-- Monthly leaderboards and LQ test statistics, for a new, empty database. Safe to run more
-- than once. A database that still has the weekly tables needs
-- sql/0002-monthly-and-lq-stats.sql instead.

-- One row per player per game per month, holding that player's best score.
-- `client` is a salted SHA-256 of the client's network (its IP, or the /64 for IPv6) and the
-- month; `player` also mixes in the nickname. The raw IP is never stored, and once the month is
-- over the daily cleanup clears `client` and swaps `player` for a placeholder.
CREATE TABLE IF NOT EXISTS scores (
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
  -- `player` alone would be unique; leading with `client` lets the same index count how many
  -- nicknames one network has used this month.
  UNIQUE (game, period, client, player)
);

-- Serves both the top-N query and the "how many are ahead of me" count.
CREATE INDEX IF NOT EXISTS scores_board ON scores (game, period, score DESC, updated_at, id);

-- Rate limiting: posts per client per game in one-minute buckets. Rows older than a day are
-- deleted by the scheduled cleanup. No extra index: the table only ever holds a day of rows,
-- and every index would add a billed write to each post.
CREATE TABLE IF NOT EXISTS hits (
  client  TEXT    NOT NULL,                 -- salted SHA-256 of the client's network; for
                                            -- 'lq-results' only a 4-hex-digit tag of it
  game    TEXT    NOT NULL,                 -- a board's game id, or 'lq-results'
  bucket  INTEGER NOT NULL,                 -- unix minute
  count   INTEGER NOT NULL,
  PRIMARY KEY (client, game, bucket)
) WITHOUT ROWID;

-- Anonymous LQ test results, one row per completed test that the visitor chose to add. There is
-- deliberately no name, IP, hash of the IP, country or time of day here, and ids are random so
-- the rows don't keep the order they came in. Kept for recalibrating the test's norms; nothing
-- reads this table on a request, so it has no index.
CREATE TABLE IF NOT EXISTS lq_results (
  id         INTEGER PRIMARY KEY,           -- random, below 2^53
  day        TEXT    NOT NULL,              -- YYYY-MM-DD, New York time
  lang       TEXT    NOT NULL,              -- en, ko, es, ja or zh
  version    TEXT    NOT NULL,              -- scoring.js VERSION that produced lq
  lq         INTEGER NOT NULL,              -- 55..145
  archetype  TEXT    NOT NULL,
  answers    TEXT    NOT NULL               -- JSON array in the order of ITEMS in scoring.js
);

-- Running histogram of lq_results, so reading the distribution never scans the results.
-- Bin i covers LQ 55+5i .. 59+5i; the last bin (17) covers 140..145.
CREATE TABLE IF NOT EXISTS lq_hist (
  bin         INTEGER PRIMARY KEY,
  count       INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL              -- midnight UTC (ms since epoch) of the day of the latest result in this bin
);

-- Runs already posted, by fingerprint (see games.js), so one ride or match can't be posted
-- again under another nickname or in a later month. Deleted with the boards they belong to.
CREATE TABLE IF NOT EXISTS matches (
  game    TEXT NOT NULL,
  fp      TEXT NOT NULL,                    -- SHA-256 of the game id and the run without timings
  period  TEXT NOT NULL,                    -- month it was first posted in
  PRIMARY KEY (game, fp)
) WITHOUT ROWID;
