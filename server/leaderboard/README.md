# Leaderboard API

The weekly high-score boards for the apps on hoondy.com (the LQ test and Rush Hour) live here.
It's a small Cloudflare Worker with a D1 (SQLite) database, and it fits in Cloudflare's free plan.

The site works without it. When `leaderboard_api` in `_config.yml` is empty, every visitor
gets a board that only lives in their own browser. Once you set it to this worker's URL, everyone
shares one board per game per week.

## How it works

- `GET /v1/:game/top?limit=20` returns this week's board, best first. `limit` goes from 1 to 50.
- `POST /v1/:game/scores` takes a result. The worker doesn't take the page's word for the
  score. It runs the same rule modules the pages use (`assets/apps/leadership/scoring.js` and
  `assets/apps/rush-hour/rules.js`): it re-scores the LQ answers and replays the Rush Hour
  play log (one entry per cleared word, missed word or wrong key), then rejects anything that
  doesn't add up.
- Weeks start Monday at midnight New York time (`assets/js/lib/week.js`). Nicknames go through
  the same filter as in the browser (`assets/js/lib/names.js`).
- Each player keeps one row per game per week, holding their best score. A "player" is a
  nickname on a network. The network is the client's IP address, or for IPv6 its /64 prefix:
  a home or a phone gets a whole /64 and its address changes inside it on its own. The worker
  hashes the network, the week and the nickname with a secret salt. It never stores the raw IP,
  and since the week is part of the hash, it changes every week.
- One network can put at most 3 nicknames on a game's board each week (`NAMES_PER_CLIENT`), so
  nobody can fill the board with made-up names. It can keep posting under the names it already
  has. A household or office behind one address shares that allowance.
- Posting is rate limited to 6 posts per 10 minutes per network per game. Those counters are
  keyed by a different salted hash, and they're deleted after a day.
- Boards are cached at the edge for 20 seconds. Posting clears the cache for that board.
- A daily cron job deletes old rate-limit rows. Once a week is over, it clears the IP-derived
  hashes from that week's rows, and it deletes weeks older than `RETAIN_WEEKS` (52).
- Only `https://hoondy.com` and `https://www.hoondy.com` can call the API from a browser
  (`ALLOWED_ORIGINS` in `wrangler.toml`). Under `wrangler dev`, pages on localhost are
  allowed too.

The worker imports those modules straight from the site's `assets/` folder, and Wrangler bundles
them when you deploy. If you change a game's rules, deploy the worker again so the server and
the page stay in step.

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

That prints a `database_id`. Paste it into `wrangler.toml` in place of the zeros, then create
the tables:

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

To run the API tests, keep `npm run dev` going and run this in another terminal:

```sh
npm test        # set LB_URL=http://127.0.0.1:<port> if the dev server is on another port
```

The tests post under random nicknames and fake IPs, so you can run them repeatedly. Locally,
the worker trusts the `CF-Connecting-IP` header the tests send. In production, Cloudflare sets
that header itself. To start over with an empty local database, delete `.wrangler/` and run
`npm run db:init:local` again.

To try the daily cleanup locally, run `npx wrangler dev --test-scheduled` and open
`http://localhost:8787/__scheduled?cron=17+6+*+*+*`.

## Day-to-day

Look at the live data:

```sh
npx wrangler d1 execute hoondy-leaderboard --remote \
  --command "SELECT id, game, week, name, score, country FROM scores ORDER BY id DESC LIMIT 20"
```

Remove a row, for example a nickname that got past the filter:

```sh
npx wrangler d1 execute hoondy-leaderboard --remote --command "DELETE FROM scores WHERE id = 123"
```

The board catches up within 20 seconds. To watch requests and errors live, run `npx wrangler tail`.

## Settings

These live in `wrangler.toml` under `[vars]`. Run `npm run deploy` after changing them.

| name | default | what it does |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://hoondy.com,https://www.hoondy.com` | Sites allowed to call the API from a browser, comma-separated. `http://localhost:*` matches any port. |
| `RATE_LIMIT` | `6` | Posts allowed per network (IP, or /64 for IPv6) per game... |
| `RATE_WINDOW_MINUTES` | `10` | ...within this many minutes. |
| `NAMES_PER_CLIENT` | `3` | Nicknames one network can have on a game's board in a week. |
| `RETAIN_WEEKS` | `52` | Weeks older than this are deleted. |
| `IP_SALT` | (secret) | Salt for the IP hashes. Set it with `wrangler secret put`, never in the file. |

## API

`GET /v1/:game/top?limit=20`

```json
{
  "week": "2026-W42",
  "resetsAt": "2026-10-19T04:00:00.000Z",
  "entries": [
    { "id": 17, "rank": 1, "name": "hoondy", "score": 131, "country": "US",
      "detail": { "archetype": "visionary", "pct": 97.7, "lang": "en" }, "ts": 1791990720000 }
  ]
}
```

`ts` is when the player set that score. Ties go to whoever got there first.

`POST /v1/:game/scores` with `Content-Type: application/json`:

- leadership: `{ "name", "answers": [49 integers], "lang", "durationMs" }`
- rush-hour: `{ "name", "score", "detail": { "stage", "words", "misses", "accuracy", "wpm", "durationMs", "pack" }, "log": [...] }`

A successful post returns
`{ "ok": true, "id", "rank", "score", "best", "improved", "name", "week" }`. Here `score` is
what this post was worth, `best` is the player's best this week (that's the one on the board),
and `rank` is where that best stands.

Errors come back as `{ "ok": false, "error": "<code>" }`:

| status | error | meaning |
|---|---|---|
| 400 | `bad_json`, `bad_body` | The body isn't a JSON object. |
| 400 | `name` | The nickname is empty after cleaning, or it's on the block list. |
| 403 | `origin` | The request came from a page on a site that isn't allowed. |
| 404 | `unknown_game`, `not_found` | |
| 405 | `method` | |
| 413 | `too_large` | The body is over 8 KB (leadership) or 256 KB (rush-hour). |
| 415 | `content_type` | The request isn't `application/json`. |
| 422 | (game-specific) | The game's rules rejected the result, e.g. `too_fast`, `attention` or `straightline` for the LQ test, or `score mismatch` or `speed` for Rush Hour. |
| 429 | `rate_limited` | Too many posts. The `Retry-After` header says how many seconds to wait. |
| 429 | `too_many_names` | This network already has `NAMES_PER_CLIENT` nicknames on this week's board. Posting under one of those still works; `Retry-After` counts down to the weekly reset. |
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
- D1: 5 million rows read and 100,000 rows written a day, 5 GB of storage. A post writes at
  most four rows (the rate-limit counter, the score and its two indexes). Each board view
  reads up to 50 rows, unless the edge cache already has it.
- Cron triggers are included.

If a daily limit runs out, the API returns errors until the counters reset at midnight UTC.
Until then the boards show an out-of-service notice and posting fails with an error. Nothing
falls back to a board kept on the device.
