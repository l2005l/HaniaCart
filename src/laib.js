// Victory and Hyper Cohen publish their price files on laibcatalog.co.il, which does not answer
// GitHub's servers. The Worker fetches them itself: from a Cloudflare location in Israel when a
// family member opens the app, or from the hourly cron when that location can reach the site.
import { gtin14 } from './gtin.js';

export const LAIB = [
  { label: 'ויקטורי', edi: '7290696200003', keys: ['נתיבות'] },
  { label: 'היפר כהן', edi: '7290455000004', keys: ['נתיבות'] },
];
const BASE = 'https://laibcatalog.co.il/webapi';
const pick = (block, tag) => { const m = block.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i')); return m ? m[1].trim() : ''; };
const unxml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// A barcode with a valid GS1 check digit, as GTIN-14; '' for internal codes.
export function validGtin(code) {
  const g = gtin14(code); if (!g || /^0+$/.test(g)) return '';
  let sum = 0; for (let i = 0; i < 13; i++) sum += +g[i] * (i % 2 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === +g[13] ? g : '';
}

// Bytes of a .gz (or a zip named .gz) to a stream of text, without holding the whole file.
async function textStream(resp) {
  const buf = new Uint8Array(await resp.arrayBuffer());
  let raw;
  if (buf[0] === 0x50 && buf[1] === 0x4b) { // zip: one entry, deflated
    const dv = new DataView(buf.buffer, buf.byteOffset);
    const start = 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
    raw = new Blob([buf.subarray(start)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  } else if (buf[0] === 0x1f && buf[1] === 0x8b) raw = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  else raw = new Blob([buf]).stream();
  const reader = raw.getReader(); const first = await reader.read();
  const head = first.value || new Uint8Array();
  const enc = head[0] === 0xff && head[1] === 0xfe ? 'utf-16le' : 'utf-8';
  const rest = new ReadableStream({ start(c) { if (head.length) c.enqueue(head); }, async pull(c) { const r = await reader.read(); if (r.done) c.close(); else c.enqueue(r.value); } });
  return rest.pipeThrough(new TextDecoderStream(enc));
}

// Calls fn(blockText) for every <tag>…</tag> in the file.
async function eachBlock(resp, tag, fn) {
  const reader = (await textStream(resp)).getReader();
  const open = new RegExp('<' + tag + '[\\s>]', 'i'), close = '</' + tag + '>';
  let buf = '';
  for (;;) {
    const r = await reader.read(); if (r.done) break;
    buf += r.value;
    for (;;) {
      const m = buf.match(open); if (!m) { buf = buf.slice(-200); break; }
      const end = buf.toLowerCase().indexOf(close.toLowerCase(), m.index); if (end < 0) { buf = buf.slice(m.index); break; }
      fn(buf.slice(m.index, end)); buf = buf.slice(end + close.length);
    }
  }
}

const get = (url) => fetch(url, { signal: AbortSignal.timeout(60000), headers: { 'user-agent': 'Mozilla/5.0 HaniaCart (+https://cart.hania360.com)' } });

export async function fetchLaibChain(cfg) {
  const lr = await get(BASE + '/api/getfiles?edi=' + cfg.edi);
  if (!lr.ok) throw new Error('listing HTTP ' + lr.status);
  const files = (await lr.json()).filter((f) => f && f.fileName).sort((a, b) => String(b.fileDate).localeCompare(String(a.fileDate)));
  const storesFile = files.find((f) => /^stores/i.test(f.fileName));
  if (!storesFile) throw new Error('no Stores file');
  const stores = [];
  await eachBlock(await get(BASE + '/' + cfg.edi + '/' + encodeURIComponent(storesFile.fileName)), 'Store', (b) => {
    stores.push({ id: pick(b, 'StoreId') || pick(b, 'StoreID'), text: [pick(b, 'StoreName'), pick(b, 'Address'), pick(b, 'City')].map(unxml).join(' ') });
  });
  const store = cfg.storeId ? stores.find((s) => +s.id === +cfg.storeId) : stores.find((s) => cfg.keys.some((k) => s.text.includes(k)));
  if (!store) return { ok: false, error: 'no matching store', stores: stores.map((s) => s.id + ': ' + s.text).slice(0, 80) };
  // The listing gives each file's branch; names look like PriceFull<chain>-<sub>-<branch>-<date>, so fall back to their parts.
  const ofStore = (f) => (f.branchNumber != null && f.branchNumber !== '' ? +f.branchNumber === +store.id : String(f.fileName).split(/[-.]/).slice(1, 3).some((x) => +x === +store.id));
  const pf = files.find((f) => /^pricefull/i.test(f.fileName) && ofStore(f));
  if (!pf) return { ok: false, error: 'no PriceFull for store ' + store.id, store: store.text };
  const rows = new Map();
  await eachBlock(await get(BASE + '/' + cfg.edi + '/' + encodeURIComponent(pf.fileName)), 'Item', (b) => {
    const code = validGtin(pick(b, 'ItemCode')), price = +pick(b, 'ItemPrice');
    if (!code || !(price > 0)) return;
    const qty = pick(b, 'Quantity'), uq = unxml(pick(b, 'UnitQty'));
    rows.set(code, [code, unxml(pick(b, 'ItemName') || pick(b, 'ItemNm')).slice(0, 120), Math.round(price * 100) / 100, qty && uq ? (String(+qty) + ' ' + uq).slice(0, 30) : '']);
  });
  return { ok: true, store: store.text.slice(0, 120), storeName: store.text.split(' ').slice(0, 4).join(' ').slice(0, 60), file: pf.fileName, rows: [...rows.values()] };
}

// Replace a chain's prices; D1 allows 100 bound values per statement, so 11 rows each.
export async function savePrices(env, label, storeName, rows, ts) {
  const stmts = [env.DB.prepare('DELETE FROM prices WHERE chain=?').bind(label)];
  for (let i = 0; i < rows.length; i += 11) {
    const part = rows.slice(i, i + 11);
    stmts.push(env.DB.prepare('INSERT INTO prices (chain,code,store,name,price,unit,promo,pprice,ts) VALUES ' + part.map(() => "(?,?,?,?,?,?,'',NULL,?)").join(','))
      .bind(...part.flatMap((r) => [label, r[0], storeName, r[1], r[2], r[3], ts])));
  }
  if (env.DB.batch) { for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200)); } else for (const s of stmts) await s.run();
}

export async function refreshLaib(env, where) {
  const ts = Date.now(), status = { ts, where, chains: {} };
  for (const cfg of LAIB) {
    try {
      const r = await fetchLaibChain(cfg);
      if (r.ok && r.rows.length) { await savePrices(env, cfg.label, r.storeName, r.rows, ts); status.chains[cfg.label] = { ok: true, count: r.rows.length, store: r.store, file: r.file }; }
      else status.chains[cfg.label] = Object.assign({ ok: false }, r, { rows: undefined, error: r.error || 'no barcoded items' });
    } catch (e) { status.chains[cfg.label] = { ok: false, error: String((e && (e.name + ': ' + e.message)) || e).slice(0, 200) }; }
  }
  await env.DB.prepare("INSERT INTO kv (k,v) VALUES ('prices:laib',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(status)).run();
  return status;
}
