// Strings for the LQ Test. The page embeds its own language and, on translated pages, the
// English set as a fallback, so a key a translation is missing still shows something sensible.

function readJson(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return null;
  }
}

// English decides the shape. Arrays only take the translation when the length matches,
// because some of them line up with scoring (scenario options, scale labels).
export function merge(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base)) {
    if (!Array.isArray(over) || over.length !== base.length) return base;
    return base.map((b, i) => merge(b, over[i]));
  }
  if (base && typeof base === 'object') {
    if (typeof over !== 'object' || Array.isArray(over)) return base;
    const out = {};
    for (const k of Object.keys(base)) out[k] = merge(base[k], over[k]);
    return out;
  }
  if (typeof base === 'string') return typeof over === 'string' && over.trim() ? over : base;
  return typeof over === typeof base ? over : base;
}

export function loadStrings() {
  const own = readJson('lq-i18n') || {};
  const en = readJson('lq-i18n-en');
  return en ? merge(en, own) : own;
}

export function fill(str, vars = {}) {
  return String(str ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function makeFormat(t) {
  const locale = t.locale || t.lang || 'en';
  const numberFormat = (opts) => {
    try {
      return new Intl.NumberFormat(locale, opts);
    } catch {
      return new Intl.NumberFormat('en', opts);
    }
  };
  const intFmt = numberFormat({ maximumFractionDigits: 0 });
  const shareFmt = numberFormat({ style: 'percent', maximumFractionDigits: 1 });
  // The norms are provisional, so a decimal (or a 0 or 100 at the extremes) would claim more
  // precision than they have.
  const pct = (n) => intFmt.format(Math.min(99, Math.max(1, Math.round(n))));

  const list = (items) => {
    const sep = t.templates?.list_separator ?? ', ';
    const last = t.templates?.list_last_separator ?? ' and ';
    if (items.length < 2) return items.join('');
    return items.slice(0, -1).join(sep) + last + items[items.length - 1];
  };

  const num = (n) => intFmt.format(n);
  // A share of people (0..1) as a percentage, for the chart's text alternative.
  const share = (x) => shareFmt.format(x);

  return { pct, list, num, share };
}

// Japanese and Chinese sentences follow one another without a space (after 。 or a trailing
// …); everything else, Korean included, takes one. Deciding by the text rather than the page
// language also keeps an English fallback string on a Chinese page from running together.
const CJK_END = /[　-〿぀-ヿ㐀-鿿＀-￯]…*$/;
export const sentenceGap = (s) => (CJK_END.test(String(s ?? '')) ? '' : ' ');
export const joinSentences = (a, b) => `${a}${sentenceGap(a)}${b}`;

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
