// Rush Hour scoring rules.
//
// The game records a compact log while you play and the leaderboard server replays it with
// these same functions, so a score on the board is whatever the rules say the log is worth.
// Keep this module free of DOM, timers and network code: it also runs inside the worker.
//
// Log entries (all integers, t = milliseconds of play time, pauses excluded):
//   [t, len, stage, streak, kind]   a cleared word (kind is one of KIND)
//   [t, -len]                       a word that reached the platform
//   [t, 0]                          a wrong key

export const PACKS = ['everyday', 'nyc', 'science', 'code'];

export const KIND = Object.freeze({ NORMAL: 0, EXPRESS: 1, DELAY: 2, CLEAR: 3, SWEPT: 4 });

export const POINTS_PER_LETTER = 10;
export const STAGE_STEP = 2; // extra points per letter for every stage after the first
export const COMBO_STEP = 5; // clean words needed for each +0.5 on the multiplier
export const COMBO_MAX = 4;
export const EXPRESS_BONUS = 100;
export const MISS_PENALTY = 50; // per missed word, times the stage number

export const SERVICE_MAX = 100;
export const SERVICE_HIT = 20; // five misses in a row and service is suspended
export const SERVICE_REPAIR = 2; // every typed word repairs a little

export const MIN_WORD = 2;
export const MAX_WORD = 16;
export const MAX_SWEEP = 11; // never more words than that on screen at once
export const MAX_LOG = 8000;
export const MAX_DURATION_MS = 4 * 60 * 60 * 1000;
export const MAX_IDLE_MS = 2 * 60 * 1000; // words keep falling, so a live game is never quiet for long

// Special words turn up on a small share of spawns and only from certain stages on.
// The engine rolls them at most 5%, 3% and 2.5% of the time; the caps below sit far enough
// above those rates that an honest run is very unlikely to reach them.
export const SPECIAL_FROM = { [KIND.EXPRESS]: 2, [KIND.DELAY]: 3, [KIND.CLEAR]: 4 };
export const SPECIAL_RATE = { [KIND.EXPRESS]: 0.05, [KIND.DELAY]: 0.03, [KIND.CLEAR]: 0.025 };
const SPECIAL_CAP = { [KIND.EXPRESS]: [8, 0.09], [KIND.DELAY]: [6, 0.06], [KIND.CLEAR]: [6, 0.05] };

// Typing speed limits used to reject impossible logs. 18 chars/s over ten words is 216 wpm,
// beyond what anyone keeps up while reading new words; a single short word can come out
// faster than that. Over a whole game the trains can't deliver words fast enough for even a
// flawless typist to average much over 10 chars/s, so 12 leaves plenty of room.
export const MAX_CPS = 18;
export const GAME_CPS = 12;
export const BURST_CPS = 60;
const SPEED_WINDOW = 10;
const BURST_ALLOWANCE = 3; // a stutter in the browser can bunch a couple of words together

// ---------------------------------------------------------------- how the trains run
// The engine spawns words on this schedule, and replay() checks a log against it, so both
// read the numbers from here.

// Seconds a word takes to fall the full height, and seconds between new words.
// Both shrink about 10% a stage. Tuned so a relaxed typist settles around stages 3 to 5.
export const fallSeconds = (s) => Math.max(3, 11 * 0.9 ** (s - 1));
export const spawnSeconds = (s) => Math.max(0.72, 2.3 * 0.92 ** (s - 1));
export const maxOnScreen = (s) => Math.min(MAX_SWEEP, 4 + Math.ceil(s / 2));
export const SPAWN_JITTER = [0.8, 1.2]; // each gap is spawnSeconds times a factor in this range
export const EMPTY_SPAWN_MS = 300; // an empty platform gets its next word this soon
export const HOLD_MS = 1700; // quiet gap after a stage change
export const DELAY_MS = 4500; // how long a signal delay holds the trains
export const RESUME_MS = 250; // first word after a hold

// [last stage of the tier, shortest word, longest word]
const LENGTHS = [
  [1, 3, 5],
  [2, 3, 6],
  [3, 4, 6],
  [4, 4, 7],
  [5, 4, 8],
  [7, 5, 8],
  [9, 5, 9],
  [12, 5, 10],
  [16, 5, 11],
  [Infinity, 6, 12],
];

export function lengthRange(stage) {
  const [, lo, hi] = LENGTHS.find(([upTo]) => stage <= upTo);
  return [lo, hi];
}

// A word on screen can outlast a stage change, but not two whole stages.
function lengthOk(len, stage) {
  return len >= lengthRange(Math.max(1, stage - 2))[0] && len <= lengthRange(stage)[1];
}

// Log times come from the player's clock and spawns from frame times, so a stage change or an
// empty platform can look up to a frame or so early in the log.
const SPAWN_SLACK_MS = 100;
const spawnGapMs = (stage) => spawnSeconds(stage) * 1000 * SPAWN_JITTER[0] - 5;

// The 7 from Hudson Yards to Flushing. Past the end of the line the train turns around.
export const STATIONS = [
  '34 St–Hudson Yards',
  'Times Sq–42 St',
  '5 Av',
  'Grand Central–42 St',
  'Vernon Blvd–Jackson Av',
  'Hunters Point Av',
  'Court Sq',
  'Queensboro Plaza',
  '33 St–Rawson St',
  '40 St–Lowery St',
  '46 St–Bliss St',
  '52 St',
  '61 St–Woodside',
  '69 St',
  '74 St–Broadway',
  '82 St–Jackson Hts',
  '90 St–Elmhurst Av',
  'Junction Blvd',
  '103 St–Corona Plaza',
  '111 St',
  'Mets–Willets Point',
  'Flushing–Main St',
];

export function station(stage) {
  const n = STATIONS.length;
  const period = 2 * (n - 1);
  const s = Math.max(1, Math.floor(stage) || 1);
  const p = (s - 1) % period;
  const index = p < n ? p : period - p;
  return {
    name: STATIONS[index],
    index,
    bound: p < n - 1 ? 'Flushing' : 'Manhattan',
    trip: Math.floor((s - 1) / period) + 1,
  };
}

export function wordsForStage(stage) {
  return 8 + 2 * stage;
}

export function comboMultiplier(streak) {
  return Math.min(COMBO_MAX, 1 + 0.5 * Math.floor(Math.max(0, streak) / COMBO_STEP));
}

export function basePoints(len, stage) {
  return len * (POINTS_PER_LETTER + STAGE_STEP * (stage - 1));
}

// Points for one cleared word. `streak` is the number of clean words right before this one.
export function pointsFor(len, stage, streak = 0, kind = KIND.NORMAL) {
  const base = basePoints(len, stage);
  if (kind === KIND.SWEPT) return base;
  const pts = Math.round(base * comboMultiplier(streak));
  return kind === KIND.EXPRESS ? pts * 2 + EXPRESS_BONUS : pts;
}

export function missPenalty(stage) {
  return MISS_PENALTY * stage;
}

// Accuracy only counts keys that ended up in cleared words against wrong keys, so the client
// and the server agree on it exactly. Floored so 100% means no mistakes at all.
export function stats(chars, typos, durationMs) {
  const minutes = Math.max(durationMs, 1000) / 60000;
  return {
    wpm: Math.round(chars / 5 / minutes),
    accuracy: chars + typos > 0 ? Math.floor((100 * chars) / (chars + typos)) : 100,
  };
}

const fail = (error) => ({ ok: false, error });
const isInt = (v) => Number.isSafeInteger(v);

// Replays a log and returns the totals it adds up to.
export function replay(log) {
  if (!Array.isArray(log)) return fail('log');
  if (log.length > MAX_LOG) return fail('log too long');

  let score = 0;
  let stage = 1;
  let inStage = 0;
  let streak = 0;
  let bestStreak = 0;
  let words = 0;
  let swept = 0;
  let misses = 0;
  let typos = 0;
  let chars = 0;
  let service = SERVICE_MAX;
  let lastT = 0;
  let lastClearT = 0;
  let bursts = 0;
  let sweepT = -1;
  let sweepStage = 0;
  let sweepCount = 0;
  let suspended = false;
  const specials = [0, 0, 0, 0];
  const recent = []; // [t, len] of the last typed words, for the sustained speed check

  // The most words the platform could be holding, given the earliest the engine could have
  // spawned each one. Every cleared, swept or missed word has to come out of this.
  let onScreen = 0;
  let lastSpawn = 0;
  let emptyAt = 0;
  let quietUntil = 0;
  let spare = false; // a spawn slot that came up while the platform was full
  const spawnUntil = (t) => {
    for (;;) {
      const room = onScreen < maxOnScreen(stage);
      if (spare && room && quietUntil <= t) {
        spare = false;
        onScreen++;
        continue;
      }
      const early = onScreen === 0 ? emptyAt + EMPTY_SPAWN_MS - SPAWN_SLACK_MS : Infinity;
      const due = Math.max(quietUntil, Math.min(lastSpawn + spawnGapMs(stage), early));
      if (due > t) return;
      lastSpawn = due;
      if (room) onScreen++;
      else spare = true;
    }
  };
  const quiet = (until) => {
    quietUntil = Math.max(quietUntil, until + RESUME_MS - SPAWN_SLACK_MS);
  };
  const takeWord = (t) => {
    if (onScreen <= 0) return false;
    if (--onScreen === 0) emptyAt = t;
    return true;
  };

  for (const e of log) {
    if (!Array.isArray(e) || (e.length !== 2 && e.length !== 5) || !e.every(isInt)) return fail('entry');
    if (suspended) return fail('play after service ended');
    const t = e[0];
    if (t < lastT || t > MAX_DURATION_MS) return fail('time');
    spawnUntil(t);

    if (e.length === 2) {
      const n = e[1];
      if (n === 0) {
        typos++;
        streak = 0;
      } else if (n < 0 && -n >= MIN_WORD && -n <= MAX_WORD) {
        if (!lengthOk(-n, stage)) return fail('length');
        if (!takeWord(t)) return fail('spawn');
        misses++;
        streak = 0;
        score = Math.max(0, score - missPenalty(stage));
        service -= SERVICE_HIT;
        if (service <= 0) suspended = true;
      } else {
        return fail('entry');
      }
      sweepT = -1;
      lastT = t;
      continue;
    }

    const [, len, st, combo, kind] = e;
    if (len < MIN_WORD || len > MAX_WORD) return fail('length');
    if (kind < KIND.NORMAL || kind > KIND.SWEPT) return fail('kind');

    if (kind === KIND.SWEPT) {
      if (t !== sweepT || st !== sweepStage || combo !== 0 || ++sweepCount > MAX_SWEEP) return fail('sweep');
      if (!lengthOk(len, st)) return fail('length');
      if (!takeWord(t)) return fail('spawn');
      score += pointsFor(len, st, 0, KIND.SWEPT);
      swept++;
      lastT = t;
      continue;
    }

    if (st !== stage) return fail('stage');
    if (combo !== streak) return fail('combo');
    if (!lengthOk(len, stage)) return fail('length');
    if (kind !== KIND.NORMAL) {
      if (stage < SPECIAL_FROM[kind]) return fail('special');
      specials[kind]++;
    }

    // Every letter of a word is typed after the previous word cleared.
    if ((t - lastClearT) * BURST_CPS < len * 1000 && ++bursts > BURST_ALLOWANCE) return fail('speed');
    recent.push([t, len]);
    if (recent.length > SPEED_WINDOW) {
      const [t0] = recent.shift();
      let sum = 0;
      for (const [, l] of recent) sum += l;
      if ((t - t0) * MAX_CPS < sum * 1000) return fail('speed');
    }
    if (!takeWord(t)) return fail('spawn');

    score += pointsFor(len, stage, streak, kind);
    streak++;
    if (streak > bestStreak) bestStreak = streak;
    words++;
    chars += len;
    service = Math.min(SERVICE_MAX, service + SERVICE_REPAIR);
    lastClearT = t;
    lastT = t;

    if (kind === KIND.CLEAR) {
      sweepT = t;
      sweepStage = stage;
      sweepCount = 0;
    } else {
      sweepT = -1;
    }
    if (kind === KIND.DELAY) quiet(t + DELAY_MS);

    if (++inStage >= wordsForStage(stage)) {
      stage++;
      inStage = 0;
      quiet(t + HOLD_MS);
    }
  }

  const spawned = words + swept + misses;
  for (const k of [KIND.EXPRESS, KIND.DELAY, KIND.CLEAR]) {
    const [slack, share] = SPECIAL_CAP[k];
    if (specials[k] > slack + spawned * share) return fail('special');
  }

  return { ok: true, score, stage, words, swept, misses, typos, chars, bestStreak, service, lastT, suspended };
}

/**
 * Checks a leaderboard submission: { name, score, detail: { stage, words, misses, accuracy,
 * wpm, durationMs, pack }, log }. The score is recomputed from the log and has to match.
 * Returns { ok: true, score, detail: { stage, wpm, accuracy, pack } } or { ok: false, error }.
 */
export function validateSubmission(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('body');
  const { score, detail, log } = body;
  if (!isInt(score) || score <= 0) return fail('score');
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return fail('detail');
  if (!PACKS.includes(detail.pack)) return fail('pack');

  const r = replay(log);
  if (!r.ok) return r;
  if (r.words === 0) return fail('empty');
  if (r.score !== score) return fail('score mismatch');

  const { durationMs } = detail;
  if (!isInt(durationMs) || durationMs < r.lastT || durationMs > r.lastT + MAX_IDLE_MS || durationMs > MAX_DURATION_MS) {
    return fail('duration');
  }
  if (r.chars * 1000 > durationMs * GAME_CPS) return fail('speed');
  if (detail.stage !== r.stage || detail.words !== r.words || detail.misses !== r.misses) return fail('detail mismatch');

  const { wpm, accuracy } = stats(r.chars, r.typos, durationMs);
  return { ok: true, score: r.score, detail: { stage: r.stage, wpm, accuracy, pack: detail.pack } };
}
