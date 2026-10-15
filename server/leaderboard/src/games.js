// Games that have a public board. Each validator is the same module the browser uses, so the
// server and the page always agree on the rules. A validator takes the untrusted request body
// and returns { ok: true, score, detail } or { ok: false, error }.

import { validateSubmission as leadership } from '../../../assets/apps/leadership/scoring.js';
import { validateSubmission as rushHour } from '../../../assets/apps/rush-hour/rules.js';

export const GAMES = {
  // 49 small integers plus a language code.
  leadership: { validate: leadership, maxBody: 8 * 1024 },
  // The replay log is capped at 8000 entries of at most ~26 bytes each.
  'rush-hour': { validate: rushHour, maxBody: 256 * 1024 },
};

export function getGame(id) {
  return Object.hasOwn(GAMES, id) ? GAMES[id] : null;
}
