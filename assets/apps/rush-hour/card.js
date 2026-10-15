// The image people can save or attach when they share a result: 1200×630, the usual
// link-preview size, drawn like a platform sign.

import { STATIONS, station } from './rules.js';

const PURPLE = '#B933AD';
const YELLOW = '#FCCC0A';
const AMBER = '#FFB000';

function diamond(ctx, cx, cy, size, font) {
  ctx.fillStyle = PURPLE;
  ctx.beginPath();
  ctx.moveTo(cx, cy - size / 2);
  ctx.lineTo(cx + size / 2, cy);
  ctx.lineTo(cx, cy + size / 2);
  ctx.lineTo(cx - size / 2, cy);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.round(size * 0.52)}px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('7', cx, cy + size * 0.03);
}

function fit(ctx, text, maxW, size, weight, font) {
  let s = size;
  ctx.font = `${weight} ${s}px ${font}`;
  while (ctx.measureText(text).width > maxW && s > 20) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${font}`;
  }
  return s;
}

/**
 * @param {{score:number, stage:number, wpm:number, accuracy:number, words:number, pack:string}} r
 * @param {{sign:string, led:string}} fonts
 * @returns {Promise<Blob>}
 */
export function resultCard(r, fonts) {
  const W = 1200;
  const H = 630;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const sign = fonts.sign;
  const led = fonts.led;
  const st = station(r.stage);

  // Tile wall.
  ctx.fillStyle = '#25292c';
  ctx.fillRect(0, 0, W, H);
  for (let row = 0, y = 0; y < H; row++, y += 22) {
    for (let x = row % 2 ? -22 : 0; x < W; x += 44) {
      ctx.fillStyle = `rgba(255,255,255,${0.035 + ((x * 7 + row * 13) % 5) * 0.008})`;
      ctx.fillRect(x + 1, y + 1, 42, 20);
    }
  }

  // Sign band.
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, 132);
  ctx.fillStyle = '#fff';
  ctx.fillRect(28, 14, W - 56, 3);
  diamond(ctx, 92, 74, 80, sign);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  ctx.font = `700 54px ${sign}`;
  ctx.fillText('Rush Hour', 150, 94);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#a7a9ac';
  ctx.font = `600 26px ${sign}`;
  ctx.fillText('hoondy.com/apps/rush-hour', W - 40, 90);

  // Station reached.
  ctx.textAlign = 'left';
  ctx.fillStyle = '#c9cdd1';
  ctx.font = `600 30px ${sign}`;
  ctx.fillText(st.bound === 'Manhattan' ? 'Rode back to' : 'Reached', 60, 205);
  ctx.fillStyle = '#fff';
  const size = fit(ctx, st.name, W - 120, 84, 700, sign);
  ctx.font = `700 ${size}px ${sign}`;
  ctx.fillText(st.name, 60, 290);

  // LED panel with the score.
  const py = 330;
  ctx.fillStyle = '#0b0b0b';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(60, py, W - 120, 150, 14);
  else ctx.rect(60, py, W - 120, 150);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,176,0,0.25)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = AMBER;
  ctx.shadowColor = 'rgba(255,176,0,0.55)';
  ctx.shadowBlur = 18;
  ctx.font = `700 92px ${led}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(r.score.toLocaleString('en-US'), 96, py + 80);
  ctx.shadowBlur = 0;
  ctx.textAlign = 'right';
  ctx.font = `700 30px ${led}`;
  ctx.fillText(`${r.wpm} WPM`, W - 96, py + 52);
  ctx.fillStyle = 'rgba(255,176,0,0.75)';
  ctx.font = `700 24px ${led}`;
  ctx.fillText(`${r.accuracy}% ACC · ${r.words} WORDS`, W - 96, py + 102);

  // Line strip with the station marked.
  const ly = 528;
  const x0 = 80;
  const x1 = W - 80;
  const n = STATIONS.length;
  ctx.strokeStyle = PURPLE;
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, ly);
  ctx.lineTo(x1, ly);
  ctx.stroke();
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / (n - 1);
    const here = i === st.index;
    ctx.fillStyle = here ? '#fff' : i < st.index || st.trip > 1 || st.bound === 'Manhattan' ? '#f2d6ef' : '#2a2a2a';
    ctx.strokeStyle = here ? PURPLE : '#111';
    ctx.lineWidth = here ? 5 : 3;
    ctx.beginPath();
    ctx.arc(x, ly, here ? 13 : 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Tactile strip along the bottom edge.
  ctx.fillStyle = YELLOW;
  ctx.fillRect(0, H - 40, W, 40);
  ctx.fillStyle = 'rgba(120,90,0,0.5)';
  for (let row = 0; row < 3; row++) {
    for (let x = row % 2 ? 12 : 4; x < W; x += 16) {
      ctx.beginPath();
      ctx.arc(x, H - 32 + row * 12, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'));
}
