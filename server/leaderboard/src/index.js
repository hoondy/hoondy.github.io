// Monthly leaderboards and anonymous LQ test statistics for hoondy.com.
//
//   GET  /v1/:game/top?limit=20         this month's board, best first (limit 1..50)
//   POST /v1/:game/scores               submit a run; the game's validator decides the score
//   POST /v1/leadership/results         add one anonymous LQ result to the statistics
//   GET  /v1/leadership/distribution    histogram of LQ results so far
//
// Board players are identified by a salted hash of their network + nickname that rotates every
// month, and only their best score of the month is kept. LQ results are stored with no name, no
// time of day and nothing derived from the network. The raw IP is never written anywhere.

import { periodInfo } from '../../../assets/js/lib/period.js';
import { cleanName } from '../../../assets/js/lib/names.js';
import { GAMES, getGame } from './games.js';
import { HttpError, errorResponse, json, noContent, readJsonObject } from './http.js';
import { networkOf } from './ip.js';
import { binFor, checkResult, distribution } from './lq.js';
import { monthsBefore, nyDay, utcDayStart } from './time.js';
import * as db from './db.js';

const BOARD_SIZE = 50;
const DEFAULT_LIMIT = 20;
const BOARD_TTL = 20; // seconds a board may be served from the edge cache
const DIST_TTL = 300; // seconds for the LQ histogram
const MAX_DETAIL = 1024;
// 49 small integers, a language code, a duration and a version string come to about 200 bytes.
const LQ_MAX_BODY = 4 * 1024;
const LQ_SCOPE = 'lq-results'; // rate-limit bucket, kept apart from the game boards
// The LQ counter is keyed by only 16 bits of a salted hash of the network: enough to keep one
// connection from flooding the statistics, but shared by tens of thousands of IPv4 addresses,
// so even with the salt a counter row can't be traced to an address or matched to the boards'
// counters.
const LQ_TAG_HEX = 4;
const DEV_SALT = 'local-development-salt';

const BOARD_ROUTE = /^\/v1\/([a-z0-9-]{1,40})\/(top|scores)\/?$/;
const LQ_ROUTE = /^\/v1\/leadership\/(results|distribution)\/?$/;
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

function intSetting(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function settings(env, local) {
  const origins = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const salt = typeof env.IP_SALT === 'string' && env.IP_SALT.length >= 16 ? env.IP_SALT : null;
  return {
    exact: new Set(origins.filter((o) => !o.endsWith(':*'))),
    // "http://localhost:*" allows any port on that host.
    anyPort: origins.filter((o) => o.endsWith(':*')).map((o) => o.slice(0, -1)),
    rateLimit: intSetting(env.RATE_LIMIT, 6, 1, 1000),
    rateWindow: intSetting(env.RATE_WINDOW_MINUTES, 10, 1, 24 * 60),
    lqRateLimit: intSetting(env.LQ_RATE_LIMIT, 5, 1, 1000),
    lqRateWindow: intSetting(env.LQ_RATE_WINDOW_MINUTES, 60, 1, 24 * 60),
    maxNames: intSetting(env.NAMES_PER_CLIENT, 3, 1, 1000),
    retainMonths: intSetting(env.RETAIN_MONTHS, 24, 1, 240),
    // Without a real secret the hashes could be brute-forced back to IPs, so production
    // refuses to take posts until IP_SALT is set. Local dev gets a throwaway salt.
    salt: salt || (local ? DEV_SALT : null),
  };
}

function originAllowed(origin, cfg, local) {
  if (cfg.exact.has(origin)) return true;
  if (cfg.anyPort.some((p) => origin.startsWith(p) && /^\d{1,5}$/.test(origin.slice(p.length)))) return true;
  // While running under `wrangler dev`, accept pages served from this machine.
  return local && LOOPBACK_ORIGIN.test(origin);
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function countryOf(request) {
  const c = request.cf?.country;
  // XX means unknown; Tor exits come through as T1, which the pattern already rules out.
  return typeof c === 'string' && /^[A-Z]{2}$/.test(c) && c !== 'XX' ? c : null;
}

function parseDetail(text) {
  try {
    const d = JSON.parse(text);
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------------------------------
// Edge cache. One entry per board per month holds the top BOARD_SIZE rows; any `limit` is a
// slice of it. Posting deletes the entry in that data center so the poster sees their row
// right away; elsewhere it expires within BOARD_TTL. The LQ histogram is one entry that simply
// expires, stored with the time it was read so browsers only keep it for what's left of
// DIST_TTL. (The Cache API only does anything on a custom domain; on workers.dev every read
// goes to D1.)

function boardKey(url, game, period) {
  return new Request(`${url.origin}/_board/${game}/${period}`);
}

function distKey(url) {
  return new Request(`${url.origin}/_lq/distribution`);
}

async function cacheGet(key) {
  try {
    const hit = await caches.default.match(key);
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

function cachePut(ctx, key, data, ttl) {
  const res = new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` },
  });
  try {
    ctx.waitUntil(caches.default.put(key, res).catch(() => {}));
  } catch {
    /* no cache here */
  }
}

async function cacheDelete(key) {
  try {
    await caches.default.delete(key);
  } catch {
    /* nothing cached, or no cache here */
  }
}

// ------------------------------------------------------------------------------------------
// Shared checks for POSTs

function requireJson(request, maxBody, cfg) {
  if (!/^application\/json(\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    throw new HttpError(415, 'content_type');
  }
  if (Number(request.headers.get('content-length')) > maxBody) throw new HttpError(413, 'too_large');
  if (!cfg.salt) throw new HttpError(503, 'not_configured');
}

// Counts the attempt before doing any real work, so floods stay cheap. The key has no date in
// it, so the window slides across midnight; the rows themselves are gone after a day.
async function rateLimit(env, client, scope, limit, window, now) {
  const slot = { client, game: scope, minute: Math.floor(now / 60000), window, limit };
  if (!(await db.takeSlot(env.DB, slot))) {
    const wait = await db.minutesUntilSlot(env.DB, slot);
    throw new HttpError(429, 'rate_limited', { 'retry-after': String(wait * 60 - Math.floor((now / 1000) % 60)) });
  }
}

function networkFor(request) {
  return networkOf(request.headers.get('cf-connecting-ip') || '127.0.0.1');
}

// ------------------------------------------------------------------------------------------
// Boards

async function getTop(env, ctx, url, game) {
  const limit = intSetting(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, BOARD_SIZE);
  const period = periodInfo(new Date());
  const key = boardKey(url, game, period.key);

  let rows = await cacheGet(key);
  if (!rows) {
    rows = (await db.topScores(env.DB, game, period.key, BOARD_SIZE)).map((r, i) => ({
      id: r.id,
      rank: i + 1,
      name: r.name,
      score: r.score,
      country: r.country || null,
      detail: parseDetail(r.detail),
      ts: r.ts,
    }));
    cachePut(ctx, key, rows, BOARD_TTL);
  }

  return json(200, { period: period.key, resetsAt: period.resetsAt.toISOString(), entries: rows.slice(0, limit) });
}

async function postScore(request, env, url, game, def, cfg) {
  requireJson(request, def.maxBody, cfg);
  const net = networkFor(request);
  const now = Date.now();
  await rateLimit(env, await sha256(`${cfg.salt}|limit|${net}`), game, cfg.rateLimit, cfg.rateWindow, now);

  const body = await readJsonObject(request, def.maxBody);
  const name = cleanName(body.name);
  if (!name) throw new HttpError(400, 'name');

  let verdict;
  try {
    verdict = def.validate(body);
  } catch (err) {
    console.error('validate', game, err?.message || err);
    verdict = null;
  }
  if (!verdict || verdict.ok !== true) {
    const code = typeof verdict?.error === 'string' && verdict.error ? verdict.error.slice(0, 64) : 'invalid';
    throw new HttpError(422, code);
  }
  if (!Number.isSafeInteger(verdict.score) || verdict.score < 0) throw new HttpError(422, 'invalid');

  let detail = JSON.stringify(verdict.detail ?? {});
  if (detail.length > MAX_DETAIL) detail = '{}';

  const period = periodInfo(new Date(now));
  const client = await sha256(`${cfg.salt}|client|${period.key}|${net}`);
  const player = await sha256(`${cfg.salt}|player|${game}|${period.key}|${net}|${name.toLowerCase()}`);
  const saved = await db.saveScore(env.DB, {
    game,
    period: period.key,
    client,
    player,
    name,
    score: verdict.score,
    country: countryOf(request),
    detail,
    now,
    maxNames: cfg.maxNames,
  });
  if (!saved) {
    // This network already has its share of nicknames on this month's board.
    const wait = Math.max(1, Math.ceil((period.resetsAt.getTime() - now) / 1000));
    throw new HttpError(429, 'too_many_names', { 'retry-after': String(wait) });
  }

  await cacheDelete(boardKey(url, game, period.key));

  return json(200, {
    ok: true,
    id: saved.id,
    rank: saved.rank,
    score: verdict.score,
    best: saved.best,
    improved: saved.improved,
    name,
    period: period.key,
  });
}

// ------------------------------------------------------------------------------------------
// LQ statistics

async function postLqResult(request, env, cfg) {
  requireJson(request, LQ_MAX_BODY, cfg);
  const now = Date.now();
  // The network only feeds the rate-limit counter, as a short tag; nothing about it goes into
  // the result.
  const tag = (await sha256(`${cfg.salt}|lq|${networkFor(request)}`)).slice(0, LQ_TAG_HEX);
  await rateLimit(env, tag, LQ_SCOPE, cfg.lqRateLimit, cfg.lqRateWindow, now);

  const body = await readJsonObject(request, LQ_MAX_BODY);
  const row = checkResult(body);
  // The histogram's timestamp is public, so it only says which day (UTC) a bin last changed.
  // To the minute, it would line a result up with its rate-limit row.
  const n = await db.saveLqResult(env.DB, {
    ...row,
    day: nyDay(new Date(now)),
    bin: binFor(row.lq),
    stamp: utcDayStart(now),
  });
  return json(200, { ok: true, n });
}

async function getLqDistribution(env, ctx, url) {
  const key = distKey(url);
  const now = Date.now();
  const hit = await cacheGet(key);
  let data = hit?.dist;
  let age = 0;
  if (data && Number.isFinite(hit.at)) {
    age = Math.min(DIST_TTL, Math.max(0, Math.floor((now - hit.at) / 1000)));
  } else {
    data = distribution(await db.lqHistogram(env.DB));
    cachePut(ctx, key, { at: now, dist: data }, DIST_TTL);
  }
  return json(200, data, { 'cache-control': `public, max-age=${DIST_TTL - age}` });
}

// ------------------------------------------------------------------------------------------

function preflight(allow) {
  return noContent({
    allow,
    'access-control-allow-methods': allow,
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  });
}

function only(method, request) {
  const allow = `${method}, OPTIONS`;
  if (request.method === 'OPTIONS') return preflight(allow);
  if (request.method !== method) throw new HttpError(405, 'method', { allow });
  return null;
}

async function route(request, env, ctx, url, cfg) {
  const { pathname } = url;

  if (pathname === '/' || pathname === '/v1' || pathname === '/v1/') {
    if (request.method !== 'GET') throw new HttpError(405, 'method', { allow: 'GET' });
    return json(200, { ok: true, service: 'hoondy-leaderboard', games: Object.keys(GAMES), period: periodInfo().key });
  }

  const lq = LQ_ROUTE.exec(pathname);
  if (lq) {
    if (lq[1] === 'results') return only('POST', request) || postLqResult(request, env, cfg);
    return only('GET', request) || getLqDistribution(env, ctx, url);
  }

  const m = BOARD_ROUTE.exec(pathname);
  if (!m) throw new HttpError(404, 'not_found');
  const [, game, action] = m;
  const def = getGame(game);
  if (!def) throw new HttpError(404, 'unknown_game');

  if (action === 'top') return only('GET', request) || getTop(env, ctx, url, game);
  return only('POST', request) || postScore(request, env, url, game, def, cfg);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const local = LOOPBACK_HOST.test(url.hostname);
    const cfg = settings(env, local);
    const origin = request.headers.get('origin');
    const allowed = origin !== null && originAllowed(origin, cfg, local);

    let res;
    try {
      // Browsers always send Origin on cross-site requests; scripts and curl don't need CORS.
      if (origin !== null && !allowed) throw new HttpError(403, 'origin');
      res = await route(request, env, ctx, url, cfg);
    } catch (err) {
      res = errorResponse(err);
    }

    res.headers.set('vary', 'Origin');
    if (allowed) {
      res.headers.set('access-control-allow-origin', origin);
      res.headers.set('access-control-expose-headers', 'Retry-After');
    }
    return res;
  },

  async scheduled(controller, env, ctx) {
    const now = controller.scheduledTime || Date.now();
    const cfg = settings(env, false);
    const current = periodInfo(new Date(now)).key;
    ctx.waitUntil(
      db.cleanup(env.DB, {
        minute: Math.floor(now / 60000),
        currentPeriod: current,
        oldestPeriod: monthsBefore(current, cfg.retainMonths),
      }),
    );
  },
};
