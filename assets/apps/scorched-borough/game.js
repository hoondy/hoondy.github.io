// Match rules: rounds, turns, wind, ammo, damage. No DOM; the page drains `events` every frame to
// drive sound, particles and the HUD.

import {
  DT, GRAVITY, WEAPONS, WEAPON_ORDER,
  mulberry32, generateTerrain, placeTanks, makeTerrain, supportAt, launch, step, splitShell,
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

const SETTLE_MIN = 0.7; // let the smoke clear a little before the next turn

export class Game {
  constructor({ level = 'normal', seed = 1 } = {}) {
    this.level = LEVELS[level] ? level : 'normal';
    this.rng = mulberry32(seed);
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
    this.events.push({ ...data, type });
  }

  startRound() {
    this.round++;
    this.roundSeed = (this.rng() * 4294967296) >>> 0;
    const { h, shape } = generateTerrain(this.roundSeed);
    this.shape = shape;
    this.terr = makeTerrain(h);
    this.tanks = placeTanks(h, mulberry32(this.roundSeed ^ 0x9e3779b9));
    this.world = { h, tanks: this.tanks, wind: 0 };
    this.ammo = [0, 1].map(() => Object.fromEntries(WEAPON_ORDER.map((id) => [id, WEAPONS[id].ammo])));
    this.place = this.places[(this.round - 1) % this.places.length];
    this.projectiles = [];
    this.lastImpact = [null, null];
    this.roundShots = [0, 0];
    this.winner = -1;
    // Round 1 opens with the player, then the first move alternates.
    this.first = (this.round - 1) % 2;
    this.turn = this.first;
    this.world.wind = clamp(Math.round((this.rng() * 2 - 1) * this.windMax * 0.6), -this.windMax, this.windMax);
    this.phase = 'aim';
    this.turnCount++;
    this.emit('round', { round: this.round, place: this.place, first: this.first, seed: this.roundSeed });
    this.emit('turn', { turn: this.turn, wind: this.world.wind });
  }

  canFire(weapon) {
    return this.phase === 'aim' && this.ammo[this.turn][weapon] > 0;
  }

  fire(angle, power, weapon = 'standard') {
    if (this.phase !== 'aim') return false;
    if (!(this.ammo[this.turn][weapon] > 0)) weapon = 'standard';
    const tank = this.tanks[this.turn];
    tank.angle = clamp(angle, 0, 180);
    tank.power = clamp(power, 0, 100);
    if (Number.isFinite(this.ammo[this.turn][weapon])) this.ammo[this.turn][weapon]--;
    const p = launch(this.world, this.turn, tank.angle, tank.power, weapon);
    this.projectiles = [p];
    this.shots[this.turn]++;
    this.roundShots[this.turn]++;
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

  tick() {
    this.clock += DT;
    if (this.terr && stepDirt(this.terr, DT)) this.terrainChanged = true;
    if (this.tanks) this.stepTanks();

    if (this.phase === 'flight') {
      const next = [];
      for (const p of this.projectiles) {
        const r = step(this.world, p);
        if (!r) {
          next.push(p);
        } else if (r.type === 'split') {
          next.push(...splitShell(p));
          this.emit('split', { x: r.x, y: r.y, owner: p.owner });
        } else if (r.type !== 'lost') {
          this.detonate(p, r);
        }
      }
      this.projectiles = next;
      if (!next.length) {
        this.phase = 'settle';
        this.settleT = 0;
      }
    } else if (this.phase === 'settle') {
      this.settleT += DT;
      if (this.settleT >= SETTLE_MIN && !this.terr.active && !this.tanks.some((t) => t.falling)) this.endTurn();
    }
  }

  stepTanks() {
    const h = this.terr.h;
    this.tanks.forEach((t, i) => {
      const ground = supportAt(h, t.x);
      if (!t.falling && t.y < ground - 0.5) {
        t.falling = true;
        t.fallFrom = t.y;
        t.vy = 0;
      }
      if (!t.falling) return;
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
    });
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
    if (weapon.dirt) addDirt(this.terr, r.x, r.y, weapon.radius);
    else carve(this.terr, r.x, r.y, weapon.radius);
    this.terrainChanged = true;
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
