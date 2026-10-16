// Calendar helpers on top of the shared period module. Boards run by calendar month in New York.

import { TIME_ZONE, isPeriodKey } from '../../../assets/js/lib/period.js';

const DAY_MS = 86_400_000;

const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

// The New York calendar date of an instant, as YYYY-MM-DD.
export function nyDay(date = new Date()) {
  const p = {};
  for (const { type, value } of dayFmt.formatToParts(date)) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}

// Midnight UTC at the start of the day that contains `ms` (ms since epoch).
export function utcDayStart(ms) {
  return ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS);
}

// The period key `months` months before (or after, when negative) `key`: ('2026-01', 2) -> '2025-11'.
export function monthsBefore(key, months) {
  if (!isPeriodKey(key)) throw new RangeError(`bad period ${key}`);
  const [y, m] = key.split('-').map(Number);
  const i = y * 12 + (m - 1) - months;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}
