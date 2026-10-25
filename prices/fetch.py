"""Nightly shelf prices, by branch.

1. Branches: the Stores file of every supported chain goes into `branches`, each with the
   coordinates of its town, so a household can pick the branches near it.
2. Prices: for every branch some household picked (plus the default branches from
   stores.json), download its PriceFull and PromoFull files (the chains must publish them by
   law), keep the barcoded items and their open promotions, and write `sprices`.

Everything is written to one SQL file for `wrangler d1 execute`. A branch that fails keeps
yesterday's prices; its error goes into the status row, which /api/prices/status shows.

Victory, Hyper Cohen and Mahsanei HaShuk (the Laib portal) do not answer GitHub's servers;
the Worker handles them (src/laib.js).

Usage: python fetch.py out.sql [wanted.json] [places.json]
  wanted.json and places.json are `wrangler d1 execute --json` outputs of
  SELECT sids FROM hh_stores and SELECT city,lat,lon FROM places.
"""
import json
import re
import sys
import time
import traceback
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
BATCH = 400
LAIB = {"victory", "het-cohen", "mahsanei-hashuk"}  # loaded by the Worker
MAX_WANTED = 80  # branches downloaded per night
UA = {"User-Agent": "HaniaCart/1.0 (+https://cart.hania360.com)"}


def q(v):
    """SQL literal."""
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def store_text(s):
    return " ".join(str(x) for x in (s.name, s.address, s.city, s.sub_chain_name) if x)


def sid_of(chain, store_id):
    return f"{chain}:{str(store_id).lstrip('0') or '0'}"


def pick_store(stores, cfg):
    """The branch that matches the config, plus a few near misses to help fix a wrong match."""
    if cfg.get("store_id"):
        hit = [s for s in stores if str(s.store_id).lstrip("0") == str(cfg["store_id"]).lstrip("0")]
        return (hit[0] if hit else None), []
    keys, prefer, code = cfg.get("keys", []), cfg.get("prefer", []), str(cfg.get("city_code") or "")
    cands = [s for s in stores if any(k in store_text(s) for k in keys) or (code and str(s.city or "").strip() == code)]
    cands.sort(key=lambda s: -sum(p in store_text(s) for p in prefer))
    near = [f"{s.store_id}: {store_text(s)}"[:120] for s in cands[:8]]
    return (cands[0] if cands else None), near


# ---- towns -------------------------------------------------------------------------------
def clean_city(c):
    c = re.sub(r"\s+", " ", str(c or "")).strip(" -,.")
    c = c.replace("״", '"').replace("׳", "'")
    return "" if c in ("0", "-", "") else c


def cbs_towns():
    """CBS town code -> Hebrew name, from data.gov.il (some chains publish the code, not the name)."""
    url = "https://data.gov.il/api/3/action/datastore_search?resource_id=5c78e9fa-c2e2-4771-93ff-7f400a12f7ba&limit=5000"
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        recs = json.load(r)["result"]["records"]
    out = {}
    for rec in recs:
        code, name = str(rec.get("סמל_ישוב") or "").strip(), clean_city(rec.get("שם_ישוב"))
        if code and name:
            out[code.lstrip("0")] = name
    return out


def geocode(city):
    """(lat, lon) of an Israeli town by its Hebrew name, or None."""
    url = "https://geocoding-api.open-meteo.com/v1/search?" + urllib.parse.urlencode({"name": city, "count": 1, "language": "he", "countryCode": "IL"})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
            res = json.load(r).get("results") or []
        if res:
            return round(res[0]["latitude"], 4), round(res[0]["longitude"], 4)
    except Exception:
        pass
    return None


class Towns:
    def __init__(self, known, cbs, geo):
        self.known, self.cbs, self.geo, self.new = dict(known), cbs, geo, {}

    def name(self, s):
        c = clean_city(s.city)
        if c.isdigit():
            c = self.cbs.get(c.lstrip("0"), "")
        if not c:  # no town: find a known one in the name or address
            text = " ".join(x for x in (s.name, s.address) if x)
            hits = [t for t in self.known if len(t) > 2 and t in text]
            c = max(hits, key=len) if hits else ""
        return c

    def where(self, city):
        if not city:
            return None
        if city not in self.known:
            ll = self.geo(city)
            if not ll and " " in city:
                ll = self.geo(city.split(" - ")[0].split(" ")[0])
            self.known[city] = ll
            self.new[city] = ll
            time.sleep(0.05)
        return self.known[city]


# ---- prices ------------------------------------------------------------------------------
def promo_map(promos, now):
    """barcode -> (text, price per unit) for promotions open to every customer right now."""
    out = {}
    for p in promos.promotions:
        if p.is_coupon or (p.end_time and p.end_time < now) or (p.start_time and p.start_time > now):
            continue
        if p.club_id and not str(p.club_id).strip().startswith("0"):
            continue
        for it in p.items:
            if not it.gtin:
                continue
            dp = it.discounted_price or p.discounted_price
            mq = it.min_qty or p.min_qty or 1
            per = None
            if dp:
                per = float(dp) / float(mq) if mq and float(mq) > 1 else float(dp)
            text = (p.description or "מבצע").strip()[:40]
            prev = out.get(it.gtin)
            if not prev or (per and (prev[1] is None or per < prev[1])):
                out[it.gtin] = (text, per)
    return out


def rows_for(prices, promos):
    rows = {}
    for it in prices.items:
        if not it.gtin or not it.price or it.price <= 0:
            continue
        price = round(float(it.price), 2)
        unit = ""
        if it.quantity and it.unit_qty:
            unit = f"{it.quantity.normalize():f} {it.unit_qty}".strip()[:30]
        promo, per = promos.get(it.gtin, ("", None))
        pprice = round(per, 2) if per and per < price * 0.98 else None
        rows[it.gtin] = (it.gtin, (it.name or "").strip()[:120], price, unit, promo if pprice or promo else "", pprice)
    return list(rows.values())


def store_sql(sid, rows, ts):
    out = [f"DELETE FROM sprices WHERE sid={q(sid)};"]
    for i in range(0, len(rows), BATCH):
        vals = ",".join(
            f"({q(sid)},{q(code)},{q(name)},{q(price)},{q(unit)},{q(promo)},{q(pprice)},{ts})"
            for code, name, price, unit, promo, pprice in rows[i:i + BATCH]
        )
        out.append(f"INSERT INTO sprices (sid,code,name,price,unit,promo,pprice,ts) VALUES {vals};")
    return out


def branch_sql(rows, ts):
    out = []
    for i in range(0, len(rows), BATCH):
        vals = ",".join(f"({q(r['sid'])},{q(r['chain'])},{q(r['label'])},{q(r['store_id'])},{q(r['name'])},{q(r['city'])},{q(r['address'])},{q(r['lat'])},{q(r['lon'])},{ts})" for r in rows[i:i + BATCH])
        out.append("INSERT INTO branches (sid,chain,label,store_id,name,city,address,lat,lon,ts) VALUES " + vals
                   + " ON CONFLICT(sid) DO UPDATE SET label=excluded.label,name=excluded.name,city=excluded.city,address=excluded.address,lat=excluded.lat,lon=excluded.lon,ts=excluded.ts;")
    return out


def chains_to_scan(ilp):
    return [c for c in ilp.list_chains() if c.implemented and c.sector == "supermarket" and c.slug not in LAIB and c.portal_family != "webbase"]


def run(ilp, configs, wanted=(), places=None, now=None, towns=None):
    now = now or datetime.now()
    ts = int(time.time() * 1000)
    towns = towns or Towns(places or {}, {}, lambda c: None)
    sql, status = [], {"ts": ts, "chains": {}, "branches": {}, "stores": {}}
    stores_of, labels = {}, {}

    # 1. branches of every chain
    for c in chains_to_scan(ilp):
        labels[c.slug] = c.name_he
        try:
            stores = ilp.get_stores(c.slug).stores
        except Exception as e:
            status["branches"][c.name_he] = {"ok": False, "error": f"{type(e).__name__}: {e}"[:200]}
            continue
        stores_of[c.slug] = stores
        rows = []
        for s in stores:
            city = towns.name(s)
            ll = towns.where(city)
            rows.append({"sid": sid_of(c.slug, s.store_id), "chain": c.slug, "label": c.name_he, "store_id": str(s.store_id),
                         "name": (s.name or "").strip()[:80], "city": city[:40], "address": (s.address or "").strip()[:100],
                         "lat": ll[0] if ll else None, "lon": ll[1] if ll else None})
        sql += branch_sql(rows, ts)
        status["branches"][c.name_he] = {"ok": True, "count": len(rows), "located": sum(1 for r in rows if r["lat"] is not None)}

    # 2. the default branches (stores.json): what a household sees before it picks its own
    defaults = []
    for cfg in configs:
        label = cfg["label"]
        if cfg["chain"] in LAIB:
            continue
        st = status["chains"][label] = {"ok": False}
        try:
            stores = stores_of.get(cfg["chain"]) or ilp.get_stores(cfg["chain"]).stores
            store, near = pick_store(stores, cfg)
            st["candidates"] = near
            if not store:
                st["error"] = "no matching store"
                st["all_stores"] = [f"{s.store_id}: {store_text(s)}"[:70] for s in stores][:160]
                continue
            st.update(ok=True, store=store_text(store)[:120], store_id=store.store_id, sid=sid_of(cfg["chain"], store.store_id))
            defaults.append(st["sid"])
            if cfg["chain"] not in stores_of:  # a chain outside the scan list still needs its branch row
                labels[cfg["chain"]] = label
                sql += branch_sql([{"sid": st["sid"], "chain": cfg["chain"], "label": label, "store_id": str(store.store_id), "name": (store.name or "").strip()[:80],
                                    "city": towns.name(store)[:40], "address": (store.address or "").strip()[:100], "lat": None, "lon": None}], ts)
        except Exception as e:
            st["error"] = f"{type(e).__name__}: {e}"[:300]

    # 3. prices of every wanted branch
    want, seen = [], set()
    for sid in list(defaults) + [s for s in wanted]:
        chain = sid.split(":")[0]
        if sid in seen or chain in LAIB or ":" not in sid:
            continue
        seen.add(sid)
        want.append(sid)
    for sid in want[:MAX_WANTED]:
        chain, store_id = sid.split(":", 1)
        st = status["stores"][sid] = {"ok": False}
        try:
            stores = stores_of.get(chain) or []
            real = next((s.store_id for s in stores if str(s.store_id).lstrip("0") == store_id), store_id)
            prices = ilp.get_prices(chain, store_id=real)
            try:
                promos = promo_map(ilp.get_promos(chain, store_id=real), now)
            except Exception as e:  # promotions are a bonus; prices still count
                promos, st["promo_error"] = {}, f"{type(e).__name__}: {e}"[:200]
            rows = rows_for(prices, promos)
            if not rows:
                st["error"] = "price file had no barcoded items"
                continue
            sql += store_sql(sid, rows, ts)
            st.update(ok=True, count=len(rows), promos=sum(1 for r in rows if r[5]))
        except Exception as e:
            st["error"] = f"{type(e).__name__}: {e}"[:300]
            traceback.print_exc()
        print(sid, json.dumps(st, ensure_ascii=False))
    status["skipped"] = want[MAX_WANTED:]

    for city, ll in towns.new.items():
        sql.append(f"INSERT INTO places (city,lat,lon,ts) VALUES ({q(city)},{q(ll[0] if ll else None)},{q(ll[1] if ll else None)},{ts}) ON CONFLICT(city) DO UPDATE SET lat=excluded.lat,lon=excluded.lon,ts=excluded.ts;")
    sql.append(f"INSERT INTO kv (k,v) VALUES ('prices:defaults',{q(json.dumps(defaults))}) ON CONFLICT(k) DO UPDATE SET v=excluded.v;")
    sql.append(f"INSERT INTO kv (k,v) VALUES ('prices:status',{q(json.dumps(status, ensure_ascii=False))}) ON CONFLICT(k) DO UPDATE SET v=excluded.v;")
    return sql, status


def d1_results(path):
    """Rows from a `wrangler d1 execute --json` output file, or [] when it is missing."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return data[0]["results"] if isinstance(data, list) else data.get("results", [])
    except Exception:
        return []


if __name__ == "__main__":
    import israeli_prices as ilp

    out = Path(sys.argv[1] if len(sys.argv) > 1 else "prices.sql")
    wanted = []
    for r in d1_results(sys.argv[2]) if len(sys.argv) > 2 else []:
        try:
            wanted += [s for s in json.loads(r["sids"]) if isinstance(s, str)]
        except Exception:
            pass
    places = {r["city"]: ((r["lat"], r["lon"]) if r["lat"] is not None else None) for r in (d1_results(sys.argv[3]) if len(sys.argv) > 3 else [])}
    try:
        cbs = cbs_towns()
    except Exception as e:
        print("CBS town list failed:", e)
        cbs = {}
    configs = json.loads((HERE / "stores.json").read_text(encoding="utf-8"))
    # Most wanted first, so the cap drops the least popular branches.
    counts = {}
    for s in wanted:
        counts[s] = counts.get(s, 0) + 1
    sql, status = run(ilp, configs, sorted(counts, key=lambda s: -counts[s]), now=None, towns=Towns(places, cbs, geocode))
    out.write_text("\n".join(sql) + "\n", encoding="utf-8")
    ok = sum(1 for c in status["stores"].values() if c["ok"])
    print(f"{ok}/{len(status['stores'])} branches loaded, {sum(b.get('count', 0) for b in status['branches'].values())} branches listed, {out.stat().st_size // 1024} KB of SQL")
