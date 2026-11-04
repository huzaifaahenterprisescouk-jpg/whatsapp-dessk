// WooCommerce integration:
//  - polls the store for new / changed orders and messages the customer on WhatsApp (with a PDF)
//  - admin can approve a payment or ask the customer to confirm the address (tap a button -> saved details are added)
//  - products are synced from the store so customers can browse and buy inside WhatsApp (bank transfer or cash on delivery)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const store = require('./store'), cfgEnv = require('./config'), wa = require('./whatsapp'), { pdfTable } = require('./pdf');
const bot = () => require('./bot'); // loaded lazily (bot.js also uses this file)

// ---------- settings ----------
const DEFAULT_MSGS = {
  created: 'Hi {name}, thank you for your order #{number} at {shop}! 🛒\n\nTotal: {total}\nPayment: {method}\n{payment}\n\nYour order summary (PDF) is attached.',
  approved: '✅ Hi {name}, your payment for order #{number} is approved. We are preparing your order now. Your receipt (PDF) is attached.',
  confirmed: '✅ Hi {name}, your order #{number} is confirmed. Please keep {total} ready for the delivery. Your order summary (PDF) is attached.',
  completed: '🚚 Hi {name}, your order #{number} is complete. Thank you for shopping with {shop}!',
  cancelled: 'Hi {name}, your order #{number} has been cancelled. Reply here if you need any help.',
  refunded: 'Hi {name}, your order #{number} has been refunded.',
  addr: 'Hi {name}, please confirm the delivery address for order #{number}.\n\nCurrent address: {address}\n\nTap a button below.',
  proof: '✅ Thank you {name}! We received your payment proof for order #{number}. We will verify it shortly.',
  saved: '✅ Done! These details were added to order #{number}:\n{details}',
};
const KINDS = Object.keys(DEFAULT_MSGS);
const TEMPLATE_KINDS = ['created', 'approved', 'confirmed', 'completed', 'cancelled', 'addr'];

function W() {
  const w = (store.db.woo = store.db.woo || {});
  const d = { enabled: false, url: '', key: '', secret: '', shop: '', countryCode: '92', country: 'PK', currency: 'Rs', pollSeconds: 60,
    notifyCreated: true, notifyStatus: true, shopping: true, allowBank: true, allowCod: true, bankDetails: '', webhookSecret: crypto.randomBytes(12).toString('hex'),
    lastOrderSync: '', lastProductSync: 0, lastError: '', productError: '' };
  for (const k of Object.keys(d)) if (w[k] === undefined) w[k] = d[k];
  w.msgs = w.msgs || {}; w.templates = w.templates || {}; w.products = w.products || []; w.categories = w.categories || []; w.orders = w.orders || {};
  return w;
}
const configured = () => { const w = W(); return !!(w.url && w.key && w.secret); };
const msgText = kind => (W().msgs[kind] || '').trim() || DEFAULT_MSGS[kind];
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

function publicConfig() {
  const w = W();
  const { products, categories, orders, secret, ...rest } = w;
  return { ...rest, hasSecret: !!secret, productCount: products.length, categoryCount: categories.length, orderCount: Object.keys(orders).length, defaults: DEFAULT_MSGS, templateKinds: TEMPLATE_KINDS, live: cfgEnv.live };
}
function setConfig(b = {}) {
  const w = W();
  for (const k of ['url', 'key', 'shop', 'countryCode', 'country', 'currency', 'bankDetails']) if (b[k] !== undefined) w[k] = String(b[k]).trim();
  if (b.secret) w.secret = String(b.secret).trim();
  w.url = w.url.replace(/\/+$/, ''); if (w.url && !/^https?:\/\//i.test(w.url)) w.url = 'https://' + w.url;
  w.countryCode = w.countryCode.replace(/\D/g, '');
  for (const k of ['enabled', 'notifyCreated', 'notifyStatus', 'shopping', 'allowBank', 'allowCod']) if (b[k] !== undefined) w[k] = !!b[k];
  if (+b.pollSeconds) w.pollSeconds = Math.min(3600, Math.max(20, +b.pollSeconds));
  if (b.msgs) for (const k of KINDS) if (b.msgs[k] !== undefined) { const v = String(b.msgs[k]).trim(); if (v && v !== DEFAULT_MSGS[k]) w.msgs[k] = v; else delete w.msgs[k]; }
  if (b.templates) for (const k of TEMPLATE_KINDS) if (b.templates[k]) w.templates[k] = { name: String(b.templates[k].name || '').trim(), lang: String(b.templates[k].lang || 'en').trim() || 'en', pdf: !!b.templates[k].pdf };
  store.save(); return publicConfig();
}

// ---------- WooCommerce REST ----------
async function wc(method, p, body, query = {}) {
  const w = W(); if (!configured()) throw new Error('Enter the store address, consumer key and consumer secret first.');
  const url = new URL(w.url + '/wp-json/wc/v3' + p); for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers = { Accept: 'application/json', 'User-Agent': 'WhatsAppDesk' }; // the key goes in the Authorization header over https, in the query string on plain http
  if (url.protocol === 'https:') headers.Authorization = 'Basic ' + Buffer.from(`${w.key}:${w.secret}`).toString('base64'); else { url.searchParams.set('consumer_key', w.key); url.searchParams.set('consumer_secret', w.secret); }
  if (body) headers['Content-Type'] = 'application/json';
  let res; try { res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) }); }
  catch (e) { throw new Error('Could not reach the store: ' + (e.cause && e.cause.code || e.message)); }
  const text = await res.text(); let j; try { j = text ? JSON.parse(text) : {}; } catch { throw new Error(`The store did not answer with WooCommerce data (HTTP ${res.status}). Check the store address.`); }
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'WooCommerce refused the keys (' + (j.message || res.status) + '). Use a key with Read/Write access.' : (j.message || `WooCommerce error ${res.status}`));
  return j;
}

// ---------- helpers ----------
function waPhone(raw) { // -> international digits for WhatsApp
  let d = String(raw || '').replace(/\D/g, ''); if (!d) return '';
  const cc = W().countryCode; d = d.replace(/^00/, '');
  if (d.startsWith('0') && cc) d = cc + d.slice(1);
  else if (cc && d.length <= 10 && !d.startsWith(cc)) d = cc + d;
  return d;
}
const money = n => `${W().currency} ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const strip = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#?\w+;/g, '').replace(/\s+/g, ' ').trim();
const addrText = a => a ? [a.address_1, a.address_2, a.city, a.state, a.postcode].map(x => String(x || '').trim()).filter(Boolean).join(', ') : '';
const nameOf = a => a ? `${a.first_name || ''} ${a.last_name || ''}`.trim() : '';
const emit = () => bot().bus.emit('event', { type: 'woo' });

function mirrorOf(o) {
  const b = o.billing || {}, s = o.shipping || {}, ship = addrText(s) ? s : b;
  return { id: o.id, number: o.number || String(o.id), status: o.status, total: +o.total || 0, shipping: +o.shipping_total || 0, discount: +o.discount_total || 0, tax: +o.total_tax || 0,
    date: o.date_created_gmt ? o.date_created_gmt + 'Z' : o.date_created, method: o.payment_method, methodTitle: o.payment_method_title || o.payment_method,
    name: nameOf(b) || nameOf(s), phone: waPhone(b.phone || s.phone), rawPhone: b.phone || '', email: b.email || '', customerId: o.customer_id || 0,
    address: addrText(ship), city: ship.city || '', note: o.customer_note || '',
    items: (o.line_items || []).map(i => ({ name: i.name, qty: i.quantity, price: +i.price || 0, total: +i.total || 0 })),
    link: `${W().url}/wp-admin/post.php?post=${o.id}&action=edit` };
}

// ---------- PDF ----------
function invoicePdf(m, receipt) {
  const rows = m.items.map(i => [i.name, String(i.qty), money(i.price), money(i.total)]);
  rows.push(['', '', '', '']);
  if (m.shipping) rows.push(['', '', 'Shipping', money(m.shipping)]);
  if (m.discount) rows.push(['', '', 'Discount', '-' + money(m.discount)]);
  if (m.tax) rows.push(['', '', 'Tax', money(m.tax)]);
  rows.push(['', '', 'TOTAL', money(m.total)]);
  const d = m.date ? new Date(m.date).toLocaleDateString('en-GB') : '';
  return pdfTable({ title: `${receipt ? 'Payment receipt' : 'Order summary'} - #${m.number}`, subtitle: [m.name, m.rawPhone || m.phone, d, `Payment: ${m.methodTitle || '-'}`, `Status: ${m.status}`].filter(Boolean).join('   |   '),
    columns: [{ label: 'Item' }, { label: 'Qty' }, { label: 'Price' }, { label: 'Total' }], rows, footer: `${W().shop || store.db.settings.businessName}${m.address ? '  -  Deliver to: ' + m.address : ''}`, brand: '#0f766e' });
}

// ---------- sending to the customer ----------
function orderVars(m, extra = {}) {
  const w = W(), awaiting = m.method === 'bacs' && ['on-hold', 'pending'].includes(m.status);
  return { name: (m.name || '').split(/\s+/)[0] || 'there', number: m.number, total: money(m.total), method: m.methodTitle || '-', shop: w.shop || store.db.settings.businessName,
    address: m.address || 'not provided', payment: awaiting ? 'Please pay by bank transfer' + (w.bankDetails ? ':\n' + w.bankDetails : '.') + '\nThen send a screenshot of the payment here in this chat.' : '', ...extra };
}
function markErr(rec, r) { if (!r.ok) { rec.error = r.error; bot().bus.emit('event', { type: 'message', message: rec }); } return r; }
// kind: key of the message texts; buttons: [{id,title}] (max 3); pdf: false | 'order' | 'receipt'
async function deliver(m, kind, { buttons, pdf, extra } = {}) {
  const w = W(), B = bot();
  if (!m.phone || m.phone.length < 8) return { ok: false, error: 'This order has no usable phone number' };
  const conv = B.getConv(m.phone, m.name), vars = orderVars(m, extra), text = fill(msgText(kind), vars);
  const file = pdf ? { buffer: invoicePdf(m, pdf === 'receipt'), name: `Order-${m.number}${pdf === 'receipt' ? '-receipt' : ''}.pdf` } : null;
  const rec = B.record(conv, { dir: 'out', from: 'bot', text, options: buttons });
  const t = w.templates[kind], stale = !conv.lastCustomerAt || Date.now() - conv.lastCustomerAt > 24 * 3600e3, useTpl = cfgEnv.live && t && t.name && stale;
  let r;
  if (useTpl) r = await wa.sendTemplate(m.phone, t.name, t.lang, [vars.name, m.number, vars.total], { pdf: t.pdf && file ? { buffer: file.buffer, filename: file.name } : null, buttons: (buttons || []).map(b => b.id) });
  else r = buttons ? await wa.sendButtons(m.phone, text, buttons) : await wa.sendText(m.phone, text);
  markErr(rec, r);
  if (file && !(useTpl && t.pdf && r.ok)) {
    const fr = B.record(conv, { dir: 'out', from: 'bot', text: '📄 ' + file.name, file: { name: file.name, orderId: m.id, receipt: pdf === 'receipt' } });
    markErr(fr, await wa.sendDocument(m.phone, file.buffer, file.name, ''));
  }
  return r;
}

// ---------- orders: mirror, notify ----------
const locks = new Set();
async function notifyCreated(m) {
  const w = W(); if (!w.notifyCreated) return;
  const paid = ['processing', 'completed'].includes(m.status);
  await deliver(m, paid ? (m.method === 'cod' ? 'confirmed' : 'approved') : 'created', { pdf: paid && m.method !== 'cod' ? 'receipt' : 'order' });
}
async function notifyStatus(m, prev) {
  const w = W(); if (!w.notifyStatus) return;
  if (m.status === 'processing') return deliver(m, m.method === 'cod' ? 'confirmed' : 'approved', { pdf: m.method === 'cod' ? 'order' : 'receipt' });
  if (m.status === 'completed') return deliver(m, 'completed');
  if (m.status === 'cancelled' || m.status === 'failed') return deliver(m, 'cancelled');
  if (m.status === 'refunded') return deliver(m, 'refunded');
}
async function processOrder(o, { silent } = {}) {
  if (!o || !o.id || ['auto-draft', 'checkout-draft', 'trash'].includes(o.status)) return null;
  while (locks.has(o.id)) await new Promise(r => setTimeout(r, 100));
  locks.add(o.id);
  try {
    const w = W(), old = w.orders[o.id], m = { ...(old || {}), ...mirrorOf(o) };
    w.orders[o.id] = m;
    if (!old) { m.firstSeen = Date.now(); if (silent) m.created = true; }
    store.save();
    if (!old && !silent) { m.created = true; store.save(); await notifyCreated(m).catch(e => console.error('woo notify:', e.message)); }
    else if (old && old.status !== o.status && !silent) await notifyStatus(m, old.status).catch(e => console.error('woo notify:', e.message));
    const ids = Object.keys(w.orders); if (ids.length > 400) for (const id of ids.sort((a, b) => b - a).slice(400)) delete w.orders[id];
    store.save(); emit(); return m;
  } finally { locks.delete(o.id); }
}

let running = false;
async function pollOrders() {
  const w = W(); if (!w.enabled || !configured() || running) return; running = true;
  try {
    const started = new Date(Date.now() - 5000).toISOString().replace(/\.\d+Z$/, '');
    if (!w.lastOrderSync) { for (const o of await wc('GET', '/orders', null, { per_page: 30, orderby: 'date', order: 'desc' })) await processOrder(o, { silent: true }); } // first run: just learn the existing orders, message nobody
    else for (const o of await wc('GET', '/orders', null, { per_page: 100, modified_after: w.lastOrderSync, dates_are_gmt: 'true', orderby: 'date', order: 'asc' })) await processOrder(o);
    w.lastOrderSync = started; w.lastError = '';
  } catch (e) { w.lastError = e.message; } finally { running = false; store.save(); }
}

// ---------- products ----------
let syncing = false;
async function syncProducts() {
  const w = W(); if (!configured() || syncing) return { count: w.products.length }; syncing = true;
  try {
    const out = []; let var40 = 0;
    for (let page = 1; page <= 10; page++) {
      const list = await wc('GET', '/products', null, { per_page: 100, page, status: 'publish' });
      for (const p of list) {
        const item = { id: p.id, name: strip(p.name), price: +p.price || 0, regular: +p.regular_price || 0, onSale: !!p.on_sale, stock: p.stock_status, qty: p.manage_stock ? p.stock_quantity : null, sku: p.sku || '', image: (p.images && p.images[0] && p.images[0].src) || '', cats: (p.categories || []).map(c => c.id), type: p.type, desc: strip(p.short_description || p.description).slice(0, 260), variations: [] };
        if (p.type === 'variable' && var40 < 40) { var40++; try { item.variations = (await wc('GET', `/products/${p.id}/variations`, null, { per_page: 30 })).map(v => ({ id: v.id, name: (v.attributes || []).map(a => a.option).join(' / ') || '#' + v.id, price: +v.price || 0, stock: v.stock_status })).filter(v => v.stock !== 'outofstock'); } catch {} }
        out.push(item);
      }
      if (list.length < 100) break;
    }
    w.products = out;
    w.categories = (await wc('GET', '/products/categories', null, { per_page: 100, hide_empty: 'true' })).map(c => ({ id: c.id, name: strip(c.name), count: c.count })).filter(c => c.count > 0);
    w.lastProductSync = Date.now(); w.productError = ''; store.save(); emit(); return { count: out.length };
  } catch (e) { w.productError = e.message; store.save(); throw e; } finally { syncing = false; }
}

function start() {
  setInterval(() => pollOrders().catch(() => {}), 15000); // cheap check; the real interval is "pollSeconds"
  let last = 0; setInterval(() => { const w = W(); if (w.enabled && configured() && Date.now() - last >= w.pollSeconds * 1000) { last = Date.now(); pollOrders().catch(() => {}); } }, 5000);
  setInterval(() => { const w = W(); if (w.enabled && configured() && Date.now() - w.lastProductSync > 10 * 60000) syncProducts().catch(() => {}); }, 60000);
  setTimeout(() => { const w = W(); if (w.enabled && configured()) syncProducts().catch(() => {}); }, 4000);
}

// ---------- admin actions ----------
async function testConnection() { const info = await wc('GET', '/products', null, { per_page: 1 }); const o = await wc('GET', '/orders', null, { per_page: 1 }); return { ok: true, products: Array.isArray(info) ? 'ok' : '', orders: Array.isArray(o) ? 'ok' : '' }; }
function ordersList() { return Object.values(W().orders).sort((a, b) => b.id - a.id).slice(0, 150); }
async function freshOrder(id) { return wc('GET', `/orders/${id}`); }
async function note(id, text, customer) { try { await wc('POST', `/orders/${id}/notes`, { note: text, customer_note: !!customer }); } catch {} }
async function setStatus(id, status, by) {
  if (!['processing', 'completed', 'cancelled', 'on-hold', 'refunded', 'pending', 'failed'].includes(status)) throw new Error('Unknown status');
  const o = await wc('PUT', `/orders/${id}`, { status }); await note(id, `Status set to "${status}" from WhatsApp Desk${by ? ' by ' + by : ''}`);
  return processOrder(o); // sends the customer message (and PDF) once
}
async function askAddress(id, by) {
  const m = mirrorOf(await freshOrder(id)); const cur = W().orders[id] || m; Object.assign(cur, m, { addrAsked: Date.now() }); W().orders[id] = cur; store.save();
  const r = await deliver(cur, 'addr', { buttons: [{ id: `wa:saved:${id}`, title: 'Use saved details' }, { id: `wa:type:${id}`, title: 'Type new address' }] });
  await note(id, `Asked the customer on WhatsApp to confirm the address${by ? ' (' + by + ')' : ''}`); emit();
  if (!r.ok) throw new Error('Saved, but WhatsApp could not deliver it: ' + r.error); return cur;
}
async function resend(id, kind) { const m = mirrorOf(await freshOrder(id)); const cur = Object.assign(W().orders[id] || {}, m); W().orders[id] = cur; store.save(); const r = await deliver(cur, kind === 'receipt' ? 'approved' : 'created', { pdf: kind === 'receipt' ? 'receipt' : 'order' }); if (!r.ok) throw new Error(r.error); return cur; }
async function pdfFor(id, receipt) { return invoicePdf(mirrorOf(await freshOrder(id)), receipt); }

// ---------- customer details saved in the store ----------
async function savedDetails(phone, excludeId, customerId) {
  const tail = phone.slice(-9), found = [];
  try {
    if (customerId) { const c = await wc('GET', `/customers/${customerId}`).catch(() => null); const a = c && (c.shipping && c.shipping.address_1 ? c.shipping : c.billing); if (a && a.address_1) return { ...a, phone: (c.billing && c.billing.phone) || phone, email: c.email || '', customer_id: customerId }; } // the customer's own account first
    for (const o of await wc('GET', '/orders', null, { search: tail, per_page: 15, orderby: 'date', order: 'desc' })) {
      if (o.id === +excludeId) continue; const b = o.billing || {}, s = o.shipping || {};
      if (waPhone(b.phone || s.phone).slice(-9) !== tail) continue; const a = addrText(s).length >= addrText(b).length ? s : b;
      if (a.address_1) found.push({ ...a, phone: b.phone || phone, email: b.email || '', customer_id: o.customer_id });
    }
    const cid = (found.find(f => f.customer_id) || {}).customer_id;
    if (cid) { const c = await wc('GET', `/customers/${cid}`); const a = c.shipping && c.shipping.address_1 ? c.shipping : c.billing; if (a && a.address_1) return { ...a, phone: (c.billing && c.billing.phone) || phone, email: c.email || '', customer_id: cid }; }
  } catch {}
  return found[0] || null;
}
const detailsText = d => [nameOf(d), d.phone, addrText(d)].filter(Boolean).join('\n');
async function applyDetails(id, d, by) {
  const a = { first_name: d.first_name || '', last_name: d.last_name || '', address_1: d.address_1 || '', address_2: d.address_2 || '', city: d.city || '', state: d.state || '', postcode: d.postcode || '', country: d.country || W().country };
  const o = await wc('PUT', `/orders/${id}`, { billing: { ...a, phone: d.phone || '', ...(d.email ? { email: d.email } : {}) }, shipping: a });
  await note(id, `Customer confirmed the address on WhatsApp${by ? ' (' + by + ')' : ''}: ${addrText(a)}`);
  const m = Object.assign(W().orders[id] || {}, mirrorOf(o), { addrAsked: 0 }); W().orders[id] = m; store.save(); emit(); return m;
}
// free-typed address: "Name\nStreet, area\nCity"
function parseAddress(text, fallbackName, phone) {
  const lines = String(text).split(/\n+/).map(s => s.trim()).filter(Boolean); let name = fallbackName || '';
  if (lines.length > 1 && lines[0].length <= 40 && !/\d{3,}/.test(lines[0])) name = lines.shift();
  const body = lines.join(', '), parts = body.split(/,\s*/), city = parts.length > 1 ? parts[parts.length - 1].slice(0, 40) : '';
  const [first, ...rest] = String(name).trim().split(/\s+/);
  return { first_name: first || 'Customer', last_name: rest.join(' '), address_1: body.slice(0, 200), city, phone };
}

// ---------- payment proof sent by the customer ----------
async function handleProof(conv, media) {
  const w = W(), tail = conv.phone.slice(-9);
  const open = Object.values(w.orders).filter(o => o.phone && o.phone.slice(-9) === tail && ['on-hold', 'pending'].includes(o.status)).sort((a, b) => b.id - a.id)[0];
  if (!open) return false;
  let file = '';
  try {
    if (cfgEnv.live && media.id) { const dl = await wa.downloadMedia(media.id); const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' })[dl.mime.split(';')[0]] || 'bin'; const dir = path.join(path.dirname(cfgEnv.dataFile), 'proofs'); fs.mkdirSync(dir, { recursive: true }); file = `${open.id}-${Date.now()}.${ext}`; fs.writeFileSync(path.join(dir, file), dl.buffer); }
  } catch (e) { console.error('payment proof download:', e.message); }
  open.proofs = [...(open.proofs || []), { ts: Date.now(), file, name: media.name || '' }]; store.save();
  await note(open.id, `Payment proof received on WhatsApp from ${conv.phone}${file ? ' (saved in WhatsApp Desk)' : ''}`);
  await deliver(open, 'proof'); emit(); return true;
}
function proofPath(file) { const f = path.join(path.dirname(cfgEnv.dataFile), 'proofs', path.basename(String(file))); return fs.existsSync(f) ? f : null; }

// ---------- WhatsApp shopping ----------
async function out(conv, text, o = {}) {
  const B = bot(), opts = o.buttons || o.rows;
  const rec = B.record(conv, { dir: 'out', from: 'bot', text, options: opts && opts.map(x => ({ id: x.id, title: x.title })) });
  let r;
  if (o.image && cfgEnv.live) { await wa.sendImage(conv.phone, o.image, text); r = o.buttons ? await wa.sendButtons(conv.phone, o.prompt || 'What would you like to do?', o.buttons) : { ok: true }; }
  else if (o.rows) r = await wa.sendList(conv.phone, text, o.rows, o.button, o.title);
  else if (o.buttons) r = await wa.sendButtons(conv.phone, text, o.buttons);
  else r = await wa.sendText(conv.phone, text);
  return markErr(rec, r);
}
const S = conv => (conv.woo = conv.woo || { cart: [] });
const live = () => W().products.filter(p => p.stock !== 'outofstock' && p.price > 0);
const cartTotal = c => c.reduce((s, i) => s + i.price * i.qty, 0);
const cartText = c => c.map((i, n) => `${n + 1}. ${i.name} × ${i.qty} — ${money(i.price * i.qty)}`).join('\n');

async function shopStart(conv) {
  const w = W(), ps = live(); S(conv).step = '';
  if (!ps.length) return out(conv, 'Our online shop is being updated. Please try again a little later, or type *4* to talk to our team.');
  const cats = w.categories.filter(c => ps.some(p => p.cats.includes(c.id)));
  if (cats.length <= 1) return shopPage(conv, 'all', 0);
  const rows = cats.slice(0, 9).map(c => ({ id: `wc:cat:${c.id}`, title: c.name, description: `${ps.filter(p => p.cats.includes(c.id)).length} products` })); rows.push({ id: 'wc:cat:all', title: 'All products' });
  return out(conv, `🛍️ Welcome to ${w.shop || store.db.settings.businessName}! Choose a category:`, { rows, button: 'Categories', title: 'Categories' });
}
async function shopPage(conv, cat, page) {
  const ps = live().filter(p => cat === 'all' || p.cats.includes(+cat)), per = 9, slice = ps.slice(page * per, page * per + per);
  if (!slice.length) return out(conv, 'No products here right now.', { buttons: [{ id: 'wc:shop', title: 'Back to shop' }] });
  const rows = slice.map(p => ({ id: `wc:p:${p.id}`, title: p.name, description: money(p.price) + (p.onSale ? ' (sale)' : '') }));
  if (ps.length > (page + 1) * per) rows.push({ id: `wc:more:${cat}:${page + 1}`, title: 'More products ▶' });
  return out(conv, `Pick a product${ps.length > per ? ` (page ${page + 1} of ${Math.ceil(ps.length / per)})` : ''}:`, { rows, button: 'Products', title: 'Products' });
}
async function showProduct(conv, pid) {
  const p = W().products.find(x => x.id === +pid); if (!p) return shopStart(conv);
  const head = `*${p.name}*\n${money(p.price)}${p.onSale && p.regular ? ` (was ${money(p.regular)})` : ''}${p.qty !== null && p.qty !== undefined && p.qty < 6 ? `\nOnly ${p.qty} left` : ''}${p.desc ? '\n\n' + p.desc : ''}`;
  if (p.variations.length) return out(conv, head + '\n\nChoose an option:', { rows: p.variations.slice(0, 10).map(v => ({ id: `wc:v:${p.id}:${v.id}`, title: v.name, description: money(v.price || p.price) })), button: 'Options', title: 'Options' });
  return out(conv, head, { image: p.image, prompt: 'How many would you like?', buttons: [{ id: `wc:add:${p.id}:0:1`, title: 'Add 1' }, { id: `wc:add:${p.id}:0:2`, title: 'Add 2' }, { id: `wc:qty:${p.id}:0`, title: 'Other quantity' }] });
}
async function addToCart(conv, pid, vid, qty) {
  const p = W().products.find(x => x.id === +pid); if (!p) return shopStart(conv); const v = +vid ? p.variations.find(x => x.id === +vid) : null; qty = Math.min(99, Math.max(1, +qty || 1));
  const c = S(conv).cart, key = `${p.id}:${v ? v.id : 0}`, line = c.find(i => i.key === key);
  if (line) line.qty = Math.min(99, line.qty + qty); else c.push({ key, id: p.id, vid: v ? v.id : 0, name: p.name + (v ? ` (${v.name})` : ''), price: (v && v.price) || p.price, qty });
  S(conv).step = ''; store.save();
  return out(conv, `Added ✅ ${qty} × ${p.name}${v ? ` (${v.name})` : ''}\n\n🛒 Your cart (${money(cartTotal(c))}):\n${cartText(c)}`, { buttons: [{ id: 'wc:checkout', title: 'Checkout' }, { id: 'wc:shop', title: 'Add more' }, { id: 'wc:clear', title: 'Clear cart' }] });
}
async function checkout(conv) {
  const s = S(conv); if (!s.cart.length) return out(conv, 'Your cart is empty.', { buttons: [{ id: 'wc:shop', title: 'Start shopping' }] });
  s.step = 'detail'; store.save();
  const saved = await savedDetails(conv.phone).catch(() => null); s.saved = saved || null;
  if (saved) return out(conv, `🛒 ${money(cartTotal(s.cart))} for ${s.cart.reduce((n, i) => n + i.qty, 0)} item(s).\n\nWe found your saved details:\n${detailsText(saved)}\n\nDeliver to this address?`, { buttons: [{ id: 'wc:addr_use', title: 'Use these details' }, { id: 'wc:addr_new', title: 'Type new address' }] });
  s.step = 'addr_new'; return out(conv, `🛒 ${money(cartTotal(s.cart))}.\n\nPlease send your *full name* and *delivery address* in one message, for example:\nAli Khan\nHouse 12, Street 4, DHA Phase 5\nKarachi`);
}
async function askPayment(conv) {
  const w = W(), s = S(conv), b = []; s.step = '';
  if (w.allowBank) b.push({ id: 'wc:pay:bacs', title: 'Bank transfer' }); if (w.allowCod) b.push({ id: 'wc:pay:cod', title: 'Cash on delivery' });
  if (b.length === 1) return confirmOrder(conv, b[0].id.split(':')[2]);
  return out(conv, 'How would you like to pay?', { buttons: b });
}
async function confirmOrder(conv, method) {
  const s = S(conv); s.method = method; store.save(); const d = s.addr;
  return out(conv, `Please confirm your order:\n\n${cartText(s.cart)}\n\nTotal: ${money(cartTotal(s.cart))} (delivery charges, if any, are added by our team)\nPayment: ${method === 'bacs' ? 'Bank transfer' : 'Cash on delivery'}\n\nDeliver to:\n${detailsText(d)}`, { buttons: [{ id: 'wc:place', title: 'Place order' }, { id: 'wc:cancel', title: 'Cancel' }] });
}
async function placeOrder(conv) {
  const s = S(conv), d = s.addr; if (!s.cart.length || !d || !s.method) return shopStart(conv);
  const a = { first_name: d.first_name || 'Customer', last_name: d.last_name || '', address_1: d.address_1 || '', address_2: d.address_2 || '', city: d.city || '', state: d.state || '', postcode: d.postcode || '', country: d.country || W().country };
  try {
    const o = await wc('POST', '/orders', { status: s.method === 'bacs' ? 'on-hold' : 'processing', payment_method: s.method, payment_method_title: s.method === 'bacs' ? 'Direct bank transfer' : 'Cash on delivery', set_paid: false,
      billing: { ...a, phone: conv.phone, ...(d.email ? { email: d.email } : {}) }, shipping: a, ...(d.customer_id ? { customer_id: d.customer_id } : {}), customer_note: 'Order placed on WhatsApp',
      line_items: s.cart.map(i => ({ product_id: i.id, ...(i.vid ? { variation_id: i.vid } : {}), quantity: i.qty })), meta_data: [{ key: '_placed_via', value: 'whatsapp' }] });
    conv.woo = { cart: [] }; store.save();
    await processOrder(o); // sends the confirmation message + PDF
  } catch (e) { console.error('whatsapp order:', e.message); return out(conv, 'Sorry, we could not place your order just now. Our team has been notified — type *4* to talk to us.', { buttons: [{ id: 'wc:cart', title: 'View cart' }] }); }
}

// returns true when the message was handled here
async function handleIncoming(conv, { text, replyId, media }) {
  const w = W(); if (!w.enabled || !configured()) return false;
  const s = conv.woo || null, id = String(replyId || '');
  try {
    if (media && (media.id || media.name)) return await handleProof(conv, media);

    // address button sent by the admin
    let m = /^wa:(saved|type):(\d+)$/.exec(id);
    if (m) {
      const oid = m[2], ord = w.orders[oid]; if (!ord || ord.phone.slice(-9) !== conv.phone.slice(-9)) return false;
      if (m[1] === 'saved') {
        const d = await savedDetails(conv.phone, oid, ord.customerId);
        if (d) { const om = await applyDetails(oid, { ...d, phone: d.phone || conv.phone }, 'tapped the button'); return void await deliver(om, 'saved', { buttons: [{ id: `wa:type:${oid}`, title: 'Change address' }], extra: { details: detailsText(d) } }) || true; }
      }
      S(conv).step = 'addr_order'; S(conv).orderId = oid; store.save();
      await out(conv, `Please send your *full name* and *delivery address* in one message for order #${ord.number}.`); return true;
    }
    if (s && s.step === 'addr_order' && text && !id) {
      const oid = s.orderId, ord = w.orders[oid]; s.step = ''; if (!ord) return false;
      const d = parseAddress(text, ord.name, conv.phone), om = await applyDetails(oid, d, 'typed on WhatsApp');
      await deliver(om, 'saved', { extra: { details: detailsText(d) } }); return true;
    }

    // shopping
    if (!w.shopping) return false;
    if (id === 'shop' || /^wc:shop$/.test(id) || (conv.status === 'bot' && !id && /^(buy|buy now|shop online|shop now|order now|place order|start shopping|shopping)$/i.test(text.trim()))) { await shopStart(conv); return true; }
    if (id.startsWith('wc:')) {
      const [, act, a, b, c] = id.split(':');
      if (act === 'cat') await shopPage(conv, a, 0);
      else if (act === 'more') await shopPage(conv, a, +b);
      else if (act === 'p') await showProduct(conv, a);
      else if (act === 'v') { const p = w.products.find(x => x.id === +a), v = p && p.variations.find(x => x.id === +b); if (!v) await shopStart(conv); else await out(conv, `*${p.name}* — ${v.name}\n${money(v.price || p.price)}`, { buttons: [{ id: `wc:add:${a}:${b}:1`, title: 'Add 1' }, { id: `wc:add:${a}:${b}:2`, title: 'Add 2' }, { id: `wc:qty:${a}:${b}`, title: 'Other quantity' }] }); }
      else if (act === 'add') await addToCart(conv, a, b, c);
      else if (act === 'qty') { S(conv).step = 'qty'; S(conv).pend = { pid: a, vid: b }; store.save(); await out(conv, 'How many would you like? Send a number, e.g. 5'); }
      else if (act === 'cart') { const cart = S(conv).cart; await out(conv, cart.length ? `🛒 Your cart:\n${cartText(cart)}\n\nTotal: ${money(cartTotal(cart))}` : 'Your cart is empty.', { buttons: cart.length ? [{ id: 'wc:checkout', title: 'Checkout' }, { id: 'wc:shop', title: 'Add more' }, { id: 'wc:clear', title: 'Clear cart' }] : [{ id: 'wc:shop', title: 'Start shopping' }] }); }
      else if (act === 'clear') { S(conv).cart = []; S(conv).step = ''; store.save(); await out(conv, 'Cart cleared.', { buttons: [{ id: 'wc:shop', title: 'Start shopping' }] }); }
      else if (act === 'checkout') await checkout(conv);
      else if (act === 'addr_use') { const sv = S(conv).saved; if (!sv) await checkout(conv); else { S(conv).addr = sv; await askPayment(conv); } }
      else if (act === 'addr_new') { S(conv).step = 'addr_new'; store.save(); await out(conv, 'Please send your *full name* and *delivery address* in one message.'); }
      else if (act === 'pay') await confirmOrder(conv, a === 'cod' ? 'cod' : 'bacs');
      else if (act === 'place') await placeOrder(conv);
      else if (act === 'cancel') { S(conv).cart = []; S(conv).step = ''; store.save(); await out(conv, 'Order cancelled. Type *shop* any time to start again.'); }
      else return false;
      return true;
    }
    if (s && s.step === 'qty' && text && !id) { const n = parseInt(text, 10); if (!(n > 0 && n < 100)) { await out(conv, 'Please send a number between 1 and 99.'); return true; } await addToCart(conv, s.pend.pid, s.pend.vid, n); return true; }
    if (s && s.step === 'addr_new' && text && !id) { s.addr = parseAddress(text, conv.name === conv.phone ? '' : conv.name, conv.phone); if (s.saved) s.addr.customer_id = s.saved.customer_id; s.step = ''; store.save(); await askPayment(conv); return true; }
  } catch (e) { console.error('woo incoming:', e.message); }
  return false;
}

// Optional instant updates: WooCommerce > Settings > Advanced > Webhooks (order created / updated) -> /woo/webhook?key=...
async function handleWebhook(raw, headers, key) {
  const w = W(); if (!w.enabled || key !== w.webhookSecret) return 401;
  const sig = headers['x-wc-webhook-signature'];
  if (sig) { const exp = crypto.createHmac('sha256', w.webhookSecret).update(raw).digest('base64'); if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return 401; }
  let o; try { o = JSON.parse(raw); } catch { return 200; } // WooCommerce sends a ping first
  if (o && o.id && o.line_items) processOrder(o).catch(() => {});
  return 200;
}

module.exports = { W, publicConfig, setConfig, configured, testConnection, syncProducts, pollOrders, start, ordersList, setStatus, askAddress, resend, pdfFor, proofPath, handleIncoming, handleWebhook, KINDS, waPhone, processOrder };
