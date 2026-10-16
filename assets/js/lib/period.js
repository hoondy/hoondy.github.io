// Leaderboards run by calendar month as observed in New York: a board opens on the 1st at
// 00:00 America/New_York and closes when the next month starts. Shared by the browser and the worker.

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

export function periodInfo(date = new Date()) {
  const { year, month } = nyParts(date);
  const next = month === 12 ? [year + 1, 1] : [year, month + 1];
  return {
    key: `${year}-${String(month).padStart(2, '0')}`,
    start: nyMidnight(year, month, 1),
    resetsAt: nyMidnight(next[0], next[1], 1),
  };
}

export function isPeriodKey(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

// "October 2026", "2026년 10월", "octubre de 2026"… Anything that isn't a month key gives ''.
export function periodLabel(key, locale = 'en') {
  if (!isPeriodKey(key)) return '';
  const [y, m] = key.split('-').map(Number);
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 15)));
  } catch {
    return key;
  }
}
