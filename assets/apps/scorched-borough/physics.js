// World model and ballistics for Scorched Borough.
//
// Everything here is plain data and pure-ish functions with no DOM access, so the CPU can run the
// exact same simulation the game runs when it plans a shot, and so it can all be tested in node.
// The playfield is a fixed 1200 x 675 world (y grows downward); the renderer scales it to fit.

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
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
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
    let y = base;
    switch (kind) {
      case 'hill':
        y -= amp * Math.exp(-((t - c) ** 2) / (2 * 0.1 ** 2));
        break;
      case 'valley':
        y += amp * 0.55 * Math.exp(-((t - c) ** 2) / (2 * 0.13 ** 2)) - amp * 0.3;
        break;
      case 'rolling':
        y -= amp * 0.33 * Math.sin(t * Math.PI * 2 * 1.6 + phase);
        break;
      case 'ridges':
        y -= amp * 0.75 * (Math.exp(-((t - c + 0.14) ** 2) / 0.0035) + Math.exp(-((t - c - 0.14) ** 2) / 0.0035));
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
  return { x: tank.x + Math.cos(a) * BARREL, y: tank.y - PIVOT_Y - Math.sin(a) * BARREL };
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
    vx: Math.cos(a) * v,
    vy: -Math.sin(a) * v,
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

// Advance one fixed step. Returns null while the shell is still flying, otherwise what it hit.
export function step(world, p) {
  const prevVy = p.vy;
  p.vx += world.wind * WIND_ACCEL * DT;
  p.vy += GRAVITY * DT;
  p.x += p.vx * DT;
  p.y += p.vy * DT;
  p.t += DT;

  // Side walls are solid: every shot lands somewhere the player can see. The sky has no ceiling.
  if (p.x <= 0 || p.x >= W) return { type: 'wall', x: clamp(p.x, 0, W), y: p.y };

  const tanks = world.tanks;
  for (let i = 0; i < tanks.length; i++) {
    if (i === p.owner && p.t < SELF_SAFE_T) continue;
    if (hitsTank(tanks[i], p.x, p.y)) return { type: 'tank', tank: i, x: p.x, y: p.y };
  }

  // A buried shell only digs upward. Once it starts to fall it bursts in the dirt it is in, and
  // nothing goes through bedrock.
  if (p.burrow && p.vy > 0) p.burrow = false;
  if (p.y >= FLOOR) return { type: 'ground', x: p.x, y: FLOOR };
  if (p.y >= groundAt(world.h, p.x)) {
    if (!p.burrow) return { type: 'ground', x: p.x, y: p.y };
  } else {
    p.burrow = false;
  }

  if (p.splits && prevVy < 0 && p.vy >= 0) return { type: 'split', x: p.x, y: p.y };
  if (p.t > MAX_FLIGHT) return { type: 'lost', x: p.x, y: p.y };
  return null;
}

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
    const r = step(world, p);
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

function slump(h, a, b) {
  const settle = (x) => {
    const d = h[x + 1] - h[x];
    if (d > REPOSE + 1e-3) {
      const t = (d - REPOSE) / 2;
      h[x] += t;
      h[x + 1] -= t;
      return true;
    }
    if (d < -REPOSE - 1e-3) {
      const t = (-d - REPOSE) / 2;
      h[x] -= t;
      h[x + 1] += t;
      return true;
    }
    return false;
  };
  // Sweep alternately left and right so the pile spreads both ways evenly.
  for (let pass = 0; pass < 1500; pass++) {
    let moved = false;
    if (pass % 2) for (let x = b - 1; x >= a; x--) moved = settle(x) || moved;
    else for (let x = a; x < b; x++) moved = settle(x) || moved;
    if (!moved) return pass;
  }
  return -1;
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
  const d = Math.max(0, Math.hypot(tank.x - x, tank.y - 9 - y) - 12);
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
