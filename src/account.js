// Optional Hania360 account (Hania Pass). HaniaCart never requires it: a household is
// still just its key. When the person is signed in to Hania Pass, they can save the
// household in their account and get it back on another phone by signing in there.
//
// Who is signed in is asked of Hania Pass itself, over a Service Binding (env.PASS),
// with the browser's own cookie. With no binding the feature is simply off.

import { hhKey, clean } from './worker.js';

const MAX_HOUSEHOLDS = 10;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/** The signed-in Hania Pass user for this request, or null. Undefined when the feature is off. */
export async function passUser(req, env) {
  if (!env.PASS) return undefined;
  const cookie = req.headers.get('cookie') || '';
  if (!/(^|;\s*)hp_session=/.test(cookie)) return null;
  try {
    const res = await env.PASS.fetch('https://pass.internal/api/session', { headers: { cookie } });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.signedIn && data.user && typeof data.user.id === 'string' ? { id: data.user.id, email: String(data.user.email || '') } : null;
  } catch {
    return null;
  }
}

// Changes must come from HaniaCart's own page: a cookie alone is not enough.
const sameOrigin = (req) => req.headers.get('origin') === new URL(req.url).origin;

async function households(env, userId) {
  return (await env.DB.prepare('SELECT hh FROM account_hh WHERE user_id=? ORDER BY created').bind(userId).all()).results.map((r) => r.hh);
}

export async function getAccount(req, env) {
  const user = await passUser(req, env);
  if (user === undefined) return json({ available: false });
  if (!user) return json({ available: true, signedIn: false });
  const list = await households(env, user.id);
  const hh = hhKey(req);
  return json({ available: true, signedIn: true, email: user.email, linked: !!hh && list.includes(hh), households: list });
}

export async function linkAccount(req, env) {
  if (!sameOrigin(req)) return json({ error: 'origin' }, 403);
  const hh = hhKey(req); if (!hh) return json({ error: 'household' }, 400);
  const user = await passUser(req, env);
  if (user === undefined) return json({ error: 'unavailable' }, 404);
  if (!user) return json({ error: 'signed_out' }, 401);
  const list = await households(env, user.id);
  if (!list.includes(hh)) {
    if (list.length >= MAX_HOUSEHOLDS) return json({ error: 'too_many' }, 409);
    await env.DB.prepare('INSERT INTO account_hh (user_id,hh,created) VALUES (?,?,?) ON CONFLICT(user_id,hh) DO NOTHING').bind(user.id, hh, Date.now()).run();
  }
  return json({ ok: true, linked: true });
}

export async function unlinkAccount(req, env) {
  if (!sameOrigin(req)) return json({ error: 'origin' }, 403);
  const hh = hhKey(req); if (!hh) return json({ error: 'household' }, 400);
  const user = await passUser(req, env);
  if (user === undefined) return json({ error: 'unavailable' }, 404);
  if (!user) return json({ error: 'signed_out' }, 401);
  await env.DB.prepare('DELETE FROM account_hh WHERE user_id=? AND hh=?').bind(user.id, hh).run();
  return json({ ok: true, linked: false });
}

/* ---- Hania Today: a short summary of the households saved in the account ---- */
// Read by the Hania Today page (Hania Pass) from the browser, with the shared cookie.
// Never returns household keys: a key is the household itself.

const DAY = 864e5;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

/** Only https Hania360 sites (and the staging workers.dev sites) may read the summary. */
export function summaryCors(origin) {
  if (!origin) return null;
  let u; try { u = new URL(origin); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const h = u.hostname;
  const ok = h === 'hania360.com' || h.endsWith('.hania360.com') || h.endsWith('.lior-hania.workers.dev');
  return ok ? { 'access-control-allow-origin': u.origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } : null;
}

export function summarize(rows, now = Date.now()) {
  const today = isoDay(now), soon = isoDay(now + 3 * DAY);
  const expiring = [], out = []; let listOpen = 0;
  for (const r of rows) {
    let d; try { d = JSON.parse(r.data); } catch { continue; }
    if (r.kind === 'list' && !d.done) listOpen++;
    if (r.kind !== 'item') continue;
    if (d.staple && (d.qty || 0) <= 0) { out.push(d.name); continue; }
    if (d.exp && d.exp <= soon && (d.qty || 0) > 0) expiring.push({ name: d.name, exp: d.exp, past: d.exp < today });
  }
  expiring.sort((a, b) => (a.exp < b.exp ? -1 : a.exp > b.exp ? 1 : 0));
  return { expiring: expiring.slice(0, 8), expiringCount: expiring.length, out: out.slice(0, 8), outCount: out.length, listOpen };
}

export async function accountSummary(req, env) {
  const cors = summaryCors(req.headers.get('origin'));
  const reply = (body, status = 200) => { const r = json(body, status); if (cors) for (const [k, v] of Object.entries(cors)) r.headers.set(k, v); return r; };
  const user = await passUser(req, env);
  if (user === undefined) return reply({ available: false });
  if (!user) return reply({ available: true, signedIn: false });
  const keys = await households(env, user.id);
  const homes = [];
  for (const hh of keys) {
    const rows = (await env.DB.prepare("SELECT kind,data FROM rows WHERE hh=? AND del=0 AND kind IN ('item','list')").bind(hh).all()).results;
    homes.push(summarize(rows));
  }
  return reply({ available: true, signedIn: true, homes });
}

export function summaryPreflight(req) {
  const cors = summaryCors(req.headers.get('origin'));
  return new Response(null, { status: 204, headers: cors ? { ...cors, 'access-control-allow-methods': 'GET', 'access-control-max-age': '600' } : {} });
}

/* ---- Hania Today: quick add to the shopping list ---- */
// Hania Today (another Hania360 site) adds items to the list of the first household saved in
// the account, with the shared cookie. Only Hania360 sites may ask (CORS + JSON preflight).

export async function accountListAdd(req, env) {
  const cors = summaryCors(req.headers.get('origin'));
  const reply = (body, status = 200) => { const r = json(body, status); if (cors) for (const [k, v] of Object.entries(cors)) r.headers.set(k, v); return r; };
  if (!cors) return reply({ error: 'origin' }, 403);
  if (!/^application\/json/.test(req.headers.get('content-type') || '')) return reply({ error: 'json' }, 415);
  const user = await passUser(req, env);
  if (user === undefined) return reply({ error: 'unavailable' }, 404);
  if (!user) return reply({ error: 'signed_out' }, 401);
  const body = await req.json().catch(() => ({}));
  const names = (Array.isArray(body.items) ? body.items : []).map((x) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean).slice(0, 20);
  if (!names.length) return reply({ error: 'items' }, 400);
  const keys = await households(env, user.id);
  const hh = keys[Math.max(0, Math.min(keys.length - 1, Number(body.home) || 0))];
  if (!hh) return reply({ error: 'no_home' }, 409);
  const open = new Set((await env.DB.prepare("SELECT data FROM rows WHERE hh=? AND kind='list' AND del=0").bind(hh).all()).results
    .map((r) => { try { const d = JSON.parse(r.data); return d.done ? '' : String(d.name || '').trim().toLowerCase(); } catch { return ''; } }).filter(Boolean));
  const now = Date.now(), by = String(body.by || 'Hania Today').slice(0, 30), stmts = [];
  let added = 0;
  for (const name of names) {
    if (open.has(name.toLowerCase())) continue;
    open.add(name.toLowerCase());
    const c = clean('list', { name, qty: 1, cat: 'other', done: false, by, added: now });
    if (!c) continue;
    const id = 't' + crypto.randomUUID().replace(/-/g, '').slice(0, 15);
    stmts.push(env.DB.prepare('INSERT INTO rows (hh,kind,id,data,upd,del) VALUES (?,?,?,?,?,0)').bind(hh, 'list', id, JSON.stringify(c), now));
    added++;
  }
  if (stmts.length) { if (env.DB.batch) await env.DB.batch(stmts); else for (const st of stmts) await st.run(); }
  await env.DB.prepare('INSERT INTO hh (id,created,seen) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET seen=excluded.seen').bind(hh, now, now).run();
  return reply({ ok: true, added, skipped: names.length - added });
}

export function listAddPreflight(req) {
  const cors = summaryCors(req.headers.get('origin'));
  return new Response(null, { status: 204, headers: cors ? { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' } : {} });
}
