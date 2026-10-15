// Particles, flashes, floating numbers and screen shake. Purely visual; nothing here feeds back
// into the game state.

import { WIND_ACCEL, GRAVITY } from './physics.js';

const MAX_PARTICLES = 700;
const rand = (a, b) => a + Math.random() * (b - a);

export class Fx {
  constructor({ reduced = false } = {}) {
    this.reduced = reduced;
    this.parts = [];
    this.flashes = [];
    this.rings = [];
    this.glows = [];
    this.texts = [];
    this.wrecks = [];
    this.shakeMag = 0;
    this.shakeOn = !reduced;
    this.screenFlash = 0;
    this.wind = 0;
    this.trailClock = 0;
  }

  clear() {
    this.parts.length = 0;
    this.flashes.length = 0;
    this.rings.length = 0;
    this.glows.length = 0;
    this.texts.length = 0;
    this.wrecks.length = 0;
    this.shakeMag = 0;
    this.screenFlash = 0;
  }

  n(count) {
    return Math.max(1, Math.round(count * (this.reduced ? 0.4 : 1)));
  }

  add(p) {
    if (this.parts.length >= MAX_PARTICLES) this.parts.shift();
    this.parts.push(p);
  }

  shake(mag) {
    if (this.shakeOn) this.shakeMag = Math.min(16, Math.max(this.shakeMag, mag));
  }

  smoke(x, y, { r = 8, grow = 26, life = 1.6, alpha = 0.32, vx = 0, vy = -14, tone = 0 } = {}) {
    this.add({ k: 'smoke', x, y, vx, vy, r, grow, life, max: life, alpha, tone, g: 0, drag: 0.8 });
  }

  muzzle(x, y, angle, heavy) {
    const a = (angle * Math.PI) / 180;
    this.flashes.push({ x, y, r: heavy ? 20 : 14, life: 0.09, max: 0.09 });
    for (let i = 0; i < this.n(6); i++) {
      const s = rand(30, 90);
      this.smoke(x, y, { r: rand(4, 7), grow: rand(10, 18), life: rand(0.6, 1.1), alpha: 0.28, vx: Math.cos(a) * s + rand(-15, 15), vy: -Math.sin(a) * s + rand(-15, 5) });
    }
    this.shake(heavy ? 3.5 : 2);
  }

  trail(p, dt) {
    // Shell smoke, emitted on a clock so the trail looks the same at 60 and 120 Hz.
    p.trailT = (p.trailT || 0) + dt;
    while (p.trailT > 0.014) {
      p.trailT -= 0.014;
      this.add({ k: 'smoke', x: p.x + rand(-1, 1), y: p.y + rand(-1, 1), vx: rand(-4, 4), vy: rand(-6, 2), r: p.child ? 1.6 : 2.2, grow: p.child ? 5 : 8, life: p.child ? 0.5 : 0.85, max: p.child ? 0.5 : 0.85, alpha: 0.26, tone: 1, g: 0, drag: 1.2 });
    }
  }

  explode(x, y, radius, { dirt = false, colors } = {}) {
    if (dirt) {
      for (let i = 0; i < this.n(18); i++) {
        const a = rand(Math.PI * 1.05, Math.PI * 1.95);
        const s = rand(40, 170);
        this.add({ k: 'chunk', x: x + rand(-radius, radius) * 0.5, y: y + rand(-radius, radius) * 0.4, vx: Math.cos(a) * s, vy: Math.sin(a) * s, size: rand(2, 4.5), life: rand(0.6, 1.1), max: 1.1, color: colors?.dirt || '#4a3f55', g: GRAVITY, drag: 0.2 });
      }
      for (let i = 0; i < this.n(8); i++) this.smoke(x + rand(-radius, radius) * 0.7, y + rand(-10, 10), { r: rand(10, 18), grow: rand(18, 30), life: rand(1.0, 1.8), alpha: 0.24, tone: 2, vy: rand(-18, -6) });
      this.shake(3);
      return;
    }
    const big = radius / 30;
    this.flashes.push({ x, y, r: radius * 1.7, life: 0.2, max: 0.2 });
    this.rings.push({ x, y, r0: radius * 0.8, r1: radius * 2.4, life: 0.5, max: 0.5 });
    this.glows.push({ x, y, r: radius * 1.15, life: 2.2, max: 2.2 });
    for (let i = 0; i < this.n(22 * big); i++) {
      const a = rand(Math.PI * 1.0, Math.PI * 2.0);
      const s = rand(140, 460) * Math.sqrt(big);
      this.add({ k: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.35, 0.85), max: 0.85, g: GRAVITY * 0.9, drag: 1.1, hot: rand(0, 1) });
    }
    for (let i = 0; i < this.n(16 * big); i++) {
      const a = rand(Math.PI * 1.1, Math.PI * 1.9);
      const s = rand(80, 300);
      this.add({ k: 'chunk', x: x + rand(-6, 6), y: y + rand(-6, 6), vx: Math.cos(a) * s, vy: Math.sin(a) * s, size: rand(1.6, 4), life: rand(0.8, 1.5), max: 1.5, color: colors?.dirt || '#4a3f55', g: GRAVITY, drag: 0.3 });
    }
    for (let i = 0; i < this.n(9 * big); i++) {
      this.smoke(x + rand(-radius, radius) * 0.5, y + rand(-radius, radius) * 0.3, { r: rand(8, 16) * big, grow: rand(28, 46) * big, life: rand(1.4, 2.6), alpha: rand(0.22, 0.36), vx: rand(-12, 12), vy: rand(-30, -10) });
    }
    if (!this.reduced) this.screenFlash = Math.max(this.screenFlash, Math.min(0.22, 0.08 * big));
    this.shake(4 + radius / 6);
  }

  split(x, y) {
    this.flashes.push({ x, y, r: 16, life: 0.12, max: 0.12 });
    for (let i = 0; i < this.n(10); i++) {
      const a = rand(0, Math.PI * 2);
      const s = rand(60, 160);
      this.add({ k: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.2, 0.5), max: 0.5, g: GRAVITY * 0.5, drag: 2, hot: 1 });
    }
  }

  dust(x, y, amount = 1) {
    for (let i = 0; i < this.n(7 * amount); i++) {
      this.smoke(x + rand(-22, 22), y - rand(0, 4), { r: rand(4, 8), grow: rand(10, 20), life: rand(0.7, 1.2), alpha: 0.22, tone: 2, vx: rand(-30, 30), vy: rand(-20, -5) });
    }
  }

  burst(x, y) {
    // A tank going up: one big blast plus a fire that keeps smoking.
    this.explode(x, y, 46);
    this.wrecks.push({ x, y, t: 0 });
  }

  number(x, y, text, color) {
    this.texts.push({ x, y, text, color, life: 1.3, max: 1.3 });
  }

  update(dt, wind) {
    this.wind = wind;
    const windAcc = wind * WIND_ACCEL;
    const parts = this.parts;
    let j = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      if (p.k === 'smoke') {
        p.vx += windAcc * 0.9 * dt;
        p.vx *= 1 - p.drag * dt * 0.5;
        p.vy *= 1 - p.drag * dt * 0.5;
      } else {
        p.vy += p.g * dt;
        p.vx *= 1 - p.drag * dt;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      parts[j++] = p;
    }
    parts.length = j;

    const age = (arr) => {
      let k = 0;
      for (const f of arr) {
        f.life -= dt;
        if (f.life > 0) arr[k++] = f;
      }
      arr.length = k;
    };
    age(this.flashes);
    age(this.rings);
    age(this.glows);
    for (const t of this.texts) t.y -= 26 * dt;
    age(this.texts);

    for (const w of this.wrecks) {
      w.t += dt;
      w.clock = (w.clock || 0) + dt;
      if (w.clock > (this.reduced ? 0.5 : 0.22)) {
        w.clock = 0;
        this.smoke(w.x + rand(-8, 8), w.y - 14, { r: rand(4, 7), grow: rand(20, 34), life: rand(1.6, 2.6), alpha: 0.3, vy: rand(-36, -22), tone: 0 });
      }
    }

    this.shakeMag *= Math.exp(-9 * dt);
    if (this.shakeMag < 0.05) this.shakeMag = 0;
    this.screenFlash *= Math.exp(-10 * dt);
  }

  shakeOffset() {
    if (!this.shakeMag) return { x: 0, y: 0 };
    return { x: rand(-1, 1) * this.shakeMag, y: rand(-1, 1) * this.shakeMag * 0.7 };
  }
}
