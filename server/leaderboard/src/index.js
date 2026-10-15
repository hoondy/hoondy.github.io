// Weekly leaderboards for hoondy.com.
//
//   GET  /v1/:game/top?limit=20   this week's board, best first (limit 1..50)
//   POST /v1/:game/scores         submit a result; the game's validator decides the score
//
// Players are identified by a salted hash of their network + nickname that rotates every
// week, and only their best score of the week is kept. The raw IP is never written anywhere.

import { weekInfo } from '../../../assets/js/lib/week.js';
import { cleanName } from '../../../assets/js/lib/names.js';
import { GAMES, getGame } from './games.js';
import { HttpError, errorResponse, json, noContent, readJsonObject } from './http.js';
import { networkOf } from './ip.js';
import * as db from './db.js';

const BOARD_SIZE = 50;
const DEFAULT_LIMIT = 20;
const EDGE_TTL = 20; // seconds a board may be served from the edge cache
const MAX_DETAIL = 1024;
const DEV_SALT = 'local-development-salt';

const ROUTE = /^\/v1\/([a-z0-9-]{1,40})\/(top|scores)\/?$/;
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
    maxNames: intSetting(env.NAMES_PER_CLIENT, 3, 1, 1000),
    retainWeeks: intSetting(env.RETAIN_WEEKS, 52, 1, 520),
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
// Edge cache. One entry per board per week holds the top BOARD_SIZE rows; any `limit` is a
// slice of it. Posting deletes the entry in that data center so the poster sees their row
// right away; elsewhere it expires within EDGE_TTL. (The Cache API only does anything on a
// custom domain; on workers.dev every read goes to D1.)

function boardKey(url, game, week) {
  return new Request(`${url.origin}/_board/${game}/${week}`);
}

async function cacheGet(key) {
  try {
    const hit = await caches.default.match(key);
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

function cachePut(ctx, key, rows) {
  const res = new Response(JSON.stringify(rows), {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${EDGE_TTL}` },
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
// Handlers

async function getTop(env, ctx, url, game) {
  const limit = intSetting(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, BOARD_SIZE);
  const week = weekInfo(new Date());
  const key = boardKey(url, game, week.key);

  let rows = await cacheGet(key);
  if (!rows) {
    rows = (await db.topScores(env.DB, game, week.key, BOARD_SIZE)).map((r, i) => ({
      id: r.id,
      rank: i + 1,
      name: r.name,
      score: r.score,
      country: r.country || null,
      detail: parseDetail(r.detail),
      ts: r.ts,
    }));
    cachePut(ctx, key, rows);
  }

  return json(200, { week: week.key, resetsAt: week.resetsAt.toISOString(), entries: rows.slice(0, limit) });
}

async function postScore(request, env, url, game, def, cfg) {
  if (!/^application\/json(\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    throw new HttpError(415, 'content_type');
  }
  if (Number(request.headers.get('content-length')) > def.maxBody) throw new HttpError(413, 'too_large');
  if (!cfg.salt) throw new HttpError(503, 'not_configured');

  const net = networkOf(request.headers.get('cf-connecting-ip') || '127.0.0.1');
  const now = Date.now();
  const minute = Math.floor(now / 60000);

  // Count the attempt before doing any real work, so floods stay cheap. The key has no date in
  // it, so the window slides across midnight; the rows themselves are gone after a day.
  const slot = { client: await sha256(`${cfg.salt}|limit|${net}`), game, minute, window: cfg.rateWindow, limit: cfg.rateLimit };
  if (!(await db.takeSlot(env.DB, slot))) {
    const wait = await db.minutesUntilSlot(env.DB, slot);
    throw new HttpError(429, 'rate_limited', { 'retry-after': String(wait * 60 - Math.floor((now / 1000) % 60)) });
  }

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

  const week = weekInfo(new Date(now));
  const client = await sha256(`${cfg.salt}|client|${week.key}|${net}`);
  const player = await sha256(`${cfg.salt}|player|${game}|${week.key}|${net}|${name.toLowerCase()}`);
  const saved = await db.saveScore(env.DB, {
    game,
    week: week.key,
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
    // This network already has its share of nicknames on this week's board.
    const wait = Math.max(1, Math.ceil((week.resetsAt.getTime() - now) / 1000));
    throw new HttpError(429, 'too_many_names', { 'retry-after': String(wait) });
  }

  await cacheDelete(boardKey(url, game, week.key));

  return json(200, {
    ok: true,
    id: saved.id,
    rank: saved.rank,
    score: verdict.score,
    best: saved.best,
    improved: saved.improved,
    name,
    week: week.key,
  });
}

async function route(request, env, ctx, url, cfg) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/' || pathname === '/v1' || pathname === '/v1/') {
    if (method !== 'GET') throw new HttpError(405, 'method', { allow: 'GET' });
    return json(200, { ok: true, service: 'hoondy-leaderboard', games: Object.keys(GAMES), week: weekInfo().key });
  }

  const m = ROUTE.exec(pathname);
  if (!m) throw new HttpError(404, 'not_found');
  const [, game, action] = m;
  const allow = action === 'top' ? 'GET, OPTIONS' : 'POST, OPTIONS';

  if (method === 'OPTIONS') {
    return noContent({
      allow,
      'access-control-allow-methods': allow,
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    });
  }

  const def = getGame(game);
  if (!def) throw new HttpError(404, 'unknown_game');

  if (action === 'top') {
    if (method !== 'GET') throw new HttpError(405, 'method', { allow });
    return getTop(env, ctx, url, game);
  }
  if (method !== 'POST') throw new HttpError(405, 'method', { allow });
  return postScore(request, env, url, game, def, cfg);
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
    ctx.waitUntil(
      db.cleanup(env.DB, {
        minute: Math.floor(now / 60000),
        currentWeek: weekInfo(new Date(now)).key,
        oldestWeek: weekInfo(new Date(now - cfg.retainWeeks * 7 * 86400000)).key,
      }),
    );
  },
};
