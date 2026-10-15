// Builders for realistic submissions, made with the same rule modules the worker uses.

import { DIM_IDS, ITEMS, scoreAnswers } from '../../../assets/apps/leadership/scoring.js';
import { HOLD_MS, KIND, RESUME_MS, lengthRange, replay, stats, wordsForStage } from '../../../assets/apps/rush-hour/rules.js';

// Real people don't give every statement about a trait the same answer.
const WOBBLE = [0, -1, 0, 1, 0];

/**
 * Answers for someone whose standing on each dimension is `levels[dim]` (1..5, 5 = most
 * leader-like; 3 when not given).
 */
export function leadershipAnswers(levels = {}) {
  const seen = Object.fromEntries(DIM_IDS.map((d) => [d, 0]));
  return ITEMS.map((it) => {
    if (it.type === 'attention') return it.expect;
    const lv = levels[it.dim] ?? 3;
    if (it.type === 'sjt') return it.scores.indexOf(Math.round(((lv - 1) * 3) / 4));
    const keyed = Math.min(5, Math.max(1, lv + WOBBLE[seen[it.dim]++ % WOBBLE.length]));
    return it.key > 0 ? keyed : 6 - keyed;
  });
}

export function leadershipBody(name, levels, extra = {}) {
  const answers = leadershipAnswers(levels);
  const durationMs = 4 * 60 * 1000;
  const expected = scoreAnswers(answers, { durationMs });
  if (!expected.valid) throw new Error(`fixture is not valid: ${expected.flags.join(',')}`);
  return { body: { name, answers, lang: 'en', durationMs, ...extra }, expected };
}

/**
 * A plausible Rush Hour run: `words` cleared words of about `len` letters (kept inside what
 * each stage deals), one every `gapMs`, a wrong key every `typoEvery` words and a missed word
 * at each index in `missAt`. The run waits out the hold after every stage change.
 */
export function rushHourRun({ words = 30, len = 6, gapMs = 1400, typoEvery = 9, missAt = [], pack = 'nyc' } = {}) {
  const log = [];
  let t = 0;
  let stage = 1;
  let inStage = 0;
  let streak = 0;
  for (let i = 0; i < words; i++) {
    t += gapMs;
    const [lo, hi] = lengthRange(stage);
    const n = Math.min(hi, Math.max(lo, len));
    if (missAt.includes(i)) {
      log.push([t - 200, -n]);
      streak = 0;
    }
    if (typoEvery && i % typoEvery === typoEvery - 1) {
      log.push([t - 100, 0]);
      streak = 0;
    }
    log.push([t, n, stage, streak, KIND.NORMAL]);
    streak++;
    if (++inStage >= wordsForStage(stage)) {
      stage++;
      inStage = 0;
      t += HOLD_MS + RESUME_MS;
    }
  }
  const r = replay(log);
  if (!r.ok) throw new Error(`fixture is not valid: ${r.error}`);
  const durationMs = r.lastT + 800;
  const { wpm, accuracy } = stats(r.chars, r.typos, durationMs);
  return {
    score: r.score,
    detail: { stage: r.stage, words: r.words, misses: r.misses, accuracy, wpm, durationMs, pack },
    log,
  };
}
