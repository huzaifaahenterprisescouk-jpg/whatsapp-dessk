const { readRows, sheetNames } = require('./xlsx');
const store = require('./store');

// key, label shown in the app, header names that are recognised automatically
const FIELDS = [
  ['pr', 'P.R no (requisition)', ['pr no', 'p r no', 'pr', 'pr number', 'p r number', 'purchase requisition', 'requisition no', 'requisition', 'req no', 'req number', 'req']],
  ['po', 'PO no', ['po no', 'po number', 'po', 'p o no', 'p o', 'purchase order', 'purchase order no']],
  ['cn', 'CN no (consignment / tracking)', ['cn no', 'cn number', 'cn', 'c n no', 'consignment no', 'consignment number', 'consignment', 'tracking', 'tracking no', 'tracking number', 'tracking id', 'awb', 'awb no', 'docket no', 'booking no']],
  ['orderId', 'Order ID (other reference)', ['order id', 'orderid', 'order no', 'order number', 'order', 'id', 'reference', 'ref']],
  ['courier', 'Courier', ['courier', 'courier name', 'carrier', 'shipping company', 'shipper']],
  ['status', 'Status', ['status', 'order status', 'state', 'stage']],
  ['customer', 'Customer name', ['customer name', 'customer', 'name', 'client']],
  ['phone', 'Customer phone', ['customer phone', 'phone', 'mobile', 'whatsapp', 'contact', 'phone number', 'mobile number', 'whatsapp number']],
  ['organization', 'Organization', ['organization', 'organisation', 'company', 'org', 'business']],
  ['link', 'Tracking link (web address)', ['tracking link', 'tracking url', 'link', 'url']],
  ['updated', 'Last updated', ['last updated', 'updated', 'updated at', 'last update', 'date']],
  ['notes', 'Notes', ['notes', 'note', 'remarks', 'comment', 'comments', 'details']],
];
const KEYS = FIELDS.map(f => f[0]);
const ID_KEYS = ['orderId', 'po', 'pr', 'cn'];

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const digits = s => String(s || '').replace(/\D/g, '');
const normId = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const colName = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

// How to read the sheet: which tab, which row holds the headers (0 = find it automatically), which column is which.
// Every company sheet ("source") keeps its own settings in source.cfg.
const DEFAULT_CFG = { sheet: '', headerRow: 0, map: {}, show: [] };
const getCfg = src => ({ ...DEFAULT_CFG, ...((src && src.cfg) || {}) });
function cleanCfg(x) {
  const map = {}; for (const k of KEYS) if (x.map && typeof x.map[k] === 'string' && x.map[k]) map[k] = x.map[k];
  return { sheet: String(x.sheet || ''), headerRow: Math.max(0, Math.min(50, +x.headerRow || 0)), map, show: (Array.isArray(x.show) ? x.show : []).map(String).slice(0, 30) };
}
function setCfg(src, x) { src.cfg = cleanCfg(x); store.save(); return src.cfg; }

const KNOWN = new Set(FIELDS.flatMap(f => f[2]));
function headerScore(rows) { let best = -1, score = 1; rows.slice(0, 25).forEach((r, i) => { const sc = r.filter(c => KNOWN.has(norm(c))).length; if (sc > score) { score = sc; best = i; } }); return { best, score: best >= 0 ? score : 0 }; }
function autoHeader(rows) {
  const { best } = headerScore(rows); if (best >= 0) return best;
  const first = rows.findIndex(r => r.filter(Boolean).length >= 3); return first >= 0 ? first : 0;
}

// Reads one worksheet and works out the columns. Never throws because of missing columns, so the setup screen can still show them.
function analyze(buffer, cfgIn) {
  const cfg = { ...DEFAULT_CFG, ...cfgIn }, sheets = sheetNames(buffer);
  let sheet = sheets.includes(cfg.sheet) ? cfg.sheet : '', all;
  if (sheet) all = readRows(buffer, sheet);
  else { // no tab chosen yet: use the one whose headers look most like an order sheet
    let top = -1; for (const n of sheets) { const rows = readRows(buffer, n), sc = headerScore(rows).score; if (sc > top) { top = sc; sheet = n; all = rows; } }
  }
  if (all.filter(r => r.some(Boolean)).length < 2) throw new Error(`The tab "${sheet}" is empty. Pick another tab, or add a header row and at least one order.`);
  const hi = cfg.headerRow > 0 ? Math.min(cfg.headerRow - 1, all.length - 1) : autoHeader(all);
  const width = Math.max(...all.slice(hi, hi + 60).map(r => r.length), 1), seen = {};
  const headers = Array.from({ length: width }, (_, i) => { let h = String(all[hi][i] || '').replace(/\s+/g, ' ').trim() || `Column ${colName(i)}`; if (seen[h]) h += ` (${++seen[h]})`; else seen[h] = 1; return h; });
  const idx = {}, guess = {};
  for (const [k, , aliases] of FIELDS) {
    const want = cfg.map[k]; if (want === '-') continue;
    let i = want ? headers.indexOf(want) : -1; if (i < 0) i = headers.findIndex(h => aliases.includes(norm(h)));
    if (i >= 0) { idx[k] = i; guess[k] = headers[i]; }
  }
  if (idx.orderId !== undefined && !cfg.map.orderId && ['po', 'pr', 'cn'].some(k => idx[k] !== undefined)) { delete idx.orderId; delete guess.orderId; }
  const used = new Set(Object.values(idx)), dispIdx = headers.findIndex(h => /dispatch/i.test(h));
  const rest = headers.map((_, i) => i).filter(i => !used.has(i) && !/^Column /.test(headers[i])), nice = rest.filter(i => /address|location|branch|city|date|package|pieces|qty|quantity|weight|item|product|description|invoice|dc no|cost/i.test(headers[i]));
  const showIdx = (cfg.show.length ? cfg.show.map(h => headers.indexOf(h)).filter(i => i >= 0) : nice.length ? nice : rest).slice(0, 14);
  const orders = [];
  for (const r of all.slice(hi + 1)) {
    const o = {}; for (const k of KEYS) o[k] = idx[k] !== undefined ? String(r[idx[k]] || '').trim() : '';
    if (!ID_KEYS.some(k => o[k])) continue;
    if (norm(o.po) === 'po' || norm(o.cn) === 'tracking') continue; // a repeated header row
    o.orderId = o.orderId || o.po || o.pr || o.cn;
    const disp = dispIdx >= 0 ? String(r[dispIdx] || '').trim() : '';
    if (!o.status) o.status = o.cn.toLowerCase() === 'self' ? 'Self collection' : (o.cn || disp) ? 'Dispatched' : 'Pending dispatch';
    o.updated = o.updated || disp;
    o.extra = showIdx.map(i => [headers[i], String(r[i] || '').trim().slice(0, 200)]).filter(([, v]) => v);
    orders.push(o);
  }
  return { sheets, sheet, headerRow: hi + 1, headers, guess, orders, hasId: ID_KEYS.some(k => idx[k] !== undefined) };
}

function parseSheet(buffer, cfg) {
  const a = analyze(buffer, cfg);
  if (!a.hasId) throw new Error('Could not find a PO no, P.R no, CN no or Order ID column. Open "Sheet & columns" and pick them.');
  return { orders: a.orders, columns: Object.keys(a.guess) };
}

// For the setup screen: tabs, headers, current guess and a preview of what customers will receive.
function inspect(buffer, cfg) {
  const a = analyze(buffer, cfg);
  return { sheets: a.sheets, sheet: a.sheet, headerRow: a.headerRow, headers: a.headers, guess: a.guess, count: a.orders.length, hasId: a.hasId,
    preview: a.orders.slice(0, 3).map(formatOrder), fields: FIELDS.map(f => ({ key: f[0], label: f[1] })) };
}

const keyOf = o => [o.po, o.pr, o.cn, o.orderId].map(normId).join('|');
// Reads one company's sheet. Only THAT company's orders are replaced / merged; the other sheets are untouched.
function importOrders(buffer, mode, src) {
  const { orders, columns } = parseSheet(buffer, getCfg(src));
  const db = store.db;
  for (const o of orders) { o.src = src.id; o.company = src.name; o.organization = o.organization || src.name; }
  const others = db.orders.filter(o => o.src !== src.id);
  let mine = orders;
  if (mode === 'merge') {
    const byId = new Map(db.orders.filter(o => o.src === src.id).map(o => [keyOf(o), o]));
    for (const o of orders) byId.set(keyOf(o), o);
    mine = [...byId.values()];
  }
  db.orders = [...others, ...mine];
  store.save();
  return { count: orders.length, total: mine.length, columns };
}

function findByPhone(phone) {
  const d = digits(phone); if (d.length < 7) return [];
  const tail = d.slice(-9);
  return store.db.orders.filter(o => { const p = digits(o.phone); return p && p.slice(-9) === tail; });
}
// match a PO no, P.R no, CN no or order id (numbers that are too short, or words like "self", never match)
function idsOf(o) { return [o.orderId, ...['po', 'pr', 'cn'].map(k => o[k]).filter(v => v && /\d/.test(v) && normId(v).length >= 4)].map(normId).filter(Boolean); }
function findById(q) {
  const id = normId(q); if (id.length < 3) return [];
  return store.db.orders.filter(o => idsOf(o).includes(id));
}

// The same PO number can exist in two companies' sheets. If we know which company the customer is from,
// show only that company's rows (when there are any); otherwise show every match.
function prefer(hits, names) {
  const ns = (names || []).map(norm).filter(n => n.length >= 3); if (!ns.length || !hits.length) return hits;
  const same = a => { a = norm(a); return a && ns.some(n => a === n || (n.length >= 4 && a.includes(n)) || (a.length >= 4 && n.includes(a))); };
  const mine = hits.filter(o => same(o.company) || same(o.organization));
  return mine.length ? mine : hits;
}

// Pull a plausible PO / PR / CN / order id / phone out of free text (searches ALL company sheets).
function lookup(text, orgNames) {
  const t = String(text || '').trim();
  let hits = findById(t);
  if (hits.length) return prefer(hits, orgNames);
  for (const tok of t.split(/[\s,;:]+/)) { hits = findById(tok); if (hits.length) return prefer(hits, orgNames); }
  if (digits(t).length >= 9) { hits = findByPhone(t); if (hits.length) return prefer(hits, orgNames); }
  return [];
}
const looksLikeId = text => String(text || '').split(/[\s,;:]+/).some(tok => /\d{4,}/.test(tok) && findById(tok).length);

const STATUS_ICON = { confirmed: '✅', processing: '⚙️', packed: '📦', shipped: '🚚', dispatched: '🚚', 'out for delivery': '🛵', delivered: '🎉', cancelled: '❌', returned: '↩️', 'on hold': '⏸️', pending: '⏳', 'pending dispatch': '⏳', 'self collection': '🏬' };
const icon = s => STATUS_ICON[String(s || '').toLowerCase()] || '📋';

function formatOrder(o) {
  const ids = [['PO no', o.po], ['PR no', o.pr], ['CN no', o.cn], ['Order ID', o.orderId !== o.po && o.orderId !== o.pr && o.orderId !== o.cn ? o.orderId : '']].filter(([, v]) => v);
  const [tl, tv] = ids[0] || ['Order', o.orderId];
  const lines = [`${icon(o.status)} *${tl} ${tv}* — *${o.status || 'Received'}*`];
  if (o.company && (store.db.sources || []).length > 1) lines.push(`Company: ${o.company}`);
  for (const [l, v] of ids.slice(1)) lines.push(`${l}: ${v}`);
  if (o.customer) lines.push(`Customer: ${o.customer}`);
  if (o.courier) lines.push(`Courier: ${o.courier}`);
  if (o.link) lines.push(/^https?:/i.test(o.link) ? `Track here: ${o.link}` : `Tracking no: ${o.link}`);
  for (const [l, v] of o.extra || []) lines.push(`${l}: ${v}`);
  if (o.notes) lines.push(`Note: ${o.notes}`);
  if (o.updated) lines.push(`Last updated: ${o.updated}`);
  return lines.join('\n');
}

module.exports = { importOrders, lookup, looksLikeId, findByPhone, formatOrder, digits, normId, getCfg, setCfg, cleanCfg, inspect };
