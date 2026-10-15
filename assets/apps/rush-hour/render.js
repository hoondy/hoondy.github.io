// Canvas drawing: the station wall, the platform edge, the word tiles and the effects.
// Sizes are in CSS pixels; the backing store is scaled by devicePixelRatio for crisp text.

import { KIND } from './rules.js';

const PURPLE = '#B933AD';
const YELLOW = '#FCCC0A';
const RED = '#EE352E';
const GREEN = '#00933C';
const AMBER = '#FFB000';
const SIGN = '#111111';

const SPECIAL = {
  [KIND.EXPRESS]: { label: 'EXPRESS ×2', color: PURPLE },
  [KIND.DELAY]: { label: 'SIGNAL DELAY', color: RED },
  [KIND.CLEAR]: { label: 'ALL CLEAR', color: GREEN },
};

const ease = (t) => 1 - (1 - t) ** 3;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Small deterministic noise so the tile wall looks the same after every resize.
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class Renderer {
  constructor(canvas, { reducedMotion = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.reducedMotion = reducedMotion;
    const css = getComputedStyle(canvas);
    this.fontSign = css.getPropertyValue('--rh-font-sign').trim() || '"Helvetica Neue", Helvetica, Arial, sans-serif';
    this.fontLed = css.getPropertyValue('--rh-font-led').trim() || 'ui-monospace, Menlo, Consolas, monospace';
    this.W = 0;
    this.H = 0;
    this.dpr = 1;
    this.bg = null;
    this.stationName = '';
    this.particles = [];
    this.popups = [];
    this.ghosts = [];
    this.banner = null;
    this.train = null;
    this.flash = 0;
    this.typoFlash = 0;
    this.missFlash = 0;
    this.widths = new Map();
  }

  // Called whenever the field changes size. Returns true if anything changed.
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width));
    const H = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (W === this.W && H === this.H && dpr === this.dpr && this.bg) return false;
    this.W = W;
    this.H = H;
    this.dpr = dpr;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);

    const small = W < 560;
    this.small = small;
    this.font = small ? 19 : clamp(Math.round(W / 46), 20, 24);
    this.tileH = Math.round(this.font * 1.85);
    this.padX = Math.round(this.font * 0.62);
    this.badgeW = Math.round(this.tileH * 0.95);
    this.capH = 15;
    this.stripH = small ? 16 : 18;
    this.trackH = small ? 32 : 36;
    this.missY = H - this.stripH - this.trackH;
    this.widths.clear();
    this.buildBackground();
    return true;
  }

  fontsChanged() {
    this.widths.clear();
    this.buildBackground();
  }

  tileWidth(text, kind) {
    const key = `${text}|${kind}`;
    let w = this.widths.get(key);
    if (w == null) {
      const ctx = this.ctx;
      ctx.font = `700 ${this.font}px ${this.fontSign}`;
      w = Math.ceil(ctx.measureText(text).width) + this.padX * 2 + (kind !== KIND.NORMAL ? this.badgeW : 0);
      this.widths.set(key, w);
    }
    return w;
  }

  // Width of a tile as a fraction of the field, for the engine's spawn placement.
  measure(text, kind) {
    return this.tileWidth(text, kind) / Math.max(1, this.W);
  }

  setStation(name) {
    if (name === this.stationName) return;
    this.stationName = name;
    if (this.W) this.buildBackground();
  }

  // ---------------------------------------------------------------- background

  buildBackground() {
    const { W, H, dpr } = this;
    if (!W || !H) return;
    const c = this.bg || document.createElement('canvas');
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Glazed cream subway tile, dimmed for a late-night platform and lit from above.
    const wallH = this.missY;
    const light = g.createLinearGradient(0, 0, 0, wallH);
    light.addColorStop(0, '#8d8775');
    light.addColorStop(0.6, '#726d5e');
    light.addColorStop(1, '#5d5a50');
    g.fillStyle = light;
    g.fillRect(0, 0, W, wallH);

    const tw = this.small ? 28 : 34;
    const th = tw / 2;
    for (let row = 0, y = 0; y < wallH; row++, y += th) {
      const off = row % 2 ? tw / 2 : 0;
      for (let col = -1, x = -off; x < W; col++, x += tw) {
        const n = hash(col + 9, row + 3);
        // No two glazes come out of the kiln quite the same.
        g.fillStyle = n < 0.5 ? `rgba(255,250,235,${n * 0.08})` : `rgba(40,34,20,${(n - 0.5) * 0.09})`;
        g.fillRect(x + 1, y + 1, tw - 2, th - 2);
        // Glaze catches the light along the top edge and darkens toward the bottom.
        g.fillStyle = 'rgba(255,252,240,0.16)';
        g.fillRect(x + 1, y + 1, tw - 2, 1.5);
        g.fillStyle = 'rgba(0,0,0,0.08)';
        g.fillRect(x + 1, y + th - 3, tw - 2, 2);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(x, y + th - 1, tw, 1);
        g.fillRect(x + tw - 1, y, 1, th);
      }
    }

    // Overhead light pool and a vignette toward the corners.
    const pool = g.createRadialGradient(W / 2, -H * 0.15, 10, W / 2, -H * 0.15, Math.max(W, H) * 0.85);
    pool.addColorStop(0, 'rgba(255,240,205,0.16)');
    pool.addColorStop(1, 'rgba(255,240,205,0)');
    g.fillStyle = pool;
    g.fillRect(0, 0, W, wallH);
    const vig = g.createRadialGradient(W / 2, H * 0.4, Math.min(W, H) * 0.25, W / 2, H * 0.4, Math.max(W, H) * 0.75);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = vig;
    g.fillRect(0, 0, W, wallH);
    // Shadow where the wall meets the platform.
    const foot = g.createLinearGradient(0, wallH - 70, 0, wallH);
    foot.addColorStop(0, 'rgba(0,0,0,0)');
    foot.addColorStop(1, 'rgba(0,0,0,0.35)');
    g.fillStyle = foot;
    g.fillRect(0, wallH - 70, W, 70);

    this.drawFrieze(g);

    // Platform edge: tactile warning strip, then the drop to the trackbed.
    const sy = this.missY;
    g.fillStyle = '#d9ab00';
    g.fillRect(0, sy, W, this.stripH);
    g.fillStyle = YELLOW;
    g.fillRect(0, sy, W, this.stripH - 2);
    const gap = this.small ? 7 : 8;
    const r = this.small ? 1.6 : 1.9;
    for (let row = 0, y = sy + gap / 2 + 0.5; y < sy + this.stripH - 2; row++, y += gap) {
      for (let x = (row % 2 ? gap : gap / 2); x < W; x += gap) {
        g.fillStyle = 'rgba(120,90,0,0.55)';
        g.beginPath();
        g.arc(x + 0.4, y + 0.5, r, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = 'rgba(255,240,170,0.9)';
        g.beginPath();
        g.arc(x - 0.3, y - 0.3, r * 0.55, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.fillStyle = 'rgba(255,255,255,0.65)';
    g.fillRect(0, sy, W, 1);

    const ty = sy + this.stripH;
    const pit = g.createLinearGradient(0, ty, 0, H);
    pit.addColorStop(0, '#0d0d0e');
    pit.addColorStop(1, '#050505');
    g.fillStyle = pit;
    g.fillRect(0, ty, W, H - ty);
    g.fillStyle = '#2a2b2d';
    g.fillRect(0, ty, W, 3);
    // Running rail glint.
    g.fillStyle = 'rgba(200,205,210,0.18)';
    g.fillRect(0, H - 9, W, 2);

    this.bg = c;
  }

  // A mosaic band with the station's name tablet, kept dim so it never competes with the words.
  drawFrieze(g) {
    const { W } = this;
    const t = this.small ? 5 : 6;
    const rows = 5;
    const y = Math.round(this.missY * 0.2);
    const cream = '#cfc5aa';
    const plum = ['#6d2766', '#82307a', '#5a2055'];
    g.save();
    g.globalAlpha = 0.72;
    for (let r = 0; r < rows; r++) {
      for (let c = 0, x = 0; x < W; c++, x += t) {
        let color;
        if (r === 0 || r === rows - 1) color = cream;
        else if (r === 2) color = c % 6 === 0 ? cream : plum[(c >> 1) % 3];
        else color = (c + (r === 1 ? 0 : 3)) % 6 < 3 ? plum[1] : '#3d1a39';
        g.fillStyle = color;
        g.fillRect(x + 0.5, y + r * t + 0.5, t - 1, t - 1);
      }
    }
    g.restore();

    const name = this.stationName;
    if (!name) return;
    const fs = this.small ? 13 : 15;
    g.font = `700 ${fs}px ${this.fontSign}`;
    const tw = Math.ceil(g.measureText(name).width) + (this.small ? 30 : 44);
    const th = this.small ? 30 : 36;
    const tx = Math.round((W - tw) / 2);
    const ty = Math.round(y + (rows * t) / 2 - th / 2);
    g.save();
    g.globalAlpha = 0.88;
    g.fillStyle = '#3d1a39';
    g.fillRect(tx - t, ty - t, tw + t * 2, th + t * 2);
    for (let x = tx - t; x < tx + tw + t; x += t) {
      g.fillStyle = plum[(x / t) % 3 | 0] || plum[0];
      g.fillRect(x + 0.5, ty - t + 0.5, t - 1, t - 1);
      g.fillRect(x + 0.5, ty + th + 0.5, t - 1, t - 1);
    }
    g.fillStyle = '#d8ceb4';
    g.fillRect(tx, ty, tw, th);
    g.fillStyle = '#2b1c26';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name, tx + tw / 2, ty + th / 2 + 1);
    // Grout lines over the lettering give it the tessellated look.
    g.fillStyle = 'rgba(216,206,180,0.5)';
    for (let x = tx; x < tx + tw; x += 3) g.fillRect(x, ty, 1, th);
    for (let yy = ty; yy < ty + th; yy += 3) g.fillRect(tx, yy, tw, 1);
    g.restore();
  }

  // ---------------------------------------------------------------- geometry

  tileRect(w) {
    const width = this.tileWidth(w.text, w.kind);
    const top0 = -(this.tileH + this.capH + 4);
    const top1 = this.missY - this.tileH;
    const y = top0 + w.y * (top1 - top0);
    const x = clamp(w.x * this.W - width / 2, 4, Math.max(4, this.W - width - 4));
    return { x, y, w: width, h: this.tileH };
  }

  // ---------------------------------------------------------------- effects

  showBanner(kicker, title, ms = 2100) {
    this.banner = { kicker, title, t: 0, ms };
  }

  // `multiplier` is set when this word took the combo up a step.
  wordCleared(word, points, streak, multiplier = 0) {
    const r = this.tileRect(word);
    const express = word.kind === KIND.EXPRESS;
    this.ghosts.push({ ...r, text: word.text, kind: word.kind, t: 0, ms: 380, mode: 'clear' });
    this.popup(r.x + r.w / 2, r.y, `+${points.toLocaleString('en-US')}`, express ? '#f3a6ec' : AMBER, express ? 26 : 22);
    if (multiplier) this.popup(r.x + r.w / 2, r.y - 28, `COMBO ×${multiplier}`, '#f3a6ec', 18, 1100);
    this.burst(r.x + r.w / 2, r.y + r.h / 2, express ? 26 : 14, express ? PURPLE : YELLOW, streak);
    this.flash = Math.max(this.flash, word.kind === KIND.NORMAL ? 0 : 0.35);
  }

  wordMissed(word, penalty) {
    const r = this.tileRect(word);
    this.ghosts.push({ ...r, text: word.text, kind: word.kind, t: 0, ms: 700, mode: 'miss' });
    if (penalty > 0) this.popup(r.x + r.w / 2, this.missY - 24, `−${penalty.toLocaleString('en-US')}`, '#ff6b5e');
    this.missFlash = 1;
  }

  swept(words, points) {
    const rects = words.map((w, i) => ({ ...this.tileRect(w), text: w.text, kind: w.kind, points: points[i] }));
    if (this.reducedMotion) {
      for (const r of rects) {
        this.ghosts.push({ ...r, t: 0, ms: 300, mode: 'clear' });
        this.popup(r.x + r.w / 2, r.y, `+${r.points}`, AMBER);
      }
      this.flash = 0.6;
      return;
    }
    for (const r of rects) this.ghosts.push({ ...r, t: 0, ms: 1e9, mode: 'wait' });
    this.train = { t: 0, ms: 1000, rects };
  }

  // The sign being typed shakes; with nothing targeted, the platform edge flushes red.
  typo(onTarget = true) {
    this.typoFlash = 1;
    if (!onTarget) this.missFlash = Math.max(this.missFlash, 0.35);
  }

  popup(x, y, text, color, size = 22, ms = 900) {
    if (this.popups.length > 30) this.popups.shift();
    this.popups.push({ x, y, text, color, size, t: 0, ms });
  }

  burst(x, y, n, color, streak = 0) {
    if (this.reducedMotion) return;
    const count = Math.min(n + Math.min(streak, 20), 40);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 60 + Math.random() * 220;
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 80,
        t: 0, ms: 450 + Math.random() * 350,
        size: 2 + Math.random() * 3,
        color: i % 3 === 0 ? '#ffffff' : color,
      });
    }
    if (this.particles.length > 400) this.particles.splice(0, this.particles.length - 400);
  }

  clearEffects() {
    this.particles.length = 0;
    this.popups.length = 0;
    this.ghosts.length = 0;
    this.banner = null;
    this.train = null;
    this.flash = this.typoFlash = this.missFlash = 0;
  }

  get busy() {
    return this.particles.length || this.popups.length || this.ghosts.length || this.banner || this.train || this.flash > 0.01 || this.missFlash > 0.01;
  }

  // ---------------------------------------------------------------- frame

  /**
   * @param {object} view  { words, buffer, target, slowed, slowLeft, danger } snapshot from the game
   * @param {number} dt    ms since the last frame
   */
  draw(view, dt) {
    const { ctx, W, dpr } = this;
    if (!W || !this.bg) return;
    const s = dt / 1000;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.bg, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (view.slowed) this.drawDelay(view);
    // Banners go under the signs, so a word is never hidden behind one.
    if (this.banner) this.drawBanner(dt);

    // Warn on the strip when something is about to hit it.
    let danger = 0;
    for (const w of view.words) danger = Math.max(danger, (w.y - 0.72) / 0.28);
    danger = clamp(danger, 0, 1);
    const hit = Math.max(this.missFlash, danger * 0.45);
    if (hit > 0.01) {
      const grad = ctx.createLinearGradient(0, this.missY - 60, 0, this.missY + this.stripH);
      grad.addColorStop(0, 'rgba(238,53,46,0)');
      grad.addColorStop(1, `rgba(238,53,46,${0.55 * hit})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, this.missY - 60, W, 60 + this.stripH);
    }

    this.drawGhosts(dt);
    const masked = !!view.masked;
    for (const w of view.words) if (w !== view.target) this.drawTile(w, false, null, masked);
    if (view.target) this.drawTile(view.target, true, null, masked);

    if (this.train) this.drawTrain(dt);
    this.drawParticles(s, dt);
    this.drawPopups(dt);
    this.drawBuffer(view);

    if (this.flash > 0.01) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.18})`;
      ctx.fillRect(0, 0, W, this.missY);
      this.flash *= Math.pow(0.0005, s);
    }
    this.missFlash = Math.max(0, this.missFlash - s * 2.2);
    this.typoFlash = Math.max(0, this.typoFlash - s * 4);
  }

  drawTile(w, isTarget, rect = null, masked = false) {
    const { ctx } = this;
    const r = { ...(rect || this.tileRect(w)) };
    if (r.y + r.h < -2) return;
    const special = SPECIAL[w.kind];
    const danger = clamp((w.y - 0.72) / 0.28, 0, 1);
    const shake = isTarget && !this.reducedMotion ? this.typoFlash : 0;
    if (shake > 0) r.x += Math.sin(shake * 40) * 4 * shake;

    if (special) {
      ctx.font = `800 10px ${this.fontSign}`;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      const lw = Math.ceil(ctx.measureText(special.label).width) + 10;
      roundRect(ctx, r.x, r.y - this.capH - 2, lw, this.capH, 3);
      ctx.fillStyle = special.color;
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(special.label, r.x + 5, r.y - 6);
    }

    ctx.save();
    if (isTarget) {
      ctx.shadowColor = 'rgba(185,51,173,0.9)';
      ctx.shadowBlur = 16;
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 3;
    }
    roundRect(ctx, r.x, r.y, r.w, r.h, 5);
    ctx.fillStyle = SIGN;
    ctx.fill();
    ctx.restore();

    if (isTarget) {
      roundRect(ctx, r.x - 1, r.y - 1, r.w + 2, r.h + 2, 6);
      ctx.strokeStyle = this.typoFlash > 0.15 ? RED : PURPLE;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // The thin white rule along the top of every subway sign; it turns red near the edge.
    const ruleY = r.y + 4;
    ctx.fillStyle = danger > 0 ? `rgb(255,${Math.round(255 - danger * 200)},${Math.round(255 - danger * 210)})` : 'rgba(255,255,255,0.92)';
    ctx.fillRect(r.x + 5, ruleY, r.w - 10, 1.5);

    let tx = r.x + this.padX;
    if (special) {
      const bx = r.x + 6;
      const by = r.y + 8;
      const bs = r.h - 13;
      this.drawBadge(w.kind, bx, by, bs);
      tx += this.badgeW - 2;
    }
    if (masked) return;

    ctx.font = `700 ${this.font}px ${this.fontSign}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const ty = r.y + r.h / 2 + 2.5;
    const typed = w.typed ? w.text.slice(0, w.typed) : '';
    if (typed) {
      ctx.fillStyle = YELLOW;
      ctx.fillText(typed, tx, ty);
      tx += ctx.measureText(typed).width;
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillText(w.text.slice(typed.length), tx, ty);
  }

  drawBadge(kind, x, y, size) {
    const { ctx } = this;
    const cx = x + size / 2;
    const cy = y + size / 2;
    if (kind === KIND.EXPRESS) {
      ctx.fillStyle = PURPLE;
      ctx.beginPath();
      ctx.moveTo(cx, y - 1);
      ctx.lineTo(x + size + 1, cy);
      ctx.lineTo(cx, y + size + 1);
      ctx.lineTo(x - 1, cy);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${Math.round(size * 0.62)}px ${this.fontSign}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('7', cx, cy + 1);
    } else if (kind === KIND.DELAY) {
      ctx.fillStyle = '#2b2b2b';
      roundRect(ctx, x, y, size, size, size / 2);
      ctx.fill();
      ctx.fillStyle = RED;
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath();
      ctx.arc(cx - size * 0.09, cy - size * 0.09, size * 0.08, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === KIND.CLEAR) {
      ctx.fillStyle = GREEN;
      ctx.beginPath();
      ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - size * 0.22, cy + 0.5);
      ctx.lineTo(cx - size * 0.05, cy + size * 0.17);
      ctx.lineTo(cx + size * 0.24, cy - size * 0.18);
      ctx.stroke();
    }
  }

  drawGhosts(dt) {
    const { ctx } = this;
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const g = this.ghosts[i];
      if (g.mode === 'wait') {
        this.drawTile({ ...g, y: 0, x: 0, typed: 0 }, false, g);
        continue;
      }
      g.t += dt;
      const p = g.t / g.ms;
      if (p >= 1) {
        this.ghosts.splice(i, 1);
        continue;
      }
      ctx.save();
      if (g.mode === 'clear') {
        // Hold the flash for a beat, then let it go.
        ctx.globalAlpha = 1 - p * p;
        const sc = 1 + ease(p) * 0.18;
        ctx.translate(g.x + g.w / 2, g.y + g.h / 2);
        ctx.scale(sc, sc);
        roundRect(ctx, -g.w / 2, -g.h / 2, g.w, g.h, 5);
        ctx.fillStyle = g.kind === KIND.EXPRESS ? PURPLE : YELLOW;
        ctx.fill();
        ctx.fillStyle = '#111';
        ctx.font = `700 ${this.font}px ${this.fontSign}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(g.text, 0, 2.5);
      } else {
        // A missed word tips over the edge and drops onto the tracks.
        const drop = this.reducedMotion ? 0 : p * p * 120;
        ctx.globalAlpha = 1 - p;
        ctx.translate(g.x + g.w / 2, g.y + g.h / 2 + drop);
        if (!this.reducedMotion) ctx.rotate(p * 0.35 * (g.x > this.W / 2 ? 1 : -1));
        roundRect(ctx, -g.w / 2, -g.h / 2, g.w, g.h, 5);
        ctx.fillStyle = '#5a1410';
        ctx.fill();
        ctx.strokeStyle = RED;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#ffd7d3';
        ctx.font = `700 ${this.font}px ${this.fontSign}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(g.text, 0, 2.5);
      }
      ctx.restore();
    }
  }

  drawParticles(s, dt) {
    const { ctx } = this;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.t += dt;
      if (p.t >= p.ms) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += 520 * s;
      p.x += p.vx * s;
      p.y += p.vy * s;
      ctx.globalAlpha = 1 - p.t / p.ms;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  drawPopups(dt) {
    const { ctx } = this;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(10,10,10,0.85)';
    ctx.lineWidth = 4;
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.t += dt;
      const k = p.t / p.ms;
      if (k >= 1) {
        this.popups.splice(i, 1);
        continue;
      }
      const size = this.small ? Math.round(p.size * 0.86) : p.size;
      ctx.font = `800 ${size}px ${this.fontSign}`;
      ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      const y = p.y - 8 - ease(k) * 34;
      const x = clamp(p.x, ctx.measureText(p.text).width / 2 + 6, this.W - ctx.measureText(p.text).width / 2 - 6);
      ctx.strokeText(p.text, x, y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, x, y);
    }
    ctx.globalAlpha = 1;
  }

  // What you have typed so far, on a small LED readout below the platform edge.
  drawBuffer(view) {
    const { ctx, W } = this;
    const text = view.buffer || '';
    const h = this.trackH - 12;
    const y = this.missY + this.stripH + 6;
    ctx.font = `700 ${this.small ? 16 : 18}px ${this.fontLed}`;
    const tw = Math.max(ctx.measureText(text || 'm').width, 40);
    const w = Math.min(W - 24, tw + 34);
    const x = (W - w) / 2;
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = this.typoFlash > 0 ? `rgba(120,18,12,${0.6 + this.typoFlash * 0.4})` : '#121212';
    ctx.fill();
    ctx.strokeStyle = this.typoFlash > 0 ? RED : 'rgba(255,176,0,0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (text) {
      ctx.fillStyle = AMBER;
      ctx.fillText(text, W / 2, y + h / 2 + 1);
    } else {
      ctx.fillStyle = 'rgba(255,176,0,0.35)';
      ctx.fillText(view.hint || '', W / 2, y + h / 2 + 1);
    }
  }

  drawBanner(dt) {
    const { ctx, W } = this;
    const b = this.banner;
    b.t += dt;
    if (b.t >= b.ms) {
      this.banner = null;
      return;
    }
    const inK = clamp(b.t / 260, 0, 1);
    const outK = clamp((b.ms - b.t) / 260, 0, 1);
    const k = this.reducedMotion ? 1 : ease(Math.min(inK, outK));
    const alpha = this.reducedMotion ? Math.min(inK, outK) : 1;

    ctx.font = `700 ${this.small ? 20 : 26}px ${this.fontSign}`;
    const titleW = ctx.measureText(b.title).width;
    const bw = Math.min(W - 24, Math.max(titleW + 96, this.small ? 240 : 340));
    const bh = this.small ? 58 : 68;
    const x = (W - bw) / 2;
    const y = -bh + k * (bh + (this.small ? 14 : 22));

    ctx.save();
    ctx.globalAlpha = alpha * 0.96;
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 18;
    roundRect(ctx, x, y, bw, bh, 6);
    ctx.fillStyle = SIGN;
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#fff';
    ctx.fillRect(x + 8, y + 6, bw - 16, 1.5);

    const bs = this.small ? 30 : 36;
    const bx = x + 14;
    const by = y + (bh - bs) / 2 + 3;
    ctx.fillStyle = PURPLE;
    ctx.beginPath();
    ctx.moveTo(bx + bs / 2, by);
    ctx.lineTo(bx + bs, by + bs / 2);
    ctx.lineTo(bx + bs / 2, by + bs);
    ctx.lineTo(bx, by + bs / 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(bs * 0.55)}px ${this.fontSign}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('7', bx + bs / 2, by + bs / 2 + 1);

    const tx = bx + bs + 12;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#a7a9ac';
    ctx.font = `700 ${this.small ? 10 : 11}px ${this.fontSign}`;
    ctx.fillText(b.kicker.toUpperCase(), tx, y + (this.small ? 25 : 28));
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${this.small ? 20 : 26}px ${this.fontSign}`;
    let title = b.title;
    const maxW = x + bw - 14 - tx;
    while (ctx.measureText(title).width > maxW && title.length > 4) title = `${title.slice(0, -2)}…`;
    ctx.fillText(title, tx, y + bh - (this.small ? 12 : 14));
    ctx.restore();
  }

  drawDelay(view) {
    const { ctx, W } = this;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
    ctx.fillStyle = `rgba(150,20,14,${0.1 + pulse * 0.05})`;
    ctx.fillRect(0, 0, W, this.missY);

    const r = this.small ? 9 : 11;
    const x = W - (this.small ? 26 : 34);
    const y = this.small ? 26 : 32;
    const label = `SIGNAL DELAY ${Math.ceil(view.slowLeft / 1000)}`;
    ctx.font = `700 ${this.small ? 12 : 14}px ${this.fontLed}`;
    const lw = ctx.measureText(label).width;
    ctx.save();
    // A signal head on a dark backplate, so it reads against the light tile.
    ctx.fillStyle = 'rgba(20,20,20,0.88)';
    roundRect(ctx, x - r - 14 - lw - 12, y - r - 6, lw + 12 + 14 + r * 2 + 12, r * 2 + 12, r + 6);
    ctx.fill();
    ctx.shadowColor = RED;
    ctx.shadowBlur = 10 + pulse * 14;
    ctx.fillStyle = RED;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.font = `700 ${this.small ? 12 : 14}px ${this.fontLed}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff6b5e';
    ctx.fillText(label, x - r - 14, y);
  }

  drawTrain(dt) {
    const { ctx, W } = this;
    const tr = this.train;
    tr.t += dt;
    const carW = this.small ? 230 : 320;
    const cars = 3;
    const len = carW * cars + 8 * (cars - 1);
    const h = Math.round(clamp(this.missY * 0.32, 70, 130));
    const y = Math.round(this.missY * 0.42 - h / 2);
    const p = tr.t / tr.ms;
    const front = -40 + p * (W + len + 80);
    const x0 = front - len;

    // Words pop as the front of the train reaches them.
    for (const r of tr.rects) {
      if (!r.done && front >= r.x + r.w / 2) {
        r.done = true;
        const ghost = this.ghosts.find((g) => g.mode === 'wait' && g.text === r.text);
        if (ghost) {
          ghost.mode = 'clear';
          ghost.ms = 260;
          ghost.t = 0;
        }
        this.burst(r.x + r.w / 2, r.y + r.h / 2, 12, GREEN);
        this.popup(r.x + r.w / 2, r.y, `+${r.points}`, AMBER);
      }
    }

    if (p >= 1) {
      this.train = null;
      for (const g of this.ghosts) if (g.mode === 'wait') g.mode = 'clear';
      return;
    }

    ctx.save();
    // Speed streaks behind the train.
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    for (let i = 0; i < 6; i++) {
      const sy = y + 10 + ((i * 37) % (h - 20));
      ctx.fillRect(x0 - 260 + i * 30, sy, 240, 2);
    }

    for (let c = 0; c < cars; c++) {
      const cx = x0 + c * (carW + 8);
      if (cx > W || cx + carW < 0) continue;
      const body = ctx.createLinearGradient(0, y, 0, y + h);
      body.addColorStop(0, '#e9ecee');
      body.addColorStop(0.45, '#b8bec3');
      body.addColorStop(1, '#80878d');
      roundRect(ctx, cx, y, carW, h, c === cars - 1 ? 18 : 6);
      ctx.fillStyle = body;
      ctx.fill();
      // Fluting on the stainless sides.
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      for (let fy = y + h * 0.66; fy < y + h - 6; fy += 5) ctx.fillRect(cx + 4, fy, carW - 8, 1);
      // Windows and doors.
      const wy = y + h * 0.18;
      const wh = h * 0.36;
      const doorW = carW * 0.11;
      for (let d = 0; d < 2; d++) {
        const dx = cx + carW * (0.24 + d * 0.42);
        ctx.fillStyle = '#5d6469';
        ctx.fillRect(dx, y + h * 0.1, doorW, h * 0.84);
        ctx.fillStyle = '#f3e7bf';
        ctx.fillRect(dx + 3, wy, doorW / 2 - 4, wh);
        ctx.fillRect(dx + doorW / 2 + 1, wy, doorW / 2 - 4, wh);
      }
      ctx.fillStyle = '#f3e7bf';
      for (const f of [0.04, 0.38, 0.8]) {
        const ww = carW * 0.14;
        roundRect(ctx, cx + carW * f + 6, wy, ww, wh, 4);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(30,30,30,0.35)';
      ctx.fillRect(cx, y + h * 0.58, carW, 2);
    }

    // Cab end with the route sign.
    const nose = x0 + len;
    ctx.fillStyle = '#20252a';
    roundRect(ctx, nose - 46, y + h * 0.14, 34, h * 0.36, 5);
    ctx.fill();
    const bs = Math.min(26, h * 0.26);
    const bx = nose - 29;
    const by = y + h * 0.32;
    ctx.fillStyle = PURPLE;
    ctx.beginPath();
    ctx.moveTo(bx, by - bs / 2);
    ctx.lineTo(bx + bs / 2, by);
    ctx.lineTo(bx, by + bs / 2);
    ctx.lineTo(bx - bs / 2, by);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(bs * 0.55)}px ${this.fontSign}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('7', bx, by + 1);
    ctx.fillStyle = '#fff8d0';
    ctx.shadowColor = '#fff3b0';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(nose - 12, y + h * 0.78, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
