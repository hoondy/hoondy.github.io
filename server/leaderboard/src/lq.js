// Anonymous LQ test statistics. The test has no public board; instead each completed, valid
// test can add one anonymous row, and a small histogram of LQ scores is kept up to date so the
// results page can show where a visitor lands among real test takers.

import { ARCHETYPE_IDS, LANGS, LQ_MAX, LQ_MIN, VERSION, validateSubmission } from '../../../assets/apps/leadership/scoring.js';
import { HttpError } from './http.js';
import { utcDayStart } from './time.js';

export const LQ_STEP = 5;
// Bin i holds LQ_MIN + 5i … LQ_MIN + 5i + 4; the top bin also takes LQ_MAX itself (140–145).
export const LQ_BINS = Math.floor((LQ_MAX - LQ_MIN) / LQ_STEP);

export function binFor(lq) {
  return Math.min(LQ_BINS - 1, Math.max(0, Math.floor((lq - LQ_MIN) / LQ_STEP)));
}

// Turns a posted result into the row to store, or throws a 422. The answers are re-scored with
// the same module the page uses; nothing the client says about its own score is read.
export function checkResult(body) {
  // Results scored under other rules (an old cached page, or a page newer than this worker)
  // would put answers in the wrong slots, so they're turned away rather than mixed in.
  if (body.v !== VERSION) throw new HttpError(422, 'version');

  let verdict;
  try {
    verdict = validateSubmission(body);
  } catch (err) {
    console.error('validate', 'leadership', err?.message || err);
    verdict = null;
  }
  if (!verdict || verdict.ok !== true) {
    const code = typeof verdict?.error === 'string' && verdict.error ? verdict.error.slice(0, 64) : 'invalid';
    throw new HttpError(422, code);
  }

  const lq = verdict.score;
  const archetype = verdict.detail?.archetype;
  if (!Number.isInteger(lq) || lq < LQ_MIN || lq > LQ_MAX || !ARCHETYPE_IDS.includes(archetype) || !LANGS.includes(body.lang)) {
    throw new HttpError(422, 'invalid');
  }
  // The validator has already checked every answer is a small integer in range.
  return { lq, archetype, lang: body.lang, version: VERSION, answers: JSON.stringify(body.answers) };
}

// `updatedAt` is the UTC day of the latest result. The worker already stores only the day; it's
// rounded down here too, so the public field never carries a time of day.
export function distribution(rows) {
  const bins = new Array(LQ_BINS).fill(0);
  let n = 0;
  let updated = 0;
  for (const r of rows) {
    if (!Number.isInteger(r.bin) || r.bin < 0 || r.bin >= LQ_BINS) continue;
    bins[r.bin] = r.count;
    n += r.count;
    updated = Math.max(updated, r.updated_at || 0);
  }
  return { n, min: LQ_MIN, max: LQ_MAX, step: LQ_STEP, bins, updatedAt: updated ? new Date(utcDayStart(updated)).toISOString() : null };
}
