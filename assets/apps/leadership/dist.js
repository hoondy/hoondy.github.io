// "Where you land": the LQ distribution on the results page. It draws what the scoring model
// expects right away and swaps in the real distribution when the API has enough results.

import { LQ_MAX, LQ_MIN } from './scoring.js';
import { BINS, binOf, binRange, getDistribution, hasApi, modelBins, percentileIn, usable } from './stats.js';
import { distSvg } from './charts.js';
import { escapeHtml, fill, joinSentences } from './i18n.js';

const TICKS = [55, 70, 85, 100, 115, 130, 145];
// How long the chart may wait for real data before it settles on the model view. If the data
// turns up later it still replaces the model.
const PATIENCE_MS = 1500;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
// --x places a label, --k says how much of its own width sits left of that point: labels at the
// ends stay inside the screen, and the "You are here" pill slides along with its bin.
const pos = (x, k = x) => `--x:${(x * 100).toFixed(2)}%;--k:${k.toFixed(4)}`;
const tickPos = (v, i) => {
  const x = (v - LQ_MIN) / (LQ_MAX - LQ_MIN);
  return pos(x, i === 0 ? 0 : i === TICKS.length - 1 ? 1 : 0.5);
};

/** el: the <figure>; ctx: { t, fmt, r } */
export function mountDistribution(el, { t, fmt, r }) {
  const D = t.ui.distribution;
  const you = binOf(r.lq);
  const [lo, hi] = binRange(you);
  const label = fill(D.chart_label, { lq: r.lq, range: `${lo}–${hi}` });
  const ranges = Array.from({ length: BINS }, (_, i) => binRange(i).join('–'));

  const draw = (mode, data) => {
    const real = mode === 'real';
    const values = real ? data.bins : modelBins();
    const total = values.reduce((s, x) => s + x, 0);
    const pct = fmt.pct(real ? percentileIn(data.bins, r.lq) : r.percentile);
    const headline = real ? fill(D.real_pct, { pct }) : fill(t.templates.percentile, { pct });
    const source = real ? fill(D.real_label, { n: fmt.num(data.n) }) : joinSentences(D.model_label, D.model_note);
    const rows = values
      .map((v, i) => `<tr${i === you ? ' aria-current="true"' : ''}><th scope="row">${ranges[i]}</th><td>${escapeHtml(fmt.share(total ? v / total : 0))}</td></tr>`)
      .join('');

    el.dataset.mode = mode;
    el.innerHTML = `<div class="lq-dist__screen">
  <div class="lq-dist__head" aria-hidden="true"><span>LQ ${LQ_MIN}–${LQ_MAX}</span><span class="lq-dist__badge">${escapeHtml(real ? D.badge_real : D.badge_model)}</span></div>
  <div class="lq-dist__plot" style="${pos((you + 0.5) / BINS)}">
    <span class="lq-dist__here" aria-hidden="true">${escapeHtml(D.you_are_here)}</span>
    <span class="lq-dist__pin" aria-hidden="true"></span>
    ${distSvg(values, you)}
    <div class="lq-dist__axis" aria-hidden="true">${TICKS.map((v, i) => `<span style="${tickPos(v, i)}">${v}</span>`).join('')}</div>
  </div>
</div>
<div class="visually-hidden"><table>
  <caption>${escapeHtml(label)}</caption>
  <thead><tr><th scope="col">${escapeHtml(D.col_range)}</th><th scope="col">${escapeHtml(D.col_share)}</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<figcaption class="lq-dist__cap">
  <strong class="lq-dist__pct">${escapeHtml(headline)}</strong>
  <span class="lq-dist__src">${escapeHtml(source)}</span>
</figcaption>`;
  };

  // The cells light up column by column the first time the chart scrolls into view.
  if (!reducedMotion() && 'IntersectionObserver' in window) {
    el.classList.add('is-armed');
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        el.classList.replace('is-armed', 'is-lit');
      },
      { threshold: 0.4 },
    );
    io.observe(el);
  }

  draw('model');
  if (!hasApi()) return;

  el.classList.add('is-pending');
  let settled = false;
  const settle = () => {
    settled = true;
    el.classList.remove('is-pending');
  };
  const timer = setTimeout(settle, PATIENCE_MS);
  getDistribution().then((d) => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    if (usable(d)) draw('real', d);
    if (!settled) settle();
  });
}
