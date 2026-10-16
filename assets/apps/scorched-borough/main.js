// Scorched Borough: page controller. Wires the game, the CPU, the renderer and the controls.

import { W, H, WEAPONS, WEAPON_ORDER, UNIT_M, PIVOT_Y, clamp, randomSeed, mulberry32, groundAt } from './physics.js';
import { Game, LEVELS } from './game.js';
import { Brain } from './cpu.js';
import { Renderer } from './render.js';
import { Fx } from './fx.js';
import { Sound } from './audio.js';
import { loadStats, recordMatch, LEVEL_IDS } from './stats.js';
import { LEVEL_MULTIPLIER, MIN_POINTS, SHOT_COST, VERSION, WIN_POINTS, validateSubmission } from './rules.js';
import { cleanName, getPlayerName, getTop, renderBoard, submit } from '/assets/js/lib/leaderboard.js';
import { mountShareBar } from '/assets/js/lib/share.js';

const GAME_ID = 'scorched-borough';

const DEFAULT_AIM = { angle: 50, power: 62 };
const TURN_BANNER_MS = 950;
const ROUND_BANNER_MS = 1700;
const ROUND_OVER_MS = 2600;
const CPU_SLICE_MS = 4;

const round1 = (v) => Math.round(v * 10) / 10;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const fmtAngle = (a) => `${a.toFixed(1)}°`;
// Doto draws "." as a five-dot cluster that reads like "+", so the LED dials show whole numbers
// plainly and draw the decimal point in a plain face.
const setLed = (el, v, unit = '') => {
  const [whole, frac] = (Number.isInteger(v) ? String(v) : v.toFixed(1)).split('.');
  el.textContent = whole;
  if (frac) el.append(Object.assign(document.createElement('span'), { className: 'sb-dp', textContent: '.' }), frac);
  if (unit) el.append(unit);
};
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* fine */
    }
  },
};

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const NAME_HINT = 'Try another nickname: letters and numbers, up to 16.';

// The most points any replay-checked win has been worth in this browser, posted or not.
const BEST_KEY = 'sb:best';
function loadBest() {
  try {
    const b = JSON.parse(store.get(BEST_KEY) || 'null');
    if (b && Number.isInteger(b.score) && b.score > 0 && Object.hasOwn(LEVELS, b.level)) return b;
  } catch {
    /* corrupt: start over */
  }
  return null;
}

// What this browser has posted this month, per nickname. The board keeps each nickname's best
// of the month, and this says so when a smaller win is posted under the same name, even when
// that row is too far down the board to show.
const POSTED_KEY = 'sb:posted';
function postedBefore(period, name) {
  try {
    const p = JSON.parse(store.get(POSTED_KEY) || 'null');
    const score = p?.period === period ? p.best?.[name.toLowerCase()] : 0;
    return Number.isInteger(score) ? score : 0;
  } catch {
    return 0;
  }
}
function rememberPosted(period, name, score) {
  let p = null;
  try {
    p = JSON.parse(store.get(POSTED_KEY) || 'null');
  } catch {
    /* start over */
  }
  if (!p || p.period !== period || typeof p.best !== 'object') p = { period, best: {} };
  p.best[name.toLowerCase()] = score;
  store.set(POSTED_KEY, JSON.stringify(p));
}

// In a narrow board this wraps, so it only breaks after a dot: "Hard · 2–1 ·" / "7 shots".
function boardMeta(entry) {
  const d = entry.detail || {};
  const parts = [];
  if (Object.hasOwn(LEVELS, d.level)) parts.push(LEVELS[d.level].label);
  if (typeof d.rounds === 'string' && /^\d-\d$/.test(d.rounds)) parts.push(d.rounds.replace('-', '–'));
  if (Number.isInteger(d.shots)) parts.push(`${d.shots}\u00a0shot${d.shots === 1 ? '' : 's'}`);
  return parts.join('\u00a0· ');
}

// "October" for a board key like "2026-10". A post just after midnight on the 1st lands on the
// new month's board, so name the month rather than saying "this month".
function boardMonth(period) {
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.exec(period || '');
  if (!m) return '';
  return new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, m[1] - 1, 15)));
}

class App {
  constructor(root) {
    this.root = root;
    const $ = (s) => root.querySelector(s);
    this.el = {
      canvas: $('.sb-canvas'),
      screen: $('.sb-screen'),
      banner: $('.sb-banner'),
      bannerMain: $('.sb-banner__main'),
      bannerSub: $('.sb-banner__sub'),
      menu: $('.sb-menu'),
      console: $('.sb-console'),
      result: $('.sb-result'),
      fire: $('.sb-fire'),
      fireLabel: $('.sb-fire__label'),
      angle: $('#sb-angle'),
      power: $('#sb-power'),
      angleOut: $('[data-dial="angle"] .sb-dial__led'),
      powerOut: $('[data-dial="power"] .sb-dial__led'),
      plates: [...root.querySelectorAll('.sb-plate')],
      wind: $('.sb-wind'),
      windGauge: $('.sb-wind__gauge'),
      windVal: $('.sb-wind__val'),
      whereRound: $('.sb-where__round'),
      wherePlace: $('.sb-where__place'),
      arms: [...root.querySelectorAll('.sb-arm')],
      levels: [...root.querySelectorAll('.sb-level')],
      start: $('.sb-start'),
      dock: $('.sb-dock'),
      ctaGo: $('.sb-cta__go'),
      ctaLvl: $('.sb-cta__lvl'),
      ctaPick: $('.sb-cta__pick'),
      menuStats: $('.sb-menu__stats'),
      live: $('.sb-live'),
      tools: Object.fromEntries([...root.querySelectorAll('.sb-tool')].map((b) => [b.dataset.tool, b])),
      boards: { menu: $('[data-sb-board="menu"]'), result: $('[data-sb-board="result"]') },
      points: $('.sb-points'),
      pointsNum: $('.sb-points__num'),
      pointsHow: $('.sb-points__how'),
      pointsNew: $('.sb-points__new'),
      post: $('.sb-post'),
      name: $('.sb-name'),
      postBtn: $('.sb-post__btn'),
      postMsg: $('.sb-post__msg'),
    };

    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.reduced = Boolean(mq?.matches);
    this.renderer = new Renderer(this.el.canvas, { reduced: this.reduced });
    this.fx = new Fx({ reduced: this.reduced });
    const shakePref = store.get('sb:shake');
    this.fx.shakeOn = shakePref == null ? !this.reduced : shakePref === '1';
    this.sound = new Sound();

    this.level = LEVELS[store.get('sb:level')] ? store.get('sb:level') : 'normal';
    this.mode = 'menu';
    this.aim = { ...DEFAULT_AIM, weapon: 'standard' };
    this.banners = [];
    this.banner = null;
    this.cpu = null;
    this.drag = null;
    this.flash = [0, 0];
    this.cam = 0;
    this.marker = null;
    this.timers = {};
    this.visible = true;
    this.last = performance.now();
    this.holdStart = 0;
    this.hinted = false;
    this.result = null;
    this.record = null;
    this.turnAt = 0;

    this.buildWindGauge();
    this.bind();
    this.syncTools();
    this.renderMenu();
    this.observe();
    this.startDemo();
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------------ setup

  buildWindGauge() {
    const g = this.el.windGauge;
    g.textContent = '';
    this.windCells = [];
    for (let i = 0; i < 20; i++) {
      const c = document.createElement('i');
      if (i === 10) g.append(Object.assign(document.createElement('b'), { className: 'sb-wind__mid' }));
      g.append(c);
      this.windCells.push(c);
    }
  }

  observe() {
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.el.screen);
    this.resize();
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        for (const e of entries) this.visible = e.isIntersecting;
      }).observe(this.root);
    }
    document.addEventListener('visibilitychange', () => {
      this.last = performance.now();
    });
  }

  resize() {
    const r = this.el.screen.getBoundingClientRect();
    if (r.width < 2) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.renderer.resize(r.width, (r.width * H) / W, dpr);
    this.renderer.terrainDirty = true;
    if (this.game?.terr) this.drawNow();
  }

  bind() {
    const { el } = this;
    const go = () => {
      this.sound.unlock();
      this.startMatch(this.level);
    };
    el.start.addEventListener('click', go);
    el.ctaGo.addEventListener('click', go);
    el.ctaPick.addEventListener('click', () => {
      el.menu.scrollIntoView({ block: 'nearest', behavior: this.reduced ? 'auto' : 'smooth' });
      el.levels.find((b) => b.dataset.level === this.level)?.focus({ preventScroll: true });
    });
    for (const b of el.levels) b.addEventListener('click', () => this.pickLevel(b.dataset.level));
    this.radioGroup(el.levels, (b) => this.pickLevel(b.dataset.level));

    for (const b of el.arms) b.addEventListener('click', () => this.pickWeapon(b.dataset.weapon, true));
    this.radioGroup(el.arms, (b) => this.pickWeapon(b.dataset.weapon, true));

    // A click on a weapon or a tool must not pull keyboard focus off the battlefield, or Space and
    // the arrow keys would go to that button (and cycle weapons) instead of aiming and firing.
    for (const b of this.root.querySelectorAll('.sb-arm, .sb-tool')) {
      b.addEventListener('pointerdown', (e) => {
        if (e.button === 0) e.preventDefault();
      });
    }

    el.fire.addEventListener('click', () => this.press());

    el.angle.addEventListener('input', () => this.setAim(+el.angle.value, this.aim.power, 'angle'));
    el.power.addEventListener('input', () => this.setAim(this.aim.angle, +el.power.value, 'power'));
    // Same for the sliders: after a mouse drag, hand the keys back to the battlefield. Keyboard
    // users who tab onto a slider keep its native arrow keys.
    for (const r of [el.angle, el.power]) {
      r.addEventListener('pointerdown', (e) => {
        this.rangeByPointer = e.pointerType !== 'touch';
      });
    }
    window.addEventListener('pointerup', () => {
      if (!this.rangeByPointer) return;
      this.rangeByPointer = false;
      if (document.activeElement === el.angle || document.activeElement === el.power) el.canvas.focus({ preventScroll: true });
    });

    for (const b of this.root.querySelectorAll('.sb-nudge')) {
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        this.sound.unlock();
        this.startNudge(b, e.shiftKey);
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => this.stopNudge());
      b.addEventListener('click', (e) => {
        if (e.detail === 0) this.nudge(b, e.shiftKey ? 0.1 : 1); // keyboard activation
      });
    }

    el.tools.sound.addEventListener('click', () => {
      this.sound.unlock();
      this.sound.setMuted(!this.sound.muted);
      this.syncTools();
    });
    el.tools.shake.addEventListener('click', () => {
      this.fx.shakeOn = !this.fx.shakeOn;
      store.set('sb:shake', this.fx.shakeOn ? '1' : '0');
      if (this.fx.shakeOn) this.fx.shake(4);
      this.syncTools();
    });
    el.tools.quit.addEventListener('click', () => this.quit());

    this.root.querySelector('.sb-again').addEventListener('click', () => this.startMatch(this.level));
    el.post.addEventListener('submit', (e) => this.onPost(e));

    const c = el.canvas;
    c.addEventListener('click', () => {
      if (this.mode === 'menu') {
        this.sound.unlock();
        this.startMatch(this.level);
      }
    });
    c.addEventListener('pointerdown', (e) => this.pointerDown(e));
    c.addEventListener('pointermove', (e) => this.pointerMove(e));
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) c.addEventListener(ev, (e) => this.pointerUp(e));

    document.addEventListener('keydown', (e) => this.keyDown(e));

    // Turning a phone sideways mid-match swaps to the side-by-side layout; bring the battlefield
    // and the Fire button back into view.
    const sideways = window.matchMedia?.('(orientation: landscape) and (max-height: 520px)');
    sideways?.addEventListener?.('change', () => {
      if (this.mode !== 'menu') requestAnimationFrame(() => this.reveal(true));
    });

    // Leaving in the middle of a match you have already played into counts as a loss, so a
    // losing match can't be dodged to protect a streak.
    window.addEventListener('pagehide', () => {
      if (this.forfeit()) this.leftMatch = true;
    });
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && this.leftMatch) {
        this.leftMatch = false;
        this.showMenu(false);
      }
    });
  }

  radioGroup(items, choose) {
    for (const b of items) {
      b.addEventListener('keydown', (e) => {
        const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!dir) return;
        e.preventDefault();
        const live = items.filter((x) => !x.disabled);
        const i = live.indexOf(b);
        const next = live[(i + dir + live.length) % live.length];
        next.focus();
        choose(next);
      });
    }
  }

  // ------------------------------------------------------------------ modes

  setMode(mode) {
    this.mode = mode;
    this.root.dataset.state = mode;
    this.el.menu.hidden = mode !== 'menu';
    this.el.console.hidden = mode !== 'match';
    this.el.result.hidden = mode !== 'result';
  }

  startDemo() {
    this.setMode('menu');
    this.demo = true;
    this.game = new Game({ level: 'normal', seed: randomSeed() });
    const rng = mulberry32(randomSeed());
    this.demoBrains = [new Brain('normal', rng), new Brain('easy', rng)];
    this.resetMatchState();
    this.game.startRound();
    this.root.classList.add('is-demo');
  }

  resetMatchState() {
    this.cpu = null;
    this.drag = null;
    this.banners = [];
    this.banner = null;
    this.hideBanner(true);
    this.marker = null;
    this.flash = [0, 0];
    this.timers = {};
    this.fx.clear();
    this.sound.stopWhistle();
  }

  startMatch(level) {
    this.level = LEVELS[level] ? level : 'normal';
    store.set('sb:level', this.level);
    this.demo = false;
    this.root.classList.remove('is-demo');
    this.game = new Game({ level: this.level, seed: randomSeed() });
    this.brain = new Brain(this.level, mulberry32(randomSeed()));
    this.result = null;
    this.record = null;
    this.matchStart = performance.now();
    this.matchMs = 0;
    this.resetMatchState();
    this.setMode('match');
    this.el.plates[1].querySelector('.sb-plate__lvl').textContent = LEVELS[this.level].label;
    this.game.startRound();
    // Set up the round now rather than on the next frame: a shot fired before then would time
    // its turn from the last turn of the previous match.
    this.drainNow(performance.now());
    this.reveal();
    this.el.canvas.focus({ preventScroll: true });
  }

  quit() {
    const b = this.el.tools.quit;
    if (!b.classList.contains('is-armed')) {
      b.classList.add('is-armed');
      b.querySelector('span').textContent = this.wouldForfeit() ? 'Tap again to forfeit' : 'Tap again to quit';
      clearTimeout(this.quitTimer);
      this.quitTimer = setTimeout(() => this.disarmQuit(), 3000);
      return;
    }
    this.disarmQuit();
    this.forfeit();
    this.showMenu(true);
  }

  // Once you have fired, or the CPU has taken a round, walking away is a loss.
  wouldForfeit() {
    const g = this.game;
    return this.mode === 'match' && !this.demo && !this.result && Boolean(g) && (g.shots[0] > 0 || g.score[1] > 0);
  }

  forfeit() {
    if (!this.wouldForfeit()) return false;
    this.result = recordMatch(this.level, false, this.game.shots[0]);
    return true;
  }

  disarmQuit() {
    const b = this.el.tools.quit;
    b.classList.remove('is-armed');
    b.querySelector('span').textContent = 'Quit match';
  }

  showMenu(focus) {
    this.renderMenu();
    this.el.plates[1].querySelector('.sb-plate__lvl').textContent = '';
    this.startDemo();
    if (focus) this.el.levels.find((b) => b.dataset.level === this.level)?.focus({ preventScroll: true });
  }

  reveal(instant) {
    const r = this.root.getBoundingClientRect();
    if (r.top >= 0 && r.bottom <= window.innerHeight) return;
    const fits = r.height <= window.innerHeight;
    this.root.scrollIntoView({ block: fits ? 'center' : 'start', behavior: instant || this.reduced ? 'auto' : 'smooth' });
  }

  pickLevel(level) {
    if (!LEVELS[level]) return;
    this.level = level;
    store.set('sb:level', level);
    for (const b of this.el.levels) {
      const on = b.dataset.level === level;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    this.el.ctaLvl.textContent = LEVELS[level].label;
  }

  renderMenu() {
    const s = loadStats();
    this.pickLevel(this.level);
    for (const id of LEVEL_IDS) {
      const r = s[id];
      const el = this.root.querySelector(`[data-rec="${id}"]`);
      el.textContent = r.w + r.l ? `${r.w}–${r.l}` : '';
      el.setAttribute('aria-label', r.w + r.l ? `Your record: ${r.w} wins, ${r.l} losses` : '');
    }
    const bits = [];
    const top = loadBest();
    if (top) bits.push(`Most points ${fmt(top.score)} on ${LEVELS[top.level].label}`);
    if (s.best) bits.push(`Best win streak ${s.best}`);
    const fast = LEVEL_IDS.filter((id) => s[id].fast).map((id) => ({ id, n: s[id].fast }));
    if (fast.length) {
      const hardest = fast.reduce((a, b) => (LEVEL_IDS.indexOf(b.id) > LEVEL_IDS.indexOf(a.id) ? b : a));
      bits.push(`Fastest win on ${LEVELS[hardest.id].label}: ${hardest.n} shots`);
    }
    this.el.menuStats.textContent = bits.length ? bits.join(' · ') : 'Best of three rounds. You shoot first.';
    this.loadBoard('menu');
  }

  // ------------------------------------------------------------------ aiming

  canAim() {
    const g = this.game;
    return this.mode === 'match' && g && g.tanks[0].alive && (g.phase === 'aim' || g.phase === 'flight' || g.phase === 'settle');
  }

  canFire() {
    const g = this.game;
    return this.mode === 'match' && g && g.phase === 'aim' && g.turn === 0 && g.tanks[0].alive;
  }

  setAim(angle, power, source) {
    const a = round1(clamp(angle, 0, 180));
    const p = round1(clamp(power, 0, 100));
    this.aim.angle = a;
    this.aim.power = p;
    if (this.game && !this.demo) {
      const t = this.game.tanks[0];
      t.angle = a;
      t.shown = a;
      t.power = p;
    }
    if (source !== 'angle') this.el.angle.value = a;
    if (source !== 'power') this.el.power.value = p;
    setLed(this.el.angleOut, a, '°');
    setLed(this.el.powerOut, p);
    this.el.angle.setAttribute('aria-valuetext', `${a} degrees`);
  }

  nudge(btn, step) {
    if (!this.canAim()) return;
    const dir = +btn.dataset.dir;
    if (btn.dataset.dial === 'angle') this.setAim(this.aim.angle + dir * step, this.aim.power);
    else this.setAim(this.aim.angle, this.aim.power + dir * step);
  }

  startNudge(btn, fine) {
    this.stopNudge();
    this.nudge(btn, fine ? 0.1 : 1);
    let n = 0;
    const rep = () => {
      n++;
      this.nudge(btn, fine ? 0.1 : n > 24 ? 3 : 1);
      this.nudgeTimer = setTimeout(rep, 55);
    };
    this.nudgeTimer = setTimeout(rep, 380);
  }

  stopNudge() {
    clearTimeout(this.nudgeTimer);
  }

  pickWeapon(id, sound) {
    const g = this.game;
    if (!WEAPONS[id]) return;
    if (g && !this.demo && !(g.ammo[0][id] > 0)) return;
    if (sound && id !== this.aim.weapon) this.sound.click();
    this.aim.weapon = id;
    this.syncArsenal();
  }

  syncArsenal() {
    const g = this.game;
    for (const b of this.el.arms) {
      const id = b.dataset.weapon;
      const left = g && !this.demo ? g.ammo[0][id] : WEAPONS[id].ammo;
      const on = id === this.aim.weapon;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      b.disabled = !(left > 0);
      const ammo = b.querySelector('.sb-arm__ammo');
      ammo.textContent = Number.isFinite(left) ? String(left) : '∞';
      if (Number.isFinite(left)) ammo.setAttribute('aria-label', `${left} left`);
    }
  }

  // The Fire button doubles as "Next round" while a round result is up.
  press() {
    if (this.mode === 'match' && this.game?.phase === 'round-over') {
      this.timers.next = 0;
      return;
    }
    this.fire();
  }

  fire() {
    if (!this.canFire()) return;
    this.sound.unlock();
    const g = this.game;
    if (!(g.ammo[0][this.aim.weapon] > 0)) this.aim.weapon = 'standard';
    g.fire(this.aim.angle, this.aim.power, this.aim.weapon, performance.now() - this.turnAt);
    if (!(g.ammo[0][this.aim.weapon] > 0)) this.aim.weapon = 'standard';
    this.syncArsenal();
    this.syncControls();
  }

  toWorld(e) {
    const r = this.el.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  }

  pointerDown(e) {
    if (this.game?.phase === 'round-over' && this.mode === 'match') {
      this.timers.next = 0; // tap to skip the round result
      return;
    }
    if (!this.canAim() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const p = this.toWorld(e);
    const t = this.game.tanks[0];
    const px = t.x;
    const py = t.y - PIVOT_Y;
    const near = Math.hypot(p.x - px, p.y - py) < Math.max(60, this.renderer.css(44));
    this.drag = { id: e.pointerId, ax: near ? px : p.x, ay: near ? py : p.y, px: p.x, py: p.y, live: false };
    try {
      this.el.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    this.sound.unlock();
    this.dropTurnBanners(); // it sits right where people aim
    e.preventDefault();
    if (near) this.pointerMove(e);
  }

  pointerMove(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const p = this.toWorld(e);
    d.px = p.x;
    d.py = p.y;
    // Slingshot: the shot goes the opposite way from the pull.
    const vx = d.ax - p.x;
    const vy = p.y - d.ay;
    const lenCss = Math.hypot(vx, vy) * this.renderer.cssK;
    if (!d.live && lenCss < 10) return;
    d.live = true;
    let ang = (Math.atan2(vy, vx) * 180) / Math.PI;
    if (ang < 0) ang = ang < -90 ? 180 : 0;
    const full = clamp(this.renderer.cssK * W * 0.32, 110, 260);
    this.setAim(ang, (lenCss / full) * 100);
  }

  pointerUp(e) {
    if (this.drag && e.pointerId === this.drag.id) this.drag = null;
  }

  keyScope() {
    const r = this.root.getBoundingClientRect();
    const shown = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    if (shown < Math.min(r.height, window.innerHeight) * 0.45) return false;
    const a = document.activeElement;
    return !a || a === document.body || this.root.contains(a);
  }

  keyDown(e) {
    if (this.mode !== 'match' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest('input:not([type=range]), textarea, select, [contenteditable]')) return;
    if (!this.keyScope()) return;
    const onRange = t?.matches('input[type=range]');
    const onButton = t?.closest('button, a, summary');
    const g = this.game;

    if (e.key === ' ' || e.key === 'Enter') {
      // On the weapon you already have, Space and Enter fire it.
      const arm = t?.closest('.sb-arm');
      if (onButton && !(arm && arm.getAttribute('aria-checked') === 'true')) return;
      e.preventDefault();
      if (g.phase === 'round-over') this.timers.next = 0;
      else this.fire();
      return;
    }
    if (/^[1-4]$/.test(e.key)) {
      e.preventDefault();
      this.pickWeapon(WEAPON_ORDER[+e.key - 1], true);
      return;
    }
    const dirs = { ArrowLeft: ['angle', 1], ArrowRight: ['angle', -1], ArrowUp: ['power', 1], ArrowDown: ['power', -1] };
    const m = dirs[e.key];
    if (!m || onRange || t?.closest('[role=radiogroup]')) return;
    e.preventDefault();
    if (!this.canAim()) return;
    if (!e.repeat) this.holdStart = performance.now();
    const held = performance.now() - this.holdStart;
    const step = e.shiftKey ? 0.1 : held > 1400 ? 3 : held > 500 ? 2 : 1;
    if (m[0] === 'angle') this.setAim(this.aim.angle + m[1] * step, this.aim.power);
    else this.setAim(this.aim.angle, this.aim.power + m[1] * step);
  }

  // ------------------------------------------------------------------ CPU

  startCpu(side) {
    const g = this.game;
    const brain = this.demo ? this.demoBrains[side] : this.brain;
    const t = g.tanks[side];
    this.cpu = {
      side,
      brain,
      gen: brain.plan(g.world, side, 1 - side, g.ammo[side]),
      plan: null,
      t0: null,
      think: brain.thinkTime() * (this.demo ? 1.3 : 1),
      from: t.shown ?? t.angle,
      fromPower: t.power,
    };
  }

  runCpu(now) {
    const c = this.cpu;
    const g = this.game;
    if (!c || g.phase !== 'aim' || g.turn !== c.side) return;
    if (!c.plan) {
      const t0 = performance.now();
      while (performance.now() - t0 < CPU_SLICE_MS) {
        const r = c.gen.next();
        if (r.done) {
          c.plan = r.value;
          break;
        }
      }
      return;
    }
    if (c.t0 == null) c.t0 = now;
    const el = now - c.t0;
    const t = g.tanks[c.side];
    const s = ease(clamp((el - (c.think - 750)) / 700, 0, 1));
    t.shown = c.from + (c.plan.angle - c.from) * s;
    t.power = c.fromPower + (c.plan.power - c.fromPower) * s;
    if (el < c.think || this.banner?.hold) return; // let a round title clear before shooting
    t.shown = c.plan.angle;
    this.cpu = null;
    g.fire(c.plan.angle, c.plan.power, c.plan.weapon, now - this.turnAt);
  }

  // ------------------------------------------------------------------ events

  onEvent(e, now) {
    this.handle(e, now);
    this.syncControls();
  }

  drainNow(now) {
    const g = this.game;
    for (const e of g.drain()) this.onEvent(e, now);
    // The terrain only needs painting again when it changed, including on the step where the
    // last falling dirt lands.
    if (g.terrainChanged) {
      g.terrainChanged = false;
      this.renderer.terrainDirty = true;
    }
  }

  handle(e, now) {
    const g = this.game;
    const sfx = !this.demo;
    switch (e.type) {
      case 'round': {
        this.renderer.resetRound();
        this.renderer.setCity(e.seed, g.world.h);
        this.fx.clear();
        this.marker = null;
        this.cpu = null;
        if (!this.demo) {
          this.aim.weapon = 'standard';
          this.setAim(DEFAULT_AIM.angle, DEFAULT_AIM.power);
          this.brain.reset();
        } else {
          this.demoBrains.forEach((b) => b.reset());
        }
        g.tanks.forEach((t) => (t.shown = t.angle));
        this.syncArsenal();
        this.syncHud();
        if (!this.demo) {
          const sub = e.round === 1 ? `${e.place}. Stand clear of the closing doors.` : e.round === 3 ? `${e.place}. Last stop, this is it.` : `Next stop: ${e.place}`;
          this.queueBanner(`Round ${e.round}`, sub, ROUND_BANNER_MS, { hold: true });
          this.say(`Round ${e.round}, ${e.place}.`);
          this.sound.chime();
        }
        break;
      }
      case 'turn': {
        this.turnAt = now; // how long each turn takes goes into the match log
        this.syncWind(e.wind);
        this.syncHud();
        // With reduced motion the demo behind the menu stays a still picture.
        if ((this.demo && !this.reduced) || (!this.demo && e.turn === 1)) this.startCpu(e.turn);
        if (!this.demo) {
          let hint = '';
          if (e.turn === 0 && !this.hinted) {
            this.hinted = true;
            hint = window.matchMedia?.('(pointer: coarse)').matches ? 'Drag back from your tank to aim, then tap Fire.' : 'Arrow keys aim, Space fires. Or drag back from your tank.';
          }
          this.queueBanner(e.turn === 0 ? 'Your turn' : 'CPU’s turn', hint, hint ? 2800 : TURN_BANNER_MS, { tone: e.turn === 0 ? 'you' : 'cpu', kind: 'turn' });
          if (e.turn === 0) this.say(`Your turn. ${this.windWords(e.wind)}.`);
        }
        break;
      }
      case 'fire': {
        const w = WEAPONS[e.weapon];
        this.dropTurnBanners(); // stale once someone has fired
        this.fx.muzzle(e.x, e.y, e.angle, e.weapon === 'heavy');
        if (sfx) {
          this.sound.fire(e.weapon === 'heavy');
          this.sound.startWhistle();
          if (e.tank === 1) this.say(`CPU fired ${w.id === 'standard' ? 'a shell' : `the ${w.name}`}.`);
        }
        break;
      }
      case 'split':
        this.fx.split(e.x, e.y);
        if (sfx) this.sound.pop();
        break;
      case 'explode': {
        const w = WEAPONS[e.weapon];
        this.fx.explode(e.x, e.y, w.radius, { dirt: w.dirt });
        if (!w.dirt) this.renderer.addScorch(e.x, e.y, w.radius);
        this.renderer.terrainDirty = true;
        if (sfx) {
          if (!e.child || !g.projectiles.length) this.sound.stopWhistle();
          if (w.dirt) this.sound.thud(1.2);
          else this.sound.boom(w.radius);
        }
        break;
      }
      case 'damage': {
        const t = g.tanks[e.tank];
        this.fx.number(t.x, t.y - 44, `−${e.amount}`, e.tank === 0 ? '#C9F2B4' : '#FFC9A8');
        this.flash[e.tank] = 0.22;
        this.syncHud();
        if (sfx && e.cause !== 'fall') {
          if (e.tank === 1 && e.by === 0) this.say(`You hit the CPU for ${e.amount}.`);
          else if (e.tank === 0 && e.by === 1) this.say(`The CPU hit you for ${e.amount}.`);
        }
        break;
      }
      case 'destroyed':
        this.fx.burst(e.x, e.y - 8);
        if (sfx) this.sound.boom(60);
        break;
      case 'land':
        if (e.dist > 6) {
          this.fx.dust(e.x, e.y, Math.min(2, e.dist / 40));
          if (sfx) this.sound.thud(Math.min(1, e.dist / 60));
        }
        break;
      case 'impact': {
        const brain = this.demo ? this.demoBrains[e.owner] : e.owner === 1 ? this.brain : null;
        brain?.observe(e);
        if (e.owner === 0 && !this.demo) {
          const text = this.spot(e);
          const y = clamp(Math.min(e.y, groundAt(g.world.h, e.x)), 14, H - 6);
          this.marker = { x: clamp(e.x, 8, W - 8), y, text, side: 0 };
          this.say(`Your shell: ${text}.`);
        }
        break;
      }
      case 'round-over': {
        this.syncHud();
        if (this.demo) {
          this.timers.next = now + 2200;
          break;
        }
        const you = e.winner === 0;
        const score = `${e.score[0]}–${e.score[1]}`;
        if (e.final) {
          this.queueBanner(you ? 'You win the match' : 'The CPU takes it', score, 60000, { tone: you ? 'you' : 'cpu', sticky: true });
        } else {
          this.queueBanner(you ? 'Round to you' : 'Round to the CPU', score, ROUND_OVER_MS - 200, { tone: you ? 'you' : 'cpu', sticky: true });
          this.timers.next = now + ROUND_OVER_MS;
        }
        this.say(`${you ? 'You win' : 'The CPU wins'} round ${g.round}. ${score}.`);
        if (you) this.sound.win();
        else this.sound.lose();
        break;
      }
      case 'match-over':
        if (this.demo) {
          this.timers.restart = now + 2600;
          break;
        }
        // Record it now; the result panel only waits so the last blast can be seen.
        this.result ||= recordMatch(this.level, e.winner === 0, e.shots[0]);
        this.matchMs = Math.round(now - this.matchStart);
        this.timers.result = now + 1500;
        break;
      default:
    }
  }

  spot(e) {
    if (e.direct) return 'direct hit';
    if (e.hit === 'wall') return 'hit the wall';
    const g = this.game;
    const dir = Math.sign(g.tanks[1].x - g.tanks[0].x) || 1;
    const along = e.dx * dir;
    const m = Math.round(Math.abs(e.dx) * UNIT_M);
    if (m <= 3) return 'on target';
    return `${m} m ${along < 0 ? 'short' : 'long'}`;
  }

  windWords(w) {
    if (!w) return 'No wind';
    return `Wind ${Math.abs(w)} to the ${w < 0 ? 'left' : 'right'}`;
  }

  say(text) {
    this.el.live.textContent = text;
  }

  // ------------------------------------------------------------------ HUD

  syncHud() {
    const g = this.game;
    if (!g?.tanks) return;
    g.tanks.forEach((t, i) => {
      const plate = this.el.plates[i];
      const hp = Math.max(0, Math.round(t.hp));
      plate.querySelectorAll('.sb-plate__num').forEach((n) => (n.textContent = String(hp)));
      plate.querySelector('.sb-hp__fill').style.setProperty('--hp', `${hp}%`);
      plate.querySelector('.sb-hp').setAttribute('aria-valuenow', String(hp));
      plate.classList.toggle('is-low', hp > 0 && hp <= 30);
      plate.classList.toggle('is-out', hp <= 0);
      plate.classList.toggle('is-turn', g.phase !== 'round-over' && g.phase !== 'match-over' && g.turn === i);
      plate.querySelectorAll('.sb-pips i').forEach((p, k) => p.classList.toggle('is-on', g.score[i] > k));
    });
    this.el.whereRound.textContent = this.demo ? 'Demo' : `Round ${g.round}`;
    this.el.wherePlace.textContent = g.place;
  }

  syncWind(w) {
    const n = Math.abs(w);
    this.windCells.forEach((c, i) => {
      const on = w < 0 ? i < 10 && i >= 10 - n : w > 0 ? i >= 10 && i < 10 + n : false;
      c.classList.toggle('is-on', on);
    });
    this.el.windVal.textContent = String(n);
    this.el.wind.dataset.dir = w < 0 ? 'left' : w > 0 ? 'right' : 'calm';
    this.el.wind.setAttribute('aria-label', this.windWords(w));
  }

  syncControls() {
    const g = this.game;
    const mine = this.canFire();
    const next = this.mode === 'match' && g?.phase === 'round-over';
    this.el.fire.disabled = !mine && !next;
    this.el.fire.classList.toggle('is-next', next);
    let label = 'Fire';
    if (next) label = 'Next round';
    else if (!mine && g && this.mode === 'match') {
      if (g.phase === 'aim' && g.turn === 1) label = 'CPU aiming';
      else if (g.phase === 'flight' || g.phase === 'settle') label = g.turn === 0 ? 'Shell away' : 'Incoming';
      else if (g.phase === 'match-over') label = 'Match over';
      else label = 'Wait';
    }
    this.el.fireLabel.textContent = label;
    this.root.classList.toggle('is-your-turn', mine);
  }

  syncTools() {
    const { sound, shake } = this.el.tools;
    sound.setAttribute('aria-pressed', String(!this.sound.muted));
    sound.querySelector('span').textContent = this.sound.muted ? 'Sound off' : 'Sound on';
    shake.setAttribute('aria-pressed', String(this.fx.shakeOn));
    shake.querySelector('span').textContent = this.fx.shakeOn ? 'Shake on' : 'Shake off';
  }

  queueBanner(main, sub, ms, { tone = '', sticky = false, hold = false, kind = '' } = {}) {
    if (sticky) this.banners = [];
    this.banners.push({ main, sub, ms, tone, hold, kind });
    if (sticky || !this.banner) this.nextBanner(performance.now(), sticky);
  }

  dropTurnBanners() {
    this.banners = this.banners.filter((b) => b.kind !== 'turn');
    if (this.banner?.kind === 'turn') {
      this.banner = null;
      this.nextBanner(performance.now());
    }
  }

  nextBanner(now, force) {
    if (this.banner && !force) return;
    const b = this.banners.shift();
    if (!b) {
      this.hideBanner();
      return;
    }
    this.banner = { ...b, until: now + b.ms };
    const el = this.el.banner;
    this.el.bannerMain.textContent = b.main;
    this.el.bannerSub.textContent = b.sub;
    this.el.bannerSub.hidden = !b.sub;
    el.dataset.tone = b.tone;
    el.classList.remove('is-on');
    void el.offsetWidth; // restart the entrance animation
    el.classList.add('is-on');
  }

  hideBanner(clearQueue) {
    this.banner = null;
    this.el.banner.classList.remove('is-on');
    if (clearQueue) this.banners = [];
  }

  // ------------------------------------------------------------------ result

  showResult() {
    const g = this.game;
    const won = g.matchWinner === 0;
    const shots = g.shots[0];
    const lvl = LEVELS[this.level].label;
    const { stats, newFast, newBest } = this.result || recordMatch(this.level, won, shots);
    const mine = stats[this.level];
    this.hideBanner(true); // the result title says the same thing
    this.setMode('result');
    this.el.dock.scrollTop = 0;
    const r = this.el.result;
    r.dataset.won = String(won);
    r.querySelector('.sb-result__kicker').textContent = `Match over · ${lvl}`;
    r.querySelector('.sb-result__title').textContent = won ? 'You flattened the CPU' : 'Flattened by the CPU';
    r.querySelector('.sb-result__line').innerHTML = `<span class="sb-score">${g.score[0]}–${g.score[1]}</span> <span>${won ? `in ${shots} shot${shots === 1 ? '' : 's'}` : `You fired ${shots} shot${shots === 1 ? '' : 's'}`}</span>`;

    const items = [
      [`Record vs ${lvl}`, `${mine.w}–${mine.l}`, false],
      ['Win streak', `${stats.streak}${stats.best > stats.streak ? ` (best ${stats.best})` : ''}`, won && newBest],
      [`Fastest win on ${lvl}`, mine.fast ? `${mine.fast} shots` : '—', won && newFast],
    ];
    const ul = r.querySelector('.sb-result__stats');
    ul.textContent = '';
    for (const [k, v, isNew] of items) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="sb-stat__k"></span><span class="sb-stat__v"></span>`;
      li.firstChild.textContent = k;
      li.lastChild.textContent = v;
      if (isNew) li.lastChild.insertAdjacentHTML('beforeend', ' <em class="sb-new">New</em>');
      ul.append(li);
    }
    const rec = this.showRecord(won);
    const again = r.querySelector('.sb-again');
    again.textContent = won && this.level !== 'hard' ? 'Play again' : 'Rematch';
    const change = r.querySelector('.sb-change');
    change.textContent = won && this.level !== 'hard' ? `Next: ${LEVELS[LEVEL_IDS[LEVEL_IDS.indexOf(this.level) + 1]].label}` : 'Change difficulty';
    change.onclick = won && this.level !== 'hard' ? () => this.startMatch(LEVEL_IDS[LEVEL_IDS.indexOf(this.level) + 1]) : () => this.showMenu(true);

    const pts = rec?.score;
    const text = won
      ? `I flattened the CPU on ${lvl} in ${shots} shots${pts ? ` for ${fmt(pts)} points` : ''} in Scorched Borough.`
      : `The CPU flattened me on ${lvl} in Scorched Borough. Think you can do better?`;
    const url = this.root.dataset.shareUrl || location.href.split('#')[0];
    mountShareBar(r.querySelector('.sb-result__share'), {
      url,
      text,
      title: 'Scorched Borough',
      image: () => this.card(won, lvl, shots, pts),
      imageName: 'scorched-borough.png',
    });
    this.say(`${won ? 'You won' : 'You lost'} the match ${g.score[0]} to ${g.score[1]}.`);
    const title = r.querySelector('.sb-result__title');
    title.focus({ preventScroll: true });
    // Show the whole block if it fits; otherwise make sure the panel itself is in view.
    const behavior = this.reduced ? 'auto' : 'smooth';
    const box = this.root.getBoundingClientRect();
    const rr = r.getBoundingClientRect();
    if (box.height <= window.innerHeight) {
      if (box.top < 0 || box.bottom > window.innerHeight) this.root.scrollIntoView({ block: 'nearest', behavior });
    } else if (rr.top < 0 || rr.bottom > window.innerHeight) {
      r.scrollIntoView({ block: 'nearest', behavior });
    }
  }

  // ------------------------------------------------------------------ records

  // The log the records board replays: the seed and every shot either tank fired.
  matchLog() {
    const g = this.game;
    return {
      v: VERSION,
      level: g.level,
      seed: g.seed,
      durationMs: this.matchMs,
      rounds: g.history.map((r) => ({ first: r.first === 0 ? 'you' : 'cpu', shots: r.shots.map((s) => s.slice()) })),
    };
  }

  // Scores a won match with the same replay the board runs, so the points shown are the points
  // the board will give, then sets up the post form.
  showRecord(won) {
    const { points, pointsNum, pointsHow, pointsNew, post, name, postBtn, postMsg } = this.el;
    this.record = null;
    this.posted = false;
    post.classList.remove('is-done');
    let refused = '';
    if (won) {
      const log = this.matchLog();
      let check;
      try {
        check = validateSubmission({ log });
      } catch {
        check = { ok: false, error: 'replay' };
      }
      if (check.ok) this.record = { score: check.score, detail: check.detail, log };
      else {
        refused = check.error;
        console.warn('Scorched Borough: this match does not replay', check.error);
      }
    }
    const rec = this.record;
    points.hidden = !rec;
    post.hidden = !rec;
    if (rec) {
      const best = loadBest();
      pointsNew.hidden = !(best && rec.score > best.score);
      if (!best || rec.score > best.score) store.set(BEST_KEY, JSON.stringify({ score: rec.score, ...rec.detail }));
      pointsNum.textContent = fmt(rec.score);
      pointsHow.textContent = this.pointsText(rec.detail);
      name.disabled = false;
      postBtn.disabled = false;
      name.value = getPlayerName() || '';
    }
    let msg = '';
    if (!won) msg = 'Win a match to post a record.';
    // The board refuses any match where the CPU's own shot hurt it. The CPU checks its aim so
    // that it never does, but if it ever slips, say why.
    else if (refused === 'cpu self-hit') msg = 'The CPU hit itself this match, so it can’t go on the records board.';
    else if (!rec) msg = 'This match can’t go on the records board.';
    postMsg.textContent = msg;
    this.loadBoard('result');
    return rec;
  }

  pointsText({ level, rounds, shots }) {
    const raw = WIN_POINTS - SHOT_COST * shots;
    let text = `${fmt(WIN_POINTS)} for the win − ${fmt(SHOT_COST * shots)} for ${shots} shot${shots === 1 ? '' : 's'}`;
    if (rounds !== '2-0') text += ' in the rounds you won';
    if (raw < MIN_POINTS) text += `, raised to ${MIN_POINTS}`;
    return `${text}, ×${LEVEL_MULTIPLIER[level]} on ${LEVELS[level].label}`;
  }

  async loadBoard(which, fresh = false) {
    const el = this.el.boards[which];
    if (!el) return null;
    if (!el.querySelector('.board')) el.innerHTML = '<p class="sb-records__loading">Loading…</p>';
    try {
      const data = await getTop(GAME_ID, { limit: 10, fresh });
      renderBoard(el, data, {
        formatScore: (e) => fmt(e.score),
        formatMeta: boardMeta,
        labels: { title: 'This month', empty: 'No records yet this month. Win a match to set one.', unavailable: 'The board is out of service right now.' },
      });
      return data;
    } catch {
      el.innerHTML = '<p class="sb-records__loading">The board is out of service right now.</p>';
      return null;
    }
  }

  async onPost(e) {
    e.preventDefault();
    const rec = this.record;
    if (this.posted || !rec) return;
    const { name, postBtn, postMsg, post } = this.el;
    const clean = cleanName(name.value);
    if (!clean) {
      postMsg.textContent = NAME_HINT;
      name.focus();
      return;
    }
    postBtn.disabled = true;
    postMsg.textContent = 'Posting…';
    const res = await submit(GAME_ID, { name: clean, score: rec.score, detail: rec.detail, log: rec.log }, { localScore: rec.score, detail: rec.detail });
    if (this.record !== rec) return; // a new match started while this was in flight
    if (res.ok) {
      this.posted = true;
      post.classList.add('is-done');
      name.disabled = true;
      // The form is gone now; keep keyboard focus where it was instead of dropping it on the page.
      postMsg.focus({ preventScroll: true });
      const month = boardMonth(res.period);
      // A smaller win leaves the nickname's earlier best on the board. This browser may remember
      // it; otherwise the fresh board shows it (if it is slow, the plain message will do).
      const board = this.loadBoard('result', true);
      const data = await Promise.race([board, new Promise((done) => setTimeout(done, 2000, null))]);
      if (this.record !== rec) return;
      const same = (e) => e.me && (e.rank === res.rank || e.name.toLowerCase() === clean.toLowerCase());
      const kept = Math.max(data?.entries.find(same)?.score || 0, postedBefore(res.period, clean));
      rememberPosted(res.period, clean, Math.max(kept, rec.score));
      if (kept > rec.score) {
        postMsg.textContent = `Your ${fmt(kept)} from earlier ${month ? `in ${month}` : 'this month'} still stands${res.rank ? `, #${res.rank} on the board` : ''}.`;
      } else {
        postMsg.textContent = res.rank ? `Posted. You’re #${res.rank} ${month ? `for ${month}` : 'this month'}.` : 'Posted.';
      }
      return;
    }
    const status = res.status || 0;
    postBtn.disabled = false;
    if (res.error === 'name') {
      postMsg.textContent = NAME_HINT;
    } else if (res.error === 'too_many_names') {
      postMsg.textContent = 'This network has posted under enough nicknames this month. Try one you used before.';
    } else if (status === 429) {
      postMsg.textContent = 'Too many posts from this network just now. Try again in up to 10 minutes.';
    } else if (res.error === 'duplicate') {
      postBtn.disabled = true;
      postMsg.textContent = 'This match is already on the board.';
    } else if (res.error === 'version') {
      postBtn.disabled = true;
      postMsg.textContent = 'The board is running a newer version of the game. Reload the page and your next win will post.';
    } else if (status >= 400 && status < 500) {
      // The board replayed this match and said no. Posting it again would get the same answer.
      postBtn.disabled = true;
      console.warn('Scorched Borough: record not accepted', status, res.error);
      postMsg.textContent = 'This match couldn’t be verified, so it wasn’t posted.';
    } else {
      postMsg.textContent = 'Couldn’t reach the board. Try again in a moment.';
    }
  }

  // A share image: the final battlefield with the result on top.
  card(won, lvl, shots, pts) {
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 630;
    const g = c.getContext('2d');
    const src = this.el.canvas;
    const sh = (src.width * 630) / 1200;
    g.drawImage(src, 0, (src.height - sh) / 2, src.width, sh, 0, 0, 1200, 630);
    const shade = g.createLinearGradient(0, 0, 900, 0);
    shade.addColorStop(0, 'rgba(5,7,18,0.92)');
    shade.addColorStop(0.55, 'rgba(5,7,18,0.6)');
    shade.addColorStop(1, 'rgba(5,7,18,0)');
    g.fillStyle = shade;
    g.fillRect(0, 0, 1200, 630);
    const font = '"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif';
    g.fillStyle = '#6CBE45';
    g.beginPath();
    g.arc(96, 110, 30, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = `700 36px ${font}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('G', 96, 112);
    g.textAlign = 'left';
    g.font = `700 30px ${font}`;
    g.fillText('Scorched Borough', 144, 112);
    g.font = `800 76px ${font}`;
    g.fillText(won ? 'Flattened' : 'Flattened by', 66, 270);
    g.fillText(won ? 'the CPU.' : 'the CPU.', 66, 354);
    g.font = `500 34px ${font}`;
    g.fillStyle = 'rgba(255,255,255,0.86)';
    const tally = `${this.game.score[0]}–${this.game.score[1]}`;
    g.fillText(won ? `${lvl} · ${tally} in ${shots} shots${pts ? ` · ${fmt(pts)} points` : ''}` : `${lvl} · ${tally}`, 68, 430);
    g.fillStyle = '#FFB000';
    g.font = `600 26px ${font}`;
    g.fillText('hoondy.com/apps/scorched-borough', 68, 548);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('no image'))), 'image/png'));
  }

  // ------------------------------------------------------------------ loop

  frame(now) {
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (!this.visible || document.hidden) return;
    this.step(dt, now);
    this.drawNow();
  }

  step(dt, now) {
    const g = this.game;
    if (!g) return;
    this.runCpu(now);
    g.update(dt);
    this.drainNow(now);

    const wind = g.world ? g.world.wind : 0;
    this.renderer.update(dt, wind);
    for (const p of g.projectiles) this.fx.trail(p, dt);
    this.fx.update(dt, wind);
    this.flash = this.flash.map((f) => Math.max(0, f - dt));

    const main = g.projectiles.find((p) => p.center) || g.projectiles[0];
    const target = main ? clamp((main.x - W / 2) * 0.06, -30, 30) : 0;
    this.cam += (target - this.cam) * (1 - Math.exp(-2.5 * dt));
    if (main && !this.demo) this.sound.updateWhistle(main.vy > 0, groundAt(g.world.h, main.x) - main.y);
    else if (!main) this.sound.stopWhistle();

    if (this.banner && now >= this.banner.until) {
      this.banner = null;
      this.nextBanner(now);
    }
    if (this.timers.next != null && g.phase === 'round-over' && now >= this.timers.next) {
      this.timers.next = null;
      this.hideBanner(true);
      g.nextRound();
      this.drainNow(now);
    }
    if (this.timers.result && now >= this.timers.result) {
      this.timers.result = null;
      this.showResult();
    }
    if (this.timers.restart && now >= this.timers.restart && this.demo) {
      this.timers.restart = null;
      this.startDemo();
    }
  }

  scene() {
    const g = this.game;
    const yourAim = !this.demo && this.mode === 'match' && g.tanks[0].alive && g.phase !== 'round-over' && g.phase !== 'match-over';
    const cpuTurn = g.phase === 'aim' && (this.demo || g.turn === 1) && this.cpu?.plan && this.cpu.t0 != null;
    let readout = null;
    if (cpuTurn && !this.demo) {
      const t = g.tanks[g.turn];
      const w = WEAPONS[this.cpu.plan.weapon];
      readout = { text: `${w.short} · ${fmtAngle(t.shown)} · ${Math.round(t.power)}`, x: t.x, y: t.y - 34 - this.renderer.css(36) };
    }
    let drag = null;
    if (this.drag?.live) drag = { ax: this.drag.ax, ay: this.drag.ay, px: this.drag.px, py: this.drag.py };
    return {
      terr: g.terr,
      tanks: g.tanks,
      projectiles: g.projectiles,
      cam: this.cam,
      flash: this.flash,
      marker: this.mode === 'match' ? this.marker : null,
      aim: yourAim ? { tank: 0, angle: this.aim.angle, power: this.aim.power, strong: Boolean(drag) || (g.phase === 'aim' && g.turn === 0) } : null,
      drag,
      readout,
      active: g.phase === 'aim' && !this.demo ? g.turn : -1,
    };
  }

  drawNow() {
    if (!this.game?.terr) return;
    this.renderer.draw(this.scene(), this.fx);
  }
}

const root = document.getElementById('play');
const app = root ? new App(root) : null;
