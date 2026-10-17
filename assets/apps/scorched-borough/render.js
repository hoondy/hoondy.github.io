// Canvas renderer. The world is drawn in world units with one transform, so the whole scene
// scales with the canvas; the skyline layers are painted once per size into offscreen canvases
// and slid sideways a little for parallax.

import { W, H, UNIT_M, BARREL, PIVOT_Y, mulberry32, isBuried, clamp } from './physics.js';

const M = 40; // parallax margin on each side of a background layer, world units
const TUNNEL = { y0: H - 64, y1: H - 22 }; // a subway line runs under the battlefield
const STATION = { x0: W * 0.41, x1: W * 0.59 };
const CAR = 92;
const CAR_GAP = 4;
const PARALLAX = { far: 0.18, mid: 0.42, near: 0.75 };
const LAYER_TOP = H * 0.12; // nothing on the skyline layers is drawn above this

export const PALETTE = {
  sky: ['#050816', '#0d1235', '#1d1a46', '#3b2852'],
  far: '#1a1f47',
  mid: '#121637',
  near: '#0a0d23',
  dirt: ['#3d3549', '#28222f', '#120f17'],
  crust: '#6CBE45',
  you: { main: '#6CBE45', dark: '#3E7F24', light: '#A6E388' },
  cpu: { main: '#FF6319', dark: '#B63F06', light: '#FFA06E' },
  wreck: { main: '#3a3a42', dark: '#202026', light: '#55555f' },
};

const TAU = Math.PI * 2;

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export class Renderer {
  constructor(el, { reduced = false } = {}) {
    this.canvas = el;
    this.ctx = el.getContext('2d', { alpha: false });
    this.reduced = reduced;
    this.k = el.width / W;
    this.cssK = this.k;
    this.dpr = 1;
    this.citySeed = 7;
    this.terrainCanvas = canvas(el.width, el.height);
    this.terrainDirty = true;
    this.scorches = [];
    this.cloudX = 0;
    this.steam = [];
    this.steamClock = 0;
    this.stack = { x: W * 0.5, y: H * 0.52 };
    this.time = 0;
    this.train = null;
    this.nextTrain = 4 + Math.random() * 6;
    this.body = null;
    this.build();
  }

  resize(cssW, cssH, dpr) {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    this.cssK = cssW / W;
    this.dpr = dpr;
    if (w === this.canvas.width && h === this.canvas.height && this.sky) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.k = w / W;
    this.terrainCanvas = canvas(w, h);
    this.terrainDirty = true;
    this.pattern = null;
    // Repainting the skyline is the slow part, so while a window is being dragged the old
    // layers are stretched and the real repaint waits until the size settles.
    clearTimeout(this.buildTimer);
    if (!this.sky) this.build();
    else this.buildTimer = setTimeout(() => this.build(), 140);
  }

  setCity(seed, ground) {
    if (seed === this.citySeed) return;
    this.citySeed = seed;
    this.cityGround = ground ? Float32Array.from(ground) : null;
    this.build();
  }

  resetRound() {
    this.scorches = [];
    this.terrainDirty = true;
  }

  addScorch(x, y, r) {
    this.scorches.push({ x, y, r });
    if (this.scorches.length > 48) this.scorches.shift();
    this.terrainDirty = true;
  }

  // World units that come out as `px` CSS pixels on screen.
  css(px) {
    return px / this.cssK;
  }

  build() {
    clearTimeout(this.buildTimer);
    const k = this.k;
    const lw = (W + 2 * M) * k;
    const lh = (H - LAYER_TOP) * k;
    this.backK = k;
    this.sky = canvas(W * k, H * k);
    this.layers = { far: canvas(lw, lh), mid: canvas(lw, lh), near: canvas(lw, lh) };
    this.clouds = canvas(W * 2 * k, H * 0.4 * k);
    paintSky(this.sky.getContext('2d'), k, mulberry32(this.citySeed));
    paintClouds(this.clouds.getContext('2d'), k, mulberry32(this.citySeed + 1));
    const rng = mulberry32(this.citySeed + 2);
    paintFar(this.layerCtx('far'), rng);
    paintMid(this.layerCtx('mid'), rng);
    this.stack = paintNear(this.layerCtx('near'), rng, this.cityGround);
  }

  layerCtx(name) {
    const g = this.layers[name].getContext('2d');
    g.setTransform(this.k, 0, 0, this.k, M * this.k, -LAYER_TOP * this.k);
    return g;
  }

  dirtPattern(g) {
    if (this.pattern) return this.pattern;
    const s = Math.max(64, Math.round(180 * Math.min(2, this.k * 1.6)));
    const tile = canvas(s, s);
    const t = tile.getContext('2d');
    const rng = mulberry32(99);
    for (let i = 0; i < s * 0.9; i++) {
      t.fillStyle = rng() < 0.55 ? `rgba(255,255,255,${0.025 + rng() * 0.05})` : `rgba(0,0,0,${0.1 + rng() * 0.18})`;
      const r = 0.6 + rng() * 1.6 * Math.max(1, this.k);
      t.beginPath();
      t.arc(rng() * s, rng() * s, r, 0, TAU);
      t.fill();
    }
    for (let i = 0; i < 6; i++) {
      t.fillStyle = `rgba(255,255,255,${0.012 + rng() * 0.02})`;
      t.fillRect(0, rng() * s, s, 1 + rng() * 2);
    }
    this.pattern = g.createPattern(tile, 'repeat');
    return this.pattern;
  }

  paintTerrain(terr) {
    const g = this.terrainCanvas.getContext('2d');
    const k = this.k;
    const { h, len, top } = terr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.terrainCanvas.width, this.terrainCanvas.height);
    g.setTransform(k, 0, 0, k, 0, 0);

    const surface = new Path2D();
    surface.moveTo(0, h[0] + len[0]);
    for (let x = 1; x <= W; x++) surface.lineTo(x, h[x] + len[x]);
    const body = new Path2D();
    body.moveTo(0, H + 30);
    for (let x = 0; x <= W; x++) body.lineTo(x, h[x] + len[x]);
    body.lineTo(W, H + 30);
    body.closePath();

    // Loose dirt still on its way down, one closed shape per run of columns.
    const chunks = new Path2D();
    const chunkTops = new Path2D();
    if (terr.active) {
      let x = 0;
      while (x <= W) {
        if (len[x] <= 0) {
          x++;
          continue;
        }
        const a = x;
        while (x <= W && len[x] > 0) x++;
        const b = x - 1;
        chunks.moveTo(a, top[a]);
        chunkTops.moveTo(a, top[a]);
        for (let i = a + 1; i <= b; i++) {
          chunks.lineTo(i, top[i]);
          chunkTops.lineTo(i, top[i]);
        }
        for (let i = b; i >= a; i--) chunks.lineTo(i + 0.5, top[i] + len[i]);
        chunks.closePath();
      }
      body.addPath(chunks);
    }

    this.body = body;
    const grad = g.createLinearGradient(0, H * 0.3, 0, H);
    grad.addColorStop(0, PALETTE.dirt[0]);
    grad.addColorStop(0.45, PALETTE.dirt[1]);
    grad.addColorStop(1, PALETTE.dirt[2]);
    g.fillStyle = grad;
    g.fill(body);

    g.globalCompositeOperation = 'source-atop';
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = this.dirtPattern(g);
    g.fillRect(0, 0, this.terrainCanvas.width, this.terrainCanvas.height);
    g.restore();
    paintTunnel(g);

    // A darker band just under the surface gives the ground some depth.
    g.save();
    g.translate(0, 7);
    g.strokeStyle = 'rgba(8,6,12,0.42)';
    g.lineWidth = 12;
    g.stroke(surface);
    g.restore();

    for (const s of this.scorches) {
      const r = s.r * 1.35;
      const rg = g.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
      rg.addColorStop(0, 'rgba(6,4,8,0.72)');
      rg.addColorStop(0.55, 'rgba(10,6,10,0.4)');
      rg.addColorStop(1, 'rgba(10,6,10,0)');
      g.fillStyle = rg;
      g.fillRect(s.x - r, s.y - r, r * 2, r * 2);
    }
    g.globalCompositeOperation = 'source-over';

    const line = Math.max(2.2, this.css(1.8));
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(108,190,69,0.16)';
    g.lineWidth = line * 3.4;
    g.stroke(surface);
    g.strokeStyle = PALETTE.crust;
    g.lineWidth = line;
    g.stroke(surface);
    if (terr.active) g.stroke(chunkTops);
    this.terrainDirty = false;
  }

  update(dt, wind) {
    this.time += dt;
    if (!this.reduced) {
      if (!this.train && this.time > this.nextTrain) {
        const dir = Math.random() < 0.5 ? 1 : -1;
        const cars = 4;
        const len = cars * (CAR + CAR_GAP);
        this.train = { dir, cars, x: dir > 0 ? -20 : W + 20, len, speed: 250 + Math.random() * 60 };
      }
      if (this.train) {
        const tr = this.train;
        tr.x += tr.dir * tr.speed * dt;
        if ((tr.dir > 0 && tr.x - tr.len > W + 20) || (tr.dir < 0 && tr.x + tr.len < -20)) {
          this.train = null;
          this.nextTrain = this.time + 12 + Math.random() * 16;
        }
      }
    }
    this.cloudX += wind * 2.4 * dt + 1.2 * dt;
    // Steam from the stack on the near skyline: a wind sock everybody in New York can read.
    this.steamClock += dt;
    const every = this.reduced ? 0.22 : 0.07;
    while (this.steamClock > every) {
      this.steamClock -= every;
      this.steam.push({ x: this.stack.x + (Math.random() - 0.5) * 3, y: this.stack.y, vx: (Math.random() - 0.5) * 6, vy: -16 - Math.random() * 8, r: 3, life: 3.2, max: 3.2 });
    }
    let j = 0;
    for (const s of this.steam) {
      s.life -= dt;
      if (s.life <= 0) continue;
      s.vx += (wind * 9 - s.vx) * 0.9 * dt;
      s.vy *= 1 - 0.35 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.r += 6 * dt;
      this.steam[j++] = s;
    }
    this.steam.length = j;
  }

  draw(scene, fx) {
    const ctx = this.ctx;
    const k = this.k;
    if (this.terrainDirty || scene.terr.active) this.paintTerrain(scene.terr);

    const shake = fx ? fx.shakeOffset() : { x: 0, y: 0 };
    const sx = this.css(shake.x) * k;
    const sy = this.css(shake.y) * k;
    const cam = clamp(scene.cam || 0, -30, 30);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const f = k / this.backK; // 1 except right after a resize
    ctx.drawImage(this.sky, 0, 0, this.sky.width * f, this.sky.height * f);

    // clouds drift with the wind
    const cw = this.clouds.width * f;
    const ox = ((((this.cloudX * k) % cw) + cw) % cw) - cw;
    for (const x of [ox, ox + cw]) ctx.drawImage(this.clouds, x, H * 0.04 * k, cw, this.clouds.height * f);

    for (const name of ['far', 'mid', 'near']) {
      const layer = this.layers[name];
      const off = -(M + cam * PARALLAX[name]) * k;
      ctx.drawImage(layer, Math.round(off + sx * PARALLAX[name]), Math.round(LAYER_TOP * k + sy * PARALLAX[name]), layer.width * f, layer.height * f);
      if (name === 'near') this.drawSteam(ctx, -(cam * PARALLAX.near) + this.css(shake.x) * PARALLAX.near);
    }

    ctx.setTransform(k, 0, 0, k, sx, sy);

    // A tank with dirt banked partway up its hull goes behind the ground, so it looks sunk in,
    // and gets its hull outlined on top. Only one buried past its turret gets the BURIED tag.
    const sunk = scene.tanks.map((t) => t.alive && scene.terr.h[clamp(Math.round(t.x), 0, W)] < t.y - 9);
    const buried = scene.tanks.map((t) => t.alive && isBuried(scene.terr.h, t));
    scene.tanks.forEach((t, i) => sunk[i] && this.drawTank(ctx, t, i, scene));

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, sx, sy);
    ctx.drawImage(this.terrainCanvas, 0, 0);
    ctx.restore();
    if (this.train && this.body) this.drawTrain(ctx);

    this.drawGlows(ctx, fx);
    this.drawWalls(ctx);
    scene.tanks.forEach((t, i) => (sunk[i] ? this.drawBuriedOutline(ctx, t, i) : this.drawTank(ctx, t, i, scene)));

    if (scene.marker) this.drawMarker(ctx, scene.marker);
    if (scene.drag) this.drawDrag(ctx, scene.drag);
    if (scene.aim) this.drawAim(ctx, scene.aim, scene);
    if (scene.readout) this.drawReadout(ctx, scene.readout, scene);
    if (scene.active >= 0) this.drawCaret(ctx, scene.tanks[scene.active], scene.active, scene, buried[scene.active] && scene.tags);
    // A buried tank's next shot goes off on top of it, so it is labelled on every turn, not just its own.
    if (scene.tags) scene.tanks.forEach((t, i) => buried[i] && i !== scene.active && this.drawBuriedTag(ctx, t, scene));

    if (fx) this.drawFx(ctx, fx);
    for (const p of scene.projectiles) this.drawShell(ctx, p);
    for (const p of scene.projectiles) if (p.y < -4) this.drawOffscreen(ctx, p);

    if (fx && fx.screenFlash > 0.01) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(255,236,200,${fx.screenFlash})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  drawTrain(ctx) {
    const tr = this.train;
    const top = TUNNEL.y1 - 30;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, TUNNEL.y0, W, TUNNEL.y1 - TUNNEL.y0);
    ctx.clip();
    ctx.clip(this.body);
    for (let i = 0; i < tr.cars; i++) {
      // x is the nose of the train; cars trail behind it
      const x = tr.dir > 0 ? tr.x - (i + 1) * (CAR + CAR_GAP) : tr.x + i * (CAR + CAR_GAP) + CAR_GAP;
      const g = ctx.createLinearGradient(0, top, 0, top + 25);
      g.addColorStop(0, '#c9ced8');
      g.addColorStop(0.5, '#9aa1ae');
      g.addColorStop(1, '#6b7280');
      ctx.fillStyle = g;
      roundRect(ctx, x, top, CAR, 25, 4);
      ctx.fill();
      ctx.fillStyle = '#1a1c22';
      ctx.fillRect(x + 4, top + 5, CAR - 8, 9);
      ctx.fillStyle = 'rgba(255,236,190,0.85)';
      for (let w = x + 8; w < x + CAR - 10; w += 11) ctx.fillRect(w, top + 6.5, 7, 6);
      ctx.fillStyle = '#4d535f';
      ctx.fillRect(x + CAR / 2 - 5, top + 4, 10, 18);
      if (i === 0) {
        const nose = tr.dir > 0 ? x + CAR : x;
        ctx.fillStyle = PALETTE.crust;
        ctx.beginPath();
        ctx.arc(nose - tr.dir * 12, top + 19, 4.2, 0, TAU);
        ctx.fill();
        const hl = ctx.createRadialGradient(nose, top + 18, 0, nose, top + 18, 40);
        hl.addColorStop(0, 'rgba(255,250,220,0.55)');
        hl.addColorStop(1, 'rgba(255,250,220,0)');
        ctx.fillStyle = hl;
        ctx.fillRect(nose - 40, top - 20, 80, 60);
      }
    }
    ctx.restore();
  }

  drawSteam(ctx, offWorld) {
    if (!this.steam.length) return;
    const k = this.k;
    ctx.setTransform(k, 0, 0, k, offWorld * k, 0);
    for (const s of this.steam) {
      const a = (s.life / s.max) * 0.16;
      ctx.fillStyle = `rgba(226,230,242,${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, TAU);
      ctx.fill();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  drawWalls(ctx) {
    const w = Math.max(3, this.css(3));
    for (const x of [0, W - w]) {
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      const edge = 'rgba(190,200,220,0.28)';
      g.addColorStop(0, x ? 'rgba(190,200,220,0)' : edge);
      g.addColorStop(1, x ? edge : 'rgba(190,200,220,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, w, H);
    }
  }

  drawTank(ctx, t, i, scene) {
    const pal = !t.alive ? PALETTE.wreck : i === 0 ? PALETTE.you : PALETTE.cpu;
    const flash = scene.flash ? scene.flash[i] : 0;
    const angle = t.alive ? (t.shown ?? t.angle) : i === 0 ? -12 : 192;
    const a = (angle * Math.PI) / 180;
    ctx.save();
    ctx.translate(t.x, t.y);

    // barrel: dark outline then a light core so it reads against the night sky
    const bx = Math.cos(a) * BARREL;
    const by = -PIVOT_Y - Math.sin(a) * BARREL;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#07080c';
    ctx.lineWidth = 6.4;
    ctx.beginPath();
    ctx.moveTo(0, -PIVOT_Y);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.strokeStyle = t.alive ? '#DCE1EA' : '#4a4a52';
    ctx.lineWidth = 3.6;
    ctx.stroke();

    // turret dome
    ctx.fillStyle = '#07080c';
    ctx.beginPath();
    ctx.arc(0, -13.5, 10, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = pal.main;
    ctx.beginPath();
    ctx.arc(0, -13.5, 8.6, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = pal.light;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(-2.4, -17, 3, Math.PI, 0);
    ctx.fill();
    ctx.globalAlpha = 1;

    // hull
    ctx.fillStyle = '#07080c';
    ctx.beginPath();
    ctx.moveTo(-23, -5);
    ctx.lineTo(-17.5, -15);
    ctx.lineTo(17.5, -15);
    ctx.lineTo(23, -5);
    ctx.closePath();
    ctx.fill();
    const hg = ctx.createLinearGradient(0, -14, 0, -5);
    hg.addColorStop(0, pal.light);
    hg.addColorStop(0.35, pal.main);
    hg.addColorStop(1, pal.dark);
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.moveTo(-21.5, -6);
    ctx.lineTo(-16.6, -13.8);
    ctx.lineTo(16.6, -13.8);
    ctx.lineTo(21.5, -6);
    ctx.closePath();
    ctx.fill();

    // tracks and road wheels
    ctx.fillStyle = '#101117';
    roundRect(ctx, -23.5, -7.5, 47, 8, 4);
    ctx.fill();
    ctx.fillStyle = t.alive ? '#454955' : '#2c2c33';
    for (let w = -16; w <= 16; w += 8) {
      ctx.beginPath();
      ctx.arc(w, -3.5, 2.3, 0, TAU);
      ctx.fill();
    }

    if (flash > 0) {
      ctx.globalAlpha = Math.min(1, flash * 5) * 0.85;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(-23, -4);
      ctx.lineTo(-17.5, -15);
      ctx.lineTo(17.5, -15);
      ctx.lineTo(23, -4);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, -13.5, 9, Math.PI, 0);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  drawBuriedOutline(ctx, t, i) {
    const pal = i === 0 ? PALETTE.you : PALETTE.cpu;
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.setLineDash([this.css(3), this.css(3)]);
    ctx.lineWidth = Math.max(1.2, this.css(1.2));
    ctx.strokeStyle = pal.main;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(-23, -1);
    ctx.lineTo(-23, -6);
    ctx.lineTo(-17.5, -15);
    ctx.lineTo(17.5, -15);
    ctx.lineTo(23, -6);
    ctx.lineTo(23, -1);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  // Just above a tank, or above the dirt piled on it, and above a shot marker sitting on it.
  headroom(t, scene) {
    let top = t.y - 34;
    if (t.alive && isBuried(scene.terr.h, t)) top = Math.min(top, scene.terr.h[clamp(Math.round(t.x), 0, W)] - 10);
    const m = scene.marker;
    if (m && Math.abs(m.x - t.x) < 40 && m.y > top - this.css(40)) top = Math.min(top, m.y - this.css(26));
    return top;
  }

  drawCaret(ctx, t, i, scene, buried) {
    if (!t || !t.alive) return;
    const pal = i === 0 ? PALETTE.you : PALETTE.cpu;
    const bob = this.reduced ? 0 : Math.sin(this.time * 4) * this.css(2);
    const y = this.headroom(t, scene) - this.css(10) + bob;
    const s = this.css(5);
    ctx.fillStyle = pal.main;
    ctx.beginPath();
    ctx.moveTo(t.x - s, y - s);
    ctx.lineTo(t.x + s, y - s);
    ctx.lineTo(t.x, y);
    ctx.closePath();
    ctx.fill();
    const label = `${i === 0 ? 'YOU' : 'CPU'}${buried ? ' · BURIED!' : ''}`;
    ctx.font = `700 ${this.css(10.5)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const half = ctx.measureText(label).width / 2 + 4;
    const x = clamp(t.x, half, W - half);
    if (buried) {
      ctx.lineWidth = this.css(3);
      ctx.strokeStyle = 'rgba(8,8,12,0.85)';
      ctx.strokeText(label, x, y - s - this.css(3));
    }
    ctx.fillStyle = buried ? BURIED_INK : 'rgba(255,255,255,0.92)';
    ctx.fillText(label, x, y - s - this.css(3));
  }

  drawBuriedTag(ctx, t, scene) {
    this.pill(ctx, 'BURIED', t.x, this.headroom(t, scene) - this.css(2), BURIED_INK);
  }

  drawAim(ctx, aim, scene) {
    const t = scene.tanks[aim.tank];
    if (!t || !t.alive) return;
    const a = (aim.angle * Math.PI) / 180;
    const x0 = t.x + Math.cos(a) * (BARREL + 4);
    const y0 = t.y - PIVOT_Y - Math.sin(a) * (BARREL + 4);
    const L = 22 + aim.power * 1.2;
    const x1 = x0 + Math.cos(a) * L;
    const y1 = y0 - Math.sin(a) * L;
    const lw = Math.max(1.6, this.css(2));
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    const col = aim.tank === 0 ? '146,214,110' : '255,120,60';
    const alpha = aim.strong ? 0.95 : 0.6;
    g.addColorStop(0, `rgba(${col},${alpha})`);
    g.addColorStop(0.6, `rgba(${col},${alpha * 0.75})`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.strokeStyle = g;
    ctx.lineWidth = lw;
    ctx.setLineDash([this.css(5), this.css(4)]);
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // The line from your barrel out to your finger: the shot goes that way, harder the longer it is.
  drawDrag(ctx, d) {
    const lw = Math.max(1.2, this.css(1.4));
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(d.ax, d.ay);
    ctx.lineTo(d.px, d.py);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(d.px, d.py, this.css(4.5), 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.arc(d.ax, d.ay, this.css(7), 0, TAU);
    ctx.stroke();
  }

  drawMarker(ctx, m) {
    const r = this.css(6);
    const lw = Math.max(1.3, this.css(1.5));
    const col = m.side === 1 ? 'rgba(255,140,80,0.85)' : 'rgba(156,226,120,0.95)';
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(m.x, m.y, r, 0, TAU);
    ctx.moveTo(m.x - r * 1.7, m.y);
    ctx.lineTo(m.x - r * 0.5, m.y);
    ctx.moveTo(m.x + r * 0.5, m.y);
    ctx.lineTo(m.x + r * 1.7, m.y);
    ctx.moveTo(m.x, m.y - r * 1.7);
    ctx.lineTo(m.x, m.y - r * 0.5);
    ctx.stroke();
    if (m.text) this.pill(ctx, m.text, m.x, m.y - r * 2.2, col);
  }

  drawReadout(ctx, r, scene) {
    const t = scene.tanks[r.tank];
    this.pill(ctx, r.text, t.x, this.headroom(t, scene) - this.css(36), 'rgba(255,170,120,0.95)');
  }

  pill(ctx, text, x, y, color) {
    const fs = this.css(11);
    ctx.font = `600 ${fs}px ${FONT}`;
    const w = ctx.measureText(text).width + this.css(12);
    const h = fs + this.css(7);
    const cx = clamp(x, w / 2 + 4, W - w / 2 - 4);
    const top = Math.max(4, y - h);
    ctx.fillStyle = 'rgba(8,9,14,0.78)';
    roundRect(ctx, cx - w / 2, top, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, top + h / 2 + this.css(0.5));
  }

  drawShell(ctx, p) {
    const r = Math.max(p.child ? 2.2 : 3, this.css(p.child ? 2 : 2.6));
    const sp = Math.hypot(p.vx, p.vy) || 1;
    const tail = Math.min(26, sp * 0.03);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,190,110,0.55)';
    ctx.lineWidth = r * 1.4;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - (p.vx / sp) * tail, p.y - (p.vy / sp) * tail);
    ctx.stroke();
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.2);
    g.addColorStop(0, 'rgba(255,220,160,0.55)');
    g.addColorStop(1, 'rgba(255,140,60,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 3.2, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#FFF6E6';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, TAU);
    ctx.fill();
  }

  drawOffscreen(ctx, p) {
    const x = clamp(p.x, this.css(14), W - this.css(14));
    const y = this.css(6);
    const s = this.css(6);
    ctx.fillStyle = 'rgba(255,214,150,0.95)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - s, y + s * 1.2);
    ctx.lineTo(x + s, y + s * 1.2);
    ctx.closePath();
    ctx.fill();
    ctx.font = `600 ${this.css(10)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,214,150,0.9)';
    ctx.fillText(`${Math.round(-p.y * UNIT_M)} m`, x, y + s * 1.6);
  }

  drawGlows(ctx, fx) {
    if (!fx || !fx.glows.length) return;
    ctx.globalCompositeOperation = 'lighter';
    for (const gl of fx.glows) {
      const t = gl.life / gl.max;
      const g = ctx.createRadialGradient(gl.x, gl.y, 0, gl.x, gl.y, gl.r);
      g.addColorStop(0, `rgba(255,120,40,${0.38 * t})`);
      g.addColorStop(1, 'rgba(255,80,20,0)');
      ctx.fillStyle = g;
      ctx.fillRect(gl.x - gl.r, gl.y - gl.r, gl.r * 2, gl.r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  drawFx(ctx, fx) {
    // smoke and dirt first, then the bright stuff on top
    for (const p of fx.parts) {
      const t = p.life / p.max;
      if (p.k === 'smoke') {
        const r = p.r + p.grow * (1 - t);
        const a = p.alpha * t;
        ctx.fillStyle = p.tone === 1 ? `rgba(205,205,215,${a})` : p.tone === 2 ? `rgba(120,104,124,${a})` : `rgba(70,66,82,${a})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, TAU);
        ctx.fill();
      } else if (p.k === 'chunk') {
        ctx.globalAlpha = Math.min(1, t * 2);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
        ctx.globalAlpha = 1;
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const p of fx.parts) {
      if (p.k !== 'spark') continue;
      const t = p.life / p.max;
      ctx.strokeStyle = p.hot > 0.5 ? `rgba(255,230,160,${t})` : `rgba(255,140,50,${t})`;
      ctx.lineWidth = Math.max(1.2, this.css(1.3));
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.025, p.y - p.vy * 0.025);
      ctx.stroke();
    }
    for (const f of fx.flashes) {
      const t = f.life / f.max;
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r);
      g.addColorStop(0, `rgba(255,255,240,${0.95 * t})`);
      g.addColorStop(0.35, `rgba(255,200,90,${0.7 * t})`);
      g.addColorStop(1, 'rgba(255,90,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const r of fx.rings) {
      const t = 1 - r.life / r.max;
      const e = 1 - (1 - t) ** 3;
      ctx.strokeStyle = `rgba(255,236,210,${0.45 * (1 - t)})`;
      ctx.lineWidth = Math.max(1.5, this.css(2)) * (1 - t * 0.6);
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * e, 0, TAU);
      ctx.stroke();
    }
    for (const tx of fx.texts) {
      const t = tx.life / tx.max;
      ctx.globalAlpha = Math.min(1, t * 2.5);
      ctx.font = `800 ${this.css(15)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = this.css(3.5);
      ctx.strokeStyle = 'rgba(8,8,12,0.85)';
      ctx.strokeText(tx.text, tx.x, tx.y);
      ctx.fillStyle = tx.color;
      ctx.fillText(tx.text, tx.x, tx.y);
      ctx.globalAlpha = 1;
    }
  }
}

const FONT = '"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif';
const BURIED_INK = '#FFC23D';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------- the line under the park

// Drawn into the ground with source-atop, so a deep crater simply cuts it away with the dirt.
function paintTunnel(g) {
  const { y0, y1 } = TUNNEL;
  g.fillStyle = 'rgba(255,255,255,0.05)';
  g.fillRect(0, y0 - 4, W, y1 - y0 + 8);
  const tg = g.createLinearGradient(0, y0, 0, y1);
  tg.addColorStop(0, '#060509');
  tg.addColorStop(1, '#0f0d14');
  g.fillStyle = tg;
  g.fillRect(0, y0, W, y1 - y0);

  // station box: tiled wall, mosaic name tablet, platform edge
  const { x0, x1 } = STATION;
  g.fillStyle = '#d9d5ca';
  g.fillRect(x0, y0 + 2, x1 - x0, y1 - y0 - 8);
  g.fillStyle = 'rgba(60,50,40,0.13)';
  for (let x = x0; x < x1; x += 4) g.fillRect(x, y0 + 2, 0.5, y1 - y0 - 8);
  for (let y = y0 + 2; y < y1 - 6; y += 3) g.fillRect(x0, y, x1 - x0, 0.5);
  const cx = (x0 + x1) / 2;
  const tw = 104;
  const ty = y0 + 6;
  g.fillStyle = '#7a2e2a';
  g.fillRect(cx - tw / 2 - 3, ty - 2, tw + 6, 17);
  g.fillStyle = '#efe6cf';
  g.fillRect(cx - tw / 2, ty, tw, 13);
  g.fillStyle = '#1d4d3a';
  g.font = `700 9.5px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('HOONDY SQ', cx, ty + 7);
  for (const x of [x0 + 14, x1 - 14]) {
    g.fillStyle = PALETTE.crust;
    g.beginPath();
    g.arc(x, ty + 6.5, 4.5, 0, TAU);
    g.fill();
  }
  g.fillStyle = 'rgba(255,255,236,0.75)';
  for (let x = x0 + 30; x < x1 - 20; x += 46) g.fillRect(x, y0 + 2, 16, 1.4);
  g.fillStyle = '#3f3b45';
  g.fillRect(x0, y1 - 10, x1 - x0, 4);
  g.fillStyle = '#FCCC0A';
  g.fillRect(x0, y1 - 10, x1 - x0, 1);
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.fillRect(x0 - 3, y0, 3, y1 - y0);
  g.fillRect(x1, y0, 3, y1 - y0);

  // work lights along the tunnel
  for (let x = 24; x < W; x += 68) {
    if (x > x0 - 8 && x < x1 + 8) continue;
    const lg = g.createRadialGradient(x, y0 + 4, 0, x, y0 + 4, 14);
    lg.addColorStop(0, 'rgba(255,190,100,0.45)');
    lg.addColorStop(1, 'rgba(255,190,100,0)');
    g.fillStyle = lg;
    g.fillRect(x - 14, y0, 28, 18);
    g.fillStyle = '#ffcf8a';
    g.fillRect(x - 1, y0 + 2, 2, 1.6);
  }

  // track
  g.fillStyle = '#26222c';
  for (let x = 0; x < W; x += 5) g.fillRect(x, y1 - 4, 2.6, 2.4);
  g.fillStyle = '#77727f';
  g.fillRect(0, y1 - 5, W, 1.1);
}

// ---------------------------------------------------------------- background art

function paintSky(g, k, rng) {
  const w = W * k;
  const h = H * k;
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, PALETTE.sky[0]);
  grad.addColorStop(0.38, PALETTE.sky[1]);
  grad.addColorStop(0.62, PALETTE.sky[2]);
  grad.addColorStop(0.8, PALETTE.sky[3]);
  grad.addColorStop(1, '#24183a');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // the city's sodium glow along the horizon
  const glow = g.createRadialGradient(w * 0.55, h * 0.82, 0, w * 0.55, h * 0.82, w * 0.62);
  glow.addColorStop(0, 'rgba(255,130,70,0.30)');
  glow.addColorStop(0.5, 'rgba(255,110,60,0.10)');
  glow.addColorStop(1, 'rgba(255,110,60,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, w, h);

  g.setTransform(k, 0, 0, k, 0, 0);
  for (let i = 0; i < 140; i++) {
    const y = rng() ** 1.6 * H * 0.55;
    const a = (0.25 + rng() * 0.6) * (1 - y / (H * 0.62));
    g.fillStyle = `rgba(235,238,255,${a})`;
    g.beginPath();
    g.arc(rng() * W, y, Math.max(0.5 / k, 0.35 + rng() * 0.75), 0, TAU);
    g.fill();
  }

  const mx = W * 0.8;
  const my = H * 0.14;
  const halo = g.createRadialGradient(mx, my, 0, mx, my, 110);
  halo.addColorStop(0, 'rgba(255,244,220,0.22)');
  halo.addColorStop(1, 'rgba(255,244,220,0)');
  g.fillStyle = halo;
  g.fillRect(mx - 110, my - 110, 220, 220);
  g.fillStyle = '#F4EEDC';
  g.beginPath();
  g.arc(mx, my, 17, 0, TAU);
  g.fill();
  g.fillStyle = 'rgba(160,150,140,0.18)';
  for (const [dx, dy, r] of [[-5, -4, 4], [4, 3, 5], [6, -6, 2.5], [-3, 7, 2.2]]) {
    g.beginPath();
    g.arc(mx + dx, my + dy, r, 0, TAU);
    g.fill();
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
}

function paintClouds(g, k, rng) {
  g.setTransform(k, 0, 0, k, 0, 0);
  const ww = W * 2;
  const hh = H * 0.4;
  for (let i = 0; i < 16; i++) {
    const cx = rng() * ww;
    const cy = hh * (0.15 + rng() * 0.6);
    const rx = 80 + rng() * 160;
    const ry = 8 + rng() * 14;
    for (const dx of [-ww, 0, ww]) {
      g.save();
      g.translate(cx + dx, cy);
      g.scale(1, ry / rx);
      const rg = g.createRadialGradient(0, 0, 0, 0, 0, rx);
      rg.addColorStop(0, `rgba(160,150,200,${0.07 + rng() * 0.05})`);
      rg.addColorStop(1, 'rgba(160,150,200,0)');
      g.fillStyle = rg;
      g.beginPath();
      g.arc(0, 0, rx, 0, TAU);
      g.fill();
      g.restore();
    }
  }
}

function windows(g, x, top, w, base, rng, density, alpha = 1) {
  const cell = 4.2;
  const rows = Math.floor((base - top - 6) / cell);
  const cols = Math.floor((w - 3) / 3.4);
  const lit = density * (0.6 + rng() * 0.8);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (rng() > lit) continue;
      const warm = rng() < 0.82;
      const a = (0.25 + rng() * 0.55) * alpha;
      g.fillStyle = warm ? `rgba(255,${190 + Math.floor(rng() * 40)},${110 + Math.floor(rng() * 50)},${a})` : `rgba(200,220,255,${a * 0.8})`;
      g.fillRect(x + 2 + c * 3.4, top + 4 + r * cell, 1.6, 2.2);
    }
  }
}

function tower(g, x, w, height, base, rng, color, opts = {}) {
  const top = base - height;
  g.fillStyle = color;
  g.fillRect(x, top, w, height);
  let wTop = top;
  if (opts.setback && height > 90) {
    const sw = w * (0.55 + rng() * 0.2);
    const sh = 14 + rng() * 30;
    g.fillRect(x + (w - sw) / 2, top - sh, sw, sh);
    wTop = top - sh;
    if (rng() < 0.5) {
      const tw = sw * 0.5;
      g.fillRect(x + (w - tw) / 2, wTop - 10, tw, 10);
      wTop -= 10;
    }
  }
  if (opts.antenna) {
    g.fillRect(x + w / 2 - 0.6, wTop - 18 - rng() * 14, 1.2, 18 + rng() * 14);
  }
  if (opts.windows) windows(g, x, top, w, base, rng, opts.windows, opts.windowAlpha);
}

function paintFar(g, rng) {
  const base = H * 0.8;
  let x = -M;
  while (x < W + M) {
    const w = 14 + rng() * 32;
    const h = 40 + rng() ** 1.7 * 180;
    tower(g, x, w, h, base, rng, PALETTE.far, { setback: rng() < 0.35, antenna: rng() < 0.15, windows: 0.16, windowAlpha: 0.7 });
    x += w + (rng() < 0.25 ? rng() * 8 : -1);
  }
  const jitter = (rng() - 0.5) * 40;
  oneWtc(g, W * 0.24 + jitter, base);
  empire(g, W * 0.6 - jitter * 0.5, base);
  chrysler(g, W * 0.68 + jitter * 0.3, base);
}

function empire(g, cx, by) {
  g.fillStyle = PALETTE.far;
  const tiers = [[27, 0, 214], [21, 214, 236], [15, 236, 254], [10, 254, 270], [6.5, 270, 290], [3.5, 290, 312]];
  for (const [hw, a, b] of tiers) g.fillRect(cx - hw, by - b, hw * 2, b - a);
  g.fillRect(cx - 0.8, by - 352, 1.6, 42);
  // the tower lights
  const lg = g.createLinearGradient(0, by - 312, 0, by - 254);
  lg.addColorStop(0, 'rgba(255,214,160,0.34)');
  lg.addColorStop(1, 'rgba(255,214,160,0)');
  g.fillStyle = lg;
  g.fillRect(cx - 6.5, by - 310, 13, 56);
  const halo = g.createRadialGradient(cx, by - 296, 0, cx, by - 296, 30);
  halo.addColorStop(0, 'rgba(255,200,140,0.18)');
  halo.addColorStop(1, 'rgba(255,200,140,0)');
  g.fillStyle = halo;
  g.fillRect(cx - 30, by - 326, 60, 60);
  g.fillStyle = 'rgba(255,90,80,0.9)';
  g.fillRect(cx - 1, by - 354, 2, 2);
  windowsCol(g, cx - 25, by - 210, 50, by);
}

function windowsCol(g, x, top, w, base) {
  for (let yy = top + 4; yy < base - 6; yy += 4.4) {
    for (let xx = x + 2; xx < x + w - 2; xx += 3.4) {
      if (Math.sin(xx * 12.9898 + yy * 78.233) * 43758.5453 % 1 > 0.62) {
        g.fillStyle = 'rgba(255,214,150,0.5)';
        g.fillRect(xx, yy, 1.5, 2.1);
      }
    }
  }
}

function chrysler(g, cx, by) {
  g.fillStyle = PALETTE.far;
  g.fillRect(cx - 18, by - 196, 36, 196);
  g.fillRect(cx - 13, by - 210, 26, 14);
  const arcs = [[13, 210], [10.4, 222], [7.8, 232], [5.4, 241], [3.2, 249]];
  for (const [r, h] of arcs) {
    g.beginPath();
    g.arc(cx, by - h, r, Math.PI, 0);
    g.fill();
  }
  g.beginPath();
  g.moveTo(cx - 2, by - 249);
  g.lineTo(cx, by - 300);
  g.lineTo(cx + 2, by - 249);
  g.fill();
  // the lit chevrons of the crown
  g.strokeStyle = 'rgba(255,246,226,0.62)';
  g.lineWidth = 0.7;
  for (const [r, h] of arcs) {
    g.beginPath();
    g.arc(cx, by - h, r - 1.2, Math.PI * 1.05, Math.PI * 1.95);
    g.stroke();
    for (let i = 1; i < 6; i++) {
      const a = Math.PI + (i / 6) * Math.PI;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (r - 1.2), by - h + Math.sin(a) * (r - 1.2));
      g.lineTo(cx + Math.cos(a) * (r - 4), by - h + Math.sin(a) * (r - 4) + 1.5);
      g.stroke();
    }
  }
  windowsCol(g, cx - 16, by - 190, 32, by);
}

function oneWtc(g, cx, by) {
  g.fillStyle = PALETTE.far;
  g.fillRect(cx - 21, by - 52, 42, 52);
  g.beginPath();
  g.moveTo(cx - 21, by - 52);
  g.lineTo(cx - 8.5, by - 318);
  g.lineTo(cx + 8.5, by - 318);
  g.lineTo(cx + 21, by - 52);
  g.closePath();
  g.fill();
  // the faceted glass catches a little light
  g.fillStyle = 'rgba(150,170,230,0.10)';
  g.beginPath();
  g.moveTo(cx - 21, by - 52);
  g.lineTo(cx, by - 318);
  g.lineTo(cx - 8.5, by - 318);
  g.closePath();
  g.fill();
  g.fillStyle = PALETTE.far;
  g.fillRect(cx - 9, by - 325, 18, 7);
  g.fillRect(cx - 0.9, by - 392, 1.8, 68);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(cx - 1.2, by - 394, 2.4, 2.4);
  windowsCol(g, cx - 18, by - 300, 36, by - 60);
}

function paintMid(g, rng) {
  const base = H * 0.86;
  const deck = H * 0.66;
  const x0 = W * 0.02;
  const x1 = W * 0.6;
  const span = x1 - x0;

  // river
  const river = g.createLinearGradient(0, deck + 8, 0, base);
  river.addColorStop(0, '#141a3e');
  river.addColorStop(1, '#0a0e26');
  g.fillStyle = river;
  g.fillRect(-M, deck + 8, W * 0.66 + M, base - deck - 8);
  for (let i = 0; i < 70; i++) {
    const y = deck + 12 + rng() * (base - deck - 16);
    g.fillStyle = rng() < 0.7 ? `rgba(255,200,130,${0.06 + rng() * 0.14})` : `rgba(180,200,255,${0.06 + rng() * 0.1})`;
    g.fillRect(x0 + rng() * span, y, 4 + rng() * 14, 0.8);
  }

  // buildings beyond the far end of the bridge
  let x = W * 0.58;
  while (x < W + M) {
    const w = 18 + rng() * 34;
    const h = 70 + rng() * 150;
    tower(g, x, w, h, base, rng, PALETTE.mid, { setback: rng() < 0.3, antenna: rng() < 0.2, windows: 0.2, windowAlpha: 0.8 });
    if (rng() < 0.45) waterTower(g, x + w * (0.25 + rng() * 0.4), base - h, PALETTE.mid, 0.85);
    x += w + rng() * 6;
  }
  // and a low Brooklyn shoreline under the near end
  x = -M;
  while (x < x0 + 40) {
    const w = 16 + rng() * 22;
    tower(g, x, w, 40 + rng() * 40, base, rng, PALETTE.mid, { windows: 0.18 });
    x += w;
  }

  // suspension bridge with gothic towers
  const tA = x0 + span * 0.23;
  const tB = x0 + span * 0.77;
  const top = H * 0.39;
  g.fillStyle = PALETTE.mid;
  g.fillRect(x0, deck, span, 6);
  for (const tx of [tA, tB]) {
    g.fillRect(tx - 17, top, 34, base - top);
    g.fillRect(tx - 19, top - 5, 38, 7);
    g.fillRect(tx - 18, deck - 92, 36, 4);
  }
  // twin pointed arches, the Brooklyn Bridge signature
  g.save();
  g.globalCompositeOperation = 'destination-out';
  for (const tx of [tA, tB]) {
    for (const ax of [tx - 12.5, tx + 3.5]) {
      const aw = 9;
      const at = deck - 70;
      g.beginPath();
      g.moveTo(ax, deck + 6);
      g.lineTo(ax, at);
      g.quadraticCurveTo(ax, at - 9, ax + aw / 2, at - 15);
      g.quadraticCurveTo(ax + aw, at - 9, ax + aw, at);
      g.lineTo(ax + aw, deck + 6);
      g.closePath();
      g.fill();
    }
  }
  g.restore();
  g.fillStyle = 'rgba(255,214,160,0.16)';
  for (const tx of [tA, tB]) g.fillRect(tx - 17, top, 2, deck - top);

  const cable = (xa, ya, xb, yb, sag) => {
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      pts.push([xa + (xb - xa) * t, ya + (yb - ya) * t + sag * 4 * t * (1 - t)]);
    }
    return pts;
  };
  const cables = [
    cable(x0, deck - 2, tA, top + 2, 10),
    cable(tA, top + 2, tB, top + 2, deck - top - 10),
    cable(tB, top + 2, x1, deck - 2, 10),
  ];
  g.strokeStyle = 'rgba(160,170,215,0.45)';
  g.lineWidth = 0.6;
  for (const pts of cables) {
    for (let i = 0; i < pts.length; i += 2) {
      g.beginPath();
      g.moveTo(pts[i][0], pts[i][1]);
      g.lineTo(pts[i][0], deck);
      g.stroke();
    }
  }
  // the diagonal stays that fan out from each tower
  g.strokeStyle = 'rgba(160,170,215,0.28)';
  for (const tx of [tA, tB]) {
    for (let d = 14; d <= 90; d += 13) {
      for (const s of [-1, 1]) {
        g.beginPath();
        g.moveTo(tx + s * 8, top + 8);
        g.lineTo(tx + s * d, deck);
        g.stroke();
      }
    }
  }
  g.strokeStyle = 'rgba(190,198,235,0.75)';
  g.lineWidth = 1.3;
  for (const pts of cables) {
    g.beginPath();
    pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
    g.stroke();
  }
  // necklace lights
  g.fillStyle = 'rgba(255,244,214,0.9)';
  for (const pts of cables) {
    for (let i = 0; i < pts.length; i += 3) g.fillRect(pts[i][0] - 0.8, pts[i][1] - 0.8, 1.6, 1.6);
  }
  g.fillStyle = 'rgba(255,190,110,0.8)';
  for (let bx = x0 + 4; bx < x1; bx += 9) g.fillRect(bx, deck + 2, 1.4, 1.4);
}

function waterTower(g, x, roof, color, scale = 1) {
  const s = scale;
  g.fillStyle = color;
  g.strokeStyle = color;
  g.lineWidth = 1.2 * s;
  for (const lx of [-6, -2, 2, 6]) {
    g.beginPath();
    g.moveTo(x + lx * s, roof);
    g.lineTo(x + lx * 0.8 * s, roof - 10 * s);
    g.stroke();
  }
  g.lineWidth = 0.8 * s;
  g.beginPath();
  g.moveTo(x - 6 * s, roof - 3 * s);
  g.lineTo(x + 6 * s, roof - 7 * s);
  g.moveTo(x + 6 * s, roof - 3 * s);
  g.lineTo(x - 6 * s, roof - 7 * s);
  g.stroke();
  g.fillRect(x - 8 * s, roof - 26 * s, 16 * s, 16 * s);
  g.beginPath();
  g.moveTo(x - 9 * s, roof - 26 * s);
  g.lineTo(x, roof - 34 * s);
  g.lineTo(x + 9 * s, roof - 26 * s);
  g.closePath();
  g.fill();
  g.fillRect(x - 0.5 * s, roof - 37 * s, 1 * s, 4 * s);
}

function paintNear(g, rng, ground) {
  const base = H * 0.95;
  let x = -M;
  let stack = null;
  // Mid-field, well clear of both tank pads, so its plume never reads as smoke from a hit, and
  // over the lowest ground there so a hill doesn't hide it.
  let stackAt = W * (0.38 + rng() * 0.24);
  if (ground) {
    for (let sx = Math.round(W * 0.38); sx <= W * 0.62; sx += 6) if (ground[sx] > ground[Math.round(stackAt)] + 4) stackAt = sx;
  }
  while (x < W + M) {
    const w = 40 + rng() * 70;
    const h = 120 + rng() * 120;
    const top = base - h;
    tower(g, x, w, h, base, rng, PALETTE.near, { windows: 0.12, windowAlpha: 0.9 });
    // cornice
    g.fillStyle = PALETTE.near;
    g.fillRect(x - 1.5, top - 2, w + 3, 3);
    if (!stack && x + w > stackAt) {
      const sx = clamp(stackAt, x + 8, x + w - 8);
      // a striped steam stack, the kind that pokes out of Manhattan streets
      const sh = 46;
      for (let i = 0; i < 5; i++) {
        g.fillStyle = i % 2 ? '#e9ecf2' : '#ff6b1f';
        g.fillRect(sx - 4, top - sh + i * (sh / 5), 8, sh / 5 + 0.3);
      }
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(sx + 1.5, top - sh, 2.5, sh);
      stack = { x: sx, y: top - sh - 1 };
    } else if (rng() < 0.6) {
      waterTower(g, x + w * (0.2 + rng() * 0.55), top - 2, PALETTE.near, 1.15);
    }
    x += w + 4 + rng() * 26;
  }
  return stack || { x: W * 0.5, y: H * 0.5 };
}
