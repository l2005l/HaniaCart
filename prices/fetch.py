"""Nightly shelf prices for the household's stores.

For each store in stores.json: find the branch in the chain's Stores file, download its
PriceFull and PromoFull files (the chains must publish them by law), keep the barcoded
items, and write prices.sql for `wrangler d1 execute`. A chain that fails keeps yesterday's
prices; its error goes into the status row, which /api/prices/status shows.

Usage: python fetch.py [out.sql]
"""
import json
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
BATCH = 400


def q(v):
    """SQL literal."""
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def store_text(s):
    return " ".join(str(x) for x in (s.name, s.address, s.city, s.sub_chain_name) if x)


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


def chain_sql(label, store_name, rows, ts):
    out = [f"DELETE FROM prices WHERE chain={q(label)};"]
    for i in range(0, len(rows), BATCH):
        vals = ",".join(
            f"({q(label)},{q(code)},{q(store_name)},{q(name)},{q(price)},{q(unit)},{q(promo)},{q(pprice)},{ts})"
            for code, name, price, unit, promo, pprice in rows[i:i + BATCH]
        )
        out.append(f"INSERT INTO prices (chain,code,store,name,price,unit,promo,pprice,ts) VALUES {vals};")
    return out


def run(ilp, configs, now=None):
    now = now or datetime.now()
    ts = int(time.time() * 1000)
    sql, status = [], {"ts": ts, "chains": {}}
    for cfg in configs:
        label = cfg["label"]
        st = status["chains"][label] = {"ok": False}
        try:
            stores = ilp.get_stores(cfg["chain"]).stores
            st["stores"] = len(stores)
            store, near = pick_store(stores, cfg)
            st["candidates"] = near
            if not store:
                st["error"] = "no matching store"
                continue
            st["store"] = store_text(store)[:120]
            st["store_id"] = store.store_id
            prices = ilp.get_prices(cfg["chain"], store_id=store.store_id)
            try:
                promos = promo_map(ilp.get_promos(cfg["chain"], store_id=store.store_id), now)
            except Exception as e:  # promotions are a bonus; prices still count
                promos, st["promo_error"] = {}, f"{type(e).__name__}: {e}"[:200]
            rows = rows_for(prices, promos)
            if not rows:
                st["error"] = "price file had no barcoded items"
                continue
            sql += chain_sql(label, (store.name or label).strip()[:60], rows, ts)
            st.update(ok=True, count=len(rows), promos=sum(1 for r in rows if r[5]))
        except Exception as e:
            st["error"] = f"{type(e).__name__}: {e}"[:300]
            traceback.print_exc()
        print(label, json.dumps(st, ensure_ascii=False))
    sql.append(f"INSERT INTO kv (k,v) VALUES ('prices:status',{q(json.dumps(status, ensure_ascii=False))}) ON CONFLICT(k) DO UPDATE SET v=excluded.v;")
    return sql, status


if __name__ == "__main__":
    import israeli_prices as ilp

    configs = json.loads((HERE / "stores.json").read_text(encoding="utf-8"))
    sql, status = run(ilp, configs)
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "prices.sql")
    out.write_text("\n".join(sql) + "\n", encoding="utf-8")
    ok = sum(1 for c in status["chains"].values() if c["ok"])
    print(f"{ok}/{len(configs)} stores loaded, {out.stat().st_size // 1024} KB of SQL")
