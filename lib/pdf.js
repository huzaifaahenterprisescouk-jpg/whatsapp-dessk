// Dependency-free PDF writer: a titled, paginated table (A4 landscape, Helvetica).
const MAP = { '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '•': '*', ' ': ' ' };
const clean = s => String(s ?? '').replace(/[–—‘’“”…• ]/g, c => MAP[c]).replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e¡-ÿ]/g, '?');
const esc = s => clean(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const rgb = h => [1, 3, 5].map(i => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');

function pdfTable({ title, subtitle, columns, rows, footer = '', brand = '#0f766e' }) {
  const W = 842, H = 595, M = 36, FS = 8.5, RH = 19, CW = FS * 0.54;
  const usable = W - 2 * M;
  const weights = columns.map((c, i) => Math.min(34, Math.max(6, c.label.length, ...rows.slice(0, 300).map(r => clean(r[i]).length))));
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map(w => (w / total) * usable);
  const fit = (s, w) => { s = clean(s); const max = Math.max(1, Math.floor((w - 10) / CW)); return s.length > max ? s.slice(0, Math.max(1, max - 2)) + '..' : s; };
  const perPage = Math.floor((H - 2 * M - 62 - 30) / RH);
  const pages = []; for (let i = 0; i < Math.max(1, rows.length); i += perPage) pages.push(rows.slice(i, i + perPage));
  const out = pages.map((chunk, pi) => {
    let c = '';
    c += `BT /F2 17 Tf ${rgb('#10201d')} rg ${M} ${H - M - 14} Td (${esc(title)}) Tj ET\n`;
    c += `BT /F1 9 Tf ${rgb('#5b6b67')} rg ${M} ${H - M - 30} Td (${esc(subtitle)}) Tj ET\n`;
    let y = H - M - 62;
    c += `${rgb(brand)} rg ${M} ${y - 5} ${usable} ${RH} re f\n`;
    let x = M; columns.forEach((col, i) => { c += `BT /F2 ${FS} Tf 1 1 1 rg ${x + 5} ${y} Td (${esc(fit(col.label, widths[i]))}) Tj ET\n`; x += widths[i]; });
    y -= RH;
    chunk.forEach((r, ri) => {
      if (ri % 2 === 1) c += `0.955 0.968 0.964 rg ${M} ${y - 5} ${usable} ${RH} re f\n`;
      x = M; r.forEach((v, i) => { c += `BT /F1 ${FS} Tf 0.07 0.12 0.11 rg ${x + 5} ${y} Td (${esc(fit(v, widths[i]))}) Tj ET\n`; x += widths[i]; });
      y -= RH;
    });
    if (!rows.length) c += `BT /F1 10 Tf 0.4 0.45 0.44 rg ${M + 5} ${y} Td (No orders match this report today.) Tj ET\n`;
    c += `0.85 0.88 0.87 RG 0.5 w ${M} ${M + 8} m ${W - M} ${M + 8} l S\n`;
    c += `BT /F1 8 Tf 0.45 0.5 0.49 rg ${M} ${M - 4} Td (${esc(footer)}) Tj ET\n`;
    const pg = `Page ${pi + 1} of ${pages.length}`;
    c += `BT /F1 8 Tf 0.45 0.5 0.49 rg ${W - M - pg.length * 4.2} ${M - 4} Td (${pg}) Tj ET\n`;
    return c;
  });
  // objects: 1 catalog, 2 pages, 3 F1, 4 F2, then (page, content) pairs
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  out.forEach((c, i) => {
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
    const len = Buffer.byteLength(c, 'latin1');
    objs[6 + i * 2] = { stream: c, len };
  });
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]; const offs = []; let pos = parts[0].length;
  for (let i = 1; i < objs.length; i++) {
    offs[i] = pos;
    const o = objs[i];
    const b = typeof o === 'string' ? Buffer.from(`${i} 0 obj\n${o}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${i} 0 obj\n<< /Length ${o.len} >>\nstream\n`, 'latin1'), Buffer.from(o.stream, 'latin1'), Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    parts.push(b); pos += b.length;
  }
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) xref += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  parts.push(Buffer.from(xref + `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
module.exports = { pdfTable };
