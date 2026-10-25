-- Prices by branch, so every household compares the stores near it.
-- sid is "<chain slug>:<store id>". branches lists every branch the nightly job saw, with the
-- coordinates of its town (the chains publish an address, not a location).
CREATE TABLE IF NOT EXISTS branches (
  sid TEXT PRIMARY KEY, chain TEXT NOT NULL, label TEXT NOT NULL, store_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
  lat REAL, lon REAL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS branches_geo ON branches (lat, lon);
CREATE TABLE IF NOT EXISTS sprices (
  sid TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, price REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT '', promo TEXT NOT NULL DEFAULT '', pprice REAL, ts INTEGER NOT NULL,
  PRIMARY KEY (sid, code));
CREATE INDEX IF NOT EXISTS sprices_code ON sprices (code);
-- The branches a household picked (JSON array of sid). Without a row it gets the defaults.
CREATE TABLE IF NOT EXISTS hh_stores (hh TEXT PRIMARY KEY, sids TEXT NOT NULL, place TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL);
-- Town name -> coordinates, filled once per town by the nightly job or the Worker.
CREATE TABLE IF NOT EXISTS places (city TEXT PRIMARY KEY, lat REAL, lon REAL, ts INTEGER NOT NULL);
