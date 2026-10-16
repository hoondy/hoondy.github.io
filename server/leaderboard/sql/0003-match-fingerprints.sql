-- Adds the table that stops one ride or match being posted twice.
--
--   npx wrangler d1 execute hoondy-leaderboard --remote --file sql/0003-match-fingerprints.sql
--
-- Safe to run more than once.

-- Runs already posted, by fingerprint (see games.js), so one ride or match can't be posted
-- again under another nickname or in a later month. Deleted with the boards they belong to.
CREATE TABLE IF NOT EXISTS matches (
  game    TEXT NOT NULL,
  fp      TEXT NOT NULL,                    -- SHA-256 of the game id and the run without timings
  period  TEXT NOT NULL,                    -- month it was first posted in
  PRIMARY KEY (game, fp)
) WITHOUT ROWID;
