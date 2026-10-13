// Web push without a payload: the phone is only woken up, then its service worker asks
// /api/push/msg what to show. No message encryption is needed, only the VAPID signature.
// The key pair is made once and kept in D1, so nobody has to handle a secret.

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = new TextEncoder();
const HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

export function okEndpoint(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && u.length <= 800 && HOSTS.some((h) => h.test(x.hostname)); } catch { return false; }
}

export async function vapid(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k='vapid'").first();
  if (row) return JSON.parse(row.v);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const v = { pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
  await env.DB.prepare("INSERT OR IGNORE INTO kv (k,v) VALUES ('vapid',?)").bind(JSON.stringify(v)).run();
  return JSON.parse((await env.DB.prepare("SELECT v FROM kv WHERE k='vapid'").first()).v);
}

export async function vapidHeader(env, endpoint, now = Date.now()) {
  const v = await vapid(env), key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = (o) => b64u(enc.encode(JSON.stringify(o)));
  const body = part({ typ: 'JWT', alg: 'ES256' }) + '.' + part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: 'https://cart.hania360.com' });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(body));
  return 'vapid t=' + body + '.' + b64u(sig) + ', k=' + v.pub;
}

// Wakes the phone. Returns false when the subscription is gone and should be removed.
export async function wake(env, endpoint) {
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { Authorization: await vapidHeader(env, endpoint), TTL: '43200', Urgency: 'normal', 'Content-Length': '0' } });
    return !(r.status === 404 || r.status === 410);
  } catch { return true; }
}

export async function subId(endpoint) {
  return b64u(await crypto.subtle.digest('SHA-256', enc.encode(endpoint))).slice(0, 32);
}

// Israel date and hour, the clock the reminders run on.
export function ilNow(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { day: p.year + '-' + p.month + '-' + p.day, hour: +p.hour };
}

export const dayDiff = (a, b) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 864e5);

// The morning message for a household, or null when nothing needs attention.
// items: cleaned stock rows. Counts what expires within two days and staples below their minimum.
export function dueText(items, day) {
  const soon = [], gone = [], low = [];
  for (const it of items) {
    if (it.exp && it.qty > 0) { const d = dayDiff(it.exp, day); if (d < 0) gone.push(it.name); else if (d <= 2) soon.push([d, it.name]); }
    if (it.staple && it.qty < (it.minq || 1)) low.push(it.name);
  }
  if (!soon.length && !gone.length && !low.length) return null;
  soon.sort((a, b) => a[0] - b[0]);
  const parts = [];
  if (soon.length) parts.push('לאכול בקרוב: ' + soon.slice(0, 4).map(([d, n]) => n + (d === 0 ? ' (היום)' : d === 1 ? ' (מחר)' : '')).join(', ') + (soon.length > 4 ? ' ועוד ' + (soon.length - 4) : ''));
  if (gone.length) parts.push('פג תוקף: ' + gone.slice(0, 3).join(', ') + (gone.length > 3 ? ' ועוד ' + (gone.length - 3) : ''));
  if (low.length) parts.push('חסר בבית: ' + low.slice(0, 3).join(', ') + (low.length > 3 ? ' ועוד ' + (low.length - 3) : ''));
  const n = soon.length + gone.length;
  return {
    title: n ? (n === 1 ? 'מוצר אחד צריך תשומת לב' : n + ' מוצרים צריכים תשומת לב') : 'מוצרי בסיס נגמרים',
    body: parts.join(' · '),
    url: '/#stock',
  };
}
