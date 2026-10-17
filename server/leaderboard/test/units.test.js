// Runs without a server: `node --test test/units.test.js`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../../../assets/apps/leadership/scoring.js';
import { LQ_BINS, LQ_STEP, binFor, checkResult, distribution } from '../src/lq.js';
import { monthsBefore, nyDay, utcDayStart } from '../src/time.js';
import { buriedMatch, buriedShots, cpuSelfBuryLog, cpuSelfHitLog, lqResultBody, playScorched, scorchedMatch, scorchedRounds } from './fixtures.js';
import * as dm from '../../../assets/apps/scorched-borough/detmath.js';
import { SHAPES, WEAPONS, WEAPON_ORDER, generateTerrain, isBuried, mulberry32 } from '../../../assets/apps/scorched-borough/physics.js';
import { solve } from '../../../assets/apps/scorched-borough/cpu.js';
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

// Three rounds on Hard with every weapon, fired from fixed numbers. Your dirt bomb buries the CPU
// in round 1 and it digs out with a Standard; the CPU's buries you in round 2 and you dig out
// with a Heavy. The CPU takes it 2-1.
const SCRIPTED_SEED = 520043;
const SCRIPTED = [
  [[0, 536, 900, 3], [1, 1300, 620, 0], [0, 566, 970, 0], [1, 1051, 945, 0], [0, 531, 938, 2], [1, 1293, 742, 2], [0, 462, 857, 0]],
  [[1, 1200, 979, 3], [0, 500, 620, 1], [1, 1275, 939, 0], [0, 456, 778, 0], [1, 1255, 943, 2]],
  [[0, 208, 892, 2], [1, 1228, 818, 2], [0, 222, 986, 0], [1, 1317, 701, 0], [0, 602, 935, 2], [1, 1202, 739, 1]],
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
  assert.deepEqual(r.shots, [9, 9]);

  // Live play, one 60 Hz frame at a time, ends in exactly the same world as the replay.
  const states = [];
  const backfires = [];
  for (const replay of [true, false]) {
    const g = new Game({ level: 'hard', seed: SCRIPTED_SEED, replay });
    for (const shots of SCRIPTED) {
      if (g.phase === 'idle') g.startRound();
      else g.nextRound();
      for (const [, a, p, w] of shots) {
        g.fire(a / 10, p / 10, WEAPON_ORDER[w], 1000);
        if (replay) g.resolve();
        else for (let n = 0; n < 100_000 && (g.phase === 'flight' || g.phase === 'settle'); n++) g.update(1 / 60);
        for (const e of g.drain()) if (e.type === 'backfire') backfires.push([g.round, e.tank, e.weapon, e.damage, e.dugOut]);
      }
    }
    states.push(fingerprint([...g.terr.h, ...g.tanks.flatMap((t) => [t.x, t.y, t.hp]), g.world.wind]));
  }
  assert.equal(states[0], states[1]);
  assert.equal(states[0], '9b355056');
  assert.deepEqual(backfires, [[1, 1, 'standard', 30, true], [2, 0, 'heavy', 45, true]]);
});

// The final world after playing a log through, either as the server replays it or live, one
// 60 Hz frame at a time the way the page runs it.
function finalState(log, replay) {
  const g = new Game({ level: log.level, seed: log.seed, replay });
  log.rounds.forEach((round, r) => {
    if (r === 0) g.startRound();
    else g.nextRound();
    for (const [, a, p, w, ms] of round.shots) {
      g.fire(a / 10, p / 10, WEAPON_ORDER[w], ms);
      if (replay) g.resolve();
      else for (let n = 0; n < 100_000 && (g.phase === 'flight' || g.phase === 'settle'); n++) g.update(1 / 60);
    }
  });
  return fingerprint([...g.terr.h, ...g.tanks.flatMap((t) => [t.x, t.y, t.hp]), g.world.wind, g.score[0], g.score[1]]);
}

const runToEnd = (gen) => {
  for (;;) {
    const { value, done } = gen.next();
    if (done) return value;
  }
};

test('a buried tank\'s shot goes off on top of it', () => {
  // Bury the CPU with a dirt bomb, then have it fire each weapon from under the pile.
  const buried = (replay) => {
    const g = new Game({ level: 'normal', seed: 11, replay });
    g.startRound();
    const sol = runToEnd(solve(g.world, 0, g.tanks[1].x - 10));
    g.fire(sol.angle, sol.power, 'dirt', 2000);
    if (replay) g.resolve();
    else for (let n = 0; n < 100_000 && g.phase !== 'aim'; n++) g.update(1 / 60);
    g.drain();
    return g;
  };
  const world = (g) => fingerprint([...g.terr.h, ...g.tanks.flatMap((t) => [t.x, t.y, t.hp])]);
  for (const id of WEAPON_ORDER) {
    const out = [];
    for (const replay of [true, false]) {
      const g = buried(replay);
      assert.equal(g.turn, 1);
      assert.ok(isBuried(g.terr.h, g.tanks[1]), 'the dirt bomb buried the CPU');
      const over = g.terr.h[g.tanks[1].x];
      assert.equal(g.fire(130, 62, id, 1500), true);
      // Nothing flies: it went off at once and the turn is already winding down.
      assert.equal(g.phase, 'settle');
      assert.equal(g.projectiles.length, 0);
      const events = g.drain();
      if (!replay) {
        const bf = events.find((e) => e.type === 'backfire');
        assert.ok(bf && bf.tank === 1 && bf.weapon === id && bf.damage === WEAPONS[id].buried, `${id}: ${JSON.stringify(bf)}`);
        assert.ok(events.find((e) => e.type === 'fire').buried);
        assert.equal(events.some((e) => e.type === 'impact'), false, 'a buried shot tells the CPU nothing about its aim');
      }
      if (replay) g.resolve();
      else for (let n = 0; n < 100_000 && g.phase === 'settle'; n++) g.update(1 / 60);
      assert.equal(g.flightTicks, 0);
      assert.equal(g.phase, 'aim');
      assert.equal(g.tanks[0].hp, 100, `${id}: the other tank is far out of the blast`);
      const lost = 100 - g.tanks[1].hp;
      if (id === 'heavy') assert.ok(lost >= WEAPONS.heavy.buried && lost <= WEAPONS.heavy.buried + 5, `heavy cost ${lost}`);
      else assert.equal(lost, WEAPONS[id].buried, id);
      if (id === 'dirt') {
        assert.ok(isBuried(g.terr.h, g.tanks[1]), 'a dirt bomb leaves it buried');
        assert.ok(g.terr.h[g.tanks[1].x] < over, 'under even more dirt');
      } else if (id !== 'splitter') {
        // The Splitter's crater is the smallest; under a pile this deep it doesn't always do it.
        assert.equal(isBuried(g.terr.h, g.tanks[1]), false, `${id} dug the CPU out`);
      }
      out.push(world(g));
    }
    assert.equal(out[0], out[1], `${id}: live and replay agree`);
  }
  // Where a buried tank aims makes no difference.
  const a = buried(true);
  const b = buried(true);
  a.fire(130, 62, 'standard', 1500);
  b.fire(20, 100, 'standard', 1500);
  a.resolve();
  b.resolve();
  assert.equal(world(a), world(b));
  assert.deepEqual(WEAPON_ORDER.map((id) => WEAPONS[id].buried), [30, 45, 36, 0]);
});

test('one Standard digs a tank out from under a whole dirt bomb', () => {
  for (let seed = 11; seed < 31; seed++) {
    const g = new Game({ level: 'normal', seed, replay: true });
    g.startRound();
    const cpu = g.tanks[1];
    const sol = runToEnd(solve(g.world, 0, cpu.x));
    g.fire(sol.angle, sol.power, 'dirt', 2000);
    g.resolve();
    assert.ok(isBuried(g.terr.h, cpu), `seed ${seed}: a dead-centre dirt bomb buries it`);
    g.fire(130, 62, 'standard', 1500);
    g.resolve();
    assert.equal(100 - cpu.hp, WEAPONS.standard.buried, `seed ${seed}`);
    assert.equal(isBuried(g.terr.h, cpu), false, `seed ${seed}: dug out`);
    // Whatever dirt is left over the barrel, the turret is out, so the next shot really flies.
    g.fire(45, 30, 'standard', 2000);
    g.resolve();
    assert.equal(g.fire(130, 62, 'standard', 1500), true);
    assert.equal(g.phase, 'flight', `seed ${seed}`);
  }
});

test('buried tanks dig out the same way live and on the server', () => {
  for (const level of ['easy', 'normal', 'hard']) {
    const { body, backfires } = buriedMatch({ level, seed: 7, bury: 'both' });
    const v = sbValidate(body);
    assert.equal(v.ok, true, `${level}: ${v.error}`);
    assert.equal(v.score, body.score);
    // Both tanks got buried, and each dug out with a Standard, the cheapest way.
    for (const side of [0, 1]) {
      const own = backfires.filter((b) => b.tank === side);
      assert.ok(own.length >= 1, `${level}: tank ${side} never dug out`);
      for (const b of own) assert.deepEqual([b.weapon, b.damage], ['standard', 30]);
    }
    assert.deepEqual(buriedShots(body.log).map((s) => s.who).sort(), backfires.map((b) => b.tank).sort());
    assert.equal(finalState(body.log, true), finalState(body.log, false), level);
  }
});

test('a buried CPU can only dig out the way the real one does', () => {
  const { body } = buriedMatch({ level: 'normal', seed: 7, bury: 'cpu' });
  const dig = buriedShots(body.log).find((s) => s.who === 1);
  assert.ok(dig, 'the CPU was buried');
  const digShot = (b) => b.log.rounds[dig.round].shots[dig.index];
  assert.equal(digShot(body)[3], WEAPON_ORDER.indexOf('standard'));
  const swap = (fn) => {
    const t = structuredClone(body);
    fn(digShot(t));
    return sbValidate(t);
  };
  // Anything but the Standard costs the CPU more, or keeps it buried for another free turn.
  for (const id of ['heavy', 'splitter', 'dirt']) {
    assert.deepEqual(swap((s) => { s[3] = WEAPON_ORDER.indexOf(id); }), { ok: false, error: 'cpu self-hit' }, id);
  }
  // Its aim doesn't matter while it is buried, so another one replays to the same win.
  const reaimed = swap((s) => { s[1] = 900; s[2] = 1000; });
  assert.equal(reaimed.ok, true, reaimed.error);
  assert.equal(reaimed.score, body.score);

  // A forged CPU dirt bomb on its own head is refused straight away: it would set up free damage.
  const plain = scorchedMatch({ level: 'normal', seed: 7 });
  const selfBury = cpuSelfBuryLog(plain.log);
  assert.ok(selfBury, 'no self-burying shot found');
  assert.deepEqual(sbValidate({ log: selfBury }), { ok: false, error: 'cpu self-hit' });
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
