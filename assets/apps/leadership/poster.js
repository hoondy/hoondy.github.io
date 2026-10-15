// 1080x1350 share image in the style of a station poster: sign band, LED score board,
// percentile line, archetype and a small trait radar.

import { DIM_IDS } from './scoring.js';
import { fill } from './i18n.js';
import { archetypeMark } from './icons.js';

const W = 1080;
const H = 1350;

const C = {
  paper: '#F4F2EC',
  ink: '#111214',
  muted: '#55585E',
  sign: '#111111',
  signMuted: '#A9A9AD',
  rule: '#FFFFFF',
  red: '#EE352E',
  led: '#FFB000',
  ledBg: '#0B0B0B',
  bezel: '#1C1D21',
  grid: '#D8D4C9',
};

// Han characters and punctuation are drawn differently in each language, so the poster puts
// that language's own fonts first (the page sets the same order in leadership.css).
const CJK_BY_LANG = {
  ko: '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic"',
  ja: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", Meiryo',
  zh: '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei"',
};
const CJK_ALL = `${CJK_BY_LANG.ko}, ${CJK_BY_LANG.ja}, ${CJK_BY_LANG.zh}`;

// The page's LED faces (leadership.css) for CJK on the boards. They also supply the word
// space, which in Doto is more than twice as wide as a Hangul or kana space.
const LED_BY_LANG = {
  ko: { face: '"LQ LED KR"', sample: '가 ' },
  ja: { face: '"LQ LED JA"', sample: 'あ ' },
  zh: { face: '"LQ LED ZH"', sample: '中 ' },
};

let SIGN;
let SANS;
let LED;
let LED_CJK;
function setFonts(lang) {
  const own = CJK_BY_LANG[lang];
  const cjk = own ? `${own}, ${CJK_ALL}` : CJK_ALL;
  LED_CJK = LED_BY_LANG[lang] || null;
  SIGN = `"Inter Tight", "Helvetica Neue", Helvetica, Arial, ${cjk}, sans-serif`;
  SANS = `Inter, "Helvetica Neue", Helvetica, Arial, ${cjk}, sans-serif`;
  LED = `${LED_CJK ? `${LED_CJK.face}, ` : ''}Doto, ${cjk}, ui-monospace, Menlo, monospace`;
}
setFonts('en');

async function fontsReady() {
  if (!document.fonts?.load) return;
  const want = [['800 100px "Inter Tight"'], ['700 100px "Inter Tight"'], ['600 40px Inter'], ['500 40px Inter'], ['900 100px Doto'], ['800 40px Doto']];
  if (LED_CJK) want.push([`800 34px ${LED_CJK.face}`, LED_CJK.sample]);
  const timeout = new Promise((r) => setTimeout(r, 2500));
  await Promise.race([Promise.allSettled(want.map((args) => document.fonts.load(...args))), timeout]);
}

// Word-aware wrapping that also breaks CJK text, which has no spaces.
function segments(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      return [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)].map((s) => s.segment);
    } catch {
      /* fall through */
    }
  }
  return text.split(/(\s+)/);
}

function wrap(ctx, text, maxW, maxLines = 3) {
  const lines = [];
  let line = '';
  for (const seg of segments(text)) {
    const tryLine = line + seg;
    if (ctx.measureText(tryLine).width <= maxW || !line.trim()) {
      line = tryLine;
      continue;
    }
    lines.push(line.trimEnd());
    line = seg.trimStart();
  }
  if (line.trim()) lines.push(line.trimEnd());
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }
  return lines;
}

function fitFont(ctx, text, weight, family, size, maxW, min = 18) {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (s > min && ctx.measureText(text).width > maxW) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function signBand(ctx, y, h) {
  ctx.fillStyle = C.sign;
  ctx.fillRect(0, y, W, h);
  ctx.fillStyle = C.rule;
  ctx.fillRect(0, y + 14, W, 3);
}

function bullet(ctx, cx, cy, r, color, text, ink = '#FFFFFF') {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  if (text) {
    ctx.fillStyle = ink;
    ctx.font = `700 ${Math.round(r * 1.25)}px ${SIGN}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + r * 0.06);
  }
}

function ledPanel(ctx, x, y, w, h) {
  ctx.save();
  roundRect(ctx, x - 12, y - 12, w + 24, h + 24, 30);
  ctx.fillStyle = C.bezel;
  ctx.fill();
  roundRect(ctx, x, y, w, h, 20);
  ctx.fillStyle = C.ledBg;
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = 'rgba(255,176,0,.085)';
  for (let yy = y + 4; yy < y + h; yy += 8) {
    for (let xx = x + 4; xx < x + w; xx += 8) {
      ctx.beginPath();
      ctx.arc(xx, yy, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const glass = ctx.createLinearGradient(0, y, 0, y + h);
  glass.addColorStop(0, 'rgba(255,255,255,.05)');
  glass.addColorStop(0.45, 'rgba(255,255,255,0)');
  ctx.fillStyle = glass;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function ledText(ctx, text, x, y, size, align = 'left', weight = 800) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${LED}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.led;
  ctx.shadowColor = 'rgba(255,176,0,.55)';
  ctx.shadowBlur = size * 0.18;
  ctx.fillText(text, x, y);
  ctx.shadowBlur = 0;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function radar(ctx, cx, cy, R, dims, labels, minX) {
  const n = DIM_IDS.length;
  const pt = (i, r) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const poly = (fn) => {
    ctx.beginPath();
    DIM_IDS.forEach((id, i) => {
      const [x, y] = fn(id, i);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.closePath();
  };

  ctx.save();
  ctx.lineWidth = 1.5;
  for (const p of [0.25, 0.5, 0.75, 1]) {
    poly((id, i) => pt(i, R * p));
    ctx.strokeStyle = p === 0.5 ? '#B9B4A6' : C.grid;
    ctx.setLineDash(p === 0.5 ? [6, 6] : []);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  DIM_IDS.forEach((id, i) => {
    const [x, y] = pt(i, R);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.strokeStyle = C.grid;
    ctx.stroke();
  });

  const val = (id) => (R * Math.max(4, dims[id] ?? 50)) / 100;
  poly((id, i) => pt(i, val(id)));
  ctx.fillStyle = 'rgba(238,53,46,.18)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = C.red;
  ctx.stroke();
  DIM_IDS.forEach((id, i) => {
    const [x, y] = pt(i, val(id));
    ctx.beginPath();
    ctx.arc(x, y, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.lineWidth = 3.5;
    ctx.stroke();
  });

  ctx.fillStyle = C.muted;
  ctx.textBaseline = 'middle';
  DIM_IDS.forEach((id, i) => {
    const [x, y] = pt(i, R + 18);
    const dx = x - cx;
    const side = Math.abs(dx) < 4 ? 0 : Math.sign(dx);
    ctx.textAlign = side === 0 ? 'center' : side > 0 ? 'left' : 'right';
    const room = side > 0 ? W - 30 - x : side < 0 ? x - minX : 220;
    fitFont(ctx, labels[id], 600, SANS, 20, room, 11);
    ctx.fillText(labels[id], x, y + (y < cy - R * 0.7 ? -6 : y > cy + R * 0.7 ? 8 : 0));
  });
  ctx.restore();
}

/**
 * Draw the poster for a result (or a decoded shared result) and resolve to a PNG blob.
 * res: { lq, percentile, band, archetype, dims: { id: 1..99 } }
 */
export async function renderPoster(res, t, fmt) {
  setFonts(t.lang);
  await fontsReady();
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const s = t.ui.share;
  const arch = t.archetypes[res.archetype] || {};
  const band = t.bands[res.band] || {};

  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, W, H);

  // Header sign.
  signBand(ctx, 0, 176);
  bullet(ctx, 112, 100, 46, C.red, '1');
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  fitFont(ctx, s.image_kicker, 800, SIGN, 64, 560);
  ctx.fillText(s.image_kicker, 184, 124);
  ctx.fillStyle = C.signMuted;
  ctx.font = `600 30px ${SIGN}`;
  ctx.textAlign = 'right';
  ctx.fillText('hoondy.com', W - 64, 118);

  // Score board.
  const px = 72;
  const py = 246;
  const pw = W - px * 2;
  const ph = 452;
  ledPanel(ctx, px, py, pw, ph);
  ledText(ctx, s.image_lq, px + 40, py + 76, 50);
  if (band.label) ledText(ctx, band.label.toUpperCase(), px + pw - 40, py + 72, 34, 'right');
  ledText(ctx, String(res.lq), W / 2, py + 352, 300, 'center', 900);
  if (band.line) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    const size = fitFont(ctx, band.line, 800, LED, 34, pw - 80, 20);
    ledText(ctx, band.line, W / 2, py + ph - 34, size, 'center');
    ctx.restore();
  }

  // Percentile line.
  ctx.fillStyle = C.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const pctText = fill(s.image_pct, { pct: fmt.pct(res.percentile) });
  let size = 50;
  ctx.font = `700 ${size}px ${SIGN}`;
  let lines = wrap(ctx, pctText, W - 150, 2);
  if (lines.length > 1) {
    size = 44;
    ctx.font = `700 ${size}px ${SIGN}`;
    lines = wrap(ctx, pctText, W - 150, 2);
  }
  lines.forEach((l, i) => ctx.fillText(l, W / 2, 790 + i * (size * 1.18) - (lines.length - 1) * size * 0.3));

  // Divider rule with stations.
  const dy = 880;
  ctx.fillStyle = C.ink;
  ctx.fillRect(72, dy, W - 144, 4);

  // Archetype.
  const mark = archetypeMark(res.archetype);
  const mx = 120;
  const my = 976;
  bullet(ctx, mx, my, 48, mark.color, '');
  ctx.save();
  ctx.translate(mx - 30, my - 30);
  ctx.scale(2.5, 2.5);
  ctx.strokeStyle = mark.ink;
  ctx.lineWidth = 1.9;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D(mark.d));
  ctx.restore();

  ctx.textAlign = 'left';
  ctx.fillStyle = C.muted;
  ctx.font = `600 24px ${SANS}`;
  ctx.fillText(t.ui.result.archetype_label.toUpperCase(), 190, 956);
  ctx.fillStyle = C.ink;
  fitFont(ctx, arch.name || '', 800, SIGN, 52, 390, 28);
  ctx.fillText(arch.name || '', 190, 1010);
  ctx.fillStyle = C.muted;
  ctx.font = `500 29px ${SANS}`;
  wrap(ctx, arch.tagline || '', 500, 3).forEach((l, i) => ctx.fillText(l, 72, 1092 + i * 40));

  // Trait radar.
  const labels = Object.fromEntries(DIM_IDS.map((id) => [id, t.dimensions[id]?.short || t.dimensions[id]?.name || id]));
  radar(ctx, 820, 1046, 96, res.dims, labels, 590);

  // Footer sign.
  signBand(ctx, 1206, H - 1206);
  bullet(ctx, 112, 1286, 30, C.red, '1');
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  fitFont(ctx, s.image_cta, 700, SIGN, 38, W - 220, 22);
  ctx.fillText(s.image_cta, 162, 1288);

  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
}
