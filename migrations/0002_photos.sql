-- Photos of the exact product a household buys ("קמח כוסמין, זהב, 80%"), shown next to the list item.
CREATE TABLE IF NOT EXISTS photos (hh TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, type TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (hh, id));
