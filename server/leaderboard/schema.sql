-- Weekly leaderboards. Safe to run more than once.

-- One row per player per game per week, holding that player's best score.
-- `client` is a salted SHA-256 of the client's network (its IP, or the /64 for IPv6) and the
-- week; `player` also mixes in the nickname. The raw IP is never stored, and once the week is
-- over the daily cleanup clears `client` and swaps `player` for a placeholder.
CREATE TABLE IF NOT EXISTS scores (
  id          INTEGER PRIMARY KEY,
  game        TEXT    NOT NULL,
  week        TEXT    NOT NULL,             -- e.g. 2026-W42 (weeks start Monday, New York time)
  client      TEXT,                         -- NULL once the week is over
  player      TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  score       INTEGER NOT NULL,
  country     TEXT,                         -- ISO 3166-1 alpha-2 from Cloudflare, or NULL
  detail      TEXT    NOT NULL DEFAULT '{}', -- small public JSON object from the game's validator
  created_at  INTEGER NOT NULL,             -- ms since epoch, first post this week
  updated_at  INTEGER NOT NULL,             -- ms since epoch, when the current best was set
  -- `player` alone would be unique; leading with `client` lets the same index count how many
  -- nicknames one network has used this week.
  UNIQUE (game, week, client, player)
);

-- Serves both the top-N query and the "how many are ahead of me" count.
CREATE INDEX IF NOT EXISTS scores_board ON scores (game, week, score DESC, updated_at, id);

-- Rate limiting: posts per client per game in one-minute buckets. Rows older than a day are
-- deleted by the scheduled cleanup. No extra index: the table only ever holds a day of rows,
-- and every index would add a billed write to each post.
CREATE TABLE IF NOT EXISTS hits (
  client  TEXT    NOT NULL,                 -- salted SHA-256 of the client's network
  game    TEXT    NOT NULL,
  bucket  INTEGER NOT NULL,                 -- unix minute
  count   INTEGER NOT NULL,
  PRIMARY KEY (client, game, bucket)
) WITHOUT ROWID;
