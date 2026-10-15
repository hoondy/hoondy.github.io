// Everything the test keeps in this browser. Answers never leave the device unless the
// person posts to the leaderboard.

import { ITEMS } from './scoring.js';

const PROGRESS_KEY = 'lq:progress';
const LAST_KEY = 'lq:last';
const SHARED_KEY = 'lq:shared';

// Saved answers stay usable across re-norming (same items, new norms) but not across a
// change to the questions themselves, so they are tagged with the item list, not VERSION.
const ITEM_SIG = (() => {
  let h = 5381;
  for (const ch of ITEMS.map((it) => it.id).join(',')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `${ITEMS.length}.${h.toString(36)}`;
})();

// Touching window.localStorage can itself throw when storage is blocked, so the lookup
// happens inside the try.
const area = (kind) => (kind === 'session' ? window.sessionStorage : window.localStorage);

function read(kind, key) {
  try {
    const raw = area(kind).getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(kind, key, value) {
  try {
    if (value == null) area(kind).removeItem(key);
    else area(kind).setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or full storage: the test still works, it just won't resume */
  }
}

function cleanAnswers(a) {
  if (!Array.isArray(a) || a.length !== ITEMS.length) return null;
  return a.map((v) => (Number.isInteger(v) ? v : null));
}

export function loadProgress() {
  const p = read('local', PROGRESS_KEY);
  if (!p || p.items !== ITEM_SIG) return null;
  const answers = cleanAnswers(p.answers);
  if (!answers) return null;
  return {
    answers,
    pos: Number.isInteger(p.pos) ? Math.max(0, Math.min(ITEMS.length - 1, p.pos)) : 0,
    elapsed: Number.isFinite(p.elapsed) && p.elapsed > 0 ? p.elapsed : 0,
    durationMs: Number.isFinite(p.durationMs) && p.durationMs > 0 ? p.durationMs : 0,
    started: p.started || Date.now(),
  };
}

export function saveProgress(p) {
  write('local', PROGRESS_KEY, p && { ...p, items: ITEM_SIG, updated: Date.now() });
}

export function clearProgress() {
  write('local', PROGRESS_KEY, null);
}

export function answeredCount(p) {
  return p ? p.answers.filter((v) => v !== null).length : 0;
}

export function loadLast() {
  const l = read('local', LAST_KEY);
  if (!l || l.items !== ITEM_SIG) return null;
  const answers = cleanAnswers(l.answers);
  if (!answers || answers.some((v) => v === null)) return null;
  return { ...l, answers };
}

export function saveLast(l) {
  write('local', LAST_KEY, l && { ...l, items: ITEM_SIG });
}

// A shared result someone arrived with, kept for the session so their result page can
// show it next to their own.
export function loadShared() {
  return read('session', SHARED_KEY);
}

export function saveShared(code) {
  write('session', SHARED_KEY, code ? { code } : null);
}
