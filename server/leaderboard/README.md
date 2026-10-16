# Leaderboard API

This is the small backend for the apps on hoondy.com. It does two things:

- **Monthly high-score boards** for the games (today that's Rush Hour).
- **Anonymous LQ test statistics.** The LQ test has no board, since it's a test for yourself. Instead,
  people who keep the "add my anonymous result" box ticked add their result to a histogram, and
  the results page uses it to show where someone lands among real test takers.

It's a Cloudflare Worker with a D1 (SQLite) database, and it fits in Cloudflare's free plan.

The site works without it. When `leaderboard_api` in `_config.yml` is empty, every visitor
gets a game board that only lives in their own browser, and the LQ results page shows the
distribution the scoring model expects. Once you set it to this worker's URL, everyone shares
one board per game per month and the LQ page can use the real distribution.

## How it works

### Game boards

- `GET /v1/:game/top?limit=20` returns this month's board, best first. `limit` goes from 1 to 50.
- `POST /v1/:game/scores` takes a run. The worker doesn't take the page's word for the score. It
  replays the Rush Hour play log (one entry per cleared word, missed word or wrong key) with the
  same rules module the page uses (`assets/apps/rush-hour/rules.js`) and rejects anything that
  doesn't add up.
- A month starts on the 1st at midnight New York time (`assets/js/lib/period.js`). Nicknames go
  through the same filter as in the browser (`assets/js/lib/names.js`).
- Each player keeps one row per game per month, holding their best score. A "player" is a
  nickname on a network. The network is the client's IP address, or for IPv6 its /64 prefix:
  a home or a phone gets a whole /64 and its address changes inside it on its own. The worker
  hashes the network, the month and the nickname with a secret salt. It never stores the raw IP,
  and since the month is part of the hash, it changes every month.
- One network can put at most 3 nicknames on a game's board each month (`NAMES_PER_CLIENT`), so
  nobody can fill the board with made-up names. It can keep posting under the names it already
  has. A household or office behind one address shares that allowance.
- Posting is rate limited to 6 posts per 10 minutes per network per game.
- Boards are cached at the edge for 20 seconds. Posting clears the cache for that board.

### LQ statistics

- `POST /v1/leadership/results` takes one completed test: the answers, the page language, how long
  it took and the scoring version. The worker re-scores the answers with
  `assets/apps/leadership/scoring.js` and turns away anything the test itself would call invalid
  (too fast, failed attention check, straight-lining and so on). The page never sends a score.
- A valid result becomes one row in `lq_results`: the New York date (no time), the language, the
  scoring version, the LQ, the archetype and the answers. There's no name, no IP, no hash of the
  IP and no country in that table. Row ids are random, so the table doesn't record the order
  results came in. The same post bumps one bin in `lq_hist` (in the same transaction), so
  reading the distribution never scans the results. The histogram's timestamp only holds the
  day.
- `GET /v1/leadership/distribution` returns the histogram. It's cached at the edge for up to 5
  minutes, and browsers are told to keep it only for whatever is left of those 5 minutes.
- Posting is rate limited to 5 results per hour per network. That counter lives in the same
  short-lived `hits` table as the boards' counters, under its own key, and it keeps only the
  first 4 hex digits of a salted hash of the network. That's enough to slow down one connection,
  but each value is shared by tens of thousands of IPv4 addresses, so a counter row can't be
  traced back to an address (even with the salt) or matched to the boards' counters. Since
  results carry no time of day and no order, they can't be paired with counter rows by time
  either, and where one could be paired anyway (a day with a single result), the counter row
  only holds that short tag.
- The page decides whether to post. It only sends a result when the visitor left the box ticked,
  and only once per completed test.
- Results scored under a different `VERSION` of `scoring.js` than the deployed worker are turned
  away (`version`), so answers never land in the wrong slots. Deploy the worker whenever
  `scoring.js` changes.

### Housekeeping and privacy

- A daily cron job deletes rate-limit rows older than a day. Once a month is over, it clears the
  IP-derived hashes from that month's board rows, and it deletes boards older than
  `RETAIN_MONTHS` (24).
- LQ results are kept, since they hold nothing about the person. They're there to recalibrate the
  test's norms later.
- Only `https://hoondy.com` and `https://www.hoondy.com` can call the API from a browser
  (`ALLOWED_ORIGINS` in `wrangler.toml`). Under `wrangler dev`, pages on localhost are
  allowed too.
- Error responses are just a short code. Nothing internal is sent back.

The worker imports the rules modules straight from the site's `assets/` folder, and Wrangler
bundles them when you deploy. If you change `rules.js` or `scoring.js`, deploy the worker again
so the server and the page stay in step.

## One-time setup

You need Node.js 22 or newer and a free Cloudflare account.

```sh
cd server/leaderboard
npm install
npx wrangler login
```

Create the database:

```sh
npx wrangler d1 create hoondy-leaderboard
```

That prints a `database_id`. Paste it into `wrangler.toml`, then create the tables:

```sh
npm run db:init:remote
```

Set the secret salt for the IP hashes. Use a long random value and don't reuse it anywhere:

```sh
openssl rand -hex 32 | npx wrangler secret put IP_SALT
```

The worker refuses to accept posts until this is set.

Deploy:

```sh
npm run deploy
```

Wrangler prints the address, something like `https://hoondy-leaderboard.<your-subdomain>.workers.dev`.
To check it, open that URL. You should see `{"ok":true,"service":"hoondy-leaderboard",...}`.

### Moving from the weekly boards

The first version of this worker kept weekly boards for both apps. A database created back then
has a `scores` table with a `week` column and no LQ tables. Update it once, then deploy:

```sh
npm run db:migrate:remote    # runs sql/0002-monthly-and-lq-stats.sql
npm run deploy
```

The script drops the weekly boards and the rate-limit counters and recreates them in the
monthly shape, and it creates the LQ tables if they're missing. It never touches existing LQ
results. Its first statement checks that `scores` still has the `week` column, so on a database
that's already monthly it stops with `no such column: week` before dropping anything.

This database doesn't use Wrangler's tracked migrations: the tables come from `schema.sql`, plus
this one-off script for the old weekly database. That's why the script lives in `sql/` rather
than `migrations/`, the folder `wrangler d1 migrations apply` reads by default.

## Pointing the site at it

In the site's `_config.yml`:

```yaml
leaderboard_api: "https://hoondy-leaderboard.<your-subdomain>.workers.dev"
```

Commit and push. GitHub Pages rebuilds and the boards go global.

### Optional: api.hoondy.com

If hoondy.com's DNS is on Cloudflare (the site itself can stay on GitHub Pages), you can serve the
API from your own subdomain. You also need a custom domain for the edge cache to work, because
on workers.dev every board view goes to the database. That's fine at this scale, just slower.

1. In `wrangler.toml`, uncomment the `routes` line.
2. Run `npm run deploy`. Cloudflare creates the DNS record and certificate for you.
3. Set `leaderboard_api: "https://api.hoondy.com"` in `_config.yml` and push.

## Running it locally

```sh
cd server/leaderboard
npm run db:init:local     # once; creates the tables in .wrangler/
npm run dev               # http://localhost:8787
```

To build the site against the local API, add a second config file that only overrides this one
setting, for example `~/lb-local.yml` with:

```yaml
leaderboard_api: "http://127.0.0.1:8787"
```

Then run `bundle exec jekyll serve --config _config.yml,$HOME/lb-local.yml`. Local builds
don't load ads or analytics.

To run the tests, keep `npm run dev` going and run this in another terminal:

```sh
npm test        # set LB_URL=http://127.0.0.1:<port> if the dev server is on another port
npm run test:unit   # just the parts that don't need a server
```

The tests post under random nicknames and fake IPs, so you can run them repeatedly. Locally,
the worker trusts the `CF-Connecting-IP` header the tests send. In production, Cloudflare sets
that header itself. If you change a rate limit in `wrangler.toml`, pass the new value to the tests
as `LB_RATE_LIMIT` or `LB_LQ_RATE_LIMIT` (and `LB_NAMES` for `NAMES_PER_CLIENT`). To start over
with an empty local database, delete `.wrangler/` and run `npm run db:init:local` again.

To try the daily cleanup locally, run `npx wrangler dev --test-scheduled` and open
`http://localhost:8787/__scheduled?cron=17+6+*+*+*`.

## Day-to-day

Look at the live boards:

```sh
npx wrangler d1 execute hoondy-leaderboard --remote \
  --command "SELECT id, game, period, name, score, country FROM scores ORDER BY id DESC LIMIT 20"
```

Remove a row, for example a nickname that got past the filter:

```sh
npx wrangler d1 execute hoondy-leaderboard --remote --command "DELETE FROM scores WHERE id = 123"
```

The board catches up within 20 seconds. To watch requests and errors live, run `npx wrangler tail`.

Look at the LQ statistics:

```sh
npx wrangler d1 execute hoondy-leaderboard --remote --command "SELECT * FROM lq_hist ORDER BY bin"
npx wrangler d1 execute hoondy-leaderboard --remote \
  --command "SELECT version, lang, COUNT(*) AS n, ROUND(AVG(lq), 1) AS mean FROM lq_results GROUP BY 1, 2"
```

The histogram can always be rebuilt from the results, for example after deleting rows or to count
only one scoring version (add `WHERE version = '...'` before `GROUP BY`):

```sh
npx wrangler d1 execute hoondy-leaderboard --remote --command "DELETE FROM lq_hist;
  INSERT INTO lq_hist (bin, count, updated_at)
  SELECT MIN(17, MAX(0, (lq - 55) / 5)), COUNT(*), CAST(strftime('%s', 'now', 'start of day') AS INTEGER) * 1000
    FROM lq_results GROUP BY 1"
```

## Settings

These live in `wrangler.toml` under `[vars]`. Run `npm run deploy` after changing them.

| name | default | what it does |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://hoondy.com,https://www.hoondy.com` | Sites allowed to call the API from a browser, comma-separated. `http://localhost:*` matches any port. |
| `RATE_LIMIT` | `6` | Board posts allowed per network (IP, or /64 for IPv6) per game... |
| `RATE_WINDOW_MINUTES` | `10` | ...within this many minutes. |
| `LQ_RATE_LIMIT` | `5` | LQ results allowed per network... |
| `LQ_RATE_WINDOW_MINUTES` | `60` | ...within this many minutes. |
| `NAMES_PER_CLIENT` | `3` | Nicknames one network can have on a game's board in a month. |
| `RETAIN_MONTHS` | `24` | Monthly boards older than this are deleted. |
| `IP_SALT` | (secret) | Salt for the IP hashes. Set it with `wrangler secret put`, never in the file. |

## API

### Boards

`GET /v1/:game/top?limit=20`

```json
{
  "period": "2026-10",
  "resetsAt": "2026-11-01T04:00:00.000Z",
  "entries": [
    { "id": 17, "rank": 1, "name": "hoondy", "score": 10039, "country": "US",
      "detail": { "stage": 7, "wpm": 58, "accuracy": 98, "pack": "nyc" }, "ts": 1792163637826 }
  ]
}
```

`period` is the month (New York time) and `resetsAt` is when the next one starts. `ts` is when
the player set that score. Ties go to whoever got there first.

`POST /v1/:game/scores` with `Content-Type: application/json`:

- rush-hour: `{ "name", "score", "detail": { "stage", "words", "misses", "accuracy", "wpm", "durationMs", "pack" }, "log": [...] }`

A successful post returns
`{ "ok": true, "id", "rank", "score", "best", "improved", "name", "period" }`. Here `score` is
what this post was worth, `best` is the player's best this month (that's the one on the board),
`rank` is where that best stands, and `name` is the nickname as it was saved.

### LQ statistics

`POST /v1/leadership/results` with `Content-Type: application/json`:

```json
{ "answers": [49 integers in the order of ITEMS in scoring.js], "lang": "en", "durationMs": 245000, "v": "1.1.0" }
```

`v` is `VERSION` from `scoring.js`. Anything else in the body is ignored. A stored result returns
`{ "ok": true, "n": 1234 }`, where `n` is the new number of results.

`GET /v1/leadership/distribution`

```json
{ "n": 1234, "min": 55, "max": 145, "step": 5,
  "bins": [0, 1, 3, 9, 22, 48, 90, 141, 180, 199, 175, 140, 97, 61, 37, 18, 9, 4],
  "updatedAt": "2026-10-16T00:00:00.000Z" }
```

Bin `i` counts LQ scores from `55 + 5i` to `59 + 5i`, except the last one (`i = 17`), which covers
140 to 145. `updatedAt` is midnight UTC on the day of the latest result (deliberately never a
time of day), or `null` while there are none (all bins are then zero). The response may be up to
5 minutes old: `Cache-Control` gives browsers only what's left of the edge copy's 5 minutes.

### Errors

Errors come back as `{ "ok": false, "error": "<code>" }`:

| status | error | meaning |
|---|---|---|
| 400 | `bad_json`, `bad_body` | The body isn't a JSON object. |
| 400 | `name` | The nickname is empty after cleaning, or it's on the block list. |
| 403 | `origin` | The request came from a page on a site that isn't allowed. |
| 404 | `unknown_game`, `not_found` | Includes `/v1/leadership/top` and `/v1/leadership/scores`: the LQ test has no board. |
| 405 | `method` | |
| 413 | `too_large` | The body is over 256 KB (rush-hour) or 4 KB (LQ results). |
| 415 | `content_type` | The request isn't `application/json`. |
| 422 | (game-specific) | The rules rejected the result: `score mismatch`, `speed` or `detail mismatch` for Rush Hour; `version`, `too_fast`, `attention`, `straightline`, `bad_answers`, `bad_lang` and so on for LQ results. |
| 429 | `rate_limited` | Too many posts. The `Retry-After` header says how many seconds to wait. |
| 429 | `too_many_names` | This network already has `NAMES_PER_CLIENT` nicknames on this month's board. Posting under one of those still works; `Retry-After` counts down to the monthly reset. |
| 503 | `unavailable` | The database didn't answer. |
| 503 | `not_configured` | `IP_SALT` isn't set. |

## Adding a game

1. In the game's own rules module, export a `validateSubmission(body)` that returns
   `{ ok: true, score, detail }` or `{ ok: false, error }`. Keep it free of DOM and network code,
   and keep `detail` small: it's public and shown on the board.
2. Add it to `src/games.js` with a sensible body size limit.
3. Run `npm run deploy`.

## Free plan limits

These were the limits when this was written. Check Cloudflare's pricing pages for the current ones.

- Workers: 100,000 requests a day, 10 ms of CPU time per request. Checking an LQ result or a
  normal Rush Hour run (a few hundred log entries) takes about a millisecond. A Rush Hour log
  near its 8,000-entry cap (`MAX_LOG` in `rules.js`) is different: on a cold isolate, parsing
  and replaying it can take 10 to 15 ms, so on the free plan a post like that may be cut off
  and fail. If very long runs start failing, move to Workers Paid or lower `MAX_LOG`.
- D1: 5 million rows read and 100,000 rows written a day, 5 GB of storage. A board post writes at
  most four rows (the rate-limit counter, the score and its two indexes); an LQ result writes
  three (the counter, the result and its histogram bin), and a stored result takes about 200
  bytes. Each board view reads up to 50 rows and each distribution read 18, unless the edge cache
  already has it.
- Cron triggers are included.

If a daily limit runs out, the API returns errors until the counters reset at midnight UTC.
Until then the boards show an out-of-service notice, posting fails with an error, and the LQ page
falls back to the expected distribution.
