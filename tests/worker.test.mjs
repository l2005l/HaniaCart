import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dueText, ilNow } from '../src/push.js';
import { gzipSync } from 'node:zlib';
import { validGtin } from '../src/laib.js';
import worker, { gtin14, clean, cleanScan, scanPrompt, mealPrompt, looseJson, runReminders, cleanup } from '../src/worker.js';

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) db.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const stmt = (sql, args) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { prepare: (sql) => stmt(sql, []), raw: db };
}
const HH = 'a'.repeat(30), HH2 = 'b'.repeat(30);
const call = (env, method, path, { hh, body } = {}) => {
  const headers = {}; if (hh) headers['x-hh'] = hh;
  return worker.fetch(new Request('https://cart.test' + path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env);
};
const sync = async (env, hh, since = 0) => (await call(env, 'GET', '/api/sync?since=' + since, { hh })).json();
const put = (env, hh, ops) => call(env, 'POST', '/api/sync', { hh, body: { ops } });

test('a household needs its key', async () => {
  const env = { DB: fakeD1() };
  assert.equal((await call(env, 'GET', '/api/sync')).status, 400);
  assert.equal((await call(env, 'GET', '/api/sync', { hh: 'short' })).status, 400);
});

test('rows written by one phone reach the other, and households stay apart', async () => {
  const env = { DB: fakeD1() };
  assert.equal((await put(env, HH, [{ kind: 'list', id: 'l1abc', data: { name: 'חלב', qty: 2, cat: 'dairy' } }])).status, 200);
  const a = await sync(env, HH);
  assert.equal(a.rows.length, 1); assert.equal(a.rows[0].data.name, 'חלב'); assert.equal(a.rows[0].data.qty, 2);
  assert.equal((await sync(env, HH2)).rows.length, 0);
});

test('a deletion travels as a tombstone to phones that already synced', async () => {
  const env = { DB: fakeD1() };
  await put(env, HH, [{ kind: 'item', id: 'i1abc', data: { name: 'ביצים', qty: 12, cat: 'eggs', loc: 'fridge' } }]);
  const first = await sync(env, HH);
  await put(env, HH, [{ kind: 'item', id: 'i1abc', data: null }]);
  const next = await sync(env, HH, first.now);
  assert.equal(next.rows.length, 1); assert.equal(next.rows[0].del, true);
  assert.equal((await sync(env, HH)).rows.length, 0, 'a fresh phone does not get deleted rows');
  await put(env, HH, [{ kind: 'item', id: 'i1abc', data: { name: 'ביצים', qty: 12 } }]);
  assert.equal((await sync(env, HH)).rows.length, 1, 'undo brings the row back');
});

test('rows are cleaned to their shape', () => {
  const it = clean('item', { name: '  גבינה  ', qty: 5000, cat: 'nope', loc: 'roof', exp: '2026-13-40', price: -3, extra: 'x' });
  assert.deepEqual(Object.keys(it).sort(), ['added', 'by', 'cat', 'est', 'exp', 'loc', 'minq', 'name', 'opened', 'price', 'qty', 'staple']);
  assert.equal(it.name, 'גבינה'); assert.equal(it.qty, 999); assert.equal(it.cat, 'other'); assert.equal(it.loc, 'pantry'); assert.equal(it.exp, null); assert.equal(it.price, null);
  assert.equal(clean('list', { name: '' }), null);
  assert.deepEqual(clean('fav', { name: 'טחינה', cat: 'dry', added: 5, junk: 1 }), { name: 'טחינה', cat: 'dry', added: 5, photo: '', desc: '', code: '' });
  assert.equal(clean('plan', { meals: [{ dish: 'שקשוקה', uses: ['ביצים'], missing: [] }, { dish: '' }] }).meals.length, 1);
});

test('bad ops are skipped and a request has a size limit', async () => {
  const env = { DB: fakeD1() };
  const r = await (await put(env, HH, [{ kind: 'secret', id: 'x1234', data: {} }, { kind: 'list', id: '../x', data: { name: 'a' } }, { kind: 'list', id: 'ok1234', data: { name: 'לחם' } }])).json();
  assert.equal(r.skipped, 2);
  assert.equal((await put(env, HH, Array.from({ length: 201 }, (_, i) => ({ kind: 'list', id: 'id' + i + 'xx', data: { name: 'a' } })))).status, 400);
});

test('scan answers are cleaned and need an AI', async () => {
  const env = { DB: fakeD1() };
  const img = { mode: 'receipt', image: 'QUJD', type: 'image/jpeg' };
  assert.equal((await call(env, 'POST', '/api/scan', { hh: HH, body: img })).status, 503);
  env.AI = { run: async (model, input) => { assert.match(model, /vision|scout/); assert.equal(input.messages[0].content[1].type, 'image_url');
    return { response: '```json\n{"store":"שופרסל","date":"2026-10-12","total":"123.4","items":[{"name":"חלב 3%","qty":2,"price":13.8,"cat":"dairy","loc":"fridge","shelfDays":7},{"name":""}]}\n```' }; } };
  const r = await (await call(env, 'POST', '/api/scan', { hh: HH, body: img })).json();
  assert.equal(r.store, 'שופרסל'); assert.equal(r.total, 123.4); assert.equal(r.items.length, 1); assert.equal(r.items[0].shelfDays, 7);
  assert.deepEqual(cleanScan('date', { date: '2026-02-30x' }), { date: null });
  assert.match(scanPrompt('receipt', '2026-10-12'), /receipt/);
});

test('Claude is used when its key is set', async () => {
  const env = { DB: fakeD1(), ANTHROPIC_KEY: 'k' };
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, o) => { assert.match(String(u), /anthropic/); const b = JSON.parse(o.body); assert.equal(b.messages[0].content[0].type, 'image');
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"date":"2026-11-30"}' }] })); };
  try { assert.deepEqual(await (await call(env, 'POST', '/api/scan', { hh: HH, body: { mode: 'date', image: 'QUJD' } })).json(), { date: '2026-11-30' }); }
  finally { globalThis.fetch = orig; }
});

test('a household is limited in scans per day', async () => {
  const env = { DB: fakeD1(), HH_DAILY_SCANS: '2', AI: { run: async () => ({ response: '{"items":[]}' }) } };
  const b = { mode: 'shelf', image: 'QUJD' };
  for (let i = 0; i < 2; i++) assert.equal((await call(env, 'POST', '/api/scan', { hh: HH, body: b })).status, 200);
  assert.equal((await call(env, 'POST', '/api/scan', { hh: HH, body: b })).status, 429);
});

test('meal plans come back cleaned', async () => {
  const env = { DB: fakeD1(), AI: { run: async (m, i) => { assert.match(i.messages[0].content, /חזה עוף/); return { response: { meals: [{ dish: 'עוף בתנור', uses: ['חזה עוף'], missing: ['לימון'], how: 'אופים.' }] } }; } } };
  const r = await (await call(env, 'POST', '/api/meals', { hh: HH, body: { count: 3, people: 2, urgent: ['חזה עוף'], have: ['אורז'] } })).json();
  assert.equal(r.meals[0].dish, 'עוף בתנור'); assert.deepEqual(r.meals[0].missing, ['לימון']);
  assert.match(mealPrompt({ count: 99 }), /Plan 7 /);
});

test('the morning message names what spoils and what ran out', () => {
  const day = '2026-10-12';
  assert.equal(dueText([{ name: 'אורז', qty: 1, exp: '2027-01-01' }], day), null);
  const m = dueText([{ name: 'חלב', qty: 1, exp: '2026-10-12' }, { name: 'יוגורט', qty: 2, exp: '2026-10-10' }, { name: 'ביצים', qty: 0, staple: true, minq: 1 }], day);
  assert.match(m.body, /חלב \(היום\)/); assert.match(m.body, /פג תוקף: יוגורט/); assert.match(m.body, /חסר בבית: ביצים/);
});

test('reminders go out once a day at the chosen hour', async () => {
  const env = { DB: fakeD1() };
  const now = Date.parse('2026-10-12T06:10:00Z'); // 09:10 in Israel
  await put(env, HH, [{ kind: 'item', id: 'i1abc', data: { name: 'חלב', qty: 1, exp: ilNow(now).day } }]);
  env.DB.raw.prepare("INSERT INTO push_subs (id,endpoint,hh,hour,ts) VALUES ('s1','https://fcm.googleapis.com/x',?,9,0)").run(HH);
  const orig = globalThis.fetch; let woke = 0;
  globalThis.fetch = async () => { woke++; return new Response('', { status: 201 }); };
  try {
    assert.equal(await runReminders(env, now), 1);
    assert.equal(await runReminders(env, now), 0);
    assert.equal(woke, 1);
    assert.match(JSON.parse(env.DB.raw.prepare("SELECT msg FROM push_subs WHERE id='s1'").get().msg).body, /חלב/);
  } finally { globalThis.fetch = orig; }
});

test('cleanup forgets old tombstones', async () => {
  const env = { DB: fakeD1() };
  env.DB.raw.prepare("INSERT INTO rows (hh,kind,id,data,upd,del) VALUES (?,'list','old1x','{}',0,1)").run(HH);
  await cleanup(env, Date.now());
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM rows').get().c, 0);
});

test('a product photo is stored, described, served and replaced', async () => {
  const env = { DB: fakeD1(), AI: { run: async () => ({ response: '{"name":"קמח כוסמין","desc":"קמח כוסמין 80%, זהב, 1 ק״ג"}' }) } };
  const img = Buffer.from('fake-jpeg-bytes').toString('base64');
  const r = await (await call(env, 'POST', '/api/photo', { hh: HH, body: { image: img, describe: true } })).json();
  assert.match(r.id, /^p/); assert.match(r.desc, /זהב/); assert.equal(r.name, 'קמח כוסמין');
  const got = await call(env, 'GET', '/api/photo/' + HH + '/' + r.id);
  assert.equal(got.status, 200); assert.equal(Buffer.from(await got.arrayBuffer()).toString(), 'fake-jpeg-bytes');
  assert.equal((await call(env, 'GET', '/api/photo/' + HH2 + '/' + r.id)).status, 404, 'another household cannot read it');
  const r2 = await (await call(env, 'POST', '/api/photo', { hh: HH, body: { image: img, replace: r.id } })).json();
  assert.equal((await call(env, 'GET', '/api/photo/' + HH + '/' + r.id)).status, 404, 'the replaced photo is gone');
  assert.equal(r2.desc, '');
  assert.deepEqual(clean('fav', { name: 'קמח', photo: r2.id, desc: 'x' }).photo, r2.id);
});

test('prices are found by barcode and by name words', async () => {
  const env = { DB: fakeD1() };
  const ins = env.DB.raw.prepare('INSERT INTO prices (chain,code,store,name,price,unit,promo,pprice,ts) VALUES (?,?,?,?,?,?,?,?,?)');
  ins.run('רמי לוי', '07290000000017', 'פארק נועם', 'קמח כוסמין 80% זהב 1 ק"ג', 14.9, '', '', null, 1);
  ins.run('ויקטורי', '07290000000017', 'נתיבות', 'קמח כוסמין זהב', 16.5, '', '2 ב-30', 15, 1);
  ins.run('ויקטורי', '07290000000024', 'נתיבות', 'קמח לבן', 4.9, '', '', null, 1);
  assert.equal(gtin14('7290000000017'), '07290000000017'); assert.equal(gtin14('abc'), '');
  const r = await (await call(env, 'GET', '/api/prices?codes=7290000000017,1', { hh: HH })).json();
  assert.deepEqual(r.prices['07290000000017'].map((x) => x.chain), ['רמי לוי', 'ויקטורי']);
  const s = await (await call(env, 'GET', '/api/prices/search?q=' + encodeURIComponent('כוסמין קמח'), { hh: HH })).json();
  assert.equal(s.results.length, 1); assert.equal(s.results[0].chains, 2); assert.equal(s.results[0].min, 14.9);
  assert.equal((await call(env, 'GET', '/api/prices?codes=1')).status, 400, 'needs a household');
  assert.equal(clean('fav', { name: 'קמח', code: '7290000000017' }).code, '07290000000017');
});

test('Victory and Hyper Cohen are read from the Laib portal when the app asks', async () => {
  const env = { DB: fakeD1() };
  const stores = gzipSync(Buffer.from('<?xml version="1.0" encoding="utf-8"?><Root><Stores><Store><StoreId>7</StoreId><StoreName>אשקלון</StoreName><City>אשקלון</City></Store><Store><StoreId>21</StoreId><StoreName>נתיבות</StoreName><City>נתיבות</City></Store></Stores></Root>'));
  const items = '<Items>' + '<Item><ItemCode>7290000000015</ItemCode><ItemName>קמח כוסמין &quot;זהב&quot;</ItemName><ItemPrice>16.40</ItemPrice><Quantity>1.00</Quantity><UnitQty>קילו</UnitQty></Item>'
    + '<Item><ItemCode>1234</ItemCode><ItemName>עגבניות</ItemName><ItemPrice>5.9</ItemPrice></Item>'
    + '<Item><ItemCode>7290000000018</ItemCode><ItemName>בדיקת ספרה שגויה</ItemName><ItemPrice>3</ItemPrice></Item></Items>';
  const price = gzipSync(Buffer.from('<root>' + items.repeat(1) + '</root>'));
  const orig = globalThis.fetch, seen = [];
  globalThis.fetch = async (u) => {
    u = String(u); seen.push(u);
    if (u.includes('getfiles')) return new Response(JSON.stringify([
      { fileName: 'Stores7290696200003-000-202610130500.xml.gz', fileDate: '2026-10-13 05:00:00' },
      { fileName: 'PriceFull7290696200003-001-007-20261013-050000.xml.gz', branchNumber: '007', fileDate: '2026-10-13 05:00:00' },
      { fileName: 'PriceFull7290696200003-001-021-20261013-050000.xml.gz', branchNumber: '021', fileDate: '2026-10-13 05:00:00' }]));
    if (u.includes('Stores')) return new Response(stores);
    if (u.includes('-021-')) return new Response(price);
    return new Response('nope', { status: 404 });
  };
  try {
    const r = await (await call(env, 'POST', '/api/prices/refresh', { hh: HH })).json();
    assert.equal(r.ran, true); assert.equal(r.status.chains['ויקטורי'].count, 1);
    const row = env.DB.raw.prepare("SELECT * FROM prices WHERE chain='ויקטורי'").get();
    assert.equal(row.code, '07290000000015'); assert.equal(row.name, 'קמח כוסמין "זהב"'); assert.equal(row.price, 16.4); assert.equal(row.unit, '1 קילו');
    assert.ok(!seen.some((u) => u.includes('-007-')), 'only the Netivot store is downloaded');
    assert.equal((await (await call(env, 'POST', '/api/prices/refresh', { hh: HH })).json()).ran, false, 'not again while fresh');
    assert.equal(validGtin('7290000000018'), '');
  } finally { globalThis.fetch = orig; }
});

test('looseJson finds the object inside prose', () => {
  assert.deepEqual(looseJson('הנה: {"a":1} תודה'), { a: 1 });
  assert.equal(looseJson('nothing'), null);
});

/* ---- optional Hania360 account (Hania Pass) ---- */
const CART = 'https://cart.test';
const fakePass = (user) => ({
  calls: 0,
  async fetch(url, init) {
    this.calls++;
    const cookie = (init && init.headers && init.headers.cookie) || '';
    const ok = user && cookie.includes('hp_session=good');
    return new Response(JSON.stringify(ok ? { signedIn: true, user } : { signedIn: false }), { headers: { 'content-type': 'application/json' } });
  },
});
const acc = (env, method, path, { hh, cookie, origin } = {}) => {
  const headers = {}; if (hh) headers['x-hh'] = hh; if (cookie) headers.cookie = cookie; if (origin) headers.origin = origin;
  if (method === 'POST') headers['content-type'] = 'application/json';
  return worker.fetch(new Request(CART + path, { method, headers, body: method === 'POST' ? '{}' : undefined }), env);
};
const LIOR = { id: 'user-lior', email: 'lior@example.com' };

test('without Hania Pass the account feature is simply off', async () => {
  const env = { DB: fakeD1() };
  assert.deepEqual(await (await acc(env, 'GET', '/api/account', { hh: HH })).json(), { available: false });
  assert.equal((await acc(env, 'POST', '/api/account/link', { hh: HH, cookie: 'hp_session=good', origin: CART })).status, 404);
});

test('signed out: available but nothing to show, and Hania Pass is not even asked without a cookie', async () => {
  const PASS = fakePass(LIOR), env = { DB: fakeD1(), PASS };
  assert.deepEqual(await (await acc(env, 'GET', '/api/account', { hh: HH })).json(), { available: true, signedIn: false });
  assert.equal(PASS.calls, 0);
  assert.equal((await acc(env, 'POST', '/api/account/link', { hh: HH, cookie: 'hp_session=bad', origin: CART })).status, 401);
});

test('a signed-in person saves the household and gets it back on a new phone', async () => {
  const env = { DB: fakeD1(), PASS: fakePass(LIOR) }, cookie = 'hp_session=good';
  assert.equal((await acc(env, 'POST', '/api/account/link', { hh: HH, cookie, origin: CART })).status, 200);
  assert.equal((await acc(env, 'POST', '/api/account/link', { hh: HH, cookie, origin: CART })).status, 200, 'linking twice is fine');
  const here = await (await acc(env, 'GET', '/api/account', { hh: HH, cookie })).json();
  assert.equal(here.linked, true); assert.equal(here.email, 'lior@example.com'); assert.deepEqual(here.households, [HH]);
  // A new phone has its own fresh key; the account offers the saved one.
  const fresh = await (await acc(env, 'GET', '/api/account', { hh: HH2, cookie })).json();
  assert.equal(fresh.linked, false); assert.deepEqual(fresh.households, [HH]);
  assert.equal((await acc(env, 'POST', '/api/account/unlink', { hh: HH, cookie, origin: CART })).status, 200);
  assert.deepEqual((await (await acc(env, 'GET', '/api/account', { hh: HH, cookie })).json()).households, []);
});

test('another person never sees your households', async () => {
  const db = fakeD1();
  await acc({ DB: db, PASS: fakePass(LIOR) }, 'POST', '/api/account/link', { hh: HH, cookie: 'hp_session=good', origin: CART });
  const other = await (await acc({ DB: db, PASS: fakePass({ id: 'user-other', email: 'o@example.com' }) }, 'GET', '/api/account', { hh: HH2, cookie: 'hp_session=good' })).json();
  assert.deepEqual(other.households, []);
});

test('changes need HaniaCart\'s own page and a household key', async () => {
  const env = { DB: fakeD1(), PASS: fakePass(LIOR) }, cookie = 'hp_session=good';
  assert.equal((await acc(env, 'POST', '/api/account/link', { hh: HH, cookie, origin: 'https://evil.example' })).status, 403);
  assert.equal((await acc(env, 'POST', '/api/account/link', { hh: HH, cookie })).status, 403);
  assert.equal((await acc(env, 'POST', '/api/account/link', { cookie, origin: CART })).status, 400);
});

test('a household that is cleaned up also leaves the accounts', async () => {
  const env = { DB: fakeD1(), PASS: fakePass(LIOR) };
  await acc(env, 'POST', '/api/account/link', { hh: HH, cookie: 'hp_session=good', origin: CART });
  env.DB.raw.prepare('INSERT INTO hh (id,created,seen) VALUES (?,?,?)').run(HH, 0, 0);
  await cleanup(env, Date.now());
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM account_hh').get().n, 0);
});

test('production talks to Hania Pass; staging to Hania Pass staging', () => {
  const cfg = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const parsed = JSON.parse(cfg.replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(parsed.services, [{ binding: 'PASS', service: 'hania-pass' }]);
  assert.deepEqual(parsed.env.staging.services, [{ binding: 'PASS', service: 'hania-pass-staging' }]);
  assert.equal(parsed.env.staging.d1_databases[0].database_name, 'haniacart-staging');
  assert.deepEqual(parsed.env.staging.triggers.crons, []);
});

/* ---- Hania Today summary ---- */
import { summarize, summaryCors } from '../src/account.js';

test('the summary lists what expires soon, what ran out, and the open list, never the key', async () => {
  const env = { DB: fakeD1(), PASS: fakePass(LIOR) }, cookie = 'hp_session=good';
  const today = new Date().toISOString().slice(0, 10), far = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  await put(env, HH, [
    { kind: 'item', id: 'milk1', data: { name: 'חלב', qty: 1, exp: today } },
    { kind: 'item', id: 'rice1', data: { name: 'אורז', qty: 2, exp: far } },
    { kind: 'item', id: 'eggs1', data: { name: 'ביצים', qty: 0, staple: true, minq: 1 } },
    { kind: 'list', id: 'list1', data: { name: 'לחם', qty: 1 } },
    { kind: 'list', id: 'list2', data: { name: 'גבינה', qty: 1, done: true } },
  ]);
  await acc(env, 'POST', '/api/account/link', { hh: HH, cookie, origin: CART });
  const res = await worker.fetch(new Request(CART + '/api/account/summary', { headers: { cookie, origin: 'https://pass.hania360.com' } }), env);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://pass.hania360.com');
  assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  const body = await res.json(), text = JSON.stringify(body);
  assert.equal(body.homes.length, 1);
  assert.deepEqual(body.homes[0].expiring.map((e) => e.name), ['חלב']);
  assert.deepEqual(body.homes[0].out, ['ביצים']);
  assert.equal(body.homes[0].listOpen, 1);
  assert.ok(!text.includes(HH), 'the household key never leaves');
});

test('the summary is only readable by Hania360 sites, and signed out shows nothing', async () => {
  assert.equal(summaryCors('https://evil.example'), null);
  assert.equal(summaryCors('http://pass.hania360.com'), null);
  assert.ok(summaryCors('https://hania-pass-staging.lior-hania.workers.dev'));
  const env = { DB: fakeD1(), PASS: fakePass(LIOR) };
  const res = await worker.fetch(new Request(CART + '/api/account/summary', { headers: { origin: 'https://evil.example', cookie: 'hp_session=good' } }), env);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  const out = await (await worker.fetch(new Request(CART + '/api/account/summary'), env)).json();
  assert.deepEqual(out, { available: true, signedIn: false });
});

test('summarize ignores items without dates and far-off dates', () => {
  const now = Date.parse('2026-10-14T09:00:00Z');
  const s = summarize([
    { kind: 'item', data: JSON.stringify({ name: 'a', qty: 1 }) },
    { kind: 'item', data: JSON.stringify({ name: 'b', qty: 1, exp: '2026-10-13' }) },
    { kind: 'item', data: JSON.stringify({ name: 'c', qty: 1, exp: '2026-10-17' }) },
    { kind: 'item', data: JSON.stringify({ name: 'd', qty: 1, exp: '2026-10-18' }) },
    { kind: 'item', data: 'not json' },
  ], now);
  assert.deepEqual(s.expiring, [{ name: 'b', exp: '2026-10-13', past: true }, { name: 'c', exp: '2026-10-17', past: false }]);
});

test('Hania Today adds to the shopping list of the saved household, once per name', async () => {
  const env = { DB: fakeD1(), PASS: fakePass(LIOR) }, cookie = 'hp_session=good';
  await put(env, HH, [{ kind: 'list', id: 'list1', data: { name: 'חלב', qty: 1 } }]);
  await acc(env, 'POST', '/api/account/link', { hh: HH, cookie, origin: CART });
  const add = (items, origin = 'https://today.hania360.com', c = cookie) => worker.fetch(new Request(CART + '/api/account/list', { method: 'POST', headers: { cookie: c, origin, 'content-type': 'application/json' }, body: JSON.stringify({ items }) }), env);
  const r = await add(['חלב', 'ביצים', ' ביצים ', 'לחם']);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://today.hania360.com');
  assert.deepEqual(await r.json(), { ok: true, added: 2, skipped: 2 });
  const sync = await (await call(env, 'GET', '/api/sync?since=0', { hh: HH })).json();
  const names = sync.rows.filter((x) => x.kind === 'list').map((x) => x.data.name).sort();
  assert.deepEqual(names, ['ביצים', 'חלב', 'לחם']);
  assert.equal((await add(['x'], 'https://evil.example')).status, 403);
  assert.equal((await add(['x'], 'https://today.hania360.com', '')).status, 401);
});
