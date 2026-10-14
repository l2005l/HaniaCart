-- Optional link between a Hania360 account (Hania Pass user id) and a household.
-- HaniaCart still works with no account at all; this only lets a signed-in person
-- get their household back on a new phone without the join link.
CREATE TABLE IF NOT EXISTS account_hh (
  user_id TEXT NOT NULL, hh TEXT NOT NULL, created INTEGER NOT NULL,
  PRIMARY KEY (user_id, hh));
CREATE INDEX IF NOT EXISTS account_hh_hh ON account_hh (hh);
