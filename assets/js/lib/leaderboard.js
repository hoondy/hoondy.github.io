// Weekly leaderboards.
//
// When the page carries <meta name="leaderboard-api" content="https://...">, scores go to the
// worker in /server/leaderboard and everyone shares one board per game per week. Without it
// the board lives in this browser only, so the apps still work on a plain static host.

import { weekInfo, weekLabel } from './week.js';
import { cleanName, NAME_MAX } from './names.js';

const API = (document.querySelector('meta[name="leaderboard-api"]')?.content || '').trim().replace(/\/+$/, '');
const LOCAL_LIMIT = 50;
const CACHE_MS = 30_000;
const TIMEOUT_MS = 8_000;

export { cleanName, NAME_MAX, weekInfo, weekLabel };

export const isGlobal = () => Boolean(API);

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode or storage full: the board just won't persist */
    }
  },
};

export function getPlayerName() {
  return store.get('lb:name', '');
}

export function setPlayerName(name) {
  const clean = cleanName(name);
  if (clean) store.set('lb:name', clean);
  return clean;
}

export function getPersonalBest(game) {
  return store.get(`lb:pb:${game}`, null);
}

function rememberBest(game, score, detail) {
  const pb = getPersonalBest(game);
  if (!pb || score > pb.score) {
    store.set(`lb:pb:${game}`, { score, detail, ts: Date.now() });
    return true;
  }
  return false;
}

function localKey(game, week) {
  return `lb:local:${game}:${week}`;
}

function ranked(entries) {
  return entries
    .slice()
    .sort((a, b) => b.score - a.score || a.ts - b.ts)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

function mineIds(game) {
  return new Set(store.get(`lb:mine:${game}`, []));
}

function addMine(game, id) {
  const ids = store.get(`lb:mine:${game}`, []);
  ids.push(id);
  store.set(`lb:mine:${game}`, ids.slice(-100));
}

async function request(path, init) {
  // Only POSTs carry JSON; leaving GETs header-free keeps them simple CORS requests (no preflight).
  const headers = init?.body ? { 'content-type': 'application/json' } : {};
  // A server that accepts the connection and never answers would otherwise leave the
  // board on "Loading…" forever; an abort falls into the normal error paths.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API + path, { ...init, signal: ctl.signal, headers: { ...headers, ...(init?.headers || {}) } });
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const err = new Error(body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function localTop(game, limit) {
  const week = weekInfo();
  const mine = mineIds(game);
  const entries = ranked(store.get(localKey(game, week.key), []))
    .slice(0, limit)
    .map((e) => ({ ...e, me: mine.has(e.id) }));
  return { global: false, week: week.key, resetsAt: week.resetsAt.toISOString(), entries };
}

function clearCache(game) {
  try {
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith(`lb:cache:${game}:`))
      .forEach((k) => sessionStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

/**
 * Top scores for the current week.
 * @returns {Promise<{global:boolean, week:string, resetsAt:string, entries:Array<{rank:number,name:string,score:number,country?:string,detail?:object,ts:number,me?:boolean}>, error?:string}>}
 */
export async function getTop(game, { limit = 20, fresh = false } = {}) {
  if (!API) return localTop(game, limit);

  const cacheKey = `lb:cache:${game}:${limit}`;
  if (!fresh) {
    try {
      const hit = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    } catch {
      /* ignore */
    }
  }

  try {
    const data = await request(`/v1/${encodeURIComponent(game)}/top?limit=${limit}`);
    const mine = mineIds(game);
    const out = {
      global: true,
      week: data.week,
      resetsAt: data.resetsAt,
      entries: data.entries.map((e, i) => ({ ...e, rank: e.rank ?? i + 1, me: mine.has(e.id) })),
    };
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data: out }));
    } catch {
      /* ignore */
    }
    return out;
  } catch (err) {
    // Scores only ever go to the server in this mode, so a device board would just be empty.
    const week = weekInfo();
    return { global: true, week: week.key, resetsAt: week.resetsAt.toISOString(), entries: [], error: err.message || 'unavailable' };
  }
}

/**
 * Submit a score. `payload` is game specific; it always has `name`, and either `score`
 * (+ optional `detail`) or the raw data the server re-scores (e.g. `answers` for the
 * leadership test). `localScore` is what to store when no server is configured.
 * @returns {Promise<{ok:boolean, global:boolean, rank?:number, score?:number, week?:string, best?:boolean, error?:string}>}
 */
export async function submit(game, payload, { localScore = payload.score, detail = payload.detail } = {}) {
  const name = cleanName(payload.name);
  if (!name) return { ok: false, global: isGlobal(), error: 'name' };
  setPlayerName(name);

  if (API) {
    try {
      const res = await request(`/v1/${encodeURIComponent(game)}/scores`, {
        method: 'POST',
        body: JSON.stringify({ ...payload, name }),
      });
      if (res.id) addMine(game, res.id);
      clearCache(game);
      const best = rememberBest(game, res.score, detail);
      return { ok: true, global: true, rank: res.rank, score: res.score, week: res.week, best };
    } catch (err) {
      return { ok: false, global: true, error: err.message || 'unavailable', status: err.status };
    }
  }

  // Same rule as the server: one row per nickname per week, best score kept.
  const week = weekInfo();
  const key = localKey(game, week.key);
  const entries = store.get(key, []);
  const same = (e) => e.name.toLowerCase() === name.toLowerCase();
  const prev = entries.find(same);
  let entry = prev;
  if (!prev || localScore > prev.score) {
    entry = { id: prev?.id || `${Date.now()}`, name, score: localScore, detail, ts: Date.now() };
  }
  const top = ranked([...entries.filter((e) => !same(e)), entry]).slice(0, LOCAL_LIMIT);
  store.set(key, top.map(({ rank, ...e }) => e));
  if (!mineIds(game).has(entry.id)) addMine(game, entry.id);
  const rank = top.find((e) => e.id === entry.id)?.rank;
  const best = rememberBest(game, localScore, detail);
  return { ok: true, global: false, rank, score: localScore, week: week.key, best };
}

const FLAG_BASE = 0x1f1e6 - 65;
export function flag(country) {
  if (!country || !/^[A-Z]{2}$/.test(country)) return '';
  return String.fromCodePoint(FLAG_BASE + country.charCodeAt(0), FLAG_BASE + country.charCodeAt(1));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function timeLeft(resetsAt, now = Date.now()) {
  const ms = Math.max(0, new Date(resetsAt).getTime() - now);
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return { d, h, m, ms };
}

/**
 * Render a board into `el` using the shared `.board` markup (styled in main.css).
 * opts.formatScore(entry) -> string, opts.formatMeta(entry) -> string (plain text),
 * opts.labels: { title, empty, local, unavailable, resets, you, units: { d, h, m } } for translation,
 * opts.locale for the week dates (defaults to the page language).
 */
export function renderBoard(el, data, opts = {}) {
  const L = {
    title: 'This week',
    empty: 'No scores yet this week. Be the first.',
    local: 'Scores saved on this device',
    resets: 'Resets in',
    you: 'you',
    unavailable: 'The board is out of service right now.',
    ...(opts.labels || {}),
  };
  const U = { d: 'd', h: 'h', m: 'm', ...(opts.labels?.units || {}) };
  const fmtScore = opts.formatScore || ((e) => e.score.toLocaleString());
  const fmtMeta = opts.formatMeta || (() => '');
  const t = timeLeft(data.resetsAt);
  const left = t.d > 0 ? `${t.d}${U.d} ${t.h}${U.h}` : `${t.h}${U.h} ${t.m}${U.m}`;

  const rows = data.entries.length
    ? data.entries
        .map((e) => {
          const meta = fmtMeta(e);
          return `<li class="board__row${e.me ? ' board__row--me' : ''}">
  <span class="board__rank">${Number.isInteger(e.rank) ? e.rank : ''}</span>
  <span class="board__name">${e.country ? `<span class="board__flag" aria-hidden="true">${flag(e.country)}</span>` : ''}${escapeHtml(e.name)}${e.me ? ` <span class="board__you">${escapeHtml(L.you)}</span>` : ''}${meta ? `<span class="board__meta">${escapeHtml(meta)}</span>` : ''}</span>
  <span class="board__score">${escapeHtml(fmtScore(e))}</span>
</li>`;
        })
        .join('')
    : `<li class="board__empty">${escapeHtml(data.error ? L.unavailable : L.empty)}</li>`;

  el.innerHTML = `<div class="board">
  <div class="board__head">
    <span class="board__title">${escapeHtml(L.title)} <span class="board__week">${escapeHtml(weekLabel(data.week, opts.locale || document.documentElement.lang || 'en'))}</span></span>
    <span class="board__reset">${escapeHtml(L.resets)} ${escapeHtml(left)}</span>
  </div>
  <ol class="board__list">${rows}</ol>
  ${data.global ? '' : `<p class="board__note">${escapeHtml(L.local)}</p>`}
</div>`;
}
