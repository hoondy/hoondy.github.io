// World model and ballistics for Scorched Borough.
//
// Everything here is plain data and pure-ish functions with no DOM access, so the CPU can run the
// exact same simulation the game runs when it plans a shot, and so it can all be tested in node.
// The playfield is a fixed 1200 x 675 world (y grows downward); the renderer scales it to fit.
//
// The records board replays matches on the server, so anything that decides the state of the
// world sticks to arithmetic every engine rounds the same way: + - * /, Math.sqrt, rounding, and
// the sin/cos/exp/log in detmath.js. Native Math.sin and friends stay out of this file.

import { sin, cos, exp, log } from './detmath.js';

export const W = 1200;
export const H = 675;
export const DT = 1 / 240; // fixed physics step: shots replay identically on every machine
export const GRAVITY = 380; // world units / s^2
export const VMAX = 730; // muzzle speed at power 100
export const WIND_ACCEL = 6; // sideways acceleration per point of wind
export const WIND_MAX = 10;
export const FLOOR = H - 8; // bedrock: craters stop here
export const SKY_MIN = 24; // dirt can't pile higher than this
export const TANK_W = 46;
export const TANK_H = 15;
export const BARREL = 24;
export const PIVOT_Y = 16; // barrel pivot height above the tracks
export const SELF_SAFE_T = 0.12; // a shell can't clip its own tank on the way out
export const MAX_FLIGHT = 12; // safety net only: walls and bedrock stop every real shot well before this
export const SPLIT_SPREAD = 44;
export const UNIT_M = 0.5; // one world unit in meters, for callouts

export const WEAPONS = {
  standard: { id: 'standard', key: '1', name: 'Standard', short: 'Standard', radius: 32, damage: 50, ammo: Infinity },
  heavy: { id: 'heavy', key: '2', name: 'Heavy', short: 'Heavy', radius: 52, damage: 70, ammo: 3 },
  splitter: { id: 'splitter', key: '3', name: 'Five-Borough Splitter', short: 'Splitter', radius: 26, damage: 24, ammo: 2, split: 5 },
  dirt: { id: 'dirt', key: '4', name: 'Dirt Bomb', short: 'Dirt', radius: 58, damage: 0, ammo: 2, dirt: true },
};
export const WEAPON_ORDER = ['standard', 'heavy', 'splitter', 'dirt'];

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * log(u)) * cos(2 * Math.PI * rng());
}

export const randomSeed = () => (Math.random() * 4294967296) >>> 0;

function valueNoise(rng, cells) {
  const pts = Array.from({ length: cells + 2 }, () => rng() * 2 - 1);
  return (t) => {
    const f = t * cells;
    const i = Math.floor(f);
    const u = f - i;
    const s = u * u * (3 - 2 * u);
    return pts[i] + (pts[i + 1] - pts[i]) * s;
  };
}

export const SHAPES = ['hill', 'valley', 'rolling', 'ridges', 'mesa', 'slope'];

// Heightmap of the ground surface, one sample per world unit. Columns are always solid from the
// surface down, because loose dirt settles after every blast.
export function generateTerrain(seed, shape) {
  const rng = mulberry32(seed);
  const kind = shape || SHAPES[Math.floor(rng() * SHAPES.length)];
  const n1 = valueNoise(rng, 6);
  const n2 = valueNoise(rng, 17);
  const n3 = valueNoise(rng, 61);
  const base = H * (0.66 + rng() * 0.06);
  const amp = H * (0.16 + rng() * 0.12);
  const c = 0.5 + (rng() - 0.5) * 0.14;
  const phase = rng() * Math.PI * 2;
  const tilt = rng() < 0.5 ? -1 : 1;
  const h = new Float32Array(W + 1);
  for (let x = 0; x <= W; x++) {
    const t = x / W;
    const d = t - c;
    let y = base;
    switch (kind) {
      case 'hill':
        y -= amp * exp(-(d * d) / (2 * 0.1 * 0.1));
        break;
      case 'valley':
        y += amp * 0.55 * exp(-(d * d) / (2 * 0.13 * 0.13)) - amp * 0.3;
        break;
      case 'rolling':
        y -= amp * 0.33 * sin(t * Math.PI * 2 * 1.6 + phase);
        break;
      case 'ridges':
        y -= amp * 0.75 * (exp(-((d + 0.14) * (d + 0.14)) / 0.0035) + exp(-((d - 0.14) * (d - 0.14)) / 0.0035));
        break;
      case 'mesa':
        y -= amp * 0.7 * (smoothstep(c - 0.17, c - 0.1, t) - smoothstep(c + 0.1, c + 0.17, t));
        break;
      default: // slope
        y -= amp * 0.45 * (t - 0.5) * 2 * tilt;
    }
    y -= n1(t) * H * 0.06 + n2(t) * H * 0.022 + n3(t) * H * 0.006;
    h[x] = clamp(y, H * 0.3, FLOOR - 70);
  }
  return { h, shape: kind };
}

function flattenPad(h, x, half, blend) {
  let sum = 0;
  let n = 0;
  for (let i = Math.round(x - half); i <= Math.round(x + half); i++) {
    sum += h[i];
    n++;
  }
  const level = sum / n;
  for (let i = Math.round(x - half - blend); i <= Math.round(x + half + blend); i++) {
    if (i < 0 || i > W) continue;
    const k = 1 - smoothstep(half, half + blend, Math.abs(i - x));
    h[i] += (level - h[i]) * k;
  }
}

export function placeTanks(h, rng) {
  const xs = [Math.round(W * (0.07 + rng() * 0.17)), Math.round(W * (0.93 - rng() * 0.17))];
  for (const x of xs) flattenPad(h, x, 26, 24);
  return xs.map((x, i) => ({
    x,
    y: supportAt(h, x),
    hp: 100,
    alive: true,
    angle: i === 0 ? 50 : 130,
    power: 62,
    vy: 0,
    falling: false,
    fallFrom: 0,
  }));
}

export function groundAt(h, x) {
  if (x <= 0) return h[0];
  if (x >= W) return h[W];
  const i = Math.floor(x);
  const f = x - i;
  return h[i] + (h[i + 1] - h[i]) * f;
}

// A tank rests on the highest ground under the middle of its tracks.
export function supportAt(h, x) {
  let top = Infinity;
  const a = Math.max(0, Math.round(x - 14));
  const b = Math.min(W, Math.round(x + 14));
  for (let i = a; i <= b; i++) if (h[i] < top) top = h[i];
  return top;
}

export function isBuried(h, tank) {
  return h[clamp(Math.round(tank.x), 0, W)] < tank.y - 9;
}

export function pivot(tank) {
  return { x: tank.x, y: tank.y - PIVOT_Y };
}

export function muzzle(tank, angle) {
  const a = (angle * Math.PI) / 180;
  return { x: tank.x + cos(a) * BARREL, y: tank.y - PIVOT_Y - sin(a) * BARREL };
}

export function hitsTank(tank, x, y) {
  if (!tank.alive) return false;
  if (x >= tank.x - TANK_W / 2 && x <= tank.x + TANK_W / 2 && y >= tank.y - 13 && y <= tank.y + 1) return true;
  const dx = x - tank.x;
  const dy = y - (tank.y - 15);
  return dx * dx + dy * dy <= 81;
}

export function launch(world, owner, angle, power, weapon = 'standard') {
  const tank = world.tanks[owner];
  const m = muzzle(tank, angle);
  const a = (angle * Math.PI) / 180;
  const v = (clamp(power, 0, 100) / 100) * VMAX;
  return {
    x: m.x,
    y: m.y,
    vx: cos(a) * v,
    vy: -sin(a) * v,
    t: 0,
    owner,
    weapon,
    // A buried tank's shell pushes through the loose dirt above it until it reaches open air.
    burrow: m.y >= groundAt(world.h, m.x),
    splits: Boolean(WEAPONS[weapon]?.split),
    child: false,
    center: true,
  };
}

// Nothing a shell can hit reaches above this line: not the ground, and not a tank, whose top is
// 24 above its tracks and which only ever moves down. The game keeps it in world.clear so a
// shell high in the sky can skip the collision tests. Craters only lower the ground, so it only
// has to be drawn again when dirt piles up.
export function clearLine(h, tanks) {
  let top = FLOOR;
  for (let x = 0; x <= W; x++) if (h[x] < top) top = h[x];
  for (const t of tanks) if (t.y < top) top = t.y;
  return top - 26;
}

// Advance a shell by up to `max` fixed steps, stopping at the first one where it hits something.
// Returns null while it is still flying, otherwise what it hit, with `steps` taken. The game loop
// moves shells one step per tick; the CPU's planner and the records replay let a lone shell run.
// The shell lives in locals for the loop, which keeps those long runs quick.
export function fly(world, p, max = 1) {
  const ax = world.wind * WIND_ACCEL * DT;
  const tanks = world.tanks;
  const h = world.h;
  const clear = world.clear;
  const owner = p.owner;
  const splits = p.splits;
  let { x, y, vx, vy, t, burrow } = p;
  let hit = null;
  let k = 0;
  while (k < max) {
    k++;
    const prevVy = vy;
    vx += ax;
    vy += GRAVITY * DT;
    x += vx * DT;
    y += vy * DT;
    t += DT;

    // Side walls are solid: every shot lands somewhere the player can see. No ceiling, though.
    if (x <= 0 || x >= W) {
      hit = { type: 'wall', x: clamp(x, 0, W), y };
      break;
    }

    if (y < clear) {
      burrow = false;
    } else {
      for (let i = 0; i < tanks.length && !hit; i++) {
        if (i === owner && t < SELF_SAFE_T) continue;
        if (hitsTank(tanks[i], x, y)) hit = { type: 'tank', tank: i, x, y };
      }
      if (hit) break;
      // A buried shell only digs upward. Once it starts to fall it bursts in the dirt it is in,
      // and nothing goes through bedrock.
      if (burrow && vy > 0) burrow = false;
      if (y >= FLOOR) {
        hit = { type: 'ground', x, y: FLOOR };
        break;
      }
      if (y >= groundAt(h, x)) {
        if (!burrow) {
          hit = { type: 'ground', x, y };
          break;
        }
      } else {
        burrow = false;
      }
    }

    if (splits && prevVy < 0 && vy >= 0) {
      hit = { type: 'split', x, y };
      break;
    }
    if (t > MAX_FLIGHT) {
      hit = { type: 'lost', x, y };
      break;
    }
  }
  p.x = x;
  p.y = y;
  p.vx = vx;
  p.vy = vy;
  p.t = t;
  p.burrow = burrow;
  if (hit) hit.steps = k;
  return hit;
}

// One fixed step.
export const step = (world, p) => fly(world, p, 1);

export function splitShell(p) {
  const n = WEAPONS[p.weapon].split;
  const out = [];
  for (let k = 0; k < n; k++) {
    const off = k - (n - 1) / 2;
    out.push({ ...p, vx: p.vx + off * SPLIT_SPREAD, splits: false, child: true, center: off === 0, burrow: false });
  }
  return out;
}

// Where would this shot land? The splitter's middle bomblet keeps the parent's path, so a plain
// shell answers that too.
export function simulateShot(world, owner, angle, power, weapon = 'standard') {
  const p = launch(world, owner, angle, power, weapon);
  p.splits = false;
  for (;;) {
    const r = fly(world, p, 100000);
    if (r) {
      r.t = p.t;
      return r;
    }
  }
}

// Terrain with loose-dirt animation. `h` is always the settled surface; while a column has dirt
// falling, `len` holds the falling chunk's height and `top` where its upper edge is right now.
export function makeTerrain(h) {
  return { h, top: new Float32Array(W + 1), len: new Float32Array(W + 1), vel: new Float32Array(W + 1), active: 0 };
}

function landColumn(terr, x) {
  if (terr.len[x] > 0) {
    terr.len[x] = 0;
    terr.vel[x] = 0;
    terr.active--;
  }
}

export function stepDirt(terr, dt) {
  if (!terr.active) return false;
  const { h, top, len, vel } = terr;
  for (let x = 0; x <= W; x++) {
    if (len[x] <= 0) continue;
    vel[x] += GRAVITY * 1.4 * dt;
    top[x] += vel[x] * dt;
    if (top[x] >= h[x]) landColumn(terr, x);
  }
  return true;
}

function startFall(terr, x, from, length) {
  if (terr.len[x] <= 0) terr.active++;
  terr.top[x] = from;
  terr.len[x] = length;
  terr.vel[x] = 0;
}

export function carve(terr, cx, cy, r) {
  const h = terr.h;
  const x0 = Math.max(0, Math.ceil(cx - r));
  const x1 = Math.min(W, Math.floor(cx + r));
  let changed = false;
  for (let x = x0; x <= x1; x++) {
    const dx = x - cx;
    const dy = Math.sqrt(Math.max(0, r * r - dx * dx));
    const y1 = cy - dy;
    const y2 = Math.min(cy + dy, FLOOR);
    if (y2 <= y1) continue;
    landColumn(terr, x);
    const surface = h[x];
    if (surface >= y2) continue;
    changed = true;
    if (surface >= y1) {
      h[x] = y2;
    } else {
      // A pocket under the surface: the dirt above it drops in.
      h[x] = surface + (y2 - y1);
      startFall(terr, x, surface, y1 - surface);
    }
  }
  return changed;
}

// Loose dirt can't stand steeper than this (rise over run), so a dirt bomb ends up as a pile.
const REPOSE = 1.4;
const SLUMP_TOL = 1e-3;

// Let everything between columns a and b slump until no step is steeper than REPOSE, keeping the
// amount of dirt the same. Where a slope is too steep, dirt slides off the top into a straight
// ramp at the angle of repose, with as much taken off the top as lands at the foot. That ramp
// is the level stretch of h - REPOSE * x (or h + REPOSE * x for slopes the other way), so the
// settled shape is the closest non-increasing sequence to it, and the pool-adjacent-violators
// algorithm finds that in one pass. Settling one way can leave a new step the other way, so it
// alternates until both are clear, which usually takes one round.
const poolSum = new Float64Array(W + 2);
const poolLen = new Int32Array(W + 2);

function settleOneWay(h, a, b, dir) {
  let top = -1;
  let pooled = false;
  for (let x = a; x <= b; x++) {
    // dir 1: no drop to the right steeper than REPOSE; dir -1: no drop to the left.
    let sum = dir > 0 ? h[x] - REPOSE * (x - a) : -h[x] - REPOSE * (x - a);
    let len = 1;
    while (top >= 0 && sum / len > poolSum[top] / poolLen[top] + SLUMP_TOL) {
      sum += poolSum[top];
      len += poolLen[top];
      top--;
      pooled = true;
    }
    top++;
    poolSum[top] = sum;
    poolLen[top] = len;
  }
  if (!pooled) return false;
  for (let k = top, x = b; k >= 0; k--) {
    const m = poolSum[k] / poolLen[k];
    for (let i = 0; i < poolLen[k]; i++, x--) h[x] = dir > 0 ? m + REPOSE * (x - a) : -m - REPOSE * (x - a);
  }
  return true;
}

function slump(h, a, b) {
  for (let round = 0; round < 8; round++) {
    const right = settleOneWay(h, a, b, 1);
    const left = settleOneWay(h, a, b, -1);
    if (!right && !left) return;
  }
}

export function addDirt(terr, cx, cy, r) {
  const h = terr.h;
  const a = Math.max(0, Math.floor(cx - r * 2.6));
  const b = Math.min(W, Math.ceil(cx + r * 2.6));
  for (let x = a; x <= b; x++) landColumn(terr, x);
  const before = h.slice(a, b + 1);
  const ballTop = new Float32Array(b - a + 1).fill(Infinity);
  for (let x = Math.max(a, Math.ceil(cx - r)); x <= Math.min(b, Math.floor(cx + r)); x++) {
    const dx = x - cx;
    const dy = Math.sqrt(Math.max(0, r * r - dx * dx));
    const y1 = cy - dy;
    const y2 = cy + dy;
    const surface = h[x];
    const add = surface > y2 ? y2 - y1 : surface > y1 ? surface - y1 : 0;
    if (add <= 0) continue;
    h[x] = Math.max(SKY_MIN, surface - add);
    ballTop[x - a] = y1;
  }
  slump(h, a, b);
  // Animate the dirt that came out of the ball dropping onto the new pile.
  for (let x = a; x <= b; x++) {
    const i = x - a;
    const added = before[i] - h[x];
    if (added > 0.5 && ballTop[i] < h[x] - 0.5) startFall(terr, x, ballTop[i], added);
  }
}

export function blastDamage(tank, x, y, weapon, direct) {
  if (!tank.alive || !weapon.damage) return 0;
  if (direct) return weapon.damage;
  const dx = tank.x - x;
  const dy = tank.y - 9 - y;
  const d = Math.max(0, Math.sqrt(dx * dx + dy * dy) - 12);
  if (d >= weapon.radius) return 0;
  return Math.max(1, Math.round(weapon.damage * 0.9 * (1 - d / weapon.radius)));
}

export function fallDamage(dist) {
  return dist > 20 ? Math.min(30, Math.round((dist - 20) * 0.3)) : 0;
}

export function nextWind(rng, prev, max) {
  if (rng() < 0.1) return 0;
  return clamp(Math.round(prev + gauss(rng) * max * 0.28), -max, max);
}
