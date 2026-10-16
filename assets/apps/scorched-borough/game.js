// Match rules: rounds, turns, wind, ammo, damage. No DOM; the page drains `events` every frame to
// drive sound, particles and the HUD.
//
// The world only ever moves in fixed DT steps, and everything random comes from the match seed,
// so a match is fully described by its seed, level and the list of shots fired. The game keeps
// that list in `history` as it goes, and the records board replays it (see rules.js). In replay
// mode the game skips what only the picture needs: events, the dirt-falling animation and the
// pause after each shot.

import {
  DT, GRAVITY, WEAPONS, WEAPON_ORDER,
  mulberry32, generateTerrain, placeTanks, makeTerrain, supportAt, launch, step, fly, splitShell, clearLine,
  carve, addDirt, stepDirt, blastDamage, fallDamage, nextWind, clamp,
} from './physics.js';

export const LEVELS = {
  easy: { label: 'Easy', wind: 4 },
  normal: { label: 'Normal', wind: 8 },
  hard: { label: 'Hard', wind: 10 },
};
export const ROUNDS_TO_WIN = 2;

export const PLACES = [
  'Red Hook', 'Astoria', 'Mott Haven', 'DUMBO', 'Bushwick', 'Flushing Meadows', 'Inwood Hill',
  'St. George', 'Coney Island', 'Long Island City', 'Bay Ridge', 'Riverdale', 'Hoboken',
  'Jersey City', 'Greenpoint', 'Sunnyside', 'Rockaway', 'Harlem', 'Fort Greene', 'Gowanus',
];

export const SETTLE_MIN = 0.7; // let the smoke clear a little before the next turn

// The match RNG starts from the seed in its top 30 bits and the level in the bottom two, so a
// seed deals a different match on each level, and no seed on one level can start the RNG where a
// seed on another level does. If one could, a log from a Normal win could be posted as Hard with
// that seed and would often still replay as a win. mulberry32 only ever steps its state by one
// odd constant, so the nearest another level can get is the same stream a few draws early or
// late, and that deals other terrain, other tank spots and other wind.
export const SEED_MAX = 0x3fffffff;
const LEVEL_BITS = { easy: 1, normal: 2, hard: 3 };
export const rngStart = (seed, level) => ((((seed & SEED_MAX) << 2) | LEVEL_BITS[level]) >>> 0);

// The level goes into every round's terrain as well. Otherwise a forged first round that used up
// just the right number of draws could bring another level's stream back in line with the real
// match's, and rounds 2 and 3 would replay the same apart from the wind.
const ROUND_MIX = { easy: 0x2545f491, normal: 0x68e31da4, hard: 0xb5297a4d };

// Angle and power move in tenths everywhere (sliders, keys, the CPU), so a shot is three small
// integers and a replay fires exactly the numbers the match did.
export const tenths = (v) => Math.round(v * 10);

export class Game {
  constructor({ level = 'normal', seed = 1, replay = false } = {}) {
    this.level = LEVELS[level] ? level : 'normal';
    this.seed = (seed >>> 0) & SEED_MAX;
    this.replay = replay;
    this.rng = mulberry32(rngStart(this.seed, this.level));
    this.round = 0;
    this.score = [0, 0];
    this.shots = [0, 0];
    this.roundShots = [0, 0];
    this.turn = 0;
    this.turnCount = 0;
    this.phase = 'idle';
    this.events = [];
    this.projectiles = [];
    this.lastImpact = [null, null];
    this.acc = 0;
    this.clock = 0;
    this.settleT = 0;
    this.winner = -1;
    this.matchWinner = -1;
    this.history = [];
    this.flightTicks = 0;
    this.groundDirty = true;
    this.places = PLACES.slice();
    for (let i = this.places.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [this.places[i], this.places[j]] = [this.places[j], this.places[i]];
    }
  }

  get windMax() {
    return LEVELS[this.level].wind;
  }

  emit(type, data = {}) {
    if (!this.replay) this.events.push({ ...data, type });
  }

  startRound() {
    this.round++;
    this.roundSeed = (((this.rng() * 4294967296) >>> 0) ^ ROUND_MIX[this.level]) >>> 0;
    const { h, shape } = generateTerrain(this.roundSeed);
    this.shape = shape;
    this.terr = makeTerrain(h);
    this.tanks = placeTanks(h, mulberry32(this.roundSeed ^ 0x9e3779b9));
    this.world = { h, tanks: this.tanks, wind: 0, clear: clearLine(h, this.tanks) };
    this.ammo = [0, 1].map(() => Object.fromEntries(WEAPON_ORDER.map((id) => [id, WEAPONS[id].ammo])));
    this.place = this.places[(this.round - 1) % this.places.length];
    this.projectiles = [];
    this.lastImpact = [null, null];
    this.roundShots = [0, 0];
    this.winner = -1;
    this.groundDirty = true;
    // Round 1 opens with the player, then the first move alternates.
    this.first = (this.round - 1) % 2;
    this.turn = this.first;
    this.history.push({ first: this.first, shots: [] });
    this.world.wind = clamp(Math.round((this.rng() * 2 - 1) * this.windMax * 0.6), -this.windMax, this.windMax);
    this.phase = 'aim';
    this.turnCount++;
    this.emit('round', { round: this.round, place: this.place, first: this.first, seed: this.roundSeed });
    this.emit('turn', { turn: this.turn, wind: this.world.wind });
  }

  canFire(weapon) {
    return this.phase === 'aim' && this.ammo[this.turn][weapon] > 0;
  }

  // `ms` is how long the shooter took over this turn; it only goes into the history.
  fire(angle, power, weapon = 'standard', ms = 0) {
    if (this.phase !== 'aim') return false;
    if (!(this.ammo[this.turn][weapon] > 0)) weapon = 'standard';
    const tank = this.tanks[this.turn];
    const a = clamp(tenths(angle) || 0, 0, 1800);
    const pw = clamp(tenths(power) || 0, 0, 1000);
    tank.angle = a / 10;
    tank.power = pw / 10;
    if (Number.isFinite(this.ammo[this.turn][weapon])) this.ammo[this.turn][weapon]--;
    this.history[this.history.length - 1].shots.push([this.turn, a, pw, WEAPON_ORDER.indexOf(weapon), Math.max(0, Math.round(ms) || 0)]);
    const p = launch(this.world, this.turn, tank.angle, tank.power, weapon);
    this.projectiles = [p];
    this.shots[this.turn]++;
    this.roundShots[this.turn]++;
    this.flightTicks = 0;
    this.phase = 'flight';
    this.emit('fire', { tank: this.turn, x: p.x, y: p.y, angle: tank.angle, power: tank.power, weapon });
    return true;
  }

  update(dt) {
    this.acc += Math.min(dt, 0.1);
    let n = 0;
    while (this.acc >= DT && n < 60) {
      this.acc -= DT;
      this.tick();
      n++;
    }
  }

  // One fixed step of the whole world. This runs a few hundred times per shot, and the records
  // board runs it for every shot of a match, so it avoids allocating anything on the way.
  tick() {
    this.clock += DT;
    // Falling dirt is only a picture: the surface in terr.h is already where it will settle.
    if (this.terr && !this.replay && stepDirt(this.terr, DT)) this.terrainChanged = true;
    const tanks = this.tanks;
    // Tanks never move sideways, so a tank that has landed stays put until the ground changes.
    if (tanks && (this.groundDirty || tanks[0].falling || tanks[1].falling)) this.stepTanks();

    if (this.phase === 'flight') {
      this.flightTicks++;
      const shells = this.projectiles;
      let next = null; // a new list only when a shell bursts or splits
      for (let i = 0; i < shells.length; i++) {
        const p = shells[i];
        const r = step(this.world, p);
        if (!r) {
          if (next) next.push(p);
          continue;
        }
        if (!next) next = shells.slice(0, i);
        this.shellDone(p, r, next);
      }
      if (next) this.landed(next);
    } else if (this.phase === 'settle') {
      this.settleT += DT;
      const still = !tanks[0].falling && !tanks[1].falling;
      // Once both tanks have landed nothing else can change, so a replay moves straight on.
      if (still && (this.replay || (this.settleT >= SETTLE_MIN && !this.terr.active))) this.endTurn();
    }
  }

  shellDone(p, r, next) {
    if (r.type === 'split') {
      next.push(...splitShell(p));
      this.emit('split', { x: r.x, y: r.y, owner: p.owner });
    } else if (r.type !== 'lost') {
      this.detonate(p, r);
    }
  }

  landed(next) {
    this.projectiles = next;
    if (!next.length) {
      this.phase = 'settle';
      this.settleT = 0;
    }
  }

  // Play out the shot in the air until the next turn (or the end of the round). Replays only.
  // While a single shell is in the air and nothing else is moving, a tick is just that shell's
  // step, so it runs those straight through; anything else goes through tick().
  resolve() {
    const tanks = this.tanks;
    for (let n = 0; n < 20000 && (this.phase === 'flight' || this.phase === 'settle'); n++) {
      if (this.phase === 'flight' && this.projectiles.length === 1 && !this.groundDirty && !tanks[0].falling && !tanks[1].falling) {
        const p = this.projectiles[0];
        const budget = 20000 - n;
        const r = fly(this.world, p, budget);
        const k = r ? r.steps : budget;
        n += k - 1;
        this.clock += k * DT;
        this.flightTicks += k;
        if (!r) break;
        const next = [];
        this.shellDone(p, r, next);
        this.landed(next);
      } else {
        this.tick();
      }
    }
  }

  stepTanks() {
    const tanks = this.tanks;
    if (this.groundDirty) {
      const h = this.terr.h;
      for (let i = 0; i < tanks.length; i++) tanks[i].ground = supportAt(h, tanks[i].x);
      this.groundDirty = false;
    }
    for (let i = 0; i < tanks.length; i++) {
      const t = tanks[i];
      const ground = t.ground;
      if (!t.falling) {
        if (!(t.y < ground - 0.5)) continue;
        t.falling = true;
        t.fallFrom = t.y;
        t.vy = 0;
      }
      t.vy += GRAVITY * DT;
      t.y += t.vy * DT;
      if (t.y >= ground) {
        t.y = ground;
        t.falling = false;
        t.vy = 0;
        const dist = ground - t.fallFrom;
        const dmg = t.alive ? fallDamage(dist) : 0;
        this.emit('land', { tank: i, x: t.x, y: t.y, dist, damage: dmg });
        if (dmg) this.hurt(i, dmg, 'fall');
      }
    }
  }

  hurt(i, amount, cause, by = -1) {
    const t = this.tanks[i];
    if (!t.alive || amount <= 0) return;
    t.hp = Math.max(0, t.hp - amount);
    this.emit('damage', { tank: i, amount, cause, by, hp: t.hp, x: t.x, y: t.y });
    if (t.hp <= 0) {
      t.alive = false;
      this.emit('destroyed', { tank: i, x: t.x, y: t.y, by });
    }
  }

  detonate(p, r) {
    const weapon = WEAPONS[p.weapon];
    const direct = r.type === 'tank' ? r.tank : -1;
    const hits = this.tanks.map((t, i) => blastDamage(t, r.x, r.y, weapon, i === direct));
    // A crater only lowers the ground, so the clear line still holds; a pile can rise above it.
    if (weapon.dirt) {
      addDirt(this.terr, r.x, r.y, weapon.radius);
      this.world.clear = clearLine(this.terr.h, this.tanks);
    } else {
      carve(this.terr, r.x, r.y, weapon.radius);
    }
    this.terrainChanged = true;
    this.groundDirty = true;
    this.emit('explode', { x: r.x, y: r.y, hit: r.type, weapon: weapon.id, radius: weapon.radius, owner: p.owner, direct, child: p.child });
    hits.forEach((dmg, i) => this.hurt(i, dmg, direct === i ? 'direct' : 'blast', p.owner));
    if (p.center) {
      const target = this.tanks[1 - p.owner];
      this.lastImpact[p.owner] = { x: r.x, y: r.y, hit: r.type, dx: r.x - target.x, turn: this.turnCount, direct: direct === 1 - p.owner };
      this.emit('impact', { owner: p.owner, ...this.lastImpact[p.owner] });
    }
  }

  endTurn() {
    const dead = this.tanks.map((t) => !t.alive);
    if (dead[0] || dead[1]) {
      // A shot that takes out both tanks counts against the shooter, so there are no drawn rounds.
      const winner = dead[0] && dead[1] ? 1 - this.turn : dead[0] ? 1 : 0;
      this.winner = winner;
      this.score[winner]++;
      if (this.score[winner] >= ROUNDS_TO_WIN) {
        this.matchWinner = winner;
        this.phase = 'match-over';
        this.emit('round-over', { winner, score: this.score.slice(), final: true });
        this.emit('match-over', { winner, score: this.score.slice(), shots: this.shots.slice() });
      } else {
        this.phase = 'round-over';
        this.emit('round-over', { winner, score: this.score.slice(), final: false });
      }
      return;
    }
    this.turn = 1 - this.turn;
    this.turnCount++;
    this.world.wind = nextWind(this.rng, this.world.wind, this.windMax);
    this.phase = 'aim';
    this.emit('turn', { turn: this.turn, wind: this.world.wind });
  }

  nextRound() {
    if (this.phase === 'round-over') this.startRound();
  }

  drain() {
    const ev = this.events;
    this.events = [];
    return ev;
  }
}
