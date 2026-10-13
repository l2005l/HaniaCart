-- Shelf prices from the chains' public price files, loaded nightly by .github/workflows/prices.yml.
-- code is the GTIN-14 barcode, the key that is the same in every chain.
CREATE TABLE IF NOT EXISTS prices (
  chain TEXT NOT NULL, code TEXT NOT NULL, store TEXT NOT NULL, name TEXT NOT NULL,
  price REAL NOT NULL, unit TEXT NOT NULL DEFAULT '', promo TEXT NOT NULL DEFAULT '', pprice REAL,
  ts INTEGER NOT NULL, PRIMARY KEY (chain, code));
CREATE INDEX IF NOT EXISTS prices_code ON prices (code);
