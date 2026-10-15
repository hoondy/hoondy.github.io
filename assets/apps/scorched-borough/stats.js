// Personal record, kept in this browser only.

const KEY = 'sb:stats:v1';
export const LEVEL_IDS = ['easy', 'normal', 'hard'];

const blank = () => ({
  easy: { w: 0, l: 0, fast: null },
  normal: { w: 0, l: 0, fast: null },
  hard: { w: 0, l: 0, fast: null },
  streak: 0,
  best: 0,
});

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

export function loadStats() {
  const s = blank();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && typeof raw === 'object') {
      for (const id of LEVEL_IDS) {
        const r = raw[id] || {};
        s[id] = { w: count(r.w), l: count(r.l), fast: Number.isInteger(r.fast) && r.fast > 0 ? r.fast : null };
      }
      s.streak = count(raw.streak);
      s.best = Math.max(count(raw.best), s.streak);
    }
  } catch {
    /* corrupt or blocked storage: start fresh */
  }
  return s;
}

function save(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: the record just won't stick */
  }
}

export function recordMatch(level, won, shots) {
  const s = loadStats();
  const rec = s[level];
  const out = { newFast: false, newBest: false };
  if (won) {
    rec.w++;
    s.streak++;
    if (s.streak > s.best) {
      s.best = s.streak;
      out.newBest = s.best > 1;
    }
    if (rec.fast == null || shots < rec.fast) {
      out.newFast = rec.fast != null;
      rec.fast = shots;
    }
  } else {
    rec.l++;
    s.streak = 0;
  }
  save(s);
  return { stats: s, ...out };
}
