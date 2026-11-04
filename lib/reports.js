// Scheduled reports: pick rows + columns from the order sheet, build PDF + Excel, email them.
const store = require('./store');
const { pdfTable } = require('./pdf');
const { writeRows } = require('./xlsx');
const mailer = require('./mailer');

const COLUMNS = [
  { key: 'orderId', label: 'Order ID' }, { key: 'customer', label: 'Customer' }, { key: 'phone', label: 'Phone' },
  { key: 'organization', label: 'Organization' }, { key: 'status', label: 'Status' }, { key: 'courier', label: 'Courier' },
  { key: 'link', label: 'Tracking' }, { key: 'updated', label: 'Last updated' }, { key: 'notes', label: 'Notes' },
];
const DEFAULT_COLS = ['orderId', 'customer', 'organization', 'status', 'courier', 'updated', 'notes'];
const emailRe = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

const list = () => (store.db.reports = store.db.reports || []);
const mailCfg = () => (store.db.mail = store.db.mail || { host: '', port: 587, security: 'starttls', user: '', pass: '', from: '', fromName: '' });
const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const slug = s => String(s || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';

function clean(b, old = {}) {
  const f = b.filter || {};
  const arr = v => (Array.isArray(v) ? v : String(v || '').split(/[\n,;]+/)).map(s => String(s).trim()).filter(Boolean);
  const r = {
    id: old.id || store.nextId('r'),
    name: String(b.name || '').trim().slice(0, 80),
    enabled: b.enabled !== false,
    filter: { organizations: arr(f.organizations), statuses: arr(f.statuses), updatedWithinDays: f.updatedWithinDays === '' || f.updatedWithinDays == null ? '' : Math.max(0, +f.updatedWithinDays || 0), search: String(f.search || '').trim() },
    columns: arr(b.columns).filter(k => COLUMNS.some(c => c.key === k)),
    pdf: b.pdf !== false, excel: b.excel !== false,
    recipients: arr(b.recipients).map(s => s.toLowerCase()),
    subject: String(b.subject || '').trim().slice(0, 150), message: String(b.message || '').trim().slice(0, 2000),
    time: /^\d{2}:\d{2}$/.test(b.time) ? b.time : '09:00',
    days: arr(b.days).map(Number).filter(d => d >= 0 && d <= 6),
    skipIfEmpty: !!b.skipIfEmpty,
    lastRun: old.lastRun || null, lastRunDay: old.lastRunDay || '',
  };
  if (!r.name) throw new Error('Give the report a name.');
  if (!r.columns.length) r.columns = DEFAULT_COLS;
  if (!r.days.length) r.days = [0, 1, 2, 3, 4, 5, 6];
  if (!r.pdf && !r.excel) throw new Error('Choose PDF, Excel or both.');
  const bad = r.recipients.find(e => !emailRe.test(e));
  if (bad) throw new Error(`"${bad}" is not a valid email address.`);
  if (!r.recipients.length) throw new Error('Add at least one email address.');
  return r;
}

function select(r) {
  const f = r.filter; const q = f.search.toLowerCase();
  const orgs = f.organizations.map(s => s.toLowerCase()), sts = f.statuses.map(s => s.toLowerCase());
  const cutoff = f.updatedWithinDays !== '' ? Date.now() - f.updatedWithinDays * 864e5 : null;
  return store.db.orders.filter(o => {
    if (orgs.length && !orgs.includes(String(o.organization || '').toLowerCase())) return false;
    if (sts.length && !sts.includes(String(o.status || 'Pending').toLowerCase())) return false;
    if (cutoff !== null) { const t = Date.parse(o.updated); if (!(t >= cutoff - 864e5)) return false; }
    if (q && !Object.values(o).join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
}

function build(r) {
  const rows = select(r), cols = r.columns.map(k => COLUMNS.find(c => c.key === k));
  const grid = rows.map(o => cols.map(c => o[c.key] ?? ''));
  const day = today(), base = `${slug(r.name)}-${day}`, biz = store.db.settings.businessName;
  const files = [];
  if (r.excel) files.push({ filename: base + '.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: writeRows([cols.map(c => c.label), ...grid], r.name.slice(0, 28)) });
  if (r.pdf) files.push({ filename: base + '.pdf', type: 'application/pdf', content: pdfTable({ title: r.name, subtitle: `${biz} · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} · ${rows.length} order${rows.length === 1 ? '' : 's'}`, columns: cols, rows: grid, footer: `${biz} · generated automatically` }) });
  const byStatus = {}; rows.forEach(o => { const s = o.status || 'Pending'; byStatus[s] = (byStatus[s] || 0) + 1; });
  return { rows, files, byStatus };
}

function emailBody(r, b) {
  const biz = store.db.settings.businessName;
  const intro = r.message || 'Please find the latest report attached.';
  const lines = Object.entries(b.byStatus).map(([s, n]) => `${s}: ${n}`);
  const text = `${intro}\n\n${r.name} — ${b.rows.length} order(s)\n${lines.join('\n')}\n\n— ${biz}`;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;color:#10201d"><div style="background:#0f766e;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;font-size:18px;font-weight:700">${esc(r.name)}</div>
  <div style="border:1px solid #e4e9e7;border-top:0;padding:20px;border-radius:0 0 12px 12px"><p style="margin:0 0 14px;white-space:pre-wrap">${esc(intro)}</p>
  <p style="margin:0 0 8px;font-size:28px;font-weight:800">${b.rows.length} <span style="font-size:14px;font-weight:500;color:#5b6b67">order${b.rows.length === 1 ? '' : 's'} in this report</span></p>
  <table style="border-collapse:collapse;width:100%;font-size:14px">${Object.entries(b.byStatus).map(([s, n]) => `<tr><td style="padding:6px 0;border-top:1px solid #e4e9e7">${esc(s)}</td><td style="padding:6px 0;border-top:1px solid #e4e9e7;text-align:right;font-weight:700">${n}</td></tr>`).join('')}</table>
  <p style="margin:16px 0 0;color:#8a9893;font-size:12px">The full list is attached. Sent automatically by ${esc(biz)}.</p></div></div>`;
  return { text, html };
}

// Reports are sent from the account typed in "Email settings"; if that was never filled in, the first Gmail mailbox
// added under Email (the shared inbox) is used, so one mailbox set-up is enough.
function fallbackAccount() { return ((store.db.inbox || {}).accounts || []).find(a => a.enabled !== false && a.user && a.pass) || null; }
function effectiveCfg() {
  const c = mailCfg(); if (c.host && c.from) return { ...c, source: 'settings' };
  const a = fallbackAccount(); if (!a) return null;
  return { host: a.smtpHost || 'smtp.gmail.com', port: +a.smtpPort || 587, security: +a.smtpPort === 465 ? 'ssl' : 'starttls', user: a.user, pass: a.pass, from: a.user, fromName: a.fromName || a.label || '', source: 'mailbox', label: a.label || a.user };
}
async function sendMail(msg) {
  const c = effectiveCfg();
  if (!c) throw new Error('Set up the email account first (Email settings, or add a Gmail mailbox under Email).');
  return mailer.send(c, msg);
}

async function run(r, { manual } = {}) {
  const b = build(r);
  if (!manual && r.skipIfEmpty && !b.rows.length) { r.lastRun = { ts: Date.now(), ok: true, count: 0, note: 'Skipped: no matching orders' }; r.lastRunDay = today(); store.save(); return r.lastRun; }
  const subject = (r.subject || `${r.name} — ${today()}`).replace('{date}', today()).replace('{count}', b.rows.length);
  try {
    const { text, html } = emailBody(r, b);
    await sendMail({ to: r.recipients, subject, text, html, attachments: b.files });
    r.lastRun = { ts: Date.now(), ok: true, count: b.rows.length, note: `Sent to ${r.recipients.length} ${r.recipients.length === 1 ? 'person' : 'people'}` };
  } catch (e) { r.lastRun = { ts: Date.now(), ok: false, count: b.rows.length, note: e.message }; }
  if (!manual) r.lastRunDay = today();
  store.save();
  if (!r.lastRun.ok) throw new Error(r.lastRun.note);
  return r.lastRun;
}

let timer;
function tick() {
  const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
  for (const r of list()) {
    if (!r.enabled || r.lastRunDay === today(now) || !r.days.includes(now.getDay())) continue;
    const [h, m] = r.time.split(':').map(Number), due = mins - (h * 60 + m);
    if (due >= 0 && due < 90) run(r).catch(e => console.error(`Report "${r.name}" failed:`, e.message));
  }
}
function start() { clearInterval(timer); timer = setInterval(tick, 20000); setTimeout(tick, 3000); }

module.exports = { COLUMNS, list, mailCfg, effectiveCfg, clean, build, run, start, sendMail, select };
