const cfg = require('./config');

async function call(body) {
  const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json.error && json.error.message) || `WhatsApp API ${res.status}`);
  return json;
}

// Send a plain text message. Returns {ok, error}.
async function sendText(to, text) {
  if (!cfg.live) return { ok: true, demo: true };
  try { await call({ to, type: 'text', text: { body: text, preview_url: true } }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Send a tappable menu (WhatsApp interactive list, up to 10 rows).
async function sendMenu(to, body, options) {
  if (!cfg.live) return { ok: true, demo: true };
  try {
    await call({
      to, type: 'interactive',
      interactive: {
        type: 'list', body: { text: body.slice(0, 1024) },
        action: { button: 'Choose an option', sections: [{ title: 'Menu', rows: options.slice(0, 10).map(o => ({ id: o.id, title: o.title.slice(0, 24) })) }] },
      },
    });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function markRead(messageId) {
  if (!cfg.live || !messageId) return;
  try { await call({ status: 'read', message_id: messageId }); } catch (_) {}
}


// Up to 3 tappable reply buttons (titles max 20 characters).
async function sendButtons(to, body, buttons) {
  if (!cfg.live) return { ok: true, demo: true };
  try {
    await call({ to, type: 'interactive', interactive: { type: 'button', body: { text: String(body).slice(0, 1024) }, action: { buttons: buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) } })) } } });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// A list with a custom button label and row descriptions (max 10 rows).
async function sendList(to, body, rows, button = 'Choose', title = 'Options') {
  if (!cfg.live) return { ok: true, demo: true };
  try {
    await call({ to, type: 'interactive', interactive: { type: 'list', body: { text: String(body).slice(0, 1024) }, action: { button: String(button).slice(0, 20), sections: [{ title: String(title).slice(0, 24), rows: rows.slice(0, 10).map(r => ({ id: String(r.id).slice(0, 200), title: String(r.title).slice(0, 24), ...(r.description ? { description: String(r.description).slice(0, 72) } : {}) })) }] } } });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function sendImage(to, link, caption) {
  if (!cfg.live) return { ok: true, demo: true };
  try { await call({ to, type: 'image', image: { link, caption: String(caption || '').slice(0, 1000) } }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Upload a file to WhatsApp and return its media id.
async function uploadMedia(buffer, mime, filename) {
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp'); fd.append('type', mime);
  fd.append('file', new Blob([buffer], { type: mime }), filename);
  const res = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/media`, { method: 'POST', headers: { Authorization: `Bearer ${cfg.token}` }, body: fd });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.id) throw new Error((j.error && j.error.message) || `WhatsApp media upload ${res.status}`);
  return j.id;
}
async function sendDocument(to, buffer, filename, caption) {
  if (!cfg.live) return { ok: true, demo: true };
  try { const id = await uploadMedia(buffer, 'application/pdf', filename); await call({ to, type: 'document', document: { id, filename, caption: String(caption || '').slice(0, 1000) } }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Approved message template (needed when the customer has not written to you in the last 24 hours).
// bodyParams -> {{1}}, {{2}}…; pdf -> { buffer, filename } when the template has a PDF header; buttons -> payloads of quick-reply buttons.
async function sendTemplate(to, name, lang, bodyParams = [], { pdf, buttons = [] } = {}) {
  if (!cfg.live) return { ok: true, demo: true };
  try {
    const components = [];
    if (pdf) { const id = await uploadMedia(pdf.buffer, 'application/pdf', pdf.filename); components.push({ type: 'header', parameters: [{ type: 'document', document: { id, filename: pdf.filename } }] }); }
    if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t).replace(/\s+/g, ' ').slice(0, 1000) || '-' })) });
    buttons.forEach((payload, i) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: String(payload).slice(0, 256) }] }));
    await call({ to, type: 'template', template: { name, language: { code: lang || 'en' }, components } });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Download a file the customer sent (payment screenshot etc.)
async function downloadMedia(mediaId) {
  const meta = await (await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${mediaId}`, { headers: { Authorization: `Bearer ${cfg.token}` } })).json();
  if (!meta.url) throw new Error((meta.error && meta.error.message) || 'Could not find the file');
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return { buffer: Buffer.from(await res.arrayBuffer()), mime: meta.mime_type || res.headers.get('content-type') || '' };
}

module.exports = { sendText, sendMenu, markRead, sendButtons, sendList, sendImage, sendDocument, sendTemplate, downloadMedia };
