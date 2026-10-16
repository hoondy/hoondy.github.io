// Games that have a public board. Each validator is the same module the browser uses, so the
// server and the page always agree on the rules. A validator takes the untrusted request body
// and returns { ok: true, score, detail } or { ok: false, error }.
//
// The LQ test is deliberately not here: it's a test for oneself, so it gets anonymous
// statistics (src/lq.js) instead of a high-score board.

import { validateSubmission as rushHour } from '../../../assets/apps/rush-hour/rules.js';
import { VERSION as SB_VERSION, replay as sbReplay, validateSubmission as scorchedBorough } from '../../../assets/apps/scorched-borough/rules.js';

// `fingerprint` names a run by what was played, leaving out the timings, so the same ride or
// match can be posted only once, whatever nickname or month it is sent under.
export const GAMES = {
  // The replay log is capped at 8000 entries of at most ~26 bytes each.
  'rush-hour': {
    validate: rushHour,
    maxBody: 256 * 1024,
    fingerprint: (body) => body.log.map((entry) => entry.slice(1)),
  },
  // A match log is at most 3 rounds of 120 shots, about 25 bytes a shot.
  'scorched-borough': {
    validate: scorchedBorough,
    maxBody: 16 * 1024,
    fingerprint: ({ log }) => [log.level, log.seed, log.rounds.map((r) => [r.first, r.shots.map((s) => s.slice(0, 4))])],
  },
};

export function getGame(id) {
  return Object.hasOwn(GAMES, id) ? GAMES[id] : null;
}

// A Scorched Borough post replays the whole match, physics and all. On a fresh isolate that
// code starts out in V8's interpreter, which roughly doubles the first post's CPU time and can
// push it past the free plan's 10 ms. Replaying one short match while the worker starts up
// gets it compiled before a real post arrives. This one is three rounds with every weapon, and
// the CPU wins it, so it could never pass as a record anyway.
const WARM_UP = [
  [[0, 611, 821, 2], [1, 1471, 857, 1], [0, 526, 856, 1], [1, 1197, 898, 2], [0, 576, 780, 2], [1, 1383, 859, 1]],
  [[1, 1353, 699, 0], [0, 388, 741, 0], [1, 1651, 945, 3], [0, 375, 573, 3], [1, 1290, 819, 0], [0, 601, 745, 0]],
  [[0, 119, 934, 2], [1, 1385, 737, 1], [0, 305, 899, 1], [1, 1592, 905, 2]],
];

try {
  sbReplay({
    v: SB_VERSION,
    level: 'hard',
    seed: 425570,
    durationMs: 120_000,
    rounds: WARM_UP.map((shots, i) => ({ first: i % 2 ? 'cpu' : 'you', shots: shots.map((s) => [...s, 1500]) })),
  });
} catch {
  /* only ever a head start */
}
