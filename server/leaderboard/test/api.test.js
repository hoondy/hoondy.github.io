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
import { lqResultBody, rushHourRun } from './fixtures.js';

const API = (process.env.LB_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const RUN = Math.random().toString(36).slice(2, 7);
const SITE = 'http://127.0.0.1:4000';
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const RATE_LIMIT = Number(process.env.LB_RATE_LIMIT || 6);
const LQ_RATE_LIMIT = Number(process.env.LB_LQ_RATE_LIMIT || 5);

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
const lqPost = (body, opts) => call('/v1/leadership/results', { method: 'POST', body, ...opts });
const lqDist = (opts) => call('/v1/leadership/distribution', opts);

const HIGH = { drive: 5, presence: 4, dependability: 4, composure: 4, vision: 4, empathy: 3, motivation: 5, decisiveness: 5 };
const MID = { drive: 3, presence: 3, dependability: 4, composure: 3, vision: 3, empathy: 4, motivation: 3, decisiveness: 3 };

test('health check lists the board games', async () => {
  const r = await call('/');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.games, ['rush-hour']);
  assert.match(r.data.period, PERIOD);
});

test('board shape and limits', async () => {
  const r = await top('rush-hour', 5);
  assert.equal(r.status, 200);
  assert.match(r.data.period, PERIOD);
  assert.equal(r.data.week, undefined);
  const resetsAt = Date.parse(r.data.resetsAt);
  assert.ok(resetsAt > Date.now() && resetsAt - Date.now() <= 32 * 86400000);
  assert.ok(Array.isArray(r.data.entries) && r.data.entries.length <= 5);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');

  assert.ok((await top('rush-hour', 0)).data.entries.length <= 1);
  assert.ok((await top('rush-hour', 999)).data.entries.length <= 50);
  assert.equal((await call('/v1/rush-hour/top?limit=abc')).status, 200);
});

test('unknown games, paths and methods', async () => {
  assert.deepEqual((await top('tetris')).data, { ok: false, error: 'unknown_game' });
  assert.equal((await top('tetris')).status, 404);
  assert.equal((await call('/v2/rush-hour/top')).status, 404);
  assert.equal((await call('/v1/rush-hour/scores')).status, 405);
  assert.equal((await call('/v1/rush-hour/top', { method: 'POST', body: {} })).status, 405);
  assert.equal((await call('/v1/leadership/results')).status, 405);
  assert.equal((await call('/v1/leadership/distribution', { method: 'POST', body: {} })).status, 405);
  assert.equal((await call('/v1/rush-hour/results', { method: 'POST', body: {} })).status, 404);
});

test('the LQ test has no board any more', async () => {
  const board = await top('leadership', 10);
  assert.equal(board.status, 404);
  assert.deepEqual(board.data, { ok: false, error: 'unknown_game' });

  const { body } = lqResultBody(MID);
  const posted = await post('leadership', { ...body, name: `Lead${RUN}` });
  assert.equal(posted.status, 404);
  assert.deepEqual(posted.data, { ok: false, error: 'unknown_game' });

  const preflight = await call('/v1/leadership/scores', { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST' } });
  assert.equal(preflight.status, 404);
});

test('CORS', async () => {
  const preflight = (path, origin) =>
    call(path, {
      method: 'OPTIONS',
      origin,
      headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });

  for (const path of ['/v1/rush-hour/scores', '/v1/leadership/results']) {
    for (const origin of ['http://127.0.0.1:4000', 'http://localhost:8080', 'https://hoondy.com', 'https://www.hoondy.com']) {
      const ok = await preflight(path, origin);
      assert.equal(ok.status, 204, `${path} ${origin}`);
      assert.equal(ok.headers.get('access-control-allow-origin'), origin);
      assert.match(ok.headers.get('access-control-allow-headers'), /content-type/);
      assert.match(ok.headers.get('access-control-allow-methods'), /POST/);
      assert.match(ok.headers.get('vary'), /Origin/);
    }

    for (const origin of ['https://evil.example', 'https://hoondy.com.evil.example', 'http://hoondy.com', 'null']) {
      const no = await preflight(path, origin);
      assert.equal(no.status, 403, `${path} ${origin}`);
      assert.equal(no.headers.get('access-control-allow-origin'), null);
    }
  }

  for (const get of [() => top('rush-hour', 3, { origin: 'https://evil.example' }), () => lqDist({ origin: 'https://evil.example' })]) {
    const r = await get();
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  }
  const { body } = lqResultBody(MID);
  const evilPost = await lqPost(body, { origin: 'https://evil.example' });
  assert.equal(evilPost.status, 403);

  const noOrigin = await top('rush-hour', 3, { origin: null });
  assert.equal(noOrigin.status, 200);
  assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);

  const site = await lqDist({ origin: 'https://hoondy.com' });
  assert.equal(site.status, 200);
  assert.equal(site.headers.get('access-control-allow-origin'), 'https://hoondy.com');
});

test('rush hour: the log decides the score', async () => {
  const run = rushHourRun({ words: 90, gapMs: 1100, missAt: [12] });
  const ok = await post('rush-hour', { name: `Rider${RUN}`, ...run });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.ok, true);
  assert.equal(ok.data.score, run.score);
  assert.equal(ok.data.name, `Rider${RUN}`);
  assert.match(ok.data.period, PERIOD);
  assert.equal(ok.data.week, undefined);
  assert.ok(Number.isInteger(ok.data.rank) && ok.data.rank >= 1);

  const board = await top('rush-hour', 50);
  assert.equal(board.data.period, ok.data.period);
  const row = board.data.entries.find((e) => e.id === ok.data.id);
  if (row) {
    assert.equal(row.rank, ok.data.rank);
    assert.equal(row.name, `Rider${RUN}`);
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

test('one row per player per month, best score kept', async () => {
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

test('one network can only put a few nicknames on a board each month', async () => {
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
  // Retry-After counts down to the start of next month.
  const wait = Number(extra.headers.get('retry-after'));
  const resetsAt = Date.parse((await top('rush-hour', 1)).data.resetsAt);
  assert.ok(wait > 0 && Math.abs(Date.now() + wait * 1000 - resetsAt) < 60_000, `retry-after ${wait}`);
  const { entries } = (await top('rush-hour', 50)).data;
  assert.equal(entries.filter((e) => e.name === `Alias${RUN}x`).length, 0);

  // Names it already has still work.
  const known = await post('rush-hour', { name: `Alias${RUN}0`, ...rushHourRun({ words: 50 }) }, { ip });
  assert.equal(known.status, 200, JSON.stringify(known.data));
  assert.equal(known.data.id, ids[0]);

  // The same goes for IPv6 addresses that share a /64.
  const net = fresh64();
  for (let i = 0; i < cap; i++) {
    const r = await post('rush-hour', { name: `V6${RUN}${i}`, ...rushHourRun({ words: 12 }) }, { ip: `${net}::${i + 1}` });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const v6extra = await post('rush-hour', { name: `V6${RUN}x`, ...rushHourRun({ words: 12 }) }, { ip: `${net}::99` });
  assert.equal(v6extra.data.error, 'too_many_names');
});

test('ranks agree with the board', async () => {
  const ip = freshIp();
  const posted = [];
  for (const [i, words] of [25, 45, 35].entries()) {
    const r = await post('rush-hour', { name: `Rank${RUN}${i}`, ...rushHourRun({ words }) }, { ip: i === 0 ? ip : freshIp() });
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

async function streamed(path, text) {
  const chunks = [new TextEncoder().encode(text)];
  const stream = new ReadableStream({
    pull(c) {
      if (chunks.length) c.enqueue(chunks.shift());
      else c.close();
    },
  });
  return fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': freshIp() },
    body: stream,
    duplex: 'half',
  });
}

test('malformed requests', async () => {
  for (const path of ['/v1/rush-hour/scores', '/v1/leadership/results']) {
    const bad = (body, headers) => call(path, { method: 'POST', body, headers });
    assert.deepEqual((await bad('{"name":')).data, { ok: false, error: 'bad_json' }, path);
    assert.deepEqual((await bad('[1,2,3]')).data, { ok: false, error: 'bad_body' }, path);
    assert.deepEqual((await bad('"x"')).data, { ok: false, error: 'bad_body' }, path);
    assert.equal((await bad('{}', { 'content-type': 'text/plain' })).status, 415, path);

    const notUtf8 = await fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': freshIp() },
      body: new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
    });
    assert.equal(notUtf8.status, 400, path);
    assert.deepEqual(await notUtf8.json(), { ok: false, error: 'bad_json' });
  }

  // LQ results are tiny, so the cap is too.
  const { body } = lqResultBody(MID);
  const huge = await lqPost({ ...body, pad: 'x'.repeat(5_000) });
  assert.equal(huge.status, 413);
  assert.equal(huge.data.error, 'too_large');
  assert.equal((await streamed('/v1/leadership/results', JSON.stringify({ ...body, pad: 'x'.repeat(20_000) }))).status, 413);

  const run = rushHourRun({ words: 12 });
  const bigRun = await post('rush-hour', { name: `Big${RUN}`, ...run, pad: 'x'.repeat(300_000) });
  assert.equal(bigRun.status, 413);
  assert.equal((await streamed('/v1/rush-hour/scores', JSON.stringify({ name: `Big${RUN}`, ...run, pad: 'x'.repeat(300_000) }))).status, 413);
});

test('board posting is rate limited per client and game', async () => {
  const ip = freshIp();
  const run = rushHourRun({ words: 12 });
  for (let i = 0; i < RATE_LIMIT; i++) {
    const r = await post('rush-hour', { name: `Spam${RUN}`, ...run, score: run.score + 1 }, { ip });
    assert.equal(r.status, 422);
  }
  const blocked = await post('rush-hour', { name: `Spam${RUN}`, ...run }, { ip });
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.data, { ok: false, error: 'rate_limited' });
  const wait = Number(blocked.headers.get('retry-after'));
  assert.ok(wait > 0 && wait <= 600, `retry-after ${wait}`);

  // Other clients are unaffected, and so are LQ results from the same network.
  assert.equal((await post('rush-hour', { name: `Spam${RUN}`, ...run })).status, 200);
  assert.equal((await lqPost(lqResultBody(MID).body, { ip })).status, 200);
});

test('rotating IPv6 addresses within a /64 does not get around the limit', async () => {
  const net = fresh64();
  const run = rushHourRun({ words: 12 });
  for (let i = 0; i < RATE_LIMIT; i++) {
    const r = await post('rush-hour', { name: `Rot${RUN}`, ...run, score: 1 }, { ip: `${net}::${(i + 1).toString(16)}` });
    assert.equal(r.status, 422);
  }
  const blocked = await post('rush-hour', { name: `Rot${RUN}`, ...run }, { ip: `${net}:aaaa:bbbb:cccc:dddd` });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.error, 'rate_limited');
  assert.equal((await post('rush-hour', { name: `Rot${RUN}`, ...run }, { ip: `${fresh64()}::1` })).status, 200);
});

// ------------------------------------------------------------------------------------------
// LQ statistics

function checkDistribution(d) {
  assert.deepEqual(Object.keys(d).sort(), ['bins', 'max', 'min', 'n', 'step', 'updatedAt']);
  assert.equal(d.min, 55);
  assert.equal(d.max, 145);
  assert.equal(d.step, 5);
  assert.equal(d.bins.length, 18);
  assert.ok(d.bins.every((c) => Number.isInteger(c) && c >= 0));
  assert.equal(d.bins.reduce((s, c) => s + c, 0), d.n);
  if (d.n > 0) {
    // The day only: a time of day could be matched up with the rate-limit rows.
    assert.match(d.updatedAt, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    assert.ok(Date.parse(d.updatedAt) <= Date.now());
  } else {
    assert.equal(d.updatedAt, null);
  }
}

function maxAge(res) {
  const m = /(?:^|[\s,])max-age=(\d+)(?:$|[\s,])/.exec(res.headers.get('cache-control') || '');
  assert.ok(m, `cache-control: ${res.headers.get('cache-control')}`);
  return Number(m[1]);
}

test('LQ distribution shape', async () => {
  const r = await lqDist();
  assert.equal(r.status, 200);
  checkDistribution(r.data);
  assert.match(r.headers.get('cache-control'), /^public, max-age=\d+$/);
  assert.ok(maxAge(r) <= 300);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await call('/v1/leadership/distribution/')).status, 200);
});

test('LQ results are re-scored, counted and answered with the new total', async () => {
  const { body, expected } = lqResultBody(HIGH, { lq: 145, score: 999, name: `Lead${RUN}` });
  const first = await lqPost(body);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(Object.keys(first.data).sort(), ['n', 'ok']);
  assert.equal(first.data.ok, true);
  assert.ok(Number.isInteger(first.data.n) && first.data.n >= 1);

  const second = await lqPost(lqResultBody(MID).body);
  assert.equal(second.status, 200);
  assert.equal(second.data.n, first.data.n + 1);

  // The histogram is cached for a few minutes, so it may lag behind, but never runs ahead.
  const d = (await lqDist()).data;
  checkDistribution(d);
  assert.ok(d.n <= second.data.n);
  assert.ok(expected.lq >= 55 && expected.lq <= 145);
});

test('browsers only keep a cached distribution for what is left of its 5 minutes', async () => {
  await lqDist(); // fills the edge copy, where there is an edge cache
  const posted = await lqPost(lqResultBody(MID).body);
  assert.equal(posted.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const r = await lqDist();
  checkDistribution(r.data);
  assert.ok(r.data.n <= posted.data.n);
  // A copy that's missing the new result was read at least a second ago.
  if (r.data.n < posted.data.n) assert.ok(maxAge(r) < 300, `max-age ${maxAge(r)} for a stale copy`);
});

test('LQ results that do not hold up are refused and not counted', async () => {
  const ip = freshIp();
  const before = await lqPost(lqResultBody(MID).body, { ip });
  assert.equal(before.status, 200);

  const { body } = lqResultBody(MID);
  const cases = [
    [{ ...body, v: '0.0.1' }, 'version'],
    [{ ...body, durationMs: 20_000 }, 'too_fast'],
    [{ ...body, lang: 'xx' }, 'bad_lang'],
    [{ ...body, answers: body.answers.slice(0, 10) }, 'bad_answers'],
  ];
  for (const [payload, error] of cases) {
    const r = await lqPost(payload);
    assert.equal(r.status, 422, error);
    assert.deepEqual(r.data, { ok: false, error });
  }

  const after = await lqPost(lqResultBody(MID).body);
  assert.equal(after.status, 200);
  assert.equal(after.data.n, before.data.n + 1);
});

test('LQ results are rate limited per network', async () => {
  const ip = freshIp();
  const { body } = lqResultBody(MID);
  for (let i = 0; i < LQ_RATE_LIMIT; i++) {
    const r = await lqPost(i % 2 ? body : { ...body, lang: 'xx' }, { ip });
    assert.ok([200, 422].includes(r.status), String(r.status));
  }
  const blocked = await lqPost(body, { ip });
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.data, { ok: false, error: 'rate_limited' });
  const wait = Number(blocked.headers.get('retry-after'));
  assert.ok(wait > 0 && wait <= 3600, `retry-after ${wait}`);

  // Same /64 counts as the same network.
  const net = fresh64();
  for (let i = 0; i < LQ_RATE_LIMIT; i++) await lqPost({ ...body, lang: 'xx' }, { ip: `${net}::${i + 1}` });
  assert.equal((await lqPost(body, { ip: `${net}::abcd` })).status, 429);

  // Boards and other networks are unaffected.
  assert.equal((await post('rush-hour', { name: `Lq${RUN}`, ...rushHourRun({ words: 12 }) }, { ip })).status, 200);
  assert.equal((await lqPost(body)).status, 200);
});
