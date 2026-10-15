// Nickname rules for public leaderboards. Shared by the browser and the worker.

export const NAME_MAX = 16;

// Deliberately short; the goal is to stop the obvious stuff, not to be a moderation system.
const BLOCKED = [
  'fuck', 'shit', 'cunt', 'nigg', 'fagg', 'bitch', 'whore', 'slut', 'rapist', 'nazi', 'hitler',
  'porn', 'pussy', 'asshole', 'retard', 'chink',
  'hijodeputa', 'putamadre', 'mierda', 'pendej', 'cabron', 'verga', 'coño',
  'まんこ', 'ちんこ', 'ちんぽ', '死ね', 'クソ',
  '傻逼', '操你', '他妈', '婊子', '鸡巴',
];

// Korean is also checked against a Hangul-only copy of the name, so a digit or Latin letter
// slipped into the middle ("시1발") doesn't split the word.
const BLOCKED_KO = [
  '씨발', '시발', '병신', '좆', '좃', '개새', '느금', '븅신', '니애미', '느개비', '씹',
  'ㅅㅂ', 'ㅆㅂ', 'ㅂㅅ', 'ㅄ', 'ㅆ발',
];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

// Cyrillic and Greek letters that pass for Latin ones.
const LOOKALIKE = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', к: 'k', м: 'm',
  н: 'h', т: 't', в: 'b', ԁ: 'd', ɡ: 'g', ο: 'o', α: 'a', ι: 'i', κ: 'k', ν: 'v', τ: 't', ρ: 'p',
  χ: 'x', υ: 'u', ε: 'e',
};

function squash(s) {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\s\S]/gu, (c) => LOOKALIKE[c] ?? LEET[c] ?? c)
    .replace(/[^\p{L}\p{N}]/gu, '');
}

const BLOCKED_SQ = BLOCKED.map(squash);
const BLOCKED_KO_SQ = BLOCKED_KO.map(squash);

// Returns a cleaned nickname, or null when nothing usable is left or it trips the block list.
export function cleanName(input) {
  if (typeof input !== 'string') return null;
  let s = input
    .normalize('NFKC') // fullwidth and math letters become plain ones
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '') // zero-width chars, Hangul fillers, variation selectors
    .replace(/[^\p{L}\p{M}\p{N} _.\-']/gu, '')
    .replace(/(^|[^\p{L}\p{N}\p{M}])\p{M}+/gu, '$1') // marks with nothing to sit on
    .replace(/(\p{M}{3})\p{M}+/gu, '$1') // no towers of stacked marks
    .replace(/\s+/g, ' ')
    .trim();
  s = Array.from(s).slice(0, NAME_MAX).join('').trim();
  if (!/[\p{L}\p{N}]/u.test(s)) return null;

  const flat = squash(s);
  if (BLOCKED_SQ.some((w) => flat.includes(w))) return null;
  const hangul = squash(s.replace(/[^\p{Script=Hangul}]/gu, ''));
  if (hangul && BLOCKED_KO_SQ.some((w) => hangul.includes(w) || flat.includes(w))) return null;
  return s;
}
