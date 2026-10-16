-- Weekly boards -> monthly boards, plus the LQ statistics tables.
--
--   npx wrangler d1 execute hoondy-leaderboard --remote --file sql/0002-monthly-and-lq-stats.sql
--
-- Run it once, before deploying the monthly worker. It throws away the weekly boards and the
-- rate-limit counters (both were empty when the switch was made) and recreates them in the
-- monthly shape. The LQ tables are only created if missing, so LQ results are never touched.
--
-- This file deliberately lives outside migrations/, the folder `wrangler d1 migrations apply`
-- picks up on its own, and it isn't a tracked migration: a new database is set up from
-- schema.sql instead.

-- Stops here, before anything is dropped, unless `scores` is still the weekly table. On a
-- database that has already been moved over (or never had weekly boards) this fails with
-- "no such column: week" or "no such table: scores", so a second run can't empty the boards.
SELECT week FROM scores LIMIT 0;

DROP INDEX IF EXISTS scores_board;
DROP TABLE IF EXISTS scores;
DROP TABLE IF EXISTS hits;

CREATE TABLE scores (
  id          INTEGER PRIMARY KEY,
  game        TEXT    NOT NULL,
  period      TEXT    NOT NULL,             -- e.g. 2026-10 (months start on the 1st, New York time)
  client      TEXT,                         -- NULL once the month is over
  player      TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  score       INTEGER NOT NULL,
  country     TEXT,                         -- ISO 3166-1 alpha-2 from Cloudflare, or NULL
  detail      TEXT    NOT NULL DEFAULT '{}', -- small public JSON object from the game's validator
  created_at  INTEGER NOT NULL,             -- ms since epoch, first post this month
  updated_at  INTEGER NOT NULL,             -- ms since epoch, when the current best was set
  UNIQUE (game, period, client, player)
);

CREATE INDEX scores_board ON scores (game, period, score DESC, updated_at, id);

CREATE TABLE hits (
  client  TEXT    NOT NULL,                 -- salted SHA-256 of the client's network; for
                                            -- 'lq-results' only a 4-hex-digit tag of it
  game    TEXT    NOT NULL,                 -- a board's game id, or 'lq-results'
  bucket  INTEGER NOT NULL,                 -- unix minute
  count   INTEGER NOT NULL,
  PRIMARY KEY (client, game, bucket)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS lq_results (
  id         INTEGER PRIMARY KEY,           -- random, below 2^53
  day        TEXT    NOT NULL,              -- YYYY-MM-DD, New York time
  lang       TEXT    NOT NULL,              -- en, ko, es, ja or zh
  version    TEXT    NOT NULL,              -- scoring.js VERSION that produced lq
  lq         INTEGER NOT NULL,              -- 55..145
  archetype  TEXT    NOT NULL,
  answers    TEXT    NOT NULL               -- JSON array in the order of ITEMS in scoring.js
);

CREATE TABLE IF NOT EXISTS lq_hist (
  bin         INTEGER PRIMARY KEY,          -- LQ 55+5*bin .. 59+5*bin; bin 17 is 140..145
  count       INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL              -- midnight UTC (ms since epoch) of the day of the latest result in this bin
);
