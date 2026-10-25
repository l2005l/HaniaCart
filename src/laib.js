// Victory and Hyper Cohen publish their price files on laibcatalog.co.il, which does not answer
// GitHub's servers. The Worker fetches them itself: from a Cloudflare location in Israel when a
// family member opens the app, or from the hourly cron when that location can reach the site.
import { gtin14 } from './gtin.js';

// keys find the default branch, the one a household sees before it picks its own.
export const LAIB = [
  { slug: 'victory', label: 'ויקטורי', edi: '7290696200003', keys: ['נתיבות'] },
  { slug: 'het-cohen', label: 'היפר כהן', edi: '7290455000004', keys: ['נתיבות'] },
  { slug: 'mahsanei-hashuk', label: 'מחסני השוק', edi: '7290661400001', keys: [] },
];
export const LAIB_SLUGS = LAIB.map((c) => c.slug);
const PER_CHAIN = 3; // branches downloaded per chain in one run
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

// Through the haniacart-il relay (placed in Israel) when it is bound; directly otherwise.
let RELAY = null;
export function useRelay(env) { RELAY = env && env.IL ? env.IL : null; }
export function relayFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('user-agent')) headers.set('user-agent', 'Mozilla/5.0 HaniaCart (+https://cart.hania360.com)');
  if (!RELAY) return fetch(url, Object.assign({}, init, { headers }));
  headers.set('x-target', String(url));
  return RELAY.fetch('https://haniacart-il/', Object.assign({}, init, { headers }));
}
const get = (url) => relayFetch(url, { signal: AbortSignal.timeout(60000) });

const sidOf = (slug, id) => slug + ':' + (String(id).replace(/^0+/, '') || '0');
async function laibFiles(cfg) {
  const lr = await get(BASE + '/api/getfiles?edi=' + cfg.edi);
  if (!lr.ok) throw new Error('listing HTTP ' + lr.status);
  const files = (await lr.json()).filter((f) => f && f.fileName).sort((a, b) => String(b.fileDate).localeCompare(String(a.fileDate)));
  const storesFile = files.find((f) => /^stores/i.test(f.fileName));
  if (!storesFile) throw new Error('no Stores file');
  const stores = [];
  await eachBlock(await get(BASE + '/' + cfg.edi + '/' + encodeURIComponent(storesFile.fileName)), 'Store', (b) => {
    const name = unxml(pick(b, 'StoreName')), address = unxml(pick(b, 'Address')), city = unxml(pick(b, 'City'));
    stores.push({ id: pick(b, 'StoreId') || pick(b, 'StoreID'), name, address, city, text: [name, address, city].join(' ') });
  });
  return { files, stores };
}
async function fetchStorePrices(cfg, files, store) {
  // The listing gives each file's branch; names look like PriceFull<chain>-<sub>-<branch>-<date>, so fall back to their parts.
  const ofStore = (f) => (f.branchNumber != null && f.branchNumber !== '' ? +f.branchNumber === +store.id : String(f.fileName).split(/[-.]/).slice(1, 3).some((x) => +x === +store.id));
  const pf = files.find((f) => /^pricefull/i.test(f.fileName) && ofStore(f));
  if (!pf) return { ok: false, error: 'no PriceFull for store ' + store.id };
  const rows = new Map();
  await eachBlock(await get(BASE + '/' + cfg.edi + '/' + encodeURIComponent(pf.fileName)), 'Item', (b) => {
    const code = validGtin(pick(b, 'ItemCode')), price = +pick(b, 'ItemPrice');
    if (!code || !(price > 0)) return;
    const qty = pick(b, 'Quantity'), uq = unxml(pick(b, 'UnitQty'));
    rows.set(code, [code, unxml(pick(b, 'ItemName') || pick(b, 'ItemNm')).slice(0, 120), Math.round(price * 100) / 100, qty && uq ? (String(+qty) + ' ' + uq).slice(0, 30) : '']);
  });
  return { ok: true, file: pf.fileName, rows: [...rows.values()] };
}

// Town coordinates from the places table; a few unknown towns are looked up each run.
async function townCoords(env, cities) {
  const out = {}, list = [...new Set(cities.filter(Boolean))];
  for (let i = 0; i < list.length; i += 90) {
    const part = list.slice(i, i + 90);
    for (const r of (await env.DB.prepare('SELECT city, lat, lon FROM places WHERE city IN (' + part.map(() => '?').join(',') + ')').bind(...part).all()).results) out[r.city] = r;
  }
  let looked = 0;
  for (const c of list) {
    if (c in out || looked >= 8) continue;
    looked++;
    try {
      const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=he&countryCode=IL&name=' + encodeURIComponent(c), { signal: AbortSignal.timeout(8000) });
      const g = ((await r.json()).results || [])[0];
      out[c] = { city: c, lat: g ? Math.round(g.latitude * 1e4) / 1e4 : null, lon: g ? Math.round(g.longitude * 1e4) / 1e4 : null };
      await env.DB.prepare('INSERT INTO places (city,lat,lon,ts) VALUES (?,?,?,?) ON CONFLICT(city) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, ts=excluded.ts').bind(c, out[c].lat, out[c].lon, Date.now()).run();
    } catch { /* try again next run */ }
  }
  return out;
}
async function run(env, stmts) {
  if (env.DB.batch) { for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200)); } else for (const s of stmts) await s.run();
}
async function saveBranches(env, cfg, stores, ts) {
  const where = await townCoords(env, stores.map((s) => s.city));
  const stmts = [];
  for (let i = 0; i < stores.length; i += 9) {
    const part = stores.slice(i, i + 9);
    stmts.push(env.DB.prepare('INSERT INTO branches (sid,chain,label,store_id,name,city,address,lat,lon,ts) VALUES ' + part.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')
      + ' ON CONFLICT(sid) DO UPDATE SET label=excluded.label, name=excluded.name, city=excluded.city, address=excluded.address, lat=excluded.lat, lon=excluded.lon, ts=excluded.ts')
      .bind(...part.flatMap((s) => { const w = where[s.city] || {}; return [sidOf(cfg.slug, s.id), cfg.slug, cfg.label, String(s.id), s.name.slice(0, 80), s.city.slice(0, 40), s.address.slice(0, 100), w.lat ?? null, w.lon ?? null, ts]; })));
  }
  await run(env, stmts);
}

// Replace a branch's prices; D1 allows 100 bound values per statement, so 12 rows each.
export async function savePrices(env, sid, rows, ts) {
  const stmts = [env.DB.prepare('DELETE FROM sprices WHERE sid=?').bind(sid)];
  for (let i = 0; i < rows.length; i += 12) {
    const part = rows.slice(i, i + 12);
    stmts.push(env.DB.prepare('INSERT INTO sprices (sid,code,name,price,unit,promo,pprice,ts) VALUES ' + part.map(() => "(?,?,?,?,?,'',NULL,?)").join(','))
      .bind(...part.flatMap((r) => [sid, r[0], r[1], r[2], r[3], ts])));
  }
  await run(env, stmts);
}

// Branch lists of the Laib chains, and prices for their default branch and the ones households picked.
export async function refreshLaib(env, where, wanted = []) {
  useRelay(env);
  const ts = Date.now(), status = { ts, where, chains: {}, stores: {} }, defaults = [];
  for (const cfg of LAIB) {
    try {
      const { files, stores } = await laibFiles(cfg);
      await saveBranches(env, cfg, stores, ts);
      status.chains[cfg.label] = { ok: true, branches: stores.length };
      const def = cfg.keys.length ? stores.find((s) => cfg.keys.some((k) => s.text.includes(k))) : null;
      if (def) defaults.push(sidOf(cfg.slug, def.id));
      const targets = [...new Set([def ? sidOf(cfg.slug, def.id) : null, ...wanted.filter((s) => s.startsWith(cfg.slug + ':'))].filter(Boolean))].slice(0, PER_CHAIN);
      for (const sid of targets) {
        const store = stores.find((s) => sidOf(cfg.slug, s.id) === sid);
        if (!store) { status.stores[sid] = { ok: false, error: 'branch not in the Stores file' }; continue; }
        try {
          const r = await fetchStorePrices(cfg, files, store);
          if (r.ok && r.rows.length) { await savePrices(env, sid, r.rows, ts); status.stores[sid] = { ok: true, count: r.rows.length, store: store.text.slice(0, 120), file: r.file }; }
          else status.stores[sid] = { ok: false, error: r.error || 'no barcoded items' };
        } catch (e) { status.stores[sid] = { ok: false, error: String((e && (e.name + ': ' + e.message)) || e).slice(0, 200) }; }
      }
    } catch (e) { status.chains[cfg.label] = { ok: false, error: String((e && (e.name + ': ' + e.message)) || e).slice(0, 200) }; }
  }
  status.ok = Object.values(status.chains).some((c) => c.ok);
  if (defaults.length) await env.DB.prepare("INSERT INTO kv (k,v) VALUES ('prices:laib-defaults',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(defaults)).run();
  await env.DB.prepare("INSERT INTO kv (k,v) VALUES ('prices:laib',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(status)).run();
  return status;
}
