// Anonymous LQ statistics: the score distribution on the results page, and the opt-in that
// adds a finished test to it. Both talk to the worker named in <meta name="leaderboard-api">.
// Without one, or when it can't be reached, the page shows the distribution the scoring model
// expects instead, so nothing here is allowed to break the result screen.

import { LANGS, LQ_MAX, LQ_MEAN, LQ_MIN, LQ_SD, VERSION, normalCdf, validateSubmission } from './scoring.js';
import { loadContribute, loadSent, markSent } from './store.js';

const API = (globalThis.document?.querySelector('meta[name="leaderboard-api"]')?.content || '').trim().replace(/\/+$/, '');
const TIMEOUT_MS = 8_000;
const CACHE_MS = 5 * 60_000;

export const STEP = 5;
// Bin i holds LQ 55 + 5i to 59 + 5i; the top bin also takes 145 (140–145).
export const BINS = Math.floor((LQ_MAX - LQ_MIN) / STEP);
// Fewer real results than this and the bars are mostly noise, so the model is shown instead.
export const MIN_REAL = 200;

export const hasApi = () => Boolean(API);

export const binOf = (lq) => Math.min(BINS - 1, Math.max(0, Math.floor((lq - LQ_MIN) / STEP)));

export function binRange(i) {
  const lo = LQ_MIN + i * STEP;
  return [lo, i === BINS - 1 ? LQ_MAX : lo + STEP - 1];
}

const sum = (xs) => xs.reduce((s, x) => s + x, 0);

/** Expected share of people per bin: LQ ~ Normal(100, 15), rounded and clamped to 55..145. */
export function modelBins() {
  return Array.from({ length: BINS }, (_, i) => {
    const [lo, hi] = binRange(i);
    const below = i === 0 ? 0 : normalCdf((lo - 0.5 - LQ_MEAN) / LQ_SD);
    const upTo = i === BINS - 1 ? 1 : normalCdf((hi + 0.5 - LQ_MEAN) / LQ_SD);
    return upTo - below;
  });
}

/**
 * Percent of results below `lq`. Only bins are known, so the part of the visitor's own bin
 * below them is taken as if the bin were spread evenly.
 */
export function percentileIn(bins, lq) {
  const total = sum(bins);
  if (!(total > 0)) return null;
  const i = binOf(lq);
  const [lo, hi] = binRange(i);
  const within = (Math.min(hi, Math.max(lo, lq)) - lo + 0.5) / (hi - lo + 1);
  return ((sum(bins.slice(0, i)) + bins[i] * within) / total) * 100;
}

async function request(path, init) {
  // GETs go without headers so they stay simple CORS requests; the POST needs a preflight
  // anyway because the worker only takes JSON.
  const headers = init?.body ? { 'content-type': 'application/json' } : {};
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API + path, { ...init, headers, signal: ctl.signal, credentials: 'omit' });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* an error page that isn't JSON */
    }
    if (!res.ok) {
      const err = new Error(body?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = body?.error;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function parseDistribution(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.bins) || d.bins.length !== BINS) return null;
  if ((d.min ?? LQ_MIN) !== LQ_MIN || (d.max ?? LQ_MAX) !== LQ_MAX || (d.step ?? STEP) !== STEP) return null;
  if (!d.bins.every((x) => Number.isInteger(x) && x >= 0)) return null;
  const total = sum(d.bins);
  const n = Number.isInteger(d.n) && d.n >= 0 ? d.n : total;
  return { n, bins: d.bins.slice(), total };
}

let cached = null;

/**
 * The real distribution, or null when there is no API or it can't be had within the timeout.
 * Resolves to { n, bins, total }; whether n is big enough to show is the caller's call.
 */
export function getDistribution() {
  if (!API) return Promise.resolve(null);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.promise;
  const promise = request('/v1/leadership/distribution')
    .then(parseDistribution)
    .catch(() => null);
  const entry = { at: Date.now(), promise };
  cached = entry;
  // Don't hold on to a failure; the next result screen can try again.
  promise.then((d) => {
    if (!d && cached === entry) cached = null;
  });
  return promise;
}

export const usable = (d) => Boolean(d && d.n >= MIN_REAL && d.total > 0);

// A finished test is identified by its answers, when it was finished and how long it took.
// The "r" prefix keeps the keys from looking like array indexes, which objects would reorder.
export function resultKey(last) {
  const s = `${last.answers.join(',')}|${last.ts || 0}|${Math.round(last.durationMs || 0)}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `r${h.toString(36)}`;
}

export function resultBody(last, lang) {
  return {
    answers: last.answers,
    lang: LANGS.includes(last.lang) ? last.lang : lang,
    durationMs: Math.round(last.durationMs),
    v: VERSION,
  };
}

const inFlight = new Map();

/**
 * Adds the result to the statistics if it qualifies and hasn't been sent before.
 * Resolves to 'added' | 'off' | 'invalid' | 'later' | 'failed'. 'later' is the worker turning
 * it away for now (rate limit, version skew); 'failed' is not getting an answer at all. Neither
 * is remembered, so the next look at the result tries again.
 */
export function contribute(last, lang) {
  const body = resultBody(last, lang);
  // The same check the worker runs; a flagged result is never sent.
  if (!validateSubmission(body).ok) return Promise.resolve('invalid');
  const key = resultKey(last);
  const prev = loadSent()[key];
  if (prev === 'added') return Promise.resolve('added');
  if (prev === 'rejected') return Promise.resolve('invalid');
  if (!loadContribute()) return Promise.resolve('off');
  if (!API) return Promise.resolve('failed');
  if (inFlight.has(key)) return inFlight.get(key);

  const p = request('/v1/leadership/results', { method: 'POST', body: JSON.stringify(body) })
    .then((res) => {
      if (res?.ok !== true) return 'failed';
      markSent(key, 'added');
      return 'added';
    })
    .catch((err) => {
      // A version mismatch means this page is older (or newer) than the worker; a reload can
      // fix that, as time fixes a rate limit, so neither is remembered. Any other 422 is the
      // worker refusing the answers.
      if (err.status === 429 || err.code === 'version') return 'later';
      if (err.status === 422) {
        markSent(key, 'rejected');
        return 'invalid';
      }
      return 'failed';
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
