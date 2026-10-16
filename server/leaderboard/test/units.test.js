// Runs without a server: `node --test test/units.test.js`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../../../assets/apps/leadership/scoring.js';
import { LQ_BINS, LQ_STEP, binFor, checkResult, distribution } from '../src/lq.js';
import { monthsBefore, nyDay, utcDayStart } from '../src/time.js';
import { lqResultBody } from './fixtures.js';

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
