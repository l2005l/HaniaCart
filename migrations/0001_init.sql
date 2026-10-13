-- One household = one long random key both phones share. Everything the household keeps
-- (stock, shopping list, receipts, purchases, waste, the meal plan) is a JSON row here.
CREATE TABLE IF NOT EXISTS hh (id TEXT PRIMARY KEY, created INTEGER NOT NULL, seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rows (
  hh TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
  upd INTEGER NOT NULL, del INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hh, kind, id));
CREATE INDEX IF NOT EXISTS rows_upd ON rows (hh, upd);
CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_subs (
  id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, hh TEXT NOT NULL, hour INTEGER NOT NULL DEFAULT 9,
  sent TEXT NOT NULL DEFAULT '', msg TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS push_hh ON push_subs (hh);
