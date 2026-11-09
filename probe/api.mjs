// HaniaSport: the data behind sport.hania360.com. Three public sources, cached at the edge for a couple of
// minutes and cut down to what the page shows:
//   - Ligat ha'Al (Israeli football): FotMob's league data (table and every fixture of the season);
//   - EuroLeague (Maccabi and Hapoel Tel Aviv): the EuroLeague feeds (games and standings);
//   - the world: FotMob's matches by day for a few big leagues, and the Portland Trail Blazers on ESPN (Deni Avdija's team).
// Nothing personal goes out; "my team" lives only on the phone.

const UA = "Mozilla/5.0 (compatible; HaniaSport/1.0; +https://sport.hania360.com)";
const FOTMOB = "https://www.fotmob.com/api/data";
const EURO = "https://feeds.incrowdsports.com/provider/euroleague-feeds";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports";

// Hebrew names for the teams people here look for. Everything else keeps its own (English) name.
export const HE = {
  10181: "הפועל תל אביב", 7855: "מכבי תל אביב", 9754: "הפועל באר שבע", 8173: "בית״ר ירושלים", 10185: "מכבי חיפה",
  1832: "מכבי נתניה", 8718: "בני סכנין", 8301: "הפועל חיפה", 7929: "מכבי פתח תקווה", 459591: "הפועל ירושלים",
  2095: "עירוני קריית שמונה", 9755: "הפועל פתח תקווה", 89753: "הפועל רמת גן", 543580: "עירוני טבריה",
  8566: "מכבי בני ריינה", 9752: "מ.ס. אשדוד", 4467: "הפועל חדרה", 9758: "בני יהודה",
};
const EURO_HE = { TEL: "מכבי תל אביב", HTA: "הפועל תל אביב" };
const WORLD = { 47: "פרמייר ליג", 87: "לה ליגה", 42: "ליגת האלופות", 55: "סרייה A", 54: "בונדסליגה", 53: "ליג 1", 73: "הליגה האירופית", 127: "ליגת העל" };

const json = (o, s = 200, maxAge = 120) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=" + maxAge, "access-control-allow-origin": "*" } });
async function get(url, ctx, ttl = 120) {
  const cache = typeof caches !== "undefined" ? caches.default : null, key = new Request(url);
  if (cache) { const hit = await cache.match(key); if (hit) return hit.json(); }
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!r.ok) throw new Error(url + " " + r.status);
  const body = await r.text();
  if (cache) { const put = cache.put(key, new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + ttl } })); if (ctx && ctx.waitUntil) ctx.waitUntil(put); }
  return JSON.parse(body);
}
const fm = (t) => ({ id: +t.id, name: HE[+t.id] || t.shortName || t.name });
const fmStatus = (s) => ({ utc: s.utcTime, done: !!s.finished, live: !!s.started && !s.finished && !s.cancelled, off: !!s.cancelled, score: s.scoreStr || "", min: s.liveTime && s.liveTime.short || "" });

async function israel(ctx) {
  const d = await get(FOTMOB + "/leagues?id=127", ctx, 180);
  const t = d.table && d.table[0] && d.table[0].data, rows = t && t.table && t.table.all || [];
  const legend = (t && t.legend || []).map((l) => ({ title: l.title, color: l.color, idx: l.indices }));
  return {
    league: "ליגת העל", season: d.details && d.details.selectedSeason,
    legend: legend.map((l) => ({ he: /playoff|championship/i.test(l.title) ? "פלייאוף עליון" : /relegation/i.test(l.title) ? "פלייאוף תחתון" : l.title, color: l.color, idx: l.idx })),
    table: rows.map((r) => ({ pos: r.idx, id: r.id, name: HE[r.id] || r.shortName, p: r.played, w: r.wins, d: r.draws, l: r.losses, gf: r.scoresStr, pts: r.pts, color: r.qualColor || "" })),
    matches: (d.fixtures && d.fixtures.allMatches || []).map((m) => ({ id: m.id, round: +m.round, home: fm(m.home), away: fm(m.away), ...fmStatus(m.status) })),
  };
}

async function euro(ctx) {
  const season = "E2026";
  const [mta, hta] = await Promise.all(["TEL", "HTA"].map((c) => get(EURO + "/v2/competitions/E/seasons/" + season + "/games?teamCode=" + c, ctx, 300)));
  const games = [...mta.data, ...hta.data].filter((g, i, a) => a.findIndex((x) => x.identifier === g.identifier) === i).sort((a, b) => a.date < b.date ? -1 : 1);
  const club = (x) => ({ code: x.code, name: EURO_HE[x.code] || x.editorialName || x.abbreviatedName || x.name, crest: x.imageUrls && x.imageUrls.crest || "" });
  const list = games.map((g) => ({ id: g.identifier, round: g.round && g.round.round, utc: g.date, done: g.status === "result", live: g.status === "live", home: club(g.home), away: club(g.away), hs: g.home.score, as: g.away.score }));
  const lastRound = Math.max(1, ...list.filter((g) => g.done).map((g) => g.round || 1));
  let table = [];
  try {
    const s = await get(EURO + "/v3/competitions/E/seasons/" + season + "/rounds/" + lastRound + "/basicstandings", ctx, 600);
    table = s.teams.map((t) => ({ pos: t.position, code: t.club.code, name: EURO_HE[t.club.code] || t.club.editorialName || t.club.name, w: t.gamesWon, l: t.gamesLost }));
  } catch {}
  return { league: "יורוליג", round: lastRound, games: list, table };
}

async function world(ctx, day) {
  const d = await get(FOTMOB + "/matches?date=" + day + "&timezone=Asia/Jerusalem&ccode3=ISR", ctx, 120);
  const out = [];
  for (const l of d.leagues || []) {
    const id = l.primaryId || l.id; if (!WORLD[id]) continue;
    out.push({ id, league: WORLD[id], matches: l.matches.slice(0, 12).map((m) => ({ id: m.id, home: HE[m.home.id] || m.home.shortName || m.home.name, away: HE[m.away.id] || m.away.shortName || m.away.name, ...fmStatus(m.status) })) });
  }
  const order = [127, 42, 47, 87, 73, 55, 54, 53];
  return { day, leagues: out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) };
}

async function nba(ctx) {
  const d = await get(ESPN + "/basketball/nba/teams/por/schedule", ctx, 600);
  const games = (d.events || []).map((e) => {
    const c = e.competitions[0], side = (x) => ({ abbr: x.team.abbreviation, name: x.team.shortDisplayName || x.team.displayName, home: x.homeAway === "home", score: x.score && (x.score.displayValue || x.score), win: x.winner });
    return { utc: e.date, done: c.status.type.completed, live: c.status.type.state === "in", teams: c.competitors.map(side) };
  });
  const now = Date.now(), past = games.filter((g) => g.done), next = games.filter((g) => !g.done && Date.parse(g.utc) > now - 4 * 3600e3);
  return { team: "פורטלנד", player: "דני אבדיה", last: past.slice(-3), next: next.slice(0, 3) };
}

export async function sportApi(request, ctx) {
  const url = new URL(request.url), p = url.pathname.replace(/^\/api\/sport\/?/, "");
  try {
    if (p === "il") return json(await israel(ctx), 200, 120);
    if (p === "euro") return json(await euro(ctx), 200, 300);
    if (p === "nba") return json(await nba(ctx), 200, 600);
    if (p === "world") {
      const day = /^\d{8}$/.test(url.searchParams.get("d") || "") ? url.searchParams.get("d") : new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
      return json(await world(ctx, day), 200, 120);
    }
  } catch (e) { return json({ error: "source", detail: String(e && e.message || e).slice(0, 120) }, 502, 30); }
  return json({ error: "not found" }, 404, 60);
}
