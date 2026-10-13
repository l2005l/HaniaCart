import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dueText, ilNow } from '../src/push.js';
import worker, { clean, cleanScan, scanPrompt, mealPrompt, looseJson, runReminders, cleanup } from '../src/worker.js';

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
  assert.deepEqual(clean('fav', { name: 'טחינה', cat: 'dry', added: 5, junk: 1 }), { name: 'טחינה', cat: 'dry', added: 5, photo: '', desc: '' });
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

test('looseJson finds the object inside prose', () => {
  assert.deepEqual(looseJson('הנה: {"a":1} תודה'), { a: 1 });
  assert.equal(looseJson('nothing'), null);
});
