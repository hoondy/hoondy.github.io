// Scorched Borough records.
//
// A won match can go on the monthly records board. The page keeps a log of the match while you
// play (the seed, the difficulty and every shot either tank fired), and the leaderboard server
// replays that log with this module and the same game code, so the score on the board is
// whatever the match was actually worth. The replay rebuilds every round from the seed and
// fires every shot again: terrain, wind, turn order, ammo, flight, craters, falls and damage.
// Keep this module free of DOM, timers and network code: it also runs inside the worker.
//
// Log (all numbers are integers):
//   {
//     v: VERSION,
//     level: 'easy' | 'normal' | 'hard',
//     seed: 0..2^30-1,           the match seed; rounds and wind all come from it
//     durationMs,                from Start match to the final blast settling
//     rounds: [{
//       first: 'you' | 'cpu',    who opened the round (you in rounds 1 and 3)
//       shots: [[who, angle, power, weapon, ms], ...]
//     }]
//   }
// who is 0 for you and 1 for the CPU, angle is in tenths of a degree (0..1800), power in
// tenths (0..1000), weapon an index into WEAPON_ORDER, and ms how long that turn took before
// the shot went off. The CPU's shots are part of the log; the server doesn't second-guess its
// aim, it checks that the shots it fired add up to the match you played. Since a log can make
// the CPU shoot however it likes, nothing the CPU's shots do can earn you points: a CPU shot
// that hurts or buries the CPU itself is refused, and the points only look at your shots in
// the rounds you won. The one CPU shot that may cost it armor is the one the real CPU fires to
// dig itself out after you buried it, and only with the shell the real CPU uses for that.

import { Game, LEVELS, SEED_MAX, SETTLE_MIN } from './game.js';
import { DT, WEAPON_ORDER, isBuried } from './physics.js';
import { PROFILES, digOutWeapon } from './cpu.js';

// 1.1.0: a buried tank's shot goes off on top of it.
export const VERSION = '1.1.0';

// Points: a win is worth WIN_POINTS, minus SHOT_COST for every shot you fired in the two rounds
// you won, never less than MIN_POINTS, all times the difficulty. A round the CPU took doesn't
// count either way, and neither does the armor left over: how well the CPU shot isn't something
// the replay can vouch for, so the points don't depend on it.
export const LEVEL_MULTIPLIER = Object.freeze({ easy: 1, normal: 2, hard: 3 });
export const WIN_POINTS = 1000;
export const SHOT_COST = 40;
export const MIN_POINTS = 100;

export const MAX_SHOTS_PER_ROUND = 120; // both tanks together
export const MAX_TURN_MS = 60 * 60 * 1000;
export const MAX_DURATION_MS = 6 * 60 * 60 * 1000;
// Frame timing can put a turn's clock a frame or so ahead of the game's own clock.
const SLACK_PER_SHOT_MS = 60;
const SLACK_MS = 500;

const SIDES = ['you', 'cpu'];
const fail = (error) => ({ ok: false, error });
const isInt = (v) => Number.isSafeInteger(v);
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Points for a won match. `shots` counts your shots in the rounds you won. */
export function scoreMatch({ level, shots }) {
  if (!Object.hasOwn(LEVEL_MULTIPLIER, level) || !isInt(shots) || shots < 0) return 0;
  return LEVEL_MULTIPLIER[level] * Math.max(MIN_POINTS, WIN_POINTS - SHOT_COST * shots);
}

// The CPU never fires before it has "thought" for at least this long.
export const cpuMinTurnMs = (level) => PROFILES[level].think[0];

/**
 * Replays a match log. Returns { ok: true, level, won, lost, winner, shots: [you, cpu], scoring,
 * count, minMs } or { ok: false, error }. `scoring` is how many shots you fired in the rounds you
 * won, and `minMs` is the least real time the match can have taken.
 */
export function replay(log) {
  if (!isObject(log)) return fail('log');
  if (log.v !== VERSION) return fail('version');
  const { level, seed, rounds } = log;
  if (!Object.hasOwn(LEVELS, level)) return fail('level');
  if (!isInt(seed) || seed < 0 || seed > SEED_MAX) return fail('seed');
  if (!Array.isArray(rounds) || rounds.length < 1 || rounds.length > 3) return fail('rounds');

  const cpuMin = cpuMinTurnMs(level);
  const game = new Game({ level, seed, replay: true });
  let minMs = 0;
  let shotCount = 0;
  let scoring = 0;

  for (let r = 0; r < rounds.length; r++) {
    const round = rounds[r];
    if (!isObject(round) || !Array.isArray(round.shots)) return fail('round');
    if (r === 0) game.startRound();
    else if (game.phase === 'round-over') game.nextRound();
    else return fail('extra round');
    if (round.first !== SIDES[game.first]) return fail('turn order');
    if (round.shots.length < 1 || round.shots.length > MAX_SHOTS_PER_ROUND) return fail('shots');

    for (const shot of round.shots) {
      if (!Array.isArray(shot) || shot.length !== 5 || !shot.every(isInt)) return fail('shot');
      if (game.phase !== 'aim') return fail('extra shots');
      const [who, angle, power, w, ms] = shot;
      if (who !== game.turn) return fail('turn order');
      if (angle < 0 || angle > 1800 || power < 0 || power > 1000) return fail('aim');
      const weapon = WEAPON_ORDER[w];
      if (!weapon) return fail('weapon');
      if (!(game.ammo[who][weapon] > 0)) return fail('ammo');
      if (ms < 0 || ms > MAX_TURN_MS) return fail('turn time');
      if (who === 1 && ms < cpuMin) return fail('turn time');
      const cpuArmor = game.tanks[1].hp;
      // Buried, a shell goes off on top of the tank that fired it. Only your dirt bombs ever bury
      // the real CPU, and it always digs out with the same shell, which costs it a fixed amount
      // (and never a fall: that crater is too shallow). Anything else is a forged turn.
      const cpuBuried = who === 1 && isBuried(game.terr.h, game.tanks[1]);
      if (cpuBuried && weapon !== digOutWeapon(game.ammo[1])) return fail('cpu self-hit');
      game.fire(angle / 10, power / 10, weapon, ms);
      game.resolve();
      // The real CPU aims away from itself and all but never hurts itself; a log that has it do
      // so is handing you free damage. This covers direct hits, blasts and falls alike, and a
      // dirt bomb on its own head, which would make its next shot blow up on it.
      if (who === 1 && !cpuBuried && (game.tanks[1].hp < cpuArmor || isBuried(game.terr.h, game.tanks[1]))) return fail('cpu self-hit');
      shotCount++;
      minMs += ms + game.flightTicks * DT * 1000 + SETTLE_MIN * 1000 - SLACK_PER_SHOT_MS;
    }
    if (game.phase !== 'round-over' && game.phase !== 'match-over') return fail('unfinished');
    if (game.winner === 0) scoring += game.roundShots[0];
  }
  if (game.phase !== 'match-over') return fail('unfinished');

  const { durationMs } = log;
  if (!isInt(durationMs) || durationMs > MAX_DURATION_MS || durationMs < minMs - SLACK_MS) return fail('duration');

  const winner = game.matchWinner;
  return {
    ok: true,
    level,
    winner,
    won: game.score[0],
    lost: game.score[1],
    shots: game.shots.slice(),
    scoring,
    count: shotCount,
    minMs: Math.max(0, Math.round(minMs)),
  };
}

/**
 * Checks a records board submission: { name, score?, detail?, log }. The match is replayed, it
 * has to be a win for you, and the score is recomputed from it; a claimed score has to match.
 * Returns { ok: true, score, detail: { level, rounds: '2-1', shots } } or { ok: false, error },
 * where `shots` are the ones that count: yours, in the rounds you won.
 */
export function validateSubmission(body) {
  if (!isObject(body)) return fail('body');
  const { score, detail } = body;
  if (score !== undefined && (!isInt(score) || score <= 0)) return fail('score');
  if (detail !== undefined && !isObject(detail)) return fail('detail');

  const r = replay(body.log);
  if (!r.ok) return r;
  if (r.winner !== 0) return fail('not a win');

  const out = { level: r.level, rounds: `${r.won}-${r.lost}`, shots: r.scoring };
  const points = scoreMatch({ level: r.level, shots: r.scoring });
  if (score !== undefined && score !== points) return fail('score mismatch');
  if (detail) {
    for (const k of Object.keys(out)) {
      if (detail[k] !== undefined && detail[k] !== out[k]) return fail('detail mismatch');
    }
  }
  return { ok: true, score: points, detail: out };
}
