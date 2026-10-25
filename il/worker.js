// haniacart-il: fetches the chain price portals that only answer from Israel (Victory, Hyper Cohen,
// Mahsanei HaShuk on laibcatalog.co.il; Carrefour). Placement keeps it in a Cloudflare data center
// next to AWS il-central-1 (Tel Aviv). It has no public address: only the haniacart Worker calls it,
// through a service binding, with the target URL in x-target.
const HOSTS = ['laibcatalog.co.il', 'prices.carrefour.co.il'];

export default {
  async fetch(req) {
    const colo = (req.cf && req.cf.colo) || '';
    let target;
    try { target = new URL(req.headers.get('x-target') || ''); } catch { return new Response('bad target', { status: 400 }); }
    if (target.protocol !== 'https:' || !HOSTS.includes(target.hostname)) return new Response('host not allowed', { status: 403 });
    const headers = new Headers();
    for (const [k, v] of req.headers) if (!/^(x-target|x-il-token|host|cf-|x-forwarded|content-length)/i.test(k)) headers.set(k, v);
    if (!headers.has('user-agent')) headers.set('user-agent', 'Mozilla/5.0 HaniaCart (+https://cart.hania360.com)');
    const r = await fetch(target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body, redirect: 'follow' });
    const out = new Response(r.body, r);
    out.headers.set('x-il-colo', colo);
    return out;
  },
};
