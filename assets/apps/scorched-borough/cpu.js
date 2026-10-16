// The CPU gunner.
//
// It plans with the real ballistics (wind included), so on its own it would never miss. To play
// like a person it picks a spot to aim at that is off the target by a random amount, and that
// amount shrinks as it gets its eye in. After a miss it aims for the other side of the target
// with a smaller error (overshoot, undershoot, hit), which is how people bracket a target.
// Planning is a generator so the page can spread the work over several frames.

import { W, WEAPONS, simulateShot, launch, fly, splitShell, gauss, clamp } from './physics.js';

// sigma*: how far off (world units) it aims, and how fast that shrinks with practice.
// windSense/windNoise: how much of the wind it actually reads, like a person squinting at a flag.
export const PROFILES = {
  easy: { sigma0: 300, shrink: 0.88, sigmaMin: 75, bracket: 0.5, converge: 0.95, windSense: 0.35, windNoise: 2, jitterA: 1.2, jitterP: 1.0, think: [1200, 1800], pick: 'any' },
  normal: { sigma0: 140, shrink: 0.6, sigmaMin: 20, bracket: 0.85, converge: 0.6, windSense: 0.85, windNoise: 0.8, jitterA: 0.5, jitterP: 0.4, think: [1000, 1500], pick: 'best' },
  hard: { sigma0: 95, shrink: 0.5, sigmaMin: 13, bracket: 0.92, converge: 0.45, windSense: 0.92, windNoise: 0.5, jitterA: 0.2, jitterP: 0.15, think: [850, 1250], pick: 'best' },
};

const SIMS_PER_SLICE = 16;

export class Brain {
  constructor(level, rng) {
    this.level = PROFILES[level] ? level : 'normal';
    this.p = PROFILES[this.level];
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.attempts = 0;
    this.lastMiss = null;
    this.lastTarget = null;
  }

  thinkTime() {
    const [a, b] = this.p.think;
    return a + (b - a) * this.rng();
  }

  *plan(world, self, target, ammo) {
    const P = this.p;
    const foe = world.tanks[target];

    // If the target moved (fell into a crater, say), the old corrections only half apply.
    if (this.lastTarget && (Math.abs(foe.x - this.lastTarget.x) > 6 || Math.abs(foe.y - this.lastTarget.y) > 24)) {
      this.attempts = Math.max(0, this.attempts - 2);
      this.lastMiss = null;
    }
    this.lastTarget = { x: foe.x, y: foe.y };

    const sigma = Math.max(P.sigmaMin, P.sigma0 * P.shrink ** this.attempts);
    let miss = Math.abs(gauss(this.rng)) * sigma;
    let side;
    if (this.lastMiss != null && Math.abs(this.lastMiss) > 4 && this.rng() < P.bracket) {
      side = -Math.sign(this.lastMiss);
      miss = Math.min(miss, Math.abs(this.lastMiss) * P.converge);
    } else {
      side = this.rng() < 0.5 ? -1 : 1;
    }
    const aimX = clamp(foe.x + side * miss, 6, W - 6);
    const weapon = this.chooseWeapon(world, self, target, ammo || {}, sigma);
    const felt = { ...world, wind: world.wind * P.windSense + gauss(this.rng) * P.windNoise };
    const sol = yield* solve(felt, self, aimX, this.rng, P.pick);
    this.attempts++;

    let shot = {
      angle: clamp(sol.angle + gauss(this.rng) * P.jitterA, 0, 180),
      power: clamp(sol.power + gauss(this.rng) * P.jitterP, 0, 100),
      weapon,
    };
    // People don't lob shells onto their own feet. A wild aim point, the wrong wind or a
    // splitter's spread now and then would, so the final aim is checked against the real wind,
    // falling back to a plain shell, then the same aim without the wobble, then a shot aimed
    // right at the target. The records board counts on this: it refuses a match where the CPU
    // hurt itself.
    if (hurtsSelf(world, self, shot)) shot = { ...shot, weapon: 'standard' };
    if (hurtsSelf(world, self, shot)) shot = { angle: sol.angle, power: sol.power, weapon: 'standard' };
    if (hurtsSelf(world, self, shot)) {
      const safe = yield* solve(felt, self, foe.x, this.rng, 'best');
      shot = { angle: safe.angle, power: safe.power, weapon: 'standard' };
    }
    return { ...shot, aimX, sigma };
  }

  observe(impact) {
    if (impact && Number.isFinite(impact.dx)) this.lastMiss = impact.direct ? 0 : impact.dx;
  }

  chooseWeapon(world, self, target, ammo, sigma) {
    const me = world.tanks[self];
    const foe = world.tanks[target];
    const has = (id) => ammo[id] > 0;
    if (Math.abs(me.x - foe.x) < 170) return 'standard'; // too close for anything with splash
    const r = this.rng();
    if (this.level === 'easy') {
      if (r < 0.3) {
        const pool = ['heavy', 'splitter', 'dirt'].filter(has);
        if (pool.length) return pool[Math.floor(this.rng() * pool.length)];
      }
      return 'standard';
    }
    if (this.level === 'normal') {
      if (has('heavy') && sigma < 40 && r < 0.7) return 'heavy';
      if (has('splitter') && sigma >= 40 && sigma < 110 && r < 0.35) return 'splitter';
      return 'standard';
    }
    if (has('heavy') && sigma < 26) return 'heavy';
    if (has('splitter') && sigma >= 26 && r < 0.55) return 'splitter';
    return 'standard';
  }
}

// Would any part of this shot come down where it hurts the shooter: a blast that reaches its tank
// or a crater under the ground it stands on? A dirt bomb only ever piles dirt up.
export function hurtsSelf(world, self, { angle, power, weapon }) {
  const w = WEAPONS[weapon];
  if (!w.damage) return false;
  const me = world.tanks[self];
  let shells = [launch(world, self, angle, power, weapon)];
  while (shells.length) {
    const next = [];
    for (const p of shells) {
      const r = fly(world, p, Infinity);
      if (r.type === 'split') next.push(...splitShell(p));
      else if (r.type !== 'lost' && ((r.type === 'tank' && r.tank === self) || Math.abs(r.x - me.x) < w.radius + 20)) return true;
    }
    shells = next;
  }
  return false;
}

// Find the angle and power that put a shell closest to aimX. Coarse grid over elevations and
// powers, then a small coordinate descent around the three best.
export function* solve(world, self, aimX, rng = Math.random, pick = 'best') {
  const me = world.tanks[self];
  const dir = aimX >= me.x ? 1 : -1;
  let sims = 0;

  const cost = (r) => {
    if (r.type === 'lost') return 1e9;
    if (r.type === 'tank' && r.tank === self) return 1e8;
    let c = Math.abs(r.x - aimX);
    const near = Math.hypot(r.x - me.x, r.y - (me.y - 9));
    if (near < 80) c += (80 - near) * 30; // never plan to land on your own doorstep
    if (r.type === 'wall') c += 40;
    return c;
  };
  const tryShot = (angle, power) => cost(simulateShot(world, self, angle, power));

  const coarse = [];
  for (let e = 12; e <= 81; e += 3) {
    const angle = dir > 0 ? e : 180 - e;
    let best = null;
    for (let p = 14; p <= 100; p += 4) {
      const c = tryShot(angle, p);
      if (!best || c < best.c) best = { angle, power: p, c };
      if (++sims % SIMS_PER_SLICE === 0) yield sims;
    }
    coarse.push(best);
  }
  coarse.sort((a, b) => a.c - b.c);

  const refined = [];
  for (const start of coarse.slice(0, 3)) {
    let { angle, power, c } = start;
    for (let s = 2; s >= 0.06; s /= 2) {
      for (const dp of [-s, s]) {
        const p = clamp(power + dp, 0, 100);
        const cc = tryShot(angle, p);
        if (cc < c) {
          c = cc;
          power = p;
        }
      }
      for (const da of [-s / 2, s / 2]) {
        const a = clamp(angle + da, 0, 180);
        const cc = tryShot(a, power);
        if (cc < c) {
          c = cc;
          angle = a;
        }
      }
      sims += 4;
      if (sims % SIMS_PER_SLICE < 4) yield sims;
    }
    refined.push({ angle, power, c });
  }
  refined.sort((a, b) => a.c - b.c);
  const good = refined.filter((r) => r.c <= refined[0].c + 3);
  return pick === 'any' ? good[Math.floor(rng() * good.length)] : good[0];
}
