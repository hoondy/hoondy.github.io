// Runs without a server: `node --test test/units.test.js`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../../../assets/apps/leadership/scoring.js';
import { LQ_BINS, LQ_STEP, binFor, checkResult, distribution } from '../src/lq.js';
import { monthsBefore, nyDay, utcDayStart } from '../src/time.js';
import { cpuSelfHitLog, lqResultBody, playScorched, scorchedMatch, scorchedRounds } from './fixtures.js';
import * as dm from '../../../assets/apps/scorched-borough/detmath.js';
import { SHAPES, WEAPON_ORDER, generateTerrain, mulberry32 } from '../../../assets/apps/scorched-borough/physics.js';
import { Game, LEVELS, SEED_MAX, rngStart } from '../../../assets/apps/scorched-borough/game.js';
import { VERSION as SB_VERSION, replay as sbReplay, scoreMatch, validateSubmission as sbValidate } from '../../../assets/apps/scorched-borough/rules.js';

const MID = { drive: 3, presence: 3, dependability: 4, composure: 3, vision: 3, empathy: 4, motivation: 3, decisiveness: 3 };

test('New York calendar dates', () => {
  // 03:30 UTC on Oct 16 is still the evening of Oct 15 in New York.
  assert.equal(nyDay(new Date('2026-10-16T03:30:00Z')), '2026-10-15');
  assert.equal(nyDay(new Date('2026-10-16T04:00:00Z')), '2026-10-16');
  // Winter time is UTC-5.
  assert.equal(nyDay(new Date('2027-01-01T04:59:59Z')), '2026-12-31');
  assert.equal(nyDay(new Date('2027-01-01T05:00:00Z')), '2027-01-01');
});

test('start of the UTC day', () => {
  assert.equal(utcDayStart(Date.UTC(2026, 9, 16, 17, 7, 19, 459)), Date.UTC(2026, 9, 16));
  assert.equal(utcDayStart(Date.UTC(2026, 9, 16)), Date.UTC(2026, 9, 16));
  assert.equal(utcDayStart(Date.UTC(2026, 9, 16) - 1), Date.UTC(2026, 9, 15));
});

test('stepping back through months', () => {
  assert.equal(monthsBefore('2026-10', 0), '2026-10');
  assert.equal(monthsBefore('2026-10', 1), '2026-09');
  assert.equal(monthsBefore('2026-10', 10), '2025-12');
  assert.equal(monthsBefore('2026-01', 1), '2025-12');
  assert.equal(monthsBefore('2026-10', 24), '2024-10');
  assert.equal(monthsBefore('2026-12', -1), '2027-01');
  assert.throws(() => monthsBefore('2026-W42', 1));
});

test('LQ bins', () => {
  assert.equal(LQ_BINS, 18);
  assert.equal(LQ_STEP, 5);
  assert.equal(binFor(55), 0);
  assert.equal(binFor(59), 0);
  assert.equal(binFor(60), 1);
  assert.equal(binFor(100), 9);
  assert.equal(binFor(139), 16);
  assert.equal(binFor(140), 17);
  assert.equal(binFor(145), 17);
  assert.equal(binFor(10), 0);
  assert.equal(binFor(500), 17);
});

test('distribution from histogram rows', () => {
  const empty = distribution([]);
  assert.deepEqual(empty, { n: 0, min: 55, max: 145, step: 5, bins: new Array(18).fill(0), updatedAt: null });

  const d = distribution([
    { bin: 9, count: 4, updated_at: Date.UTC(2026, 9, 16, 12, 34, 56, 789) },
    { bin: 17, count: 1, updated_at: Date.UTC(2026, 9, 15) },
    { bin: 42, count: 99, updated_at: Date.UTC(2030, 0, 1) },
  ]);
  assert.equal(d.n, 5);
  assert.equal(d.bins[9], 4);
  assert.equal(d.bins[17], 1);
  assert.equal(d.bins.length, 18);
  // Only the day is ever published, even if a stored value has a time in it.
  assert.equal(d.updatedAt, '2026-10-16T00:00:00.000Z');
});

test('checkResult re-scores the answers and keeps nothing personal', () => {
  const { body, expected } = lqResultBody(MID, { name: 'someone', lq: 145, ip: '1.2.3.4' });
  const row = checkResult(body);
  assert.deepEqual(Object.keys(row).sort(), ['answers', 'archetype', 'lang', 'lq', 'version']);
  assert.equal(row.lq, expected.lq);
  assert.equal(row.archetype, expected.archetype);
  assert.equal(row.version, VERSION);
  assert.equal(row.lang, 'en');
  assert.deepEqual(JSON.parse(row.answers), body.answers);
});

test('checkResult turns bad results away', () => {
  const { body } = lqResultBody(MID);
  const reject = (b) => {
    try {
      checkResult(b);
    } catch (err) {
      assert.equal(err.status, 422);
      return err.code;
    }
    return 'accepted';
  };
  assert.equal(reject({ ...body, v: undefined }), 'version');
  assert.equal(reject({ ...body, v: '0.0.1' }), 'version');
  assert.equal(reject({ ...body, lang: 'xx' }), 'bad_lang');
  assert.equal(reject({ ...body, durationMs: 20_000 }), 'too_fast');
  assert.equal(reject({ ...body, answers: body.answers.slice(0, 10) }), 'bad_answers');
  assert.equal(reject({ ...body, answers: body.answers.map((v, i) => (i === 0 ? 9 : v)) }), 'bad_answers');
  assert.equal(reject({ ...body, answers: body.answers.map((v, i) => (i === 48 ? 5 : v)) }), 'attention');
  assert.equal(reject({ ...body, answers: body.answers.map((v, i) => (i < 40 ? 4 : v)) }), 'straightline');
});

// ------------------------------------------------------------------------------------------
// Scorched Borough: the deterministic math and the match replay

// FNV-1a over the bits of a list of doubles: one flipped bit anywhere changes it.
function fingerprint(values) {
  const view = new DataView(new ArrayBuffer(8));
  let h = 0x811c9dc5;
  for (const v of values) {
    view.setFloat64(0, v);
    for (let i = 0; i < 8; i++) h = Math.imul(h ^ view.getUint8(i), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

test('deterministic sin, cos, exp and log stay within a few ulps of Math', () => {
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const worst = { sin: 0, cos: 0, exp: 0, log: 0 };
  for (let i = 0; i < 200_000; i++) {
    const x = (rnd() * 2 - 1) * 60;
    worst.sin = Math.max(worst.sin, Math.abs(dm.sin(x) - Math.sin(x)));
    worst.cos = Math.max(worst.cos, Math.abs(dm.cos(x) - Math.cos(x)));
    const y = (rnd() * 2 - 1) * 300;
    worst.exp = Math.max(worst.exp, Math.abs(dm.exp(y) - Math.exp(y)) / Math.exp(y));
    const u = rnd() * 1.5 + 1e-12;
    worst.log = Math.max(worst.log, Math.abs(dm.log(u) - Math.log(u)));
  }
  assert.ok(worst.sin < 1e-15 && worst.cos < 1e-15, JSON.stringify(worst));
  assert.ok(worst.exp < 1e-15, JSON.stringify(worst));
  assert.ok(worst.log < 1e-14, JSON.stringify(worst));
  assert.equal(dm.sin(0), 0);
  assert.equal(dm.cos(0), 1);
  assert.equal(dm.exp(0), 1);
  assert.equal(dm.log(1), 0);
  assert.equal(dm.exp(-800), 0);
  assert.equal(dm.exp(800), Infinity);
  assert.equal(dm.log(0), -Infinity);
  assert.ok(Number.isNaN(dm.sin(Infinity)) && Number.isNaN(dm.log(-1)));
});

// These pin the exact bits. If one fails, the physics changed: matches recorded before the
// change no longer replay, so bump VERSION in rules.js, then update the values here.
test('deterministic math and terrain give the same bits as always', () => {
  const pts = [];
  for (let i = 0; i <= 64; i++) {
    const x = -20 + i * 0.6180339887;
    pts.push(dm.sin(x), dm.cos(x), dm.exp(x / 3), dm.log(1 + i * 1.37));
  }
  assert.equal(fingerprint(pts), '845eca65');
  const terrain = [];
  for (const shape of SHAPES) terrain.push(...generateTerrain(20261016, shape).h);
  assert.equal(fingerprint(terrain), '47418e2f');
});

// Three rounds on Hard with every weapon, fired from fixed numbers. The CPU takes it 2-1.
const SCRIPTED_SEED = 425570;
const SCRIPTED = [
  [[0, 611, 821, 2], [1, 1471, 857, 1], [0, 526, 856, 1], [1, 1197, 898, 2], [0, 576, 780, 2], [1, 1383, 859, 1]],
  [[1, 1353, 699, 0], [0, 388, 741, 0], [1, 1651, 945, 3], [0, 375, 573, 3], [1, 1290, 819, 0], [0, 601, 745, 0]],
  [[0, 119, 934, 2], [1, 1385, 737, 1], [0, 305, 899, 1], [1, 1592, 905, 2]],
];
const scriptedLog = () => ({
  v: SB_VERSION,
  level: 'hard',
  seed: SCRIPTED_SEED,
  durationMs: 120_000,
  rounds: SCRIPTED.map((shots, r) => ({ first: r % 2 ? 'cpu' : 'you', shots: shots.map((s) => [...s, s[0] ? 1300 : 2500]) })),
});

test('a scripted match replays to the same bits', () => {
  const r = sbReplay(scriptedLog());
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.winner, r.won, r.lost], [1, 1, 2]);
  assert.deepEqual(r.shots, [8, 8]);

  // Live play, one 60 Hz frame at a time, ends in exactly the same world as the replay.
  const states = [];
  for (const replay of [true, false]) {
    const g = new Game({ level: 'hard', seed: SCRIPTED_SEED, replay });
    for (const shots of SCRIPTED) {
      if (g.phase === 'idle') g.startRound();
      else g.nextRound();
      for (const [, a, p, w] of shots) {
        g.fire(a / 10, p / 10, WEAPON_ORDER[w], 1000);
        if (replay) g.resolve();
        else for (let n = 0; n < 100_000 && (g.phase === 'flight' || g.phase === 'settle'); n++) g.update(1 / 60);
      }
    }
    states.push(fingerprint([...g.terr.h, ...g.tanks.flatMap((t) => [t.x, t.y, t.hp]), g.world.wind]));
  }
  assert.equal(states[0], states[1]);
  assert.equal(states[0], '91a4d6e8');
});

test('scorched points', () => {
  assert.equal(scoreMatch({ level: 'hard', shots: 6 }), 2280);
  assert.equal(scoreMatch({ level: 'normal', shots: 15 }), 800);
  assert.equal(scoreMatch({ level: 'easy', shots: 4 }), 840);
  assert.equal(scoreMatch({ level: 'easy', shots: 40 }), 100);
  assert.equal(scoreMatch({ level: 'hard', shots: 40 }), 300);
  assert.equal(scoreMatch({ level: 'nope', shots: 4 }), 0);
  assert.equal(scoreMatch({ level: 'hard', shots: 2.5 }), 0);
});

test('a won scorched match is accepted and scored from the replay', () => {
  for (const level of ['easy', 'normal', 'hard']) {
    const body = scorchedMatch({ level, seed: 7 });
    const v = sbValidate(body);
    assert.equal(v.ok, true, `${level}: ${v.error}`);
    assert.equal(v.score, body.score);
    assert.deepEqual(Object.keys(v.detail), ['level', 'rounds', 'shots']);
    assert.equal(v.detail.level, level);
    assert.equal(v.score, scoreMatch({ level, shots: v.detail.shots }));
    // The score is optional; the server works it out either way.
    assert.equal(sbValidate({ log: body.log }).score, body.score);
  }
});

test('only your shots in the rounds you won are scored', () => {
  let split = 0;
  for (let seed = 1; seed <= 40 && split < 3; seed++) {
    const { winner, body } = playScorched({ level: 'normal', seed, you: 'normal' });
    if (winner !== 0) continue;
    const rounds = scorchedRounds(body.log);
    const counted = rounds.filter((r) => r.winner === 0).reduce((n, r) => n + r.yours, 0);
    const fired = rounds.reduce((n, r) => n + r.yours, 0);
    const v = sbValidate(body);
    assert.equal(v.ok, true, v.error);
    assert.equal(v.detail.shots, counted);
    assert.equal(v.score, scoreMatch({ level: 'normal', shots: counted }));
    assert.equal(sbReplay(body.log).shots[0], fired);
    if (fired > counted) split++;
  }
  // The search above has to have found 2-1 wins with shots in the lost round.
  assert.ok(split > 0);
});

test('the same match always replays the same way', () => {
  const a = playScorched({ level: 'hard', seed: 31 });
  const b = playScorched({ level: 'hard', seed: 31 });
  assert.deepEqual(a.body.log, b.body.log);
  assert.deepEqual(sbReplay(a.body.log), sbReplay(b.body.log));
});

test('tampered or lost scorched matches are refused', () => {
  const body = scorchedMatch({ level: 'normal', seed: 7 });
  const lastOfYours = (b) => b.log.rounds.at(-1).shots.findLast((s) => s[0] === 0);
  const firstOfYours = (b) => b.log.rounds[0].shots.find((s) => s[0] === 0);
  const firstCpu = (b) => b.log.rounds[0].shots.find((s) => s[0] === 1);
  const cases = {
    'aim off on the winning shot': [(b) => { lastOfYours(b)[1] += lastOfYours(b)[1] < 900 ? 250 : -250; }, 'unfinished'],
    'less power on the winning shot': [(b) => { lastOfYours(b)[2] = Math.max(0, lastOfYours(b)[2] - 250); }, 'unfinished'],
    'a dirt bomb for the winning shot': [(b) => { lastOfYours(b)[3] = 3; }, 'unfinished'],
    'a fourth heavy shell': [(b) => { b.log.rounds[0].shots.filter((s) => s[0] === 0).forEach((s) => { s[3] = 3; }); }, 'ammo'],
    'two turns in a row': [(b) => { const s = b.log.rounds[0].shots; [s[0], s[1]] = [s[1], s[0]]; }, 'turn order'],
    'the CPU opening round 1': [(b) => { b.log.rounds[0].first = 'cpu'; }, 'turn order'],
    'a higher score': [(b) => { b.score += 40; }, 'score mismatch'],
    // Each level builds its own terrain and wind from the seed, so the same shots go elsewhere.
    'a harder level': [(b) => { b.log.level = 'hard'; }, ['extra shots', 'unfinished', 'score mismatch', 'cpu self-hit']],
    'a harder level with its score': [(b) => { b.log.level = 'hard'; b.score = (b.score / 2) * 3; }, ['extra shots', 'unfinished', 'cpu self-hit']],
    'another seed': [(b) => { b.log.seed += 1; }, ['extra shots', 'unfinished']],
    'an old version': [(b) => { b.log.v = '0.0.1'; }, 'version'],
    'a shot missing': [(b) => { b.log.rounds.at(-1).shots.pop(); }, 'unfinished'],
    'a shot too many': [(b) => { b.log.rounds.at(-1).shots.push([1, 900, 500, 0, 2000]); }, 'extra shots'],
    'a round missing': [(b) => { b.log.rounds.shift(); }, 'turn order'],
    'a CPU faster than it thinks': [(b) => { firstCpu(b)[4] = 100; }, 'turn time'],
    'a match quicker than its shells': [(b) => { b.log.durationMs = 10_000; }, 'duration'],
    'fractional aim': [(b) => { firstOfYours(b)[1] += 0.5; }, 'shot'],
    'aim out of range': [(b) => { firstOfYours(b)[1] = 1801; }, 'aim'],
    'an unknown weapon': [(b) => { firstOfYours(b)[3] = 4; }, 'weapon'],
    'detail that disagrees': [(b) => { b.detail.shots = 1; }, 'detail mismatch'],
    'no log': [(b) => { delete b.log; }, 'log'],
    'a log that is not an object': [(b) => { b.log = [b.log]; }, 'log'],
    'an unknown level': [(b) => { b.log.level = 'insane'; }, 'level'],
    'a seed out of range': [(b) => { b.log.seed = 2 ** 32; }, 'seed'],
    'a seed past 30 bits': [(b) => { b.log.seed += SEED_MAX + 1; }, 'seed'],
    'too many shots in a round': [(b) => { b.log.rounds[0].shots = Array.from({ length: 121 }, (_, i) => [i % 2, 900, 0, 0, 2000]); }, 'shots'],
  };
  for (const [name, [tamper, error]] of Object.entries(cases)) {
    const t = structuredClone(body);
    tamper(t);
    const v = sbValidate(t);
    assert.equal(v.ok, false, `${name} was accepted`);
    if (Array.isArray(error)) assert.ok(error.includes(v.error), `${name}: ${v.error}`);
    else assert.equal(v.error, error, name);
  }

  const selfHit = cpuSelfHitLog(body.log);
  assert.ok(selfHit, 'no self-hit found');
  assert.deepEqual(sbValidate({ log: selfHit }), { ok: false, error: 'cpu self-hit' });

  const lost = scorchedMatch({ level: 'normal', seed: 7, want: 1 });
  assert.deepEqual(sbValidate(lost), { ok: false, error: 'not a win' });
  assert.deepEqual(sbValidate({ ...lost, score: 100 }), { ok: false, error: 'not a win' });
  assert.equal(sbValidate(scriptedLog()).ok, false);
  assert.deepEqual(sbValidate({ log: scriptedLog() }), { ok: false, error: 'not a win' });
});

test('each level plays its own match from a seed', () => {
  const first = (level) => {
    const g = new Game({ level, seed: 7, replay: true });
    g.startRound();
    return fingerprint([...g.terr.h, ...g.tanks.map((t) => t.x), g.world.wind]);
  };
  assert.equal(new Set(['easy', 'normal', 'hard'].map(first)).size, 3);

  // No seed on one level starts the match RNG where a seed on another level does: every level
  // keeps its own two low bits of the start state, and the seed fills the rest.
  const rng = mulberry32(2026);
  const seeds = [0, 1, 7, SEED_MAX, ...Array.from({ length: 200 }, () => Math.floor(rng() * (SEED_MAX + 1)))];
  const levels = Object.keys(LEVELS);
  const lowBits = levels.map((level) => new Set(seeds.map((s) => rngStart(s, level) & 3)));
  assert.ok(lowBits.every((bits) => bits.size === 1));
  assert.equal(new Set(lowBits.map((bits) => [...bits][0])).size, levels.length);
  for (const level of levels) {
    for (const s of seeds) assert.equal(rngStart(s, level) >>> 2, s);
  }
  assert.equal(new Game({ seed: SEED_MAX + 8 }).seed, 7);

  // Nor can a forged first round that uses up just the right number of draws bring the stream
  // back in line for the rounds after it: from the very same RNG state, each level deals its own
  // round.
  for (let i = 0; i < 50; i++) {
    const state = Math.floor(rng() * 2 ** 32);
    const rounds = levels.map((level) => {
      const g = new Game({ level, replay: true });
      g.rng = mulberry32(state);
      g.startRound();
      return g.roundSeed;
    });
    assert.equal(new Set(rounds).size, levels.length);
  }

  // mulberry32 adds the same odd number to its state on every draw, so the closest a seed on
  // another level can come is the real match's stream a few draws early or late. That deals a
  // different first round, and the shots almost never win it. Now and then a long log full of
  // heavy shells still lands enough of them, about as often as with any seed at all.
  const STEP = 0x6d2b79f5;
  const roundSeed = (level, seed) => {
    const g = new Game({ level, seed, replay: true });
    g.startRound();
    return g.roundSeed;
  };
  const up = { easy: ['normal', 'hard'], normal: ['hard'] };
  let tried = 0;
  let forged = 0;
  for (const level of ['easy', 'normal']) {
    for (let seed = 100; seed < 116; seed++) {
      const { winner, body } = playScorched({ level, seed });
      if (winner !== 0) continue;
      const start = rngStart(seed, level);
      const real = roundSeed(level, seed);
      for (const to of up[level]) {
        // The same seed, then every seed on the harder level that starts within 12 draws.
        const candidates = [seed];
        for (let d = -12; d <= 12; d++) {
          const near = (start + Math.imul(d, STEP)) >>> 0;
          if (rngStart(near >>> 2, to) === near) candidates.push(near >>> 2);
        }
        assert.ok(candidates.length > 4);
        let passed = false;
        for (const s of candidates) {
          assert.notEqual(roundSeed(to, s), real, `${level} seed ${seed} as ${to} seed ${s}`);
          if (sbValidate({ log: { ...body.log, level: to, seed: s } }).ok) passed = true;
        }
        tried++;
        if (passed) forged++;
      }
    }
  }
  assert.ok(tried >= 20, `only ${tried} relabels tried`);
  assert.ok(forged * 20 <= tried, `${forged} of ${tried} relabelled wins passed`);
});
