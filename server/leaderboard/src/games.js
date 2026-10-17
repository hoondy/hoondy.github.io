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
// gets it compiled before a real post arrives. This one is three rounds with every weapon and
// a buried tank on each side digging itself out, and the CPU wins it, so it could never pass
// as a record anyway. It is the scripted match in test/units.test.js.
const WARM_UP = [
  [[0, 536, 900, 3], [1, 1300, 620, 0], [0, 566, 970, 0], [1, 1051, 945, 0], [0, 531, 938, 2], [1, 1293, 742, 2], [0, 462, 857, 0]],
  [[1, 1200, 979, 3], [0, 500, 620, 1], [1, 1275, 939, 0], [0, 456, 778, 0], [1, 1255, 943, 2]],
  [[0, 208, 892, 2], [1, 1228, 818, 2], [0, 222, 986, 0], [1, 1317, 701, 0], [0, 602, 935, 2], [1, 1202, 739, 1]],
];

try {
  sbReplay({
    v: SB_VERSION,
    level: 'hard',
    seed: 520043,
    durationMs: 120_000,
    rounds: WARM_UP.map((shots, i) => ({ first: i % 2 ? 'cpu' : 'you', shots: shots.map((s) => [...s, 1500]) })),
  });
} catch {
  /* only ever a head start */
}
