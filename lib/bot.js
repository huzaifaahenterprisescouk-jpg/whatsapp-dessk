const { EventEmitter } = require('events');
const store = require('./store');
const wa = require('./whatsapp');
const orders = require('./orders');
const retail = require('./retail');
const track = require('./track');
const woo = require('./woo'); // WooCommerce orders + shopping in WhatsApp (woo.js loads this file lazily)

const bus = new EventEmitter();
const now = () => Date.now();

// ---------- helpers ----------
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'ltd', 'limited', 'plc', 'inc', 'llc', 'co', 'company', 'from', 'i', 'am', 'im', 'we', 'are', 'my', 'of', 'at', 'with', 'a', 'an', 'is', 'and', 'group', 'org', 'organization', 'organisation', 'calling', 'hello', 'hi', 'salam', 'assalam', 'please']);
const sig = s => norm(s).split(' ').filter(t => t && !STOP.has(t));

function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const tokEq = (a, b) => a === b || (Math.min(a.length, b.length) >= 5 && lev(a, b) <= (Math.max(a.length, b.length) >= 8 ? 2 : 1));

// score 0..1 of how well the text names an organization
function orgScore(text, org) {
  const tt = sig(text); if (!tt.length) return 0;
  let best = 0;
  for (const cand of [org.name, ...(org.aliases || [])]) {
    const ct = sig(cand); if (!ct.length) continue;
    const matched = ct.filter(c => tt.some(t => tokEq(t, c))).length;
    const coverage = matched / ct.length;                 // how much of the org name was said
    const precision = matched / tt.length;                // how much of the text is the org name
    let s = coverage === 1 ? 0.85 + 0.15 * precision : coverage * 0.7;
    if (ct.length === 1 && coverage === 1) s = Math.max(s, 0.9);
    best = Math.max(best, s);
  }
  return best;
}
function matchOrg(text, min = 0.7) {
  let best = null, bs = 0;
  for (const o of store.db.organizations) { const s = orgScore(text, o); if (s > bs) { bs = s; best = o; } }
  return bs >= min ? best : null;
}

const agentById = id => store.db.agents.find(a => a.id === id);
function openLoad(agentId) { return Object.values(store.db.conversations).filter(c => c.agentId === agentId && c.status === 'assigned').length; }
function roundRobin() {
  let pool = store.db.agents.filter(a => a.active && a.role === 'agent');
  if (!pool.length) pool = store.db.agents.filter(a => a.active);
  if (!pool.length) return null;
  return pool.map(a => ({ a, n: openLoad(a.id) })).sort((x, y) => x.n - y.n || x.a.name.localeCompare(y.a.name))[0].a;
}
function agentForOrg(org) {
  const a = agentById(org.agentId); if (a && a.active) return a;
  const b = agentById(org.backupAgentId); if (b && b.active) return b;
  return roundRobin();
}

function getConv(phone, name) {
  const db = store.db;
  let c = db.conversations[phone];
  if (!c) {
    c = db.conversations[phone] = { phone, name: name || phone, status: 'bot', stage: 'menu', agentId: null, orgId: null, orgName: '', unread: 0, createdAt: now(), updatedAt: now(), lastCustomerAt: 0, lastPreview: '' };
  } else if (name && (c.name === c.phone || !c.name)) c.name = name;
  return c;
}

function emitConv(c) { bus.emit('event', { type: 'conversation', conversation: c }); }

function record(conv, msg) {
  const m = { id: store.nextId('m'), phone: conv.phone, ts: now(), ...msg };
  store.db.messages.push(m);
  conv.updatedAt = m.ts;
  conv.lastPreview = (m.text || '').replace(/\s+/g, ' ').slice(0, 90);
  store.save();
  bus.emit('event', { type: 'message', message: m });
  emitConv(conv);
  return m;
}

const tpl = (s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

async function say(conv, text, options) {
  const m = record(conv, { dir: 'out', from: 'bot', text, options });
  const r = options ? await wa.sendMenu(conv.phone, text, options) : await wa.sendText(conv.phone, text);
  if (!r.ok) { m.error = r.error; bus.emit('event', { type: 'message', message: m }); }
  return m;
}

function menuOptions() {
  const m = store.db.settings.menu;
  const w = woo.W(), list = [{ id: 'guide', title: m.guide }, { id: 'org', title: m.org }, { id: 'track', title: m.track }, { id: 'human', title: m.human }, { id: 'retail', title: m.retail }];
  if (w.enabled && w.shopping && woo.configured()) list.push({ id: 'shop', title: m.shop || 'Shop online' });
  return list;
}
async function showMenu(conv, prefix) {
  conv.stage = 'menu'; conv.status = 'bot';
  const s = store.db.settings;
  const body = (prefix ? prefix + '\n\n' : '') + tpl(s.greeting, { business: s.businessName });
  await say(conv, body + '\n\n' + menuOptions().map((o, i) => `${i + 1}. ${o.title}`).join('\n'), menuOptions());
}

// ---------- assignment ----------
async function assign(conv, agent, org, silent) {
  const s = store.db.settings;
  conv.agentId = agent ? agent.id : null;
  conv.orgId = org ? org.id : conv.orgId;
  if (org) conv.orgName = org.name;
  conv.stage = 'human';
  conv.status = agent ? 'assigned' : 'waiting';
  conv.assignedAt = now();
  emitConv(conv);
  if (silent) return;
  if (agent) await say(conv, tpl(s.handoffMessage, { agent: agent.name, org: org ? ` (${org.name} account)` : '' }) + (agent.phone ? '\n\nWant to speak by phone? Type *call* and we will send you their number.' : ''));
  else await say(conv, s.noAgentMessage);
}

async function routeToOrg(conv, org) { await assign(conv, agentForOrg(org), org); }
async function routeToHuman(conv) {
  const org = conv.orgId ? store.db.organizations.find(o => o.id === conv.orgId) : null;
  await assign(conv, org ? agentForOrg(org) : roundRobin(), org);
}

// ---------- understanding what the customer wants ----------
function parseChoice(text, replyId) {
  if (replyId && ['guide', 'org', 'track', 'human', 'retail', 'shop'].includes(replyId)) return replyId;
  const t = norm(text);
  const map = { '1': 'guide', '2': 'org', '3': 'track', '4': 'human', '5': 'retail', ...(woo.W().enabled && woo.W().shopping ? { '6': 'shop' } : {}) };
  if (map[t]) return map[t];
  if (/\b(track|tracking|where is my order|order status|my order|parcel|shipment|delivery status)\b/.test(t)) return 'track';
  if (/\b(agent|human|person|representative|talk|speak|support|call me|help me)\b/.test(t)) return 'human';
  if (/\b(guide|information|info|catalog|catalogue|brochure|price list|how to)\b/.test(t)) return 'guide';
  if (/\b(organi[sz]ation|company|business account)\b/.test(t)) return 'org';
  if (/\b(retail|retailer|shop|dealer|store account|account no|account number)\b/.test(t)) return 'retail';
  return null;
}

// names this customer's organization goes by (used to prefer that company's sheet when a PO / PR number is searched)
function orgNamesOf(conv) {
  const o = conv.orgId && store.db.organizations.find(x => x.id === conv.orgId);
  const names = o ? [o.name, ...(o.aliases || [])] : conv.orgName && !conv.retailId ? [conv.orgName] : [];
  if (conv.retailName) names.push(conv.retailName);
  return names;
}


// ---------- retail shops: account number, details, products, balance, new-shop registration ----------
const RETAIL_MENU = [{ id: 'r_details', title: 'Account details' }, { id: 'r_products', title: 'Products & prices' }, { id: 'r_balance', title: 'Balance & invoices' }, { id: 'r_orders', title: 'My orders' }, { id: 'human', title: 'Talk to our team' }, { id: 'menu', title: 'Main menu' }];
async function retailMenu(conv, prefix) {
  conv.stage = 'retail_menu';
  await say(conv, (prefix ? prefix + '\n\n' : '') + 'What would you like to see?\n\n' + RETAIL_MENU.map((o, i) => `${i + 1}. ${o.title}`).join('\n'), RETAIL_MENU);
}
async function retailAskAccount(conv) { conv.stage = 'retail_start'; conv.retailTries = 0; await say(conv, store.db.settings.retailPrompt); }
// the shop is confirmed: remember it on the chat (the team sees it) and show the details
async function retailEnter(conv, acc) {
  conv.retailId = acc.id; conv.retailName = acc.name; conv.retailRegion = retail.regionName(acc); conv.retailTries = 0; delete conv.retailPending;
  await say(conv, retail.detailsText(acc));
  return retailMenu(conv);
}
async function retailOpen(conv, acc) {
  if (conv.retailId === acc.id || retail.phoneMatches(acc, conv.phone)) return retailEnter(conv, acc);
  conv.stage = 'retail_verify'; conv.retailPending = acc.id;
  return say(conv, `Thank you. To protect your account, please send the *last 4 digits of the phone number registered* on account ${acc.id}.`);
}
function retailChoice(text, replyId) {
  if (replyId && RETAIL_MENU.some(o => o.id === replyId)) return replyId;
  const t = norm(text), n = { '1': 'r_details', '2': 'r_products', '3': 'r_balance', '4': 'r_orders', '5': 'human', '6': 'menu' }[t]; if (n) return n;
  if (/^products?\b|\b(price|prices|price list|catalog|catalogue|items)\b/.test(t)) return 'r_products';
  if (/\b(balance|invoice|invoices|outstanding|due|payment|ledger)\b/.test(t)) return 'r_balance';
  if (/\b(order|orders|track|tracking|delivery|dispatch)\b/.test(t)) return 'r_orders';
  if (/\b(details|account|address|profile|info)\b/.test(t)) return 'r_details';
  if (/\b(agent|human|person|team|talk|support|help)\b/.test(t)) return 'human';
  return null;
}
async function routeRetailHuman(conv) {
  const rg = retail.regionOf(conv.retailRegion), reg = rg && agentById(rg.agentId);
  conv.orgName = `Retail · ${conv.retailRegion || 'shop'}`;
  await assign(conv, reg && reg.active ? reg : roundRobin(), null);
}
const REG_STEPS = {
  reg_name: ['Let us set up your shop. 🏪\nWhat is the *name of your shop*?', 'name'],
  reg_contact: ['Who is the *contact person / owner*?', 'contact'],
  reg_phone: ['What is the shop\'s *phone number*? (Type *same* to use this WhatsApp number)', 'phone'],
  reg_address: ['What is the shop\'s *full address*?', 'address'],
  reg_city: ['Which *city / town* is it in?', 'city'],
};
async function regAsk(conv, stage) { conv.stage = stage; await say(conv, REG_STEPS[stage][0]); }
async function regAskRegion(conv) {
  conv.stage = 'reg_region'; const opts = retail.regionList().map((g, i) => ({ id: 'rg' + i, title: g.name }));
  await say(conv, 'Which *region* is your shop in?\n\n' + opts.map((o, i) => `${i + 1}. ${o.title}`).join('\n'), opts);
}
async function retailRegister(conv) {
  const have = retail.byPhone(conv.phone);
  if (have) { await say(conv, `This WhatsApp number already has an account: *${have.id}* (${have.name}).`); return retailEnter(conv, have); }
  conv.reg = {}; return regAsk(conv, 'reg_name');
}
async function handleRetailStage(conv, text, replyId) {
  const st = conv.stage;
  if (st === 'retail_start') {
    if (/^(new|register|new shop|sign ?up|create)\b/i.test(text)) return retailRegister(conv);
    const acc = retail.findInText(text);
    if (acc) return retailOpen(conv, acc);
    conv.retailTries = (conv.retailTries || 0) + 1;
    if (conv.retailTries >= 4) { conv.orgName = 'Retail · account help'; await say(conv, 'We could not find that account. Let us connect you with our team.'); return assign(conv, roundRobin(), null).then(() => emitConv(conv)); }
    return say(conv, "We couldn't find that account number. Please check it and send it again, type *NEW* to register a new shop, or *menu* to go back.");
  }
  if (st === 'retail_verify') {
    const acc = retail.byId(conv.retailPending); if (!acc) return retailAskAccount(conv);
    if (retail.last4Matches(acc, text)) return retailEnter(conv, acc);
    conv.retailTries = (conv.retailTries || 0) + 1;
    if (conv.retailTries >= 3) { conv.retailPending = null; conv.orgName = 'Retail · verify account'; await say(conv, 'Those digits do not match our records, so we cannot show this account here. Our team will help you.'); return assign(conv, roundRobin(), null).then(() => emitConv(conv)); }
    return say(conv, 'Those digits do not match. Please try again with the last 4 digits of the phone number registered on the account, or type *menu*.');
  }
  if (st === 'retail_menu') {
    const acc = retail.byId(conv.retailId); if (!acc) return retailAskAccount(conv);
    const c = retailChoice(text, replyId);
    if (c === 'menu') return showMenu(conv);
    if (c === 'human') return routeRetailHuman(conv);
    if (c === 'r_details') await say(conv, retail.detailsText(acc));
    else if (c === 'r_products') await say(conv, retail.productsText(acc, ((/^(?:show\s+)?(?:me\s+)?(?:the\s+)?(?:products?|price list|prices?|items)\b(.*)$/i.exec(text.trim()) || [])[1] || '').trim()));
    else if (c === 'r_balance') await say(conv, retail.balanceText(acc));
    else if (c === 'r_orders') await say(conv, retail.ordersText(acc, conv.phone));
    else { const hit = orders.looksLikeId(text) ? orders.lookup(text, orgNamesOf(conv)) : []; if (hit.length) await say(conv, hit.slice(0, 5).map(orders.formatOrder).join('\n\n')); else return retailMenu(conv, "Sorry, I didn't understand that."); }
    return retailMenu(conv);
  }
  // registration
  if (REG_STEPS[st]) {
    const key = REG_STEPS[st][1], v = text.trim();
    if (key === 'name' && v.length < 2) return say(conv, 'Please send the shop name.');
    if (key === 'address' && v.length < 6) return say(conv, 'Please send the full address (street, area).');
    if (key === 'phone') { if (/^same$/i.test(v)) conv.reg.phone = conv.phone; else if (orders.digits(v).length < 7) return say(conv, 'Please send a valid phone number, or type *same*.'); else conv.reg.phone = v; }
    else conv.reg[key] = v.slice(0, 160);
    const order = ['reg_name', 'reg_contact', 'reg_phone', 'reg_address', 'reg_city'], next = order[order.indexOf(st) + 1];
    return next ? regAsk(conv, next) : regAskRegion(conv);
  }
  if (st === 'reg_region') {
    const list = retail.regionList(), t = norm(text), byNum = list[(parseInt(t, 10) || 0) - 1], byId = replyId && /^rg\d+$/.test(replyId) ? list[+replyId.slice(2)] : null;
    const g = byId || byNum || retail.regionOf(text); if (!g) return regAskRegion(conv);
    conv.reg.region = g.name;
    const acc = retail.register(conv.reg, conv.phone); conv.reg = null;
    conv.retailId = acc.id; conv.retailName = acc.name; conv.retailRegion = acc.region;
    await say(conv, `✅ Your shop is registered!\n\nYour account number is *${acc.id}*\nPlease save it. Next time choose *${store.db.settings.menu.retail}* and send this number to see your details, products and balance.`);
    await say(conv, retail.detailsText(acc));
    record(conv, { dir: 'sys', from: 'system', text: `New retail shop registered: ${acc.name} (${acc.id}, ${acc.region})` });
    return retailMenu(conv);
  }
}

// ---------- main entry for every customer message ----------
async function onIncoming({ phone, name, text, replyId, waId, media }) {
  const s = store.db.settings;
  const conv = getConv(phone, name);
  text = String(text || '').trim();
  if (conv.status === 'resolved') { conv.status = 'bot'; conv.stage = 'menu'; conv.agentId = conv.agentId; }
  conv.lastCustomerAt = now();
  record(conv, { dir: 'in', from: 'customer', text });
  conv.unread = (conv.unread || 0) + 1;
  if (waId) wa.markRead(waId);

  // WooCommerce: payment proofs, address buttons, shopping in WhatsApp (works even while a person is handling the chat)
  if (await woo.handleIncoming(conv, { text, replyId, media })) return emitConv(conv);

  // "call" / "contact": give the number of the person who looks after their company
  if (/^(call|call me|call karo|phone|contact|contact number|number|your number)$/i.test(text)) {
    const ct = track.callText(conv); if (ct) return say(conv, ct);
  }

  // Customer can always escape back to the menu
  if (/^(menu|0|start|restart)$/i.test(text) && conv.status !== 'assigned') return showMenu(conv);
  if (/^(menu|0)$/i.test(text) && conv.status === 'assigned') { /* human is handling; menu keyword reopens the bot */ conv.status = 'bot'; conv.agentId = conv.agentId; return showMenu(conv); }

  // A person is already looking after this chat: stay quiet
  if (conv.status === 'assigned' || conv.status === 'waiting') {
    // ...except when the customer just sends a bare PO / P.R / CN number: answer from their company's sheet right away
    if (text.length <= 40 && text.split(/[\s,;:]+/).filter(Boolean).length <= 2 && orders.looksLikeId(text)) {
      const hits = orders.lookup(text, orgNamesOf(conv));
      if (hits.length) await say(conv, hits.slice(0, 5).map(orders.formatOrder).join('\n\n'));
    }
    if (conv.status === 'waiting') { const a = conv.orgId ? agentForOrg(store.db.organizations.find(o => o.id === conv.orgId) || { }) : roundRobin(); if (a) await assign(conv, a, null, true); }
    return emitConv(conv);
  }

  switch (conv.stage) {
    case 'await_org': {
      const org = matchOrg(text, 0.6);
      if (org) return routeToOrg(conv, org);
      conv.orgName = text.slice(0, 80);
      await say(conv, s.notFoundOrg);
      return assign(conv, roundRobin(), null, true).then(() => emitConv(conv));
    }
    case 'await_order': {
      if (parseChoice(text, replyId) === 'human') return routeToHuman(conv);
      const hits = orders.lookup(text, orgNamesOf(conv));
      if (!hits.length) return say(conv, tpl(s.notFoundOrder, { q: text.slice(0, 40) }));
      conv.stage = 'menu';
      await say(conv, hits.slice(0, 5).map(orders.formatOrder).join('\n\n') + (hits.length > 5 ? `\n\n…and ${hits.length - 5} more. Send a specific PO / CN number to see it.` : '') + '\n\nType *menu* to go back, or *4* to talk to our team.');
      return;
    }
    default: if (/^(retail_|reg_)/.test(conv.stage)) return handleRetailStage(conv, text, replyId); break;
  }

  // menu stage
  const choice = parseChoice(text, replyId);
  if (choice === 'guide') { await say(conv, s.guideText + '\n\nType *menu* to go back.'); return; }
  if (choice === 'org') { conv.stage = 'await_org'; return say(conv, s.orgPrompt); }
  if (choice === 'human') return routeToHuman(conv);
  if (choice === 'retail') return retailAskAccount(conv);
  if (choice === 'shop') { await woo.handleIncoming(conv, { text: '', replyId: 'shop' }); return emitConv(conv); }
  if (choice === 'track') {
    const mine = orders.findByPhone(phone);
    conv.stage = 'await_order';
    if (mine.length) return say(conv, `We found ${mine.length} order${mine.length > 1 ? 's' : ''} linked to this number:\n\n` + mine.slice(0, 5).map(orders.formatOrder).join('\n\n') + '\n\nSend another Order ID to check a different order, or type *menu*.');
    return say(conv, s.trackPrompt);
  }
  // free text: did they just tell us their organization? ("Hi, I'm from Hilton")
  const org = matchOrg(text, 0.85);
  if (org) return routeToOrg(conv, org);
  // a shop typed its account number straight away
  const racc = retail.findInText(text); if (racc && !orders.looksLikeId(text)) return retailOpen(conv, racc);
  // order id typed straight away
  const direct = (/\b[A-Za-z]{2,5}-?\d{3,}\b/.test(text) || orders.looksLikeId(text)) ? orders.lookup(text, orgNamesOf(conv)) : [];
  if (direct.length) return say(conv, direct.slice(0, 5).map(orders.formatOrder).join('\n\n'));
  return showMenu(conv);
}

// ---------- team actions ----------
async function agentSend(convPhone, agent, text) {
  const conv = store.db.conversations[convPhone];
  if (!conv) throw new Error('Conversation not found');
  const cfg = require('./config');
  if (cfg.live && conv.lastCustomerAt && now() - conv.lastCustomerAt > 24 * 3600 * 1000)
    throw new Error('WhatsApp only allows free-form replies within 24 hours of the customer\'s last message.');
  if (conv.status === 'bot' || conv.status === 'waiting' || !conv.agentId) { conv.agentId = agent.id; conv.status = 'assigned'; conv.stage = 'human'; }
  const m = record(conv, { dir: 'out', from: 'agent', agentId: agent.id, agentName: agent.name, text });
  if (!conv.firstResponseAt) conv.firstResponseAt = now();
  conv.unread = 0;
  const r = await wa.sendText(conv.phone, text);
  if (!r.ok) { m.error = r.error; bus.emit('event', { type: 'message', message: m }); throw new Error(r.error); }
  return m;
}

function transfer(convPhone, agentId, by) {
  const conv = store.db.conversations[convPhone]; const a = agentById(agentId);
  if (!conv || !a) throw new Error('Not found');
  conv.agentId = a.id; conv.status = 'assigned'; conv.stage = 'human';
  record(conv, { dir: 'sys', from: 'system', text: `${by} assigned this chat to ${a.name}` });
  return conv;
}
async function resolve(convPhone, by) {
  const conv = store.db.conversations[convPhone]; if (!conv) throw new Error('Not found');
  conv.status = 'resolved'; conv.stage = 'menu'; conv.unread = 0; conv.resolvedAt = now();
  record(conv, { dir: 'sys', from: 'system', text: `${by} marked this chat as resolved` });
  await say(conv, store.db.settings.closedMessage);
  return conv;
}

module.exports = { bus, record, say, onIncoming, agentSend, transfer, resolve, matchOrg, roundRobin, agentForOrg, getConv, emitConv, agentById };
