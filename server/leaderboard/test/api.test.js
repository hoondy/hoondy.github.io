// End-to-end checks against a running worker:
//
//   npm run db:init:local
//   npm run dev            (in another terminal)
//   npm test               (LB_URL=http://127.0.0.1:8787 by default)
//
// Each run posts under fresh nicknames and fake client IPs, so it can be repeated against the
// same local database. Locally the worker trusts the CF-Connecting-IP header the test sends;
// in production Cloudflare sets that header itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadershipBody, rushHourRun } from './fixtures.js';

const API = (process.env.LB_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const RUN = Math.random().toString(36).slice(2, 7);
const SITE = 'http://127.0.0.1:4000';

let ipSeq = Math.floor(Math.random() * 200);
const freshIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${(ipSeq++ % 250) + 1}`;
const hex = () => Math.floor(Math.random() * 0x10000).toString(16);
// A random /64; pass a suffix to get one address inside it.
const fresh64 = () => `2001:db8:${hex()}:${hex()}`;

async function call(path, { method = 'GET', body, ip = freshIp(), origin = SITE, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(origin ? { origin } : {}),
      'cf-connecting-ip': ip,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* empty or not JSON */
  }
  return { status: res.status, headers: res.headers, data };
}

const post = (game, body, opts) => call(`/v1/${game}/scores`, { method: 'POST', body, ...opts });
const top = (game, limit = 50, opts) => call(`/v1/${game}/top?limit=${limit}`, opts);

const HIGH = { drive: 5, presence: 4, dependability: 4, composure: 4, vision: 4, empathy: 3, motivation: 5, decisiveness: 5 };
const MID = { drive: 3, presence: 3, dependability: 4, composure: 3, vision: 3, empathy: 4, motivation: 3, decisiveness: 3 };

test('health check lists the games', async () => {
  const r = await call('/');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.games, ['leadership', 'rush-hour']);
  assert.match(r.data.week, /^\d{4}-W\d{2}$/);
});

test('board shape and limits', async () => {
  const r = await top('leadership', 5);
  assert.equal(r.status, 200);
  assert.match(r.data.week, /^\d{4}-W\d{2}$/);
  assert.ok(Date.parse(r.data.resetsAt) > Date.now());
  assert.ok(Array.isArray(r.data.entries) && r.data.entries.length <= 5);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');

  assert.ok((await top('leadership', 0)).data.entries.length <= 1);
  assert.ok((await top('leadership', 999)).data.entries.length <= 50);
  assert.equal((await call('/v1/leadership/top?limit=abc')).status, 200);
});

test('unknown games, paths and methods', async () => {
  assert.deepEqual((await top('tetris')).data, { ok: false, error: 'unknown_game' });
  assert.equal((await top('tetris')).status, 404);
  assert.equal((await call('/v2/leadership/top')).status, 404);
  assert.equal((await call('/v1/leadership/scores')).status, 405);
  assert.equal((await call('/v1/leadership/top', { method: 'POST', body: {} })).status, 405);
});

test('CORS', async () => {
  const preflight = (origin) =>
    call('/v1/leadership/scores', {
      method: 'OPTIONS',
      origin,
      headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });

  for (const origin of ['http://127.0.0.1:4000', 'http://localhost:8080', 'https://hoondy.com', 'https://www.hoondy.com']) {
    const ok = await preflight(origin);
    assert.equal(ok.status, 204, origin);
    assert.equal(ok.headers.get('access-control-allow-origin'), origin);
    assert.match(ok.headers.get('access-control-allow-headers'), /content-type/);
    assert.match(ok.headers.get('access-control-allow-methods'), /POST/);
    assert.match(ok.headers.get('vary'), /Origin/);
  }

  for (const origin of ['https://evil.example', 'https://hoondy.com.evil.example', 'http://hoondy.com', 'null']) {
    const no = await preflight(origin);
    assert.equal(no.status, 403, origin);
    assert.equal(no.headers.get('access-control-allow-origin'), null);
  }

  const get = await top('leadership', 3, { origin: 'https://evil.example' });
  assert.equal(get.status, 403);
  assert.equal(get.headers.get('access-control-allow-origin'), null);

  const noOrigin = await top('leadership', 3, { origin: null });
  assert.equal(noOrigin.status, 200);
  assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);
});

test('leadership: the server scores the answers itself', async () => {
  const { body, expected } = leadershipBody(`Lead${RUN}`, HIGH);
  const r = await post('leadership', { ...body, score: 999 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.equal(r.data.score, expected.lq);
  assert.ok(Number.isInteger(r.data.rank) && r.data.rank >= 1);
  assert.match(r.data.week, /^\d{4}-W\d{2}$/);

  const board = await top('leadership', 50);
  const row = board.data.entries.find((e) => e.id === r.data.id);
  if (row) {
    assert.equal(row.rank, r.data.rank);
    assert.equal(row.name, `Lead${RUN}`);
    assert.equal(row.score, expected.lq);
    assert.deepEqual(row.detail, { archetype: expected.archetype, pct: expected.percentile, lang: 'en' });
  }
});

test('leadership: bad results are turned away', async () => {
  const { body } = leadershipBody(`Bad${RUN}`, MID);
  const cases = [
    [{ ...body, durationMs: 20_000 }, 'too_fast'],
    [{ ...body, lang: 'xx' }, 'bad_lang'],
    [{ ...body, answers: body.answers.slice(0, 10) }, 'bad_answers'],
    [{ ...body, answers: body.answers.map((v, i) => (i === 48 ? 5 : v)) }, 'attention'],
    [{ ...body, answers: body.answers.map((v, i) => (i < 40 ? 4 : v)) }, 'straightline'],
  ];
  for (const [payload, error] of cases) {
    const r = await post('leadership', payload);
    assert.equal(r.status, 422, error);
    assert.deepEqual(r.data, { ok: false, error });
  }
});

test('rush hour: the log decides the score', async () => {
  const run = rushHourRun({ words: 90, gapMs: 1100, missAt: [12] });
  const ok = await post('rush-hour', { name: `Rider${RUN}`, ...run });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.score, run.score);

  const board = await top('rush-hour', 50);
  const row = board.data.entries.find((e) => e.id === ok.data.id);
  if (row) {
    assert.equal(row.rank, ok.data.rank);
    assert.equal(row.detail.stage, run.detail.stage);
    assert.equal(row.detail.wpm, run.detail.wpm);
  }

  const inflated = await post('rush-hour', { name: `Rider${RUN}`, ...run, score: run.score + 500 });
  assert.equal(inflated.status, 422);
  assert.equal(inflated.data.error, 'score mismatch');

  // A real run replayed twelve times faster than anyone can type.
  const quick = rushHourRun({ words: 40, typoEvery: 0 });
  const tooFast = {
    ...quick,
    log: quick.log.map(([t, ...rest]) => [Math.floor(t / 12), ...rest]),
    detail: { ...quick.detail, durationMs: Math.floor(quick.detail.durationMs / 12) },
  };
  const fast = await post('rush-hour', { name: `Rider${RUN}`, ...tooFast });
  assert.equal(fast.status, 422);
  assert.ok(['speed', 'spawn'].includes(fast.data.error), fast.data.error);

  const lied = await post('rush-hour', { name: `Rider${RUN}`, ...run, detail: { ...run.detail, stage: 30 } });
  assert.equal(lied.status, 422);
  assert.equal(lied.data.error, 'detail mismatch');
});

test('one row per player per week, best score kept', async () => {
  const ip = freshIp();
  const name = `Best${RUN}`;
  const first = await post('rush-hour', { name, ...rushHourRun({ words: 40 }) }, { ip });
  const worse = await post('rush-hour', { name: name.toUpperCase(), ...rushHourRun({ words: 20 }) }, { ip });
  const better = await post('rush-hour', { name, ...rushHourRun({ words: 60 }) }, { ip });
  for (const r of [first, worse, better]) assert.equal(r.status, 200, JSON.stringify(r.data));

  assert.equal(worse.data.id, first.data.id);
  assert.equal(better.data.id, first.data.id);
  assert.equal(worse.data.improved, false);
  assert.equal(worse.data.best, first.data.score);
  assert.ok(worse.data.rank >= 1);
  assert.equal(better.data.improved, true);
  assert.equal(better.data.best, better.data.score);

  const board = await top('rush-hour', 50);
  const rows = board.data.entries.filter((e) => e.name.toLowerCase() === name.toLowerCase());
  assert.ok(rows.length <= 1);

  // Same nickname from another network is someone else.
  const other = await post('rush-hour', { name, ...rushHourRun({ words: 20 }) });
  assert.notEqual(other.data.id, first.data.id);
});

test('an IPv6 client is one client across its /64', async () => {
  const net = fresh64();
  const name = `Six${RUN}`;
  const first = await post('rush-hour', { name, ...rushHourRun({ words: 20 }) }, { ip: `${net}::1` });
  const again = await post('rush-hour', { name, ...rushHourRun({ words: 30 }) }, { ip: `${net}:1234:5678:9abc:def0` });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.id, first.data.id);
  assert.equal(again.data.improved, true);

  const elsewhere = await post('rush-hour', { name, ...rushHourRun({ words: 20 }) }, { ip: `${fresh64()}::1` });
  assert.notEqual(elsewhere.data.id, first.data.id);
});

test('one network can only put a few nicknames on a board each week', async () => {
  const ip = freshIp();
  const cap = Number(process.env.LB_NAMES || 3);
  const ids = [];
  for (let i = 0; i < cap; i++) {
    const r = await post('rush-hour', { name: `Alias${RUN}${i}`, ...rushHourRun({ words: 12 }) }, { ip });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ids.push(r.data.id);
  }
  const extra = await post('rush-hour', { name: `Alias${RUN}x`, ...rushHourRun({ words: 50 }) }, { ip });
  assert.equal(extra.status, 429);
  assert.deepEqual(extra.data, { ok: false, error: 'too_many_names' });
  const wait = Number(extra.headers.get('retry-after'));
  assert.ok(wait > 0 && wait <= 7 * 86400 + 3600, `retry-after ${wait}`);
  const { entries } = (await top('rush-hour', 50)).data;
  assert.equal(entries.filter((e) => e.name === `Alias${RUN}x`).length, 0);

  // Names it already has still work, and so does another game.
  const known = await post('rush-hour', { name: `Alias${RUN}0`, ...rushHourRun({ words: 50 }) }, { ip });
  assert.equal(known.status, 200, JSON.stringify(known.data));
  assert.equal(known.data.id, ids[0]);
  const { body } = leadershipBody(`Alias${RUN}x`, MID);
  assert.equal((await post('leadership', body, { ip })).status, 200);

  // The same goes for IPv6 addresses that share a /64.
  const net = fresh64();
  for (let i = 0; i < cap; i++) {
    const r = await post('leadership', leadershipBody(`V6${RUN}${i}`, MID).body, { ip: `${net}::${i + 1}` });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const v6extra = await post('leadership', leadershipBody(`V6${RUN}x`, MID).body, { ip: `${net}::99` });
  assert.equal(v6extra.data.error, 'too_many_names');
});

test('ranks agree with the board', async () => {
  const ip = freshIp();
  const posted = [];
  for (const [i, words] of [25, 45, 35].entries()) {
    const r = await post('rush-hour', { name: `Rank${RUN}${i}`, ...rushHourRun({ words }) }, { ip });
    assert.equal(r.status, 200);
    posted.push(r.data);
  }
  const { entries } = (await top('rush-hour', 50)).data;
  entries.forEach((e, i) => {
    assert.equal(e.rank, i + 1);
    if (i > 0) assert.ok(entries[i - 1].score > e.score || (entries[i - 1].score === e.score && entries[i - 1].ts <= e.ts));
  });

  // Nothing has been posted since the last one, so its rank must match the board exactly.
  const last = posted.at(-1);
  const lastRow = entries.find((e) => e.id === last.id);
  if (lastRow) assert.equal(lastRow.rank, last.rank);

  const rows = posted.map((p) => entries.find((e) => e.id === p.id)).filter(Boolean);
  rows.sort((a, b) => b.score - a.score);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].rank < rows[i].rank);
});

test('nicknames are cleaned or refused', async () => {
  const ip = freshIp();
  const cleaned = await post('rush-hour', { ...rushHourRun({ words: 12 }), name: `<b>${RUN}</b>"'&` }, { ip });
  assert.equal(cleaned.status, 200);
  assert.equal(cleaned.data.name, `b${RUN}b'`);

  const long = await post('rush-hour', { ...rushHourRun({ words: 12 }), name: 'x'.repeat(40) }, { ip });
  assert.equal(long.data.name.length, 16);

  for (const name of ['<<>>', '', '   ', null, 42, 'sh1thead']) {
    const r = await post('rush-hour', { ...rushHourRun({ words: 12 }), name });
    assert.equal(r.status, 400, String(name));
    assert.deepEqual(r.data, { ok: false, error: 'name' });
  }
});

test('malformed requests', async () => {
  const bad = (body, headers) => post('leadership', body, { headers });
  assert.deepEqual((await bad('{"name":')).data, { ok: false, error: 'bad_json' });
  assert.deepEqual((await bad('[1,2,3]')).data, { ok: false, error: 'bad_body' });
  assert.equal((await bad('{}', { 'content-type': 'text/plain' })).status, 415);

  const { body } = leadershipBody(`Big${RUN}`, MID);
  const huge = await bad({ ...body, pad: 'x'.repeat(10_000) });
  assert.equal(huge.status, 413);
  assert.equal(huge.data.error, 'too_large');

  // Same thing without a Content-Length header.
  const chunks = [new TextEncoder().encode(JSON.stringify({ ...body, pad: 'x'.repeat(20_000) }))];
  const stream = new ReadableStream({
    pull(c) {
      if (chunks.length) c.enqueue(chunks.shift());
      else c.close();
    },
  });
  const res = await fetch(`${API}/v1/leadership/scores`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': freshIp() },
    body: stream,
    duplex: 'half',
  });
  assert.equal(res.status, 413);
});

test('posting is rate limited per client and game', async () => {
  const ip = freshIp();
  const limit = Number(process.env.LB_RATE_LIMIT || 6);
  const { body } = leadershipBody(`Spam${RUN}`, MID);
  for (let i = 0; i < limit; i++) {
    const r = await post('leadership', { ...body, lang: 'xx' }, { ip });
    assert.equal(r.status, 422);
  }
  const blocked = await post('leadership', body, { ip });
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.data, { ok: false, error: 'rate_limited' });
  const wait = Number(blocked.headers.get('retry-after'));
  assert.ok(wait > 0 && wait <= 600, `retry-after ${wait}`);

  // Other clients and other games are unaffected.
  assert.equal((await post('leadership', body)).status, 200);
  assert.equal((await post('rush-hour', { name: `Spam${RUN}`, ...rushHourRun({ words: 12 }) }, { ip })).status, 200);
});

test('rotating IPv6 addresses within a /64 does not get around the limit', async () => {
  const net = fresh64();
  const limit = Number(process.env.LB_RATE_LIMIT || 6);
  const { body } = leadershipBody(`Rot${RUN}`, MID);
  for (let i = 0; i < limit; i++) {
    const r = await post('leadership', { ...body, lang: 'xx' }, { ip: `${net}::${(i + 1).toString(16)}` });
    assert.equal(r.status, 422);
  }
  const blocked = await post('leadership', body, { ip: `${net}:aaaa:bbbb:cccc:dddd` });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.error, 'rate_limited');
  assert.equal((await post('leadership', body, { ip: `${fresh64()}::1` })).status, 200);
});
