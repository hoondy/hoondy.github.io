// Builders for realistic submissions, made with the same rule modules the worker uses.

import { DIM_IDS, ITEMS, VERSION, scoreAnswers } from '../../../assets/apps/leadership/scoring.js';
import { HOLD_MS, KIND, RESUME_MS, lengthRange, replay, stats, wordsForStage } from '../../../assets/apps/rush-hour/rules.js';
import { Game } from '../../../assets/apps/scorched-borough/game.js';
import { Brain } from '../../../assets/apps/scorched-borough/cpu.js';
import { WEAPON_ORDER, mulberry32, simulateShot } from '../../../assets/apps/scorched-borough/physics.js';
import { VERSION as SB_VERSION, validateSubmission as sbValidate } from '../../../assets/apps/scorched-borough/rules.js';

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

/** The body the results page posts to /v1/leadership/results, and what it should score. */
export function lqResultBody(levels, extra = {}) {
  const answers = leadershipAnswers(levels);
  const durationMs = 4 * 60 * 1000;
  const expected = scoreAnswers(answers, { durationMs });
  if (!expected.valid) throw new Error(`fixture is not valid: ${expected.flags.join(',')}`);
  return { body: { answers, lang: 'en', durationMs, v: VERSION, ...extra }, expected };
}

/**
 * A plausible Rush Hour run: `words` cleared words of about `len` letters (kept inside what
 * each stage deals), one every `gapMs`, a wrong key every `typoEvery` words and a missed word
 * at each index in `missAt`. The run waits out the hold after every stage change. Unless `vary` is
 * off, word lengths are picked at random within what each stage deals, so every call is a
 * different ride (the board only takes each ride once).
 */
export function rushHourRun({ words = 30, len = 6, gapMs = 1400, typoEvery = 9, missAt = [], pack = 'nyc', vary = true } = {}) {
  const log = [];
  let t = 0;
  let stage = 1;
  let inStage = 0;
  let streak = 0;
  for (let i = 0; i < words; i++) {
    t += gapMs;
    const [lo, hi] = lengthRange(stage);
    const n = vary ? lo + Math.floor(Math.random() * (hi - lo + 1)) : Math.min(hi, Math.max(lo, len));
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

// ------------------------------------------------------------------------------------------
// Scorched Borough

const FRAME = 1 / 60;
const ROUND_BREAK_MS = 2600;

const runToEnd = (gen) => {
  for (;;) {
    const { value, done } = gen.next();
    if (done) return value;
  }
};

/**
 * Plays one Scorched Borough match the way the page does: the real game in live mode, stepped
 * one 60 Hz frame at a time, the CPU's Brain on its side and another Brain standing in for the
 * player (`you` sets how good). Everything comes from `seed`, so the same arguments always give
 * the same match. Returns { winner, body } where body is what the page would post.
 */
export function playScorched({ level = 'normal', seed = 1, you = 'hard' } = {}) {
  const game = new Game({ level, seed });
  const rng = mulberry32(seed ^ 0x5bd1e995);
  const brains = [new Brain(you, rng), new Brain(level, rng)];
  let clock = 0;
  let turnAt = 0;
  game.startRound();
  for (let guard = 0; game.phase !== 'match-over' && guard < 500000; guard++) {
    for (const e of game.drain()) {
      if (e.type === 'turn') turnAt = clock;
      if (e.type === 'round') brains.forEach((b) => b.reset());
      if (e.type === 'impact') brains[e.owner].observe(e);
    }
    if (game.phase === 'aim') {
      const side = game.turn;
      const plan = runToEnd(brains[side].plan(game.world, side, 1 - side, game.ammo[side]));
      clock += Math.round(brains[side].thinkTime()) + 40;
      game.fire(plan.angle, plan.power, plan.weapon, clock - turnAt);
    } else if (game.phase === 'round-over') {
      clock += ROUND_BREAK_MS;
      game.nextRound();
    } else {
      clock += FRAME * 1000;
      game.update(FRAME);
    }
  }
  const log = {
    v: SB_VERSION,
    level: game.level,
    seed: game.seed,
    durationMs: Math.round(clock),
    rounds: game.history.map((r) => ({ first: r.first === 0 ? 'you' : 'cpu', shots: r.shots })),
  };
  const body = { log };
  if (game.matchWinner === 0) {
    const v = sbValidate({ log });
    if (!v.ok) throw new Error(`fixture does not replay: ${v.error}`);
    Object.assign(body, { score: v.score, detail: v.detail });
  }
  return { winner: game.matchWinner, body };
}

/** The first match from `seed` on that ends the way `want` says (0: you win, 1: the CPU does). */
export function scorchedMatch({ level = 'normal', seed = 1, want = 0, you = want === 0 ? 'hard' : 'easy' } = {}) {
  for (let s = seed; s < seed + 40; s++) {
    const m = playScorched({ level, seed: s, you });
    if (m.winner === want) return m.body;
  }
  throw new Error('no fixture match');
}

/** Replays a log's rounds one by one: who won each and how many shots you fired in it. */
export function scorchedRounds(log) {
  const game = new Game({ level: log.level, seed: log.seed, replay: true });
  return log.rounds.map((round, r) => {
    if (r === 0) game.startRound();
    else game.nextRound();
    for (const [, a, p, w, ms] of round.shots) {
      game.fire(a / 10, p / 10, WEAPON_ORDER[w], ms);
      game.resolve();
    }
    return { winner: game.winner, yours: game.roundShots[0] };
  });
}

/**
 * Swaps the CPU's first shot in a log for a heavy shell lobbed almost straight up, so it comes
 * down on the CPU itself. Returns the forged log, or null if no such shot turns up.
 */
export function cpuSelfHitLog(log) {
  const game = new Game({ level: log.level, seed: log.seed, replay: true });
  game.startRound();
  const shots = log.rounds[0].shots;
  const at = shots.findIndex((s) => s[0] === 1);
  for (const [, a, p, w, ms] of shots.slice(0, at)) {
    game.fire(a / 10, p / 10, WEAPON_ORDER[w], ms);
    game.resolve();
  }
  for (let p = 60; p <= 450; p += 5) {
    for (let a = 700; a <= 1100; a += 5) {
      const hit = simulateShot(game.world, 1, a / 10, p / 10, 'heavy');
      if (hit.type === 'tank' && hit.tank === 1) {
        const forged = structuredClone(log);
        forged.rounds[0].shots[at] = [1, a, p, WEAPON_ORDER.indexOf('heavy'), shots[at][4]];
        return forged;
      }
    }
  }
  return null;
}
