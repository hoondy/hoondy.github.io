// D1 queries. Board order is best score first; on a tie, whoever got there first wins.

import { HttpError } from './http.js';

async function run(work) {
  try {
    return await work();
  } catch (err) {
    console.error('d1', err?.message || err);
    throw new HttpError(503, 'unavailable');
  }
}

export function topScores(db, game, period, limit) {
  return run(async () => {
    const { results } = await db
      .prepare(
        `SELECT id, name, score, country, detail, updated_at AS ts
           FROM scores
          WHERE game = ?1 AND period = ?2
          ORDER BY score DESC, updated_at, id
          LIMIT ?3`,
      )
      .bind(game, period, limit)
      .all();
    return results;
  });
}

// Keeps the player's best score for the month and returns where that best now stands.
// `improved` is false when an earlier post this month was at least as good.
//
// A network may only start `maxNames` rows per game per month; otherwise one person could take
// over the whole board under a stream of nicknames. Returns null when this post would have
// been a row over that cap. The check and the insert are one statement, so racing posts
// can't slip past it.
export function saveScore(db, { game, period, client, player, name, score, country, detail, now, maxNames }) {
  return run(async () => {
    const [saved, standing] = await db.batch([
      db
        .prepare(
          `INSERT INTO scores (game, period, client, player, name, score, country, detail, created_at, updated_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9
            WHERE EXISTS (SELECT 1 FROM scores WHERE game = ?1 AND period = ?2 AND client = ?3 AND player = ?4)
               OR (SELECT COUNT(*) FROM scores WHERE game = ?1 AND period = ?2 AND client = ?3) < ?10
           ON CONFLICT (game, period, client, player) DO UPDATE SET
             name = excluded.name,
             score = excluded.score,
             country = excluded.country,
             detail = excluded.detail,
             updated_at = excluded.updated_at
           WHERE excluded.score > scores.score
           RETURNING id`,
        )
        .bind(game, period, client, player, name, score, country, detail, now, maxNames),
      db
        .prepare(
          `SELECT s.id, s.score,
                  1 + (SELECT COUNT(*) FROM scores b
                        WHERE b.game = s.game AND b.period = s.period AND b.score > s.score)
                    + (SELECT COUNT(*) FROM scores b
                        WHERE b.game = s.game AND b.period = s.period AND b.score = s.score
                          AND (b.updated_at < s.updated_at OR (b.updated_at = s.updated_at AND b.id < s.id))) AS rank
             FROM scores s
            WHERE s.game = ?1 AND s.period = ?2 AND s.client = ?3 AND s.player = ?4`,
        )
        .bind(game, period, client, player),
    ]);
    const row = standing.results[0];
    if (!row) return null;
    return { id: row.id, best: row.score, rank: row.rank, improved: saved.results.length > 0 };
  });
}

// Counts a post against the client's sliding window and returns true if it fits under the
// limit. Posts that are turned away are not counted, so waiting always helps.
export function takeSlot(db, { client, game, minute, window, limit }) {
  return run(async () => {
    const row = await db
      .prepare(
        `INSERT INTO hits (client, game, bucket, count)
         SELECT ?1, ?2, ?3, 1
          WHERE (SELECT COALESCE(SUM(count), 0) FROM hits
                  WHERE client = ?1 AND game = ?2 AND bucket > ?3 - ?4) < ?5
         ON CONFLICT (client, game, bucket) DO UPDATE SET count = count + 1
         RETURNING count`,
      )
      .bind(client, game, minute, window, limit)
      .first();
    return row != null;
  });
}

// Minutes until enough old posts fall out of the window for one more to fit.
export function minutesUntilSlot(db, { client, game, minute, window, limit }) {
  return run(async () => {
    const { results } = await db
      .prepare(
        `SELECT bucket, count FROM hits
          WHERE client = ?1 AND game = ?2 AND bucket > ?3 - ?4
          ORDER BY bucket`,
      )
      .bind(client, game, minute, window)
      .all();
    let used = results.reduce((sum, r) => sum + r.count, 0);
    for (const r of results) {
      used -= r.count;
      if (used < limit) return Math.max(1, r.bucket + window - minute);
    }
    return 1;
  });
}

// Daily housekeeping: forget rate-limit rows after a day, drop the IP-derived hashes once a
// month is over (nobody can post to it any more), and delete months past the retention period.
// LQ statistics hold nothing about the person, so they're kept.
export function cleanup(db, { minute, currentPeriod, oldestPeriod }) {
  return run(() =>
    db.batch([
      db.prepare('DELETE FROM hits WHERE bucket < ?1').bind(minute - 24 * 60),
      db
        .prepare(
          `UPDATE scores SET client = NULL, player = 'closed:' || id
            WHERE period < ?1 AND player NOT LIKE 'closed:%'`,
        )
        .bind(currentPeriod),
      db.prepare('DELETE FROM scores WHERE period < ?1').bind(oldestPeriod),
    ]),
  );
}

// ------------------------------------------------------------------------------------------
// LQ statistics

// Stores one anonymous result and counts it in the histogram in the same batch (D1 runs a
// batch as one transaction), then returns the new total.
//
// The row gets a random id rather than the next one in line: sequential ids would give the
// order results came in, and that order could be lined up with the rate-limit rows. Keeping
// ids under 2^53 lets them come back to JavaScript exactly.
export function saveLqResult(db, { day, lang, version, lq, archetype, answers, bin, stamp }) {
  return run(async () => {
    const [, , total] = await db.batch([
      db
        .prepare(
          `INSERT INTO lq_results (id, day, lang, version, lq, archetype, answers)
           VALUES (abs(random() % 9007199254740992), ?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(day, lang, version, lq, archetype, answers),
      db
        .prepare(
          `INSERT INTO lq_hist (bin, count, updated_at) VALUES (?1, 1, ?2)
           ON CONFLICT (bin) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
        )
        .bind(bin, stamp),
      db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM lq_hist'),
    ]);
    return total.results[0]?.n ?? 0;
  });
}

export function lqHistogram(db) {
  return run(async () => {
    const { results } = await db.prepare('SELECT bin, count, updated_at FROM lq_hist ORDER BY bin').all();
    return results;
  });
}
