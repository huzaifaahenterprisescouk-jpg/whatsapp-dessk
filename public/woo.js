/* WooCommerce: orders (message + PDF, approve payment, ask address), products synced to WhatsApp, and settings (loaded after app.js) */
const WOO = { tab: 'orders', cfg: null, orders: [], lastError: '', busy: new Set() };
const WSTATUS = { 'on-hold': ['amber', 'On hold'], pending: ['amber', 'Pending payment'], processing: ['blue', 'Processing'], completed: ['green', 'Completed'], cancelled: ['red', 'Cancelled'], failed: ['red', 'Failed'], refunded: ['red', 'Refunded'] };
const WKIND = { created: 'New order (awaiting payment)', approved: 'Payment approved', confirmed: 'Cash-on-delivery order confirmed', completed: 'Order completed', cancelled: 'Order cancelled', refunded: 'Order refunded', addr: 'Ask for the address (has buttons)', proof: 'Payment proof received', saved: 'Address saved' };

async function viewWoo() {
  $('#main').innerHTML = `<div class="page">${pageHead('WooCommerce', 'Orders from your online store reach customers on WhatsApp automatically — and customers can shop right inside WhatsApp.', '')}<div class="hint">Loading…</div></div>`;
  try { WOO.cfg = await api('/woo/config'); if (WOO.cfg.url && WOO.cfg.enabled) await wooLoadOrders(true); } catch (e) { toast(e.message, true); }
  if (!WOO.cfg.url) WOO.tab = 'settings';
  wooRender();
}
function wooEvent() { if (S.view === 'woo' && WOO.tab === 'orders') wooLoadOrders(false).then(() => wooRender(true)).catch(() => {}); }
async function wooLoadOrders(initial) { const d = await api('/woo/orders'); WOO.orders = d.orders; WOO.lastError = d.lastError || ''; if (!initial) return; }

function wooRender(keepScroll) {
  if (S.view !== 'woo') return; const c = WOO.cfg, y = keepScroll ? window.scrollY : 0, main = $('#main');
  const statusLine = !c.url ? '<span class="pill amber">Not connected</span>' : !c.enabled ? '<span class="pill amber">Switched off</span>' : WOO.lastError ? `<span class="pill red">Problem</span> <span class="hint">${esc(WOO.lastError)}</span>` : '<span class="pill green">Connected</span>';
  main.innerHTML = `<div class="page">${pageHead('WooCommerce', 'Orders from your online store reach customers on WhatsApp automatically — and customers can shop right inside WhatsApp.', `<span class="row" style="gap:8px">${statusLine}</span>`)}
    <div class="woo-tabs">${[['orders', 'Orders'], ['products', `Products${c.productCount ? ' (' + c.productCount + ')' : ''}`], ['settings', 'Settings']].map(([k, l]) => `<button data-tab="${k}" class="${WOO.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="wbody"></div></div>`;
  $('.woo-tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (!b) return; WOO.tab = b.dataset.tab; if (WOO.tab === 'orders') wooLoadOrders(true).then(() => wooRender()).catch(() => wooRender()); else wooRender(); };
  ({ orders: wooOrdersTab, products: wooProductsTab, settings: wooSettingsTab })[WOO.tab]($('#wbody'));
  if (y) window.scrollTo(0, y);
}

// ---------- orders ----------
function wooOrdersTab(el) {
  const c = WOO.cfg, tok = encodeURIComponent(S.token);
  if (!c.url || !c.enabled) return void (el.innerHTML = `<div class="card empty" style="padding:50px"><div><div class="big">${ic('shop')}</div><b style="font-size:16px">Connect your store first</b><div class="hint" style="margin:6px 0 14px">Open <b>Settings</b>, enter the store address and API keys, and switch it on.</div><button class="btn primary" id="go">Open settings</button></div></div>`), $('#go', el).onclick = () => { WOO.tab = 'settings'; wooRender(); };
  const rows = WOO.orders.map(o => {
    const st = WSTATUS[o.status] || ['', o.status], awaiting = ['on-hold', 'pending'].includes(o.status), busy = WOO.busy.has(o.id);
    const proofs = (o.proofs || []).map((p, i) => p.file ? `<a class="pill green" target="_blank" href="/api/woo/proof/${encodeURIComponent(p.file)}?token=${tok}">Proof ${i + 1}</a>` : '<span class="pill green">Proof received</span>').join(' ');
    return `<tr data-id="${o.id}"><td><b>#${esc(o.number)}</b><div class="hint">${o.date ? new Date(o.date).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</div></td>
      <td><b>${esc(o.name || '—')}</b><div class="hint">${o.phone ? '+' + esc(o.phone) : '<span style="color:var(--red)">no phone</span>'}</div><div class="hint" style="max-width:240px">${o.address ? esc(o.address) : '<i>no address</i>'}</div></td>
      <td style="max-width:230px">${o.items.slice(0, 3).map(i => `<div class="hint">${i.qty} × ${esc(i.name)}</div>`).join('')}${o.items.length > 3 ? `<div class="hint">+${o.items.length - 3} more</div>` : ''}</td>
      <td><b>${esc(WOO.cfg.currency)} ${Number(o.total).toLocaleString()}</b><div class="hint">${esc(o.methodTitle || '')}</div></td>
      <td><span class="pill ${st[0]}">${st[1]}</span><div style="margin-top:4px">${proofs}${awaiting && o.method === 'bacs' && !proofs ? '<span class="pill">no proof yet</span>' : ''}</div></td>
      <td><div class="wact">
        ${awaiting ? `<button class="btn sm primary" data-a="approve" ${busy ? 'disabled' : ''}>${o.method === 'cod' ? 'Confirm order' : 'Approve payment'}</button>` : ''}
        ${['processing'].includes(o.status) ? `<button class="btn sm primary" data-a="complete" ${busy ? 'disabled' : ''}>Mark completed</button>` : ''}
        <button class="btn sm" data-a="addr" ${busy ? 'disabled' : ''} title="Send the customer a WhatsApp message with buttons to confirm the delivery address">Ask address</button>
        <button class="btn sm" data-a="resend" ${busy ? 'disabled' : ''} title="Send the PDF to the customer again">Resend PDF</button>
        <a class="btn sm" target="_blank" href="/api/woo/orders/${o.id}/pdf?token=${tok}${o.status === 'processing' || o.status === 'completed' ? '&receipt=1' : ''}">PDF</a>
        ${!['cancelled', 'completed', 'refunded'].includes(o.status) ? `<button class="btn sm ghost danger" data-a="cancel" ${busy ? 'disabled' : ''}>Cancel</button>` : ''}
        <a class="btn sm ghost" target="_blank" href="${esc(o.link)}" title="Open in WooCommerce">Woo ↗</a></div></td></tr>`;
  }).join('');
  el.innerHTML = `<div class="row" style="margin-bottom:12px;gap:10px"><button class="btn" id="wref">${ic('refresh')} Check store now</button><span class="hint">New orders are picked up about every ${c.pollSeconds} seconds. ${c.live ? '' : '<b>Demo mode:</b> messages appear in the chat but are not really sent until WhatsApp is connected.'}</span></div>
    <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="hint" style="padding:30px;text-align:center">No orders yet. New orders from your store will appear here.</td></tr>'}</tbody></table></div></div>`;
  $('#wref', el).onclick = async e => { e.currentTarget.disabled = true; try { await api('/woo/sync', { method: 'POST' }); await wooLoadOrders(true); toast('Store checked'); } catch (err) { toast(err.message, true); } wooRender(true); };
  $('tbody', el).onclick = async e => {
    const b = e.target.closest('[data-a]'); if (!b) return; const id = +b.closest('tr').dataset.id, o = WOO.orders.find(x => x.id === id), a = b.dataset.a;
    const run = async (fn, ok) => { WOO.busy.add(id); wooRender(true); try { await fn(); await wooLoadOrders(true); toast(ok); } catch (err) { toast(err.message, true); await wooLoadOrders(true).catch(() => {}); } WOO.busy.delete(id); wooRender(true); };
    if (a === 'approve') { if (confirm(`Approve ${o.method === 'cod' ? 'order' : 'payment for order'} #${o.number}? The customer gets a WhatsApp message with the receipt PDF.`)) run(() => api(`/woo/orders/${id}/status`, { method: 'POST', body: { status: 'processing' } }), 'Approved — customer notified'); }
    else if (a === 'complete') { if (confirm(`Mark order #${o.number} as completed? The customer is notified.`)) run(() => api(`/woo/orders/${id}/status`, { method: 'POST', body: { status: 'completed' } }), 'Completed — customer notified'); }
    else if (a === 'cancel') { if (confirm(`Cancel order #${o.number}? The customer is notified.`)) run(() => api(`/woo/orders/${id}/status`, { method: 'POST', body: { status: 'cancelled' } }), 'Cancelled — customer notified'); }
    else if (a === 'addr') run(() => api(`/woo/orders/${id}/ask-address`, { method: 'POST', body: {} }), 'Address request sent on WhatsApp');
    else if (a === 'resend') run(() => api(`/woo/orders/${id}/resend`, { method: 'POST', body: { kind: o.status === 'processing' || o.status === 'completed' ? 'receipt' : 'order' } }), 'PDF sent again');
  };
}

// ---------- products ----------
async function wooProductsTab(el) {
  const c = WOO.cfg; let d = { products: [], categories: [] }; try { d = await api('/woo/products'); } catch {}
  const cat = id => (d.categories.find(x => x.id === id) || {}).name || '';
  el.innerHTML = `<div class="row" style="margin-bottom:12px;gap:10px;flex-wrap:wrap"><button class="btn primary" id="wsy">${ic('refresh')} Sync products now</button><span class="hint">${c.lastProductSync ? 'Last synced ' + new Date(c.lastProductSync).toLocaleString() + ' · ' : ''}Synced automatically every 10 minutes. Customers see these in WhatsApp when they choose <b>Shop online</b> (out-of-stock items are hidden).</span></div>
    ${c.productError ? `<div class="notice" style="margin:0 0 12px">${esc(c.productError)}</div>` : ''}
    <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th></tr></thead><tbody>${d.products.map(p => `<tr><td><b>${esc(p.name)}</b>${p.variations.length ? ` <span class="pill">${p.variations.length} options</span>` : ''}${p.sku ? `<div class="hint">${esc(p.sku)}</div>` : ''}</td><td>${esc(p.cats.map(cat).filter(Boolean).join(', '))}</td><td>${esc(c.currency)} ${p.price.toLocaleString()}${p.onSale ? ' <span class="pill amber">sale</span>' : ''}</td><td>${p.stock === 'outofstock' ? '<span class="pill red">Out of stock</span>' : `<span class="pill green">In stock</span>${p.qty != null ? ` <span class="hint">${p.qty}</span>` : ''}`}</td></tr>`).join('') || '<tr><td colspan="4" class="hint" style="padding:30px;text-align:center">No products synced yet. Connect the store and press “Sync products now”.</td></tr>'}</tbody></table></div></div>`;
  $('#wsy', el).onclick = async e => { e.currentTarget.disabled = true; try { const r = await api('/woo/sync', { method: 'POST' }); WOO.cfg = await api('/woo/config'); toast(`${r.count} products synced`); } catch (err) { toast(err.message, true); } wooRender(); };
}

// ---------- settings ----------
function wooSettingsTab(el) {
  const c = WOO.cfg, f = (id, l, v, ph = '', t = 'text') => `<div class="field"><label>${l}</label><input type="${t}" id="${id}" value="${esc(v)}" placeholder="${esc(ph)}" autocomplete="off"></div>`;
  const hook = `${location.origin}/woo/webhook?key=${c.webhookSecret}`;
  el.innerHTML = `<div class="card pad wsec"><h3>1. Connect your store</h3><span class="hint">In WordPress: <b>WooCommerce → Settings → Advanced → REST API → Add key</b>. Description “WhatsApp Desk”, permissions <b>Read/Write</b>. Copy the consumer key and secret here.</span>
      <div class="grid g2" style="gap:12px">${f('wu', 'Store address', c.url, 'https://ahenterprisess.co.uk')}${f('wsn', 'Shop name (shown to customers)', c.shop, 'AH Enterprises')}${f('wk', 'Consumer key', c.key, 'ck_…')}${f('ws', 'Consumer secret', '', c.hasSecret ? 'saved — leave blank to keep' : 'cs_…', 'password')}</div>
      <div class="grid g2" style="gap:12px">${f('wcc', 'Phone country code', c.countryCode, '92')}${f('wcu', 'Currency shown', c.currency, 'Rs')}${f('wco', 'Country (2 letters)', c.country, 'PK')}${f('wps', 'Check for new orders every (seconds)', c.pollSeconds, '60', 'number')}</div>
      <label class="fchk"><input type="checkbox" id="wen" ${c.enabled ? 'checked' : ''}> <span><b>Switch the integration on</b></span></label>
      <div class="row" style="gap:10px;margin-top:8px"><button class="btn primary" id="wsv">Save</button><button class="btn" id="wts">Save &amp; test connection</button></div></div>

    <div class="card pad wsec"><h3>2. Messages to the customer</h3><span class="hint">Placeholders: {name} {number} {total} {method} {shop} {address} {payment} {details}. Leave a box unchanged to use the default text.</span>
      <label class="fchk"><input type="checkbox" id="wnc" ${c.notifyCreated ? 'checked' : ''}> <span>Send a WhatsApp message + PDF as soon as a customer orders</span></label>
      <label class="fchk"><input type="checkbox" id="wns" ${c.notifyStatus ? 'checked' : ''}> <span>Message the customer when the order status changes (payment approved, completed, cancelled…)</span></label>
      <div style="height:8px"></div>${Object.keys(c.defaults).filter(k => WKIND[k] || k === 'refunded').map(k => `<div class="wmsg"><label>${WKIND[k] || 'Order refunded'}</label><textarea data-msg="${k}">${esc((c.msgs || {})[k] || c.defaults[k])}</textarea></div>`).join('')}</div>

    <div class="card pad wsec"><h3>3. Buying on WhatsApp</h3><span class="hint">Customers type <b>shop</b> or choose <b>Shop online</b> in the menu, pick products, and place the order. It is created in WooCommerce and they receive the PDF.</span>
      <label class="fchk"><input type="checkbox" id="wsh" ${c.shopping ? 'checked' : ''}> <span>Let customers shop in WhatsApp</span></label>
      <label class="fchk"><input type="checkbox" id="wab" ${c.allowBank ? 'checked' : ''}> <span>Allow bank transfer (order stays “On hold” until you approve the payment)</span></label>
      <label class="fchk"><input type="checkbox" id="wac" ${c.allowCod ? 'checked' : ''}> <span>Allow cash on delivery (order goes straight to “Processing”)</span></label>
      <div class="field"><label>Bank details sent to customers who choose bank transfer</label><textarea id="wbd" placeholder="Bank: HBL&#10;Account title: AH Enterprises&#10;Account no: 1234 5678 9012&#10;IBAN: PK00 …">${esc(c.bankDetails)}</textarea></div></div>

    <div class="card pad wsec"><h3>4. WhatsApp message templates <span class="pill">live WhatsApp only</span></h3><span class="hint">WhatsApp only allows free messages within 24 hours of the customer’s last message. For orders placed on your website (the customer has not messaged you), create <b>approved templates</b> in Meta Business Manager and enter their names here. Body variables: <b>{{1}}</b> name, <b>{{2}}</b> order number, <b>{{3}}</b> total. For the address template add two <b>quick-reply buttons</b>. Tick “PDF header” if the template has a document header. Leave blank to send normal messages (works when the customer wrote to you recently).${c.live ? '' : ' <b>Not connected to WhatsApp yet (demo mode).</b>'}</span>
      ${c.templateKinds.map(k => { const t = (c.templates || {})[k] || {}; return `<div class="wtpl"><b style="font-size:12.5px">${WKIND[k]}</b><input data-tn="${k}" value="${esc(t.name || '')}" placeholder="template_name"><input data-tl="${k}" value="${esc(t.lang || 'en')}" placeholder="en"><label class="fchk" style="padding:0"><input type="checkbox" data-tp="${k}" ${t.pdf ? 'checked' : ''}> <span>PDF header</span></label></div>`; }).join('')}</div>

    <div class="card pad wsec"><h3>5. Instant updates (optional)</h3><span class="hint">Orders are checked automatically, so this is only needed if you want customers notified within seconds. In WooCommerce → Settings → Advanced → Webhooks, add two webhooks (topics <b>Order created</b> and <b>Order updated</b>) with this delivery URL (your desk must be reachable from the internet over https) and any secret:</span><div class="wurl">${esc(hook)}</div></div>`;
  const val = id => $('#' + id, el).value, chk = id => $('#' + id, el).checked;
  const body = () => ({ url: val('wu'), shop: val('wsn'), key: val('wk'), secret: val('ws'), countryCode: val('wcc'), currency: val('wcu'), country: val('wco'), pollSeconds: val('wps'), enabled: chk('wen'), notifyCreated: chk('wnc'), notifyStatus: chk('wns'), shopping: chk('wsh'), allowBank: chk('wab'), allowCod: chk('wac'), bankDetails: val('wbd'),
    msgs: Object.fromEntries([...el.querySelectorAll('[data-msg]')].map(t => [t.dataset.msg, t.value])), templates: Object.fromEntries(c.templateKinds.map(k => [k, { name: el.querySelector(`[data-tn="${k}"]`).value, lang: el.querySelector(`[data-tl="${k}"]`).value, pdf: el.querySelector(`[data-tp="${k}"]`).checked }])) });
  const save = async () => { WOO.cfg = await api('/woo/config', { method: 'PUT', body: body() }); };
  $('#wsv', el).onclick = async e => { e.currentTarget.disabled = true; try { await save(); toast('Saved'); if (WOO.cfg.enabled && WOO.cfg.url) api('/woo/sync', { method: 'POST' }).then(() => api('/woo/config')).then(x => { WOO.cfg = x; }).catch(() => {}); } catch (err) { toast(err.message, true); } wooRender(); };
  $('#wts', el).onclick = async e => { const b = e.currentTarget; b.disabled = true; b.textContent = 'Testing…'; try { await save(); await api('/woo/test', { method: 'POST' }); toast('Connected to your store ✔'); } catch (err) { toast(err.message, true); } wooRender(); };
}
