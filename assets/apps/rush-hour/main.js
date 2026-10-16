import { Game } from './engine.js';
import { Renderer } from './render.js';
import { createAudio } from './audio.js';
import { PACK_INFO } from './words.js';
import { resultCard } from './card.js';
import { COMBO_MAX, COMBO_STEP, STATIONS, comboMultiplier, station } from './rules.js';
import { cleanName, getPlayerName, getTop, renderBoard, submit } from '/assets/js/lib/leaderboard.js';
import { mountShareBar } from '/assets/js/lib/share.js';

const GAME_ID = 'rush-hour';
const PACK_KEY = 'rush-hour:pack';
const BEST_KEY = 'rush-hour:best';
const ENDING_MS = 1300;
const OVER_KEY_GUARD_MS = 500; // a stray Enter right after the ride ends shouldn't start another
const SETTLE_MS = 1000;
const MAX_KEY_LEAD_MS = 5000; // how far a key may run ahead of the last frame (a long stall)

const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage blocked: fine, it's a convenience */
    }
  },
};

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const isField = (el) => el && el.matches && el.matches('input, textarea, select, [contenteditable="true"]');
const isControl = (el) => el && el.matches && el.matches('button, a[href], input, textarea, select, summary, [contenteditable="true"]');

function duration(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function boardMeta(entry) {
  const d = entry.detail || {};
  const parts = [];
  if (Number.isInteger(d.stage) && d.stage > 0) parts.push(station(d.stage).name);
  if (Number.isFinite(d.wpm)) parts.push(`${d.wpm} WPM`);
  return parts.join(' · ');
}

// "October" for a board key like "2026-10". A post made just after midnight on the 1st lands on
// the new month's board, so name the month rather than saying "this month".
function boardMonth(period) {
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.exec(period || '');
  if (!m) return '';
  return new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, m[1] - 1, 15)));
}

class RushHour {
  constructor(root) {
    this.root = root;
    const $ = (sel) => root.querySelector(sel);
    this.el = {
      field: $('[data-rh-field]'),
      canvas: $('[data-rh-canvas]'),
      input: $('[data-rh-input]'),
      station: $('[data-rh-station]'),
      next: $('[data-rh-next]'),
      whereLabel: $('[data-rh-where-label]'),
      stops: $('[data-rh-stops]'),
      rail: $('[data-rh-rail]'),
      car: $('[data-rh-car]'),
      score: $('[data-rh-score]'),
      combo: $('[data-rh-combo]'),
      pips: $('[data-rh-pips]'),
      wpm: $('[data-rh-wpm]'),
      acc: $('[data-rh-acc]'),
      meter: $('[data-rh-meter]'),
      status: $('[data-rh-status]'),
      pause: $('[data-rh-pause]'),
      mute: $('[data-rh-mute]'),
      packs: $('[data-rh-packs]'),
      start: $('[data-rh-start]'),
      pb: $('[data-rh-pb]'),
      hintKeys: $('[data-rh-hint-keys]'),
      hintTouch: $('[data-rh-hint-touch]'),
      live: $('[data-rh-live]'),
      screens: Object.fromEntries([...root.querySelectorAll('[data-rh-screen]')].map((s) => [s.dataset.rhScreen, s])),
      boards: { start: $('[data-rh-board="start"]'), over: $('[data-rh-board="over"]') },
      r: {
        title: $('[data-rh-r-title]'),
        kicker: $('[data-rh-r-kicker]'),
        station: $('[data-rh-r-station]'),
        score: $('[data-rh-r-score]'),
        best: $('[data-rh-r-best]'),
        wpm: $('[data-rh-r-wpm]'),
        acc: $('[data-rh-r-acc]'),
        words: $('[data-rh-r-words]'),
        misses: $('[data-rh-r-misses]'),
        streak: $('[data-rh-r-streak]'),
        time: $('[data-rh-r-time]'),
        pb: $('[data-rh-r-pb]'),
      },
      share: $('[data-rh-share]'),
      post: $('[data-rh-post]'),
      postBtn: $('[data-rh-post-btn]'),
      postMsg: $('[data-rh-post-msg]'),
      name: root.querySelector('#rh-name'),
    };

    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.touch = matchMedia('(pointer: coarse)').matches;
    this.state = 'start';
    this.game = null;
    this.result = null;
    this.shown = '';
    this.raf = 0;
    this.last = 0;
    // Play time for the log: real time spent in play, unlike game time, which is clamped per frame.
    this.playMs = 0;
    this.frameAt = 0;
    this.keyTs = null;
    this.inputKeyTs = null;
    this.overAt = 0;
    this.settleUntil = 0;
    this.visible = true;
    this.hud = {};
    this.idleWords = [];

    this.audio = createAudio();
    this.renderer = new Renderer(this.el.canvas, { reducedMotion: this.reduced });
    const saved = store.get(PACK_KEY);
    this.pack = PACK_INFO[saved] ? saved : 'everyday';

    this.buildPacks();
    this.buildLine();
    this.buildMeter();
    this.buildPips();
    this.syncMute();
    this.setStage(1, 0);
    this.showPersonalBest();
    if (this.touch) {
      this.el.hintKeys.hidden = true;
      this.el.hintTouch.hidden = false;
    }
    for (const k of root.querySelectorAll('.rh__kbd')) k.hidden = this.touch;

    this.bind();
    this.show('start');
    this.renderer.resize();
    this.renderer.setStation(STATIONS[0]);
    this.resetIdle();
    this.kick();
    this.loadBoard('start');

    // Canvas text needs the web fonts; re-measure once they arrive.
    if (document.fonts) {
      const sign = this.renderer.fontSign;
      const led = this.renderer.fontLed;
      Promise.all([document.fonts.load(`700 20px ${sign}`), document.fonts.load(`700 20px ${led}`)])
        .catch(() => {})
        .then(() => {
          this.renderer.fontsChanged();
          this.remeasure();
          this.kick();
        });
    }
  }

  // ------------------------------------------------------------------ setup

  buildPacks() {
    const frag = document.createDocumentFragment();
    for (const [id, p] of Object.entries(PACK_INFO)) {
      const label = document.createElement('label');
      label.className = 'rh__pack';
      label.style.setProperty('--pack', p.color);
      label.innerHTML = `<input type="radio" name="rh-pack" value="${id}"${id === this.pack ? ' checked' : ''}>
<span class="rh__pack-bullet${p.dark ? ' rh__pack-bullet--dark' : ''}" aria-hidden="true">${p.bullet}</span>
<span class="rh__pack-text"><strong>${p.label}</strong><span>${p.blurb}</span></span>`;
      frag.append(label);
    }
    this.el.packs.append(frag);
    this.el.packs.addEventListener('change', (e) => {
      if (e.target.name !== 'rh-pack') return;
      this.pack = e.target.value;
      store.set(PACK_KEY, this.pack);
      this.resetIdle();
    });
  }

  buildLine() {
    const n = STATIONS.length;
    const frag = document.createDocumentFragment();
    STATIONS.forEach((name, i) => {
      const s = document.createElement('span');
      s.className = 'rh__stop';
      s.style.left = `${(i / (n - 1)) * 100}%`;
      s.title = name;
      frag.append(s);
    });
    this.el.stops.append(frag);
    this.stopEls = [...this.el.stops.children];
  }

  buildMeter() {
    for (let i = 0; i < 10; i++) this.el.meter.append(document.createElement('i'));
    this.segs = [...this.el.meter.children];
  }

  // Clean words so far toward the next step of the multiplier.
  buildPips() {
    for (let i = 0; i < COMBO_STEP; i++) this.el.pips.append(document.createElement('i'));
    this.pipEls = [...this.el.pips.children];
  }

  bind() {
    const { el } = this;
    el.start.addEventListener('click', () => this.start());
    el.screens.pause.querySelector('[data-rh-resume]').addEventListener('click', () => this.resume());
    el.screens.pause.querySelector('[data-rh-quit]').addEventListener('click', () => this.quit());
    el.screens.over.querySelector('[data-rh-again]').addEventListener('click', () => this.start());
    el.screens.over.querySelector('[data-rh-menu]').addEventListener('click', () => this.menu());
    el.pause.addEventListener('click', () => (this.state === 'play' ? this.pause() : this.state === 'pause' && this.resume()));
    el.mute.addEventListener('click', () => {
      this.audio.unlock();
      this.audio.setMuted(!this.audio.muted);
      this.syncMute();
    });
    // Keep focus (and the phone keyboard) on the hidden input when tapping the toolbar.
    for (const b of [el.pause, el.mute]) b.addEventListener('pointerdown', (e) => this.state === 'play' && e.preventDefault());

    el.input.addEventListener('input', (e) => this.onInput(e));
    el.input.addEventListener('blur', () => this.onInputBlur());
    el.field.addEventListener('click', (e) => {
      if (this.state === 'play' && !e.target.closest('[data-rh-screen]')) this.focusInput();
    });
    document.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause();
      else this.kick();
    });
    window.addEventListener('blur', () => {
      if (!this.touch) this.pause();
    });
    el.post.addEventListener('submit', (e) => this.onPost(e));

    const ro = new ResizeObserver(() => {
      if (this.renderer.resize()) {
        this.remeasure();
        this.drawStill();
      }
    });
    ro.observe(el.field);

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(
        (entries) => {
          const entry = entries[entries.length - 1];
          this.visible = entry.isIntersecting;
          if (this.state === 'play' && entry.intersectionRatio < 0.5) this.holdIfHidden();
          if (this.visible) this.kick();
        },
        { threshold: [0, 0.5] },
      ).observe(el.field);
    }

    this.onViewport = () => {
      const vv = window.visualViewport;
      const h = Math.round(vv ? vv.height : window.innerHeight);
      this.root.style.setProperty('--rh-vv-h', `${h}px`);
      this.root.style.setProperty('--rh-vv-top', `${Math.round(vv ? vv.offsetTop : 0)}px`);
      // With the keyboard up every row of chrome comes out of the playing field.
      this.root.classList.toggle('is-short', h < 640);
    };
  }

  // ------------------------------------------------------------------ game flow

  start() {
    this.audio.unlock();
    // Focus inside the click handler: phones only raise the keyboard during a user gesture.
    this.focusInput();
    clearTimeout(this.endTimer);
    this.playMs = 0;
    this.frameAt = performance.now();
    this.settleUntil = this.frameAt + SETTLE_MS;
    this.game = new Game({
      words: PACK_INFO[this.pack].words,
      pack: this.pack,
      measure: (text, kind) => this.renderer.measure(text, kind),
      onEvent: (type, data) => this.onEvent(type, data),
      clock: () => this.logClock(),
    });
    this.result = null;
    this.hud = {};
    this.renderer.clearEffects();
    this.renderer.setStation(STATIONS[0]);
    if (this.roomy()) this.renderer.showBanner('Stand clear of the closing doors', station(1).name, 2000);
    this.audio.play('chime');
    this.setStage(1, 0);
    this.state = 'play';
    this.show(null);
    this.el.pause.disabled = false;
    this.el.pause.setAttribute('aria-label', 'Pause');
    if (this.touch) this.immersive(true);
    this.syncInput();
    if (!this.touch) this.reveal();
    this.announce(`Rush Hour started at ${station(1).name}. Type the falling words.`);
    this.kick();
  }

  pause() {
    if (this.state !== 'play') return;
    this.state = 'pause';
    this.show('pause');
    this.el.pause.setAttribute('aria-label', 'Resume');
    if (!this.touch) this.el.screens.pause.querySelector('[data-rh-resume]').focus({ preventScroll: true });
    this.audio.suspend();
    this.kick();
  }

  resume() {
    if (this.state !== 'pause') return;
    this.audio.resume();
    this.state = 'play';
    this.show(null);
    this.el.pause.setAttribute('aria-label', 'Pause');
    this.focusInput();
    if (!this.touch) this.reveal();
    this.last = 0;
    this.frameAt = performance.now();
    this.settleUntil = this.frameAt + SETTLE_MS;
    this.kick();
  }

  // Scrolled away mid-ride (a stray wheel or trackpad flick): hold the train. Starting a ride
  // shifts the layout and scrolls the game into view, so give that a moment to finish first.
  holdIfHidden() {
    clearTimeout(this.hideTimer);
    const wait = this.settleUntil - performance.now();
    if (wait > 0) {
      this.hideTimer = setTimeout(() => this.holdIfHidden(), wait);
      return;
    }
    if (this.state !== 'play') return;
    const r = this.el.field.getBoundingClientRect();
    const shown = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
    if (shown < r.height * 0.5) this.pause();
  }

  quit() {
    if (this.state !== 'pause' || !this.game) return;
    this.audio.resume();
    this.state = 'play';
    this.show(null);
    this.game.end('quit');
  }

  menu() {
    this.state = 'start';
    this.game = null;
    this.renderer.clearEffects();
    this.setStage(1, 0);
    this.resetIdle();
    this.show('start');
    this.showPersonalBest();
    this.loadBoard('start');
    this.el.start.focus({ preventScroll: true });
    this.kick();
  }

  finish() {
    const g = this.game;
    const detail = g.detail();
    this.result = { score: g.score, detail, log: g.log, bestStreak: g.bestStreak, reason: g.reason };
    this.state = 'over';
    this.overAt = performance.now();
    this.el.pause.disabled = true;
    this.immersive(false);
    this.el.input.blur();

    const best = store.get(BEST_KEY);
    const isBest = g.score > 0 && (!best || g.score > best.score);
    if (isBest) store.set(BEST_KEY, { score: g.score, stage: detail.stage, wpm: detail.wpm, ts: Date.now() });

    const { r } = this.el;
    const st = station(detail.stage);
    r.kicker.lastChild.textContent = g.reason === 'suspended' ? ' Service suspended' : ' End of ride';
    r.station.textContent = st.name;
    r.score.textContent = fmt(g.score);
    r.best.hidden = !isBest;
    r.wpm.textContent = detail.wpm;
    r.acc.textContent = `${detail.accuracy}%`;
    r.words.textContent = fmt(detail.words);
    r.misses.textContent = detail.misses;
    r.streak.textContent = g.bestStreak;
    r.time.textContent = duration(detail.durationMs);
    const prev = isBest ? best : store.get(BEST_KEY);
    r.pb.textContent = prev && !isBest ? `Your best: ${fmt(prev.score)} · ${station(prev.stage).name}` : isBest && best ? `Previous best: ${fmt(best.score)}` : '';
    r.pb.hidden = !r.pb.textContent;

    this.posted = false;
    this.el.post.classList.remove('is-done');
    this.el.name.disabled = false;
    this.el.postBtn.disabled = g.score <= 0;
    this.el.name.value = getPlayerName() || '';
    this.el.postMsg.textContent = g.score > 0 ? '' : 'Clear a word to get on the board.';

    const text = `I reached ${st.name} on the 7 with ${fmt(g.score)} points in Rush Hour. Beat me:`;
    const shareOpts = {
      url: document.querySelector('link[rel="canonical"]')?.href || location.href.split('#')[0],
      text,
      title: 'Rush Hour',
      image: () => resultCard({ score: g.score, ...detail }, { sign: this.renderer.fontSign, led: this.renderer.fontLed }),
      imageName: 'rush-hour.png',
    };
    if (this.shareBar) this.shareBar.update(shareOpts);
    else this.shareBar = mountShareBar(this.el.share, shareOpts);
    this.el.share.hidden = g.score <= 0;

    this.show('over');
    // Land on the result rather than <body>, so Tab reaches Ride again first and screen readers
    // start here. The heading is not a control, so a late Space or letter does nothing.
    r.title.focus({ preventScroll: true });
    this.loadBoard('over');
    this.resetIdle();
    this.announce(`${g.reason === 'suspended' ? 'Service suspended' : 'Ride ended'} at ${st.name}. Score ${fmt(g.score)}.`);
    if (this.touch) this.root.scrollIntoView({ block: 'start', behavior: this.reduced ? 'auto' : 'smooth' });
    this.kick();
  }

  // ------------------------------------------------------------------ input

  focusInput() {
    const i = this.el.input;
    if (document.activeElement !== i) i.focus({ preventScroll: true });
  }

  syncInput() {
    const b = this.game && this.state === 'play' ? this.game.buffer : '';
    if (this.el.input.value !== b) this.el.input.value = b;
    this.shown = b;
  }

  // Log time for whatever the player is doing right now. Keys are stamped with when they were
  // pressed, so a stalled frame doesn't squash a run of typing into one instant.
  logClock() {
    if (this.keyTs == null) return this.playMs;
    return this.playMs + Math.min(MAX_KEY_LEAD_MS, Math.max(0, this.keyTs - this.frameAt));
  }

  atKey(ts, fn) {
    // Ignore event times on a different clock (old engines used the epoch).
    this.keyTs = Number.isFinite(ts) && ts <= performance.now() + 50 ? ts : null;
    try {
      fn();
    } finally {
      this.keyTs = null;
    }
  }

  // The hidden input mirrors the buffer. Diffing against it works for hardware keys and for
  // phone keyboards alike, which often don't report useful key codes.
  onInput(e) {
    const g = this.game;
    const ts = this.inputKeyTs ?? e?.timeStamp;
    this.inputKeyTs = null;
    if (this.state !== 'play' || !g) {
      this.el.input.value = '';
      return;
    }
    const v = this.el.input.value.toLowerCase();
    const shown = this.shown;
    let i = 0;
    while (i < v.length && i < shown.length && v[i] === shown[i]) i++;
    this.atKey(ts, () => {
      for (let k = shown.length; k > i; k--) g.backspace();
      for (const ch of v.slice(i)) {
        if (g.over) break;
        if (ch === ' ') g.resetBuffer();
        else g.type(ch);
      }
    });
    this.syncInput();
  }

  onInputBlur() {
    if (!this.touch || this.state !== 'play') return;
    // The phone keyboard went away; don't let words fall while nobody can type.
    clearTimeout(this.blurTimer);
    this.blurTimer = setTimeout(() => {
      if (document.activeElement !== this.el.input) this.pause();
    }, 300);
  }

  onKey(e) {
    const target = e.target;
    // The input event that follows carries no useful time of its own on some browsers.
    if (target === this.el.input) this.inputKeyTs = e.timeStamp;
    if (e.isComposing) return;
    const k = e.key;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (this.state === 'play') {
      if (k === 'Escape') {
        e.preventDefault();
        this.pause();
        return;
      }
      if (target !== this.el.input && plain && (/^[a-z]$/i.test(k) || k === 'Backspace' || k === ' ')) {
        if (isField(target) && target !== this.el.input) return;
        e.preventDefault();
        this.focusInput();
        this.atKey(e.timeStamp, () => {
          if (k === 'Backspace') this.game.backspace();
          else if (k === ' ') this.game.resetBuffer();
          else this.game.type(k);
        });
        this.syncInput();
      }
      return;
    }
    if (this.state === 'pause' && (k === 'Escape' || (k === 'Enter' && !isControl(target)))) {
      e.preventDefault();
      this.resume();
      return;
    }
    if ((this.state === 'over' || this.state === 'ending') && plain) {
      // Players are usually still typing when the ride ends. Space is a game key, so don't let
      // it scroll the results away; Enter rides again, once the results have settled.
      const since = this.state === 'over' ? performance.now() - this.overAt : 0;
      const inGame = target === this.el.input || (this.root.contains(target) && !isControl(target));
      const onPage = target === document.body && since < 2000;
      if (k === ' ' && (inGame || onPage)) e.preventDefault();
      if (k === 'Enter' && (inGame || target === document.body) && this.state === 'over' && since > OVER_KEY_GUARD_MS) {
        e.preventDefault();
        this.start();
      }
      return;
    }
    const radio = target.matches?.('input[type="radio"]');
    if (this.state === 'start' && k === 'Enter' && (radio || !isControl(target)) && (target === document.body || this.root.contains(target))) {
      e.preventDefault();
      this.start();
    }
  }

  // ------------------------------------------------------------------ engine events

  onEvent(type, d) {
    const R = this.renderer;
    switch (type) {
      case 'key':
        this.audio.play('key');
        break;
      case 'typo':
        this.audio.play('typo');
        R.typo(!!this.game?.target);
        break;
      case 'clear': {
        this.audio.play('clear', d.streak);
        const m = comboMultiplier(d.streak);
        const up = m > comboMultiplier(d.streak - 1);
        R.wordCleared(d.word, d.points, d.streak, up ? m : 0);
        if (up) this.bump(this.el.combo);
        this.syncInput();
        break;
      }
      case 'express':
        this.audio.play('express');
        break;
      case 'delay':
        this.audio.play('delay');
        this.announce('Signal delay. Trains are held for a few seconds.');
        break;
      case 'sweep':
        this.audio.play('sweep');
        R.swept(d.words, d.points);
        break;
      case 'stage': {
        const st = station(d.stage);
        const nx = station(d.stage + 1);
        const end = st.index === 0 || st.index === STATIONS.length - 1;
        this.audio.play('chime');
        // On a short phone field the banner would sit on top of the words; the sign says it.
        if (this.roomy()) R.showBanner(end ? 'End of the line' : 'This is', st.name);
        else this.bump(this.el.station);
        R.setStation(st.name);
        this.announce(`This is ${st.name}. Next stop: ${nx.name}.`);
        break;
      }
      case 'miss':
        this.audio.play('miss');
        R.wordMissed(d.word, d.penalty);
        this.syncInput();
        break;
      case 'buffer':
        this.syncInput();
        break;
      case 'over':
        this.state = 'ending';
        this.el.pause.disabled = true;
        this.audio.play('over');
        R.showBanner(d.reason === 'suspended' ? 'Service suspended' : 'End of ride', station(this.game.stage).name, ENDING_MS + 200);
        this.endTimer = setTimeout(() => this.finish(), ENDING_MS);
        break;
      default:
    }
  }

  // ------------------------------------------------------------------ frame loop

  kick() {
    if (!this.raf) {
      this.last = 0;
      this.raf = requestAnimationFrame((t) => this.tick(t));
    }
  }

  animating() {
    if (document.hidden) return false;
    if (this.state === 'play' || this.state === 'ending') return true;
    // Effects are frozen while paused, so one still frame (from pause()) is enough.
    if (this.state === 'pause') return false;
    if (this.renderer.busy) return true;
    return (this.state === 'start' || this.state === 'over') && this.visible && !this.reduced;
  }

  tick(now) {
    this.raf = 0;
    const real = this.last ? now - this.last : 16;
    // Game time moves at most 50 ms a frame, so a hitch never teleports the words.
    const dt = Math.min(50, real);
    this.last = now;
    if (this.state === 'play') {
      this.playMs += real;
      this.frameAt = now;
      this.game.update(dt);
    }
    this.drawFrame(dt);
    if (this.game && (this.state === 'play' || this.state === 'ending')) this.updateHud();
    if (this.animating()) this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  drawFrame(dt) {
    const g = this.game;
    if (g && (this.state === 'play' || this.state === 'ending' || this.state === 'pause')) {
      const paused = this.state === 'pause';
      const hint = this.touch && document.activeElement !== this.el.input ? 'TAP TO TYPE' : '';
      // No reading ahead with the clock stopped: paused signs are drawn blank.
      this.renderer.draw({ words: g.words, buffer: g.buffer, target: g.target, slowed: g.slowed, slowLeft: g.slowUntil - g.t, hint, masked: paused }, paused ? 0 : dt);
      return;
    }
    this.stepIdle(dt);
    this.renderer.draw({ words: this.idleWords, buffer: '', target: null, slowed: false, hint: '' }, dt);
  }

  drawStill() {
    if (!this.raf) this.drawFrame(0);
  }

  remeasure() {
    const list = this.game ? this.game.words : this.idleWords;
    for (const w of list) w.width = this.renderer.measure(w.text, w.kind);
  }

  // A few signs drifting down behind the start and results screens.
  resetIdle() {
    const words = PACK_INFO[this.pack].words.filter((w) => w.length >= 4 && w.length <= 9);
    const pick = () => words[Math.floor(Math.random() * words.length)];
    this.idleWords = [];
    const n = this.renderer.small ? 4 : 6;
    for (let i = 0; i < n; i++) {
      const text = pick();
      this.idleWords.push({ text, kind: 0, x: (i + 0.5) / n + (Math.random() - 0.5) * 0.08, y: (i * 0.37) % 0.9, speed: 1 / 26000, typed: 0 });
    }
    this.idlePick = pick;
    this.drawStill();
  }

  stepIdle(dt) {
    for (const w of this.idleWords) {
      w.y += w.speed * dt;
      if (w.y > 0.92) {
        w.y = 0;
        w.text = this.idlePick();
      }
    }
  }

  // ------------------------------------------------------------------ HUD

  set(key, el, value) {
    if (this.hud[key] === value) return;
    this.hud[key] = value;
    el.textContent = value;
  }

  updateHud() {
    const g = this.game;
    const { el } = this;
    this.set('score', el.score, fmt(g.score));
    const m = comboMultiplier(g.streak);
    this.set('combo', el.combo, `×${m % 1 ? m.toFixed(1) : m}`);
    const lit = m >= COMBO_MAX ? COMBO_STEP : g.streak % COMBO_STEP;
    if (this.hud.pips !== lit) {
      this.hud.pips = lit;
      this.pipEls.forEach((p, i) => p.classList.toggle('is-on', i < lit));
      el.pips.classList.toggle('is-max', m >= COMBO_MAX);
    }
    if (g.t > 4000) {
      const s = g.stats();
      this.set('wpm', el.wpm, String(s.wpm));
      this.set('acc', el.acc, `${s.accuracy}%`);
    } else {
      this.set('wpm', el.wpm, '–');
      this.set('acc', el.acc, '–');
    }

    const service = Math.max(0, g.service);
    if (this.hud.service !== service) {
      this.hud.service = service;
      const lit = Math.ceil(service / 10);
      const level = service > 60 ? 'good' : service > 30 ? 'delays' : 'severe';
      this.segs.forEach((s, i) => s.classList.toggle('is-on', i < lit));
      el.meter.dataset.rhLevel = level;
      el.meter.setAttribute('aria-valuenow', String(service));
      el.status.textContent = service <= 0 ? 'Suspended' : { good: 'Good service', delays: 'Delays', severe: 'Severe delays' }[level];
    }

    const progress = Math.round(g.stageProgress * 100) / 100;
    if (this.hud.stage !== g.stage || this.hud.progress !== progress) this.setStage(g.stage, progress);
  }

  setStage(stage, progress) {
    this.hud.stage = stage;
    this.hud.progress = progress;
    const st = station(stage);
    const nx = station(stage + 1);
    this.el.station.textContent = st.name;
    this.el.next.textContent = nx.name;
    this.el.whereLabel.textContent = `${st.bound}-bound${st.trip > 1 ? ` · trip ${st.trip}` : ''}`;
    const n = STATIONS.length - 1;
    const pos = st.index + (nx.index - st.index) * progress;
    const pct = (pos / n) * 100;
    this.el.car.style.left = `${pct}%`;
    // Once you've been to Flushing the whole line counts as ridden.
    const outbound = st.bound === 'Flushing' && st.trip === 1;
    this.el.rail.style.right = outbound ? `${100 - pct}%` : '0';
    this.stopEls.forEach((s, i) => {
      s.classList.toggle('is-here', i === st.index);
      s.classList.toggle('is-done', !outbound || i < st.index);
    });
  }

  // Room for the canvas banner without crowding the words near the top. Phones play with the
  // keyboard up, which leaves a short field, so they get a pulse on the station sign instead.
  roomy() {
    return !(this.renderer.small && (this.touch || this.renderer.H < 480));
  }

  bump(el) {
    if (this.reduced || !el) return;
    el.classList.remove('is-bump');
    void el.offsetWidth;
    el.classList.add('is-bump');
  }

  syncMute() {
    const m = this.audio.muted;
    this.el.mute.setAttribute('aria-pressed', String(m));
    this.el.mute.setAttribute('aria-label', m ? 'Turn sound on' : 'Mute sound');
    this.el.mute.classList.toggle('is-muted', m);
  }

  showPersonalBest() {
    const best = store.get(BEST_KEY);
    this.el.pb.hidden = !best;
    if (best) this.el.pb.textContent = `Your best: ${fmt(best.score)} · ${station(best.stage).name}`;
  }

  // ------------------------------------------------------------------ screens

  show(name) {
    for (const [key, s] of Object.entries(this.el.screens)) s.hidden = key !== name;
    this.root.dataset.rhState = name || 'play';
  }

  immersive(on) {
    if (on === this.root.classList.contains('is-immersive')) return;
    const vv = window.visualViewport;
    if (on) {
      this.onViewport();
      vv?.addEventListener('resize', this.onViewport);
      vv?.addEventListener('scroll', this.onViewport);
      window.addEventListener('resize', this.onViewport);
    } else {
      vv?.removeEventListener('resize', this.onViewport);
      vv?.removeEventListener('scroll', this.onViewport);
      window.removeEventListener('resize', this.onViewport);
    }
    this.root.classList.toggle('is-immersive', on);
    document.documentElement.classList.toggle('rh-locked', on);
  }

  // Bring the whole game into view if part of it is off screen.
  reveal() {
    const r = this.root.getBoundingClientRect();
    if (r.top >= 0 && r.bottom <= window.innerHeight) return;
    this.root.scrollIntoView({ block: r.height <= window.innerHeight ? 'center' : 'start', behavior: this.reduced ? 'auto' : 'smooth' });
  }

  announce(msg) {
    this.el.live.textContent = '';
    setTimeout(() => {
      this.el.live.textContent = msg;
    }, 30);
  }

  // ------------------------------------------------------------------ leaderboard

  async loadBoard(which, fresh = false) {
    const el = this.el.boards[which];
    if (!el) return;
    try {
      const data = await getTop(GAME_ID, { limit: 10, fresh });
      renderBoard(el, data, {
        formatScore: (e) => fmt(e.score),
        formatMeta: boardMeta,
        labels: { title: 'This month', empty: 'No riders yet this month. Be the first.', unavailable: 'The board is out of service right now.' },
      });
    } catch {
      el.innerHTML = '<p class="rh__loading">The board is out of service right now.</p>';
    }
  }

  async onPost(e) {
    e.preventDefault();
    if (this.posted || !this.result || this.result.score <= 0) return;
    const { name, postBtn, postMsg, post } = this.el;
    const clean = cleanName(name.value);
    if (!clean) {
      postMsg.textContent = 'Try another nickname: letters and numbers, up to 16.';
      name.focus();
      return;
    }
    postBtn.disabled = true;
    postMsg.textContent = 'Posting…';
    const { score, detail, log } = this.result;
    const res = await submit(GAME_ID, { name: clean, score, detail, log }, { localScore: score, detail });
    if (res.ok) {
      this.posted = true;
      post.classList.add('is-done');
      name.disabled = true;
      const month = boardMonth(res.period);
      postMsg.textContent = res.rank ? `Posted. You're #${res.rank} ${month ? `for ${month}` : 'this month'}.` : 'Posted.';
      this.loadBoard('over', true);
      return;
    }
    const status = res.status || 0;
    if (res.error === 'name') {
      postBtn.disabled = false;
      postMsg.textContent = 'Try another nickname: letters and numbers, up to 16.';
    } else if (res.error === 'too_many_names') {
      postMsg.textContent = 'This network has posted under enough nicknames this month. Try one you used before.';
      postBtn.disabled = false;
    } else if (res.error === 'duplicate') {
      postMsg.textContent = 'This ride is already on the board.';
    } else if (status === 429) {
      postBtn.disabled = false;
      postMsg.textContent = 'Too many posts. Give it a minute and try again.';
    } else if (status >= 400 && status < 500) {
      // The board looked at this ride and said no. Posting it again would get the same answer.
      console.warn('Rush Hour: score not accepted', status, res.error);
      postMsg.textContent = "This ride couldn't be verified, so it wasn't posted.";
    } else {
      postBtn.disabled = false;
      postMsg.textContent = "Couldn't reach the board. Try again in a moment.";
    }
  }
}

const root = document.querySelector('[data-rush-hour]');
if (root) new RushHour(root);
