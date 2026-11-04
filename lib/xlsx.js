// Minimal, dependency-free .xlsx reader/writer (first sheet only).
const zlib = require('zlib');

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const data = buf.subarray(start, start + csize);
    files[name] = () => (method === 0 ? data : zlib.inflateRawSync(data));
    p += 46 + nlen + elen + clen;
  }
  return files;
}

const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref); let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function excelDate(serial) {
  const d = new Date(Math.round((serial - 25569) * 86400000));
  return d.toISOString().slice(0, 10);
}

// Worksheets of a workbook in tab order: [{ name, path, hidden }].
function listSheets(z) {
  const out = [];
  if (z['xl/workbook.xml'] && z['xl/_rels/workbook.xml.rels']) {
    const wb = z['xl/workbook.xml']().toString('utf8'), rels = z['xl/_rels/workbook.xml.rels']().toString('utf8'), target = {};
    for (const r of rels.match(/<Relationship\b[^>]*>/g) || []) {
      const id = (/\bId="([^"]+)"/.exec(r) || [])[1], t = (/Target="([^"]+)"/.exec(r) || [])[1];
      if (id && t) target[id] = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    }
    for (const sh of wb.match(/<sheet\b[^>]*>/g) || []) {
      const rid = (/r:id="([^"]+)"/.exec(sh) || [])[1], name = unesc((/\bname="([^"]*)"/.exec(sh) || [])[1] || '');
      if (target[rid] && z[target[rid]]) out.push({ name, path: target[rid], hidden: /state="(hidden|veryHidden)"/.test(sh) });
    }
  }
  if (!out.length) Object.keys(z).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort().forEach((path, i) => out.push({ name: 'Sheet' + (i + 1), path, hidden: false }));
  return out;
}
const sheetNames = buf => listSheets(readZip(buf)).filter(x => !x.hidden).map(x => x.name);

// Returns array of rows (arrays of strings) from a worksheet (the one called `sheet`, else the first visible tab).
function readRows(buf, sheet) {
  const z = readZip(buf);
  const shared = [];
  if (z['xl/sharedStrings.xml']) {
    const xml = z['xl/sharedStrings.xml']().toString('utf8');
    for (const si of xml.match(/<si[\s>][\s\S]*?<\/si>|<si\/>/g) || []) {
      shared.push(unesc((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  // date-formatted styles
  const dateXf = new Set();
  if (z['xl/styles.xml']) {
    const st = z['xl/styles.xml']().toString('utf8');
    const custom = {};
    for (const m of st.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)) custom[m[1]] = m[2];
    const xfs = (st.match(/<cellXfs[\s\S]*?<\/cellXfs>/) || [''])[0].match(/<xf\b[^>]*>/g) || [];
    xfs.forEach((xf, i) => {
      const id = (/numFmtId="(\d+)"/.exec(xf) || [])[1];
      if (!id) return;
      const n = +id;
      if ((n >= 14 && n <= 22) || (n >= 45 && n <= 47) || (custom[id] && /[dmyhs]/i.test(custom[id].replace(/\[[^\]]*\]|"[^"]*"/g, '')))) dateXf.add(i);
    });
  }
  const tabs = listSheets(z), pick = tabs.find(x => x.name === sheet) || tabs.find(x => !x.hidden) || tabs[0], sheetName = pick && pick.path;
  if (!sheetName || !z[sheetName]) throw new Error('No worksheet found');
  const xml = z[sheetName]().toString('utf8');
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] || '';
      const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1];
      const t = (/t="([^"]+)"/.exec(attrs) || [])[1];
      const s = (/s="(\d+)"/.exec(attrs) || [])[1];
      let val = '';
      const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      if (t === 's') val = shared[+v] ?? '';
      else if (t === 'inlineStr') val = unesc((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map(x => x.replace(/<[^>]+>/g, '')).join(''));
      else if (t === 'str' || t === 'e') val = unesc(v || '');
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) val = (s !== undefined && dateXf.has(+s) && isFinite(v)) ? excelDate(+v) : String(+v === Math.trunc(+v) ? Math.trunc(+v) : +v);
      const idx = ref ? colIndex(ref) : row.length;
      while (row.length < idx) row.push('');
      row[idx] = String(val).trim();
    }
    rows.push(row);
  }
  return rows;
}

// Minimal writer (stored, no compression) used for the downloadable template.
const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function writeZip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf8'), nb = Buffer.from(name), crc = crc32(data);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(nb.length, 26);
    locals.push(l, nb, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(offset, 42);
    centrals.push(c, nb);
    offset += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}

function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

function writeRows(rows, sheetName = 'Orders') {
  const sheet = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) =>
    `<c r="${colName(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`).join('') + '</row>').join('');
  const widths = rows[0].map((_, i) => {
    const mx = rows.slice(0, 500).reduce((m, r) => Math.max(m, String(r[i] ?? '').length), 0);
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(50, Math.max(11, mx + 3))}" customWidth="1"/>`;
  }).join('');
  const last = `${colName(rows[0].length - 1)}${rows.length}`;
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return writeZip([
    ['[Content_Types].xml', X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', X + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(String(sheetName).replace(/[\\/?*\[\]:]/g, ' ').slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', X + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ['xl/worksheets/sheet1.xml', X + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${widths}</cols><sheetData>${sheet}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`],
  ]);
}

module.exports = { readRows, writeRows, sheetNames };
