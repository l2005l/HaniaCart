// Optional Hania360 account (Hania Pass). HaniaCart never requires it: a household is
// still just its key. When the person is signed in to Hania Pass, they can save the
// household in their account and get it back on another phone by signing in there.
//
// Who is signed in is asked of Hania Pass itself, over a Service Binding (env.PASS),
// with the browser's own cookie. With no binding the feature is simply off.

import { hhKey } from './worker.js';

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
