// Leaderboard weeks follow the ISO calendar as observed in New York:
// a week starts Monday 00:00 America/New_York. Shared by the browser and the worker.

export const TIME_ZONE = 'America/New_York';

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', second: 'numeric',
});

function nyParts(date) {
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = +value;
  return p;
}

// Offset of New York from UTC (in ms) at the given instant.
function nyOffset(date) {
  const p = nyParts(date);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - Math.floor(date.getTime() / 1000) * 1000;
}

// UTC instant of local midnight in New York for a calendar date.
function nyMidnight(y, m, d) {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - nyOffset(new Date(guess));
  t = guess - nyOffset(new Date(t)); // settle across DST changes
  return new Date(t);
}

export function weekInfo(date = new Date()) {
  const p = nyParts(date);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dow = day.getUTCDay() || 7; // Mon=1..Sun=7

  const thursday = new Date(day);
  thursday.setUTCDate(day.getUTCDate() + 4 - dow);
  const isoYear = thursday.getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((thursday - jan1) / 86400000 + 1) / 7);

  const monday = new Date(day);
  monday.setUTCDate(day.getUTCDate() - (dow - 1));
  const next = new Date(monday);
  next.setUTCDate(monday.getUTCDate() + 7);

  return {
    key: `${isoYear}-W${String(week).padStart(2, '0')}`,
    start: nyMidnight(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate()),
    resetsAt: nyMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  };
}

// "Oct 12 – 18" (or "10月12日～18日") for the current week; any other key is returned as is,
// e.g. a server a moment past the reset. Years are left out even when the week spans New Year.
export function weekLabel(key, locale = 'en', now = new Date()) {
  const w = weekInfo(now);
  if (key !== w.key) return key;
  try {
    const f = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: TIME_ZONE });
    const end = new Date(w.resetsAt.getTime() - 1);
    if (nyParts(w.start).year !== nyParts(end).year) return `${f.format(w.start)} – ${f.format(end)}`;
    return f.formatRange(w.start, end);
  } catch {
    return key;
  }
}

export function isWeekKey(s) {
  return typeof s === 'string' && /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(s);
}
