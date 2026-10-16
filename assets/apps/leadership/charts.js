// SVG charts for the result page: trait radar, the LQ bell curve, the emergence gauge and the
// score distribution. They return markup strings; every piece of text that goes in is escaped here.

import { DIM_IDS, LQ_MIN, LQ_MAX, LQ_MEAN, LQ_SD } from './scoring.js';
import { escapeHtml } from './i18n.js';

const f = (n) => Math.round(n * 10) / 10;

function polar(cx, cy, r, i, n) {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/**
 * Octagonal radar of the eight trait percentiles.
 * values: { dimId: 1..99 }, labels: { dimId: string } (omit for a bare chart)
 * opts.compare: second set of values drawn as a dashed outline
 */
export function radarSvg(values, labels, { size = 360, compare = null, title = '', font = 13.5, showValues = true, cls = '' } = {}) {
  const n = DIM_IDS.length;
  // Side labels sit outside the octagon, so leave room for the longest one (CJK glyphs are
  // roughly twice as wide as Latin ones at the same size).
  const textW = (str) => [...String(str)].reduce((w, ch) => w + font * (ch.codePointAt(0) > 0x2e80 ? 1.04 : 0.61), 0);
  const extra = showValues ? font * 2.5 : font * 0.9;
  const pad = labels ? Math.min(size * 0.6, Math.max(font * 4, ...DIM_IDS.map((id) => textW(labels[id]) + extra))) : 10;
  const W = size + pad * 2;
  const H = size + (labels ? font * 4.8 : 20);
  const cx = W / 2;
  const cy = H / 2;
  const R = size / 2 - 6;

  const ring = (p) =>
    DIM_IDS.map((_, i) => polar(cx, cy, (R * p) / 100, i, n).map(f).join(',')).join(' ');
  const shape = (vals) =>
    DIM_IDS.map((id, i) => polar(cx, cy, (R * Math.max(4, vals[id] ?? 50)) / 100, i, n).map(f).join(',')).join(' ');

  let s = `<svg class="lq-radar${cls ? ` ${cls}` : ''}" viewBox="0 0 ${f(W)} ${f(H)}" ${title ? `role="img" aria-label="${escapeHtml(title)}"` : 'aria-hidden="true"'} focusable="false">`;
  for (const p of [25, 75, 100]) s += `<polygon class="lq-radar__ring" points="${ring(p)}"/>`;
  s += `<polygon class="lq-radar__ring lq-radar__ring--mid" points="${ring(50)}"/>`;
  DIM_IDS.forEach((_, i) => {
    const [x, y] = polar(cx, cy, R, i, n);
    s += `<line class="lq-radar__spoke" x1="${f(cx)}" y1="${f(cy)}" x2="${f(x)}" y2="${f(y)}"/>`;
  });
  if (compare) s += `<polygon class="lq-radar__compare" points="${shape(compare)}"/>`;
  s += `<polygon class="lq-radar__area" points="${shape(values)}"/>`;
  DIM_IDS.forEach((id, i) => {
    const [x, y] = polar(cx, cy, (R * Math.max(4, values[id] ?? 50)) / 100, i, n);
    s += `<circle class="lq-radar__stop" cx="${f(x)}" cy="${f(y)}" r="${size > 200 ? 4.5 : 3}"/>`;
  });
  if (labels) {
    DIM_IDS.forEach((id, i) => {
      const [x, y] = polar(cx, cy, R + font * 1.2, i, n);
      const dx = x - cx;
      const anchor = Math.abs(dx) < 4 ? 'middle' : dx > 0 ? 'start' : 'end';
      const dy = y < cy - R * 0.7 ? -font * 0.45 : y > cy + R * 0.7 ? font * 1.15 : font * 0.37;
      const value = showValues ? `<tspan class="lq-radar__value" dx="${f(font * 0.45)}">${Math.round(values[id] ?? 50)}</tspan>` : '';
      s += `<text class="lq-radar__label" x="${f(x)}" y="${f(y + dy)}" text-anchor="${anchor}" font-size="${font}">${escapeHtml(labels[id])}${value}</text>`;
    });
  }
  return `${s}</svg>`;
}

const pdf = (lq) => Math.exp(-0.5 * ((lq - LQ_MEAN) / LQ_SD) ** 2);

/** Bell curve of the LQ scale with the person's score marked. */
export function bellSvg(lq, { label = '' } = {}) {
  const W = 640;
  const H = 150;
  const top = 26;
  const base = H - 30;
  const x = (v) => ((v - LQ_MIN) / (LQ_MAX - LQ_MIN)) * W;
  const y = (v) => base - pdf(v) * (base - top);

  const pts = [];
  for (let v = LQ_MIN; v <= LQ_MAX; v += 1) pts.push([x(v), y(v)]);
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${f(px)} ${f(py)}`).join('');
  const upTo = pts.filter((_, i) => LQ_MIN + i <= lq);
  const filled = upTo.length
    ? `M${f(x(LQ_MIN))} ${base}${upTo.map(([px, py]) => `L${f(px)} ${f(py)}`).join('')}L${f(x(lq))} ${f(y(lq))}L${f(x(lq))} ${base}Z`
    : '';

  // A few units of side padding keep the marker dot whole at LQ 55 and 145.
  let s = `<svg class="lq-bell" viewBox="-8 0 ${W + 16} ${H}" ${label ? `role="img" aria-label="${escapeHtml(label)}"` : 'aria-hidden="true"'} focusable="false">`;
  s += `<path class="lq-bell__all" d="${line}L${W} ${base}L0 ${base}Z"/>`;
  if (filled) s += `<path class="lq-bell__you" d="${filled}"/>`;
  s += `<path class="lq-bell__line" d="${line}"/>`;
  s += `<line class="lq-bell__base" x1="0" y1="${base}" x2="${W}" y2="${base}"/>`;
  for (const v of [70, 85, 100, 115, 130]) {
    s += `<line class="lq-bell__tick" x1="${f(x(v))}" y1="${base}" x2="${f(x(v))}" y2="${base + 5}"/>`;
    s += `<text class="lq-bell__num" x="${f(x(v))}" y="${H - 6}" text-anchor="middle">${v}</text>`;
  }
  const mx = f(x(lq));
  s += `<line class="lq-bell__marker" x1="${mx}" y1="${f(y(lq)) - 4}" x2="${mx}" y2="${base}"/>`;
  const tx = Math.min(W - 26, Math.max(26, mx));
  s += `<g class="lq-bell__flag" transform="translate(${f(tx)} 13)"><rect x="-24" y="-12" width="48" height="22" rx="11"/><text y="4" text-anchor="middle">${lq}</text></g>`;
  s += `<circle class="lq-bell__dot" cx="${mx}" cy="${f(y(lq))}" r="5"/>`;
  return `${s}</svg>`;
}

/** Ring gauge for a percentage, with a tick where pure chance would be. */
export function gaugeSvg(value, { baseline = 20 } = {}) {
  const r = 44;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  const a = (-90 + baseline * 3.6) * (Math.PI / 180);
  const t1 = [60 + (r - 9) * Math.cos(a), 60 + (r - 9) * Math.sin(a)];
  const t2 = [60 + (r + 9) * Math.cos(a), 60 + (r + 9) * Math.sin(a)];
  return `<svg class="lq-gauge" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
<circle class="lq-gauge__track" cx="60" cy="60" r="${r}"/>
<circle class="lq-gauge__value" cx="60" cy="60" r="${r}" stroke-dasharray="${f((c * v) / 100)} ${f(c)}" transform="rotate(-90 60 60)"/>
<line class="lq-gauge__tick" x1="${f(t1[0])}" y1="${f(t1[1])}" x2="${f(t2[0])}" y2="${f(t2[1])}"/>
</svg>`;
}

/**
 * The score distribution as an LED matrix: one column of cells per bin, lit up to the bin's
 * height, with the visitor's column (`you`) lit red. `values` are counts or shares; only their
 * proportions matter. Text lives outside the SVG so it keeps its size on a phone.
 */
export function distSvg(values, you, { rows = 16 } = {}) {
  const cols = values.length;
  const pitchX = 20;
  const cellW = 15;
  const pitchY = 7.5;
  const cellH = 5;
  const W = cols * pitchX;
  const H = rows * pitchY;
  const max = Math.max(...values);
  let s = `<svg class="lq-dist__svg" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">`;
  values.forEach((v, c) => {
    // Any non-empty bin gets at least one cell, so a rare score still shows up, and so does the
    // visitor's own bin even when the counts they were served don't include them yet.
    const lit = (max > 0 && v > 0) || c === you ? Math.max(1, Math.round((max > 0 ? v / max : 0) * rows)) : 0;
    const cls = c === you ? 'd-you' : 'd-on';
    s += `<g style="--c:${c}">`;
    for (let r = 0; r < rows; r++) {
      const y = H - (r + 1) * pitchY + (pitchY - cellH) / 2;
      s += `<rect x="${f(c * pitchX + (pitchX - cellW) / 2)}" y="${f(y)}" width="${cellW}" height="${cellH}" rx="1.2" class="${r < lit ? `${cls}" style="--r:${r}` : 'd-off'}"/>`;
    }
    s += '</g>';
  });
  return `${s}</svg>`;
}
