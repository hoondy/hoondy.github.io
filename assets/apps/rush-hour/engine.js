// Game state and rules of motion. No DOM in here: the page drives it with update() and
// type(), and draws whatever is in `words`.

import {
  DELAY_MS,
  EMPTY_SPAWN_MS,
  HOLD_MS,
  KIND,
  RESUME_MS,
  SPAWN_JITTER,
  SPECIAL_FROM,
  SPECIAL_RATE,
  SERVICE_HIT,
  SERVICE_MAX,
  SERVICE_REPAIR,
  fallSeconds,
  lengthRange,
  maxOnScreen,
  missPenalty,
  pointsFor,
  spawnSeconds,
  stats,
  wordsForStage,
} from './rules.js';

const DELAY_SPEED = 0.28;
const FIRST_SPAWN_MS = 700;
const RECENT = 60;

export class Game {
  /**
   * @param {object} o
   * @param {string[]} o.words  word list for the chosen pack
   * @param {string} o.pack
   * @param {() => number} [o.random]
   * @param {(text: string, kind: number) => number} [o.measure]  tile width as a fraction of the field
   * @param {(type: string, data?: object) => void} [o.onEvent]
   * @param {() => number} [o.clock]  play time for the log, in ms; defaults to game time
   */
  constructor({ words, pack, random = Math.random, measure, onEvent, clock }) {
    this.pack = pack;
    this.random = random;
    this.clock = clock || (() => this.t);
    this.stamped = 0;
    this.measure = measure || ((text) => (text.length * 0.6 + 2) / 40);
    this.onEvent = onEvent || (() => {});
    this.byLength = new Map();
    for (const w of words) {
      if (!this.byLength.has(w.length)) this.byLength.set(w.length, []);
      this.byLength.get(w.length).push(w);
    }
    this.pool = [];
    this.poolStage = 0;
    this.recent = [];

    this.t = 0;
    this.words = [];
    this.nextId = 1;
    this.buffer = '';
    this.target = null;

    this.score = 0;
    this.stage = 1;
    this.inStage = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.cleared = 0;
    this.chars = 0;
    this.misses = 0;
    this.typos = 0;
    this.service = SERVICE_MAX;
    this.log = [];

    this.nextSpawn = FIRST_SPAWN_MS;
    this.holdUntil = 0;
    this.slowUntil = 0;
    this.over = false;
  }

  get slowed() {
    return this.t < this.slowUntil;
  }

  get stageProgress() {
    return this.inStage / wordsForStage(this.stage);
  }

  stats() {
    return stats(this.chars, this.typos, this.t);
  }

  // The log is stamped with the page's play clock rather than game time. Game time is held back
  // when the browser stalls (so words don't jump), but the player's fingers keep going.
  stamp() {
    this.stamped = Math.max(this.stamped, Math.round(this.clock()));
    return this.stamped;
  }

  detail() {
    const durationMs = this.stamp();
    const { wpm, accuracy } = stats(this.chars, this.typos, durationMs);
    return {
      stage: this.stage,
      words: this.cleared,
      misses: this.misses,
      accuracy,
      wpm,
      durationMs,
      pack: this.pack,
    };
  }

  update(dt) {
    if (this.over) return;
    this.t += dt;
    const speed = this.slowed ? DELAY_SPEED : 1;

    for (let i = 0; i < this.words.length; i++) {
      const w = this.words[i];
      w.y += w.speed * dt * speed;
      if (w.y >= 1) {
        this.miss(w);
        i--;
        if (this.over) return;
      }
    }

    const hold = this.t < this.holdUntil || this.slowed;
    if (hold) {
      this.nextSpawn = Math.max(this.nextSpawn, Math.max(this.holdUntil, this.slowUntil) + RESUME_MS);
      return;
    }
    // An empty platform shouldn't keep a fast typist waiting.
    if (this.words.length === 0) this.nextSpawn = Math.min(this.nextSpawn, this.t + EMPTY_SPAWN_MS);
    if (this.t >= this.nextSpawn) {
      if (this.words.length < maxOnScreen(this.stage)) this.spawn();
      const [lo, hi] = SPAWN_JITTER;
      this.nextSpawn = this.t + spawnSeconds(this.stage) * 1000 * (lo + (hi - lo) * this.random());
    }
  }

  // Lengths stay inside lengthRange(stage) because the leaderboard checks them; every pack
  // has plenty of words in each band.
  candidates() {
    if (this.poolStage !== this.stage) {
      const [lo, hi] = lengthRange(this.stage);
      const pool = [];
      for (let n = lo; n <= hi; n++) pool.push(...(this.byLength.get(n) || []));
      this.pool = pool;
      this.poolStage = this.stage;
    }
    return this.pool;
  }

  pickWord() {
    const pool = this.candidates();
    const onScreen = this.words.map((w) => w.text);
    const firsts = new Set(onScreen.map((w) => w[0]));
    let fallback = null;
    for (let i = 0; i < 60; i++) {
      const w = pool[Math.floor(this.random() * pool.length)];
      if (this.recent.includes(w)) continue;
      // Never let one word be the start of another on screen, or typing could not tell them apart.
      if (onScreen.some((o) => o.startsWith(w) || w.startsWith(o))) continue;
      if (!firsts.has(w[0])) return w;
      fallback ??= w;
    }
    if (fallback) return fallback;
    return pool.find((w) => !onScreen.some((o) => o.startsWith(w) || w.startsWith(o))) || null;
  }

  rollKind() {
    if (this.words.some((w) => w.kind !== KIND.NORMAL)) return KIND.NORMAL;
    const s = this.stage;
    let r = this.random();
    for (const kind of [KIND.EXPRESS, KIND.DELAY, KIND.CLEAR]) {
      r -= SPECIAL_RATE[kind];
      if (r >= 0 || s < SPECIAL_FROM[kind]) continue;
      if (kind === KIND.DELAY && this.slowed) return KIND.NORMAL;
      if (kind === KIND.CLEAR && this.words.length < 3) return KIND.NORMAL;
      return kind;
    }
    return KIND.NORMAL;
  }

  spawn() {
    const text = this.pickWord();
    if (!text) return;
    this.recent.push(text);
    if (this.recent.length > RECENT) this.recent.shift();

    const kind = this.rollKind();
    const width = Math.min(0.96, this.measure(text, kind));
    const half = width / 2;
    const lo = half + 0.02;
    const hi = Math.max(lo, 1 - half - 0.02);

    // Try a few spots and keep the one furthest from the words still near the top.
    const near = this.words.filter((w) => w.y < 0.3);
    let x = lo + (hi - lo) * this.random();
    let best = -Infinity;
    for (let i = 0; i < 8 && near.length; i++) {
      const cx = lo + (hi - lo) * this.random();
      let gap = Infinity;
      for (const w of near) {
        const d = Math.abs(cx - w.x) - (half + w.width / 2) + w.y * 0.6;
        if (d < gap) gap = d;
      }
      if (gap > best) {
        best = gap;
        x = cx;
      }
    }

    const fall = fallSeconds(this.stage) * 1000 * (0.94 + 0.12 * this.random());
    const word = { id: this.nextId++, text, kind, x, y: 0, width, speed: 1 / fall, born: this.t, typed: 0 };
    this.words.push(word);
    this.onEvent('spawn', { word });
  }

  remove(word) {
    const i = this.words.indexOf(word);
    if (i >= 0) this.words.splice(i, 1);
    if (this.target === word) this.target = null;
  }

  // Re-run the current buffer against what is still on screen.
  retarget() {
    let target = null;
    for (const w of this.words) {
      w.typed = this.buffer && w.text.startsWith(this.buffer) ? this.buffer.length : 0;
      if (w.typed && (!target || w.y > target.y)) target = w;
    }
    if (this.buffer && !target) this.buffer = '';
    this.target = target;
  }

  type(ch) {
    if (this.over) return null;
    const c = ch.toLowerCase();
    if (!/^[a-z]$/.test(c)) return null;
    const next = this.buffer + c;
    if (!this.words.some((w) => w.text.startsWith(next))) {
      this.typos++;
      this.streak = 0;
      this.log.push([this.stamp(), 0]);
      this.onEvent('typo', { ch: c, buffer: this.buffer });
      return 'typo';
    }
    this.buffer = next;
    this.retarget();
    const target = this.target;
    if (target && target.text === next) {
      this.complete(target);
      return 'clear';
    }
    this.onEvent('key', { target });
    return 'key';
  }

  backspace() {
    if (this.over || !this.buffer) return;
    this.buffer = this.buffer.slice(0, -1);
    this.retarget();
    this.onEvent('buffer');
  }

  resetBuffer() {
    if (!this.buffer) return;
    this.buffer = '';
    this.retarget();
    this.onEvent('buffer');
  }

  complete(word) {
    const t = this.stamp();
    const len = word.text.length;
    const stage = this.stage;
    const points = pointsFor(len, stage, this.streak, word.kind);
    this.log.push([t, len, stage, this.streak, word.kind]);
    this.score += points;
    this.streak++;
    if (this.streak > this.bestStreak) this.bestStreak = this.streak;
    this.cleared++;
    this.chars += len;
    this.service = Math.min(SERVICE_MAX, this.service + SERVICE_REPAIR);
    this.remove(word);
    this.buffer = '';
    this.onEvent('clear', { word, points, streak: this.streak });

    if (word.kind === KIND.CLEAR) {
      const swept = this.words.splice(0);
      const sweptPoints = [];
      for (const w of swept) {
        const p = pointsFor(w.text.length, stage, 0, KIND.SWEPT);
        this.log.push([t, w.text.length, stage, 0, KIND.SWEPT]);
        this.score += p;
        sweptPoints.push(p);
      }
      this.onEvent('sweep', { words: swept, points: sweptPoints });
    } else if (word.kind === KIND.DELAY) {
      this.slowUntil = this.t + DELAY_MS;
      this.onEvent('delay', { until: this.slowUntil });
    } else if (word.kind === KIND.EXPRESS) {
      this.onEvent('express', { word, points });
    }
    this.retarget();

    if (++this.inStage >= wordsForStage(stage)) {
      this.stage++;
      this.inStage = 0;
      this.holdUntil = this.t + HOLD_MS;
      this.onEvent('stage', { stage: this.stage });
    }
  }

  miss(word) {
    const penalty = Math.min(this.score, missPenalty(this.stage));
    this.log.push([this.stamp(), -word.text.length]);
    this.score -= penalty;
    this.misses++;
    this.streak = 0;
    this.service -= SERVICE_HIT;
    this.remove(word);
    this.retarget();
    this.onEvent('miss', { word, penalty });
    if (this.service <= 0) {
      this.service = 0;
      this.end('suspended');
    }
  }

  end(reason = 'quit') {
    if (this.over) return;
    this.over = true;
    this.reason = reason;
    this.buffer = '';
    this.onEvent('over', { reason });
  }
}
