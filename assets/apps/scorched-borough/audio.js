// All sounds are synthesized with WebAudio, so there are no audio files to download.

const KEY = 'sb:muted';
const VOLUME = 0.55;

function readMuted() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = readMuted();
    this.whistle = null;
  }

  // Browsers only allow audio after a user gesture, so this is called from click/key handlers.
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
      } catch {
        return;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : VOLUME;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      this.master.connect(comp).connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  get ready() {
    return Boolean(this.ctx) && this.ctx.state === 'running' && !this.muted;
  }

  setMuted(m) {
    this.muted = m;
    try {
      localStorage.setItem(KEY, m ? '1' : '0');
    } catch {
      /* not remembered, that's all */
    }
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : VOLUME, this.ctx.currentTime, 0.03);
    if (m) this.stopWhistle();
  }

  env(node, t, peak, attack, decay) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g).connect(this.master);
    return g;
  }

  noise(t, dur, { type = 'lowpass', f0 = 1000, f1 = f0, q = 0.7, peak = 0.5, attack = 0.005 } = {}) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    src.connect(f);
    this.env(f, t, peak, attack, dur);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + attack + 0.05);
  }

  tone(t, { type = 'sine', f0 = 440, f1 = f0, dur = 0.2, peak = 0.3, attack = 0.005 } = {}) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    this.env(o, t, peak, attack, dur);
    o.start(t);
    o.stop(t + dur + attack + 0.05);
  }

  fire(heavy = false) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.tone(t, { f0: heavy ? 120 : 170, f1: 42, dur: heavy ? 0.42 : 0.3, peak: 0.9 });
    this.noise(t, 0.16, { type: 'bandpass', f0: 1400, f1: 300, q: 0.9, peak: heavy ? 0.7 : 0.5 });
  }

  startWhistle() {
    if (!this.ready || this.whistle) return;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 1200;
    const g = this.ctx.createGain();
    g.gain.value = 0.0001;
    o.connect(g).connect(this.master);
    o.start();
    this.whistle = { o, g };
  }

  // Pitch falls as the shell comes down, the old cartoon bomb whistle.
  updateWhistle(falling, height) {
    if (!this.whistle) return;
    const t = this.ctx.currentTime;
    const f = 520 + Math.max(0, Math.min(1, height / 420)) * 1000;
    this.whistle.o.frequency.setTargetAtTime(f, t, 0.05);
    this.whistle.g.gain.setTargetAtTime(falling ? 0.045 : 0.0001, t, 0.08);
  }

  stopWhistle() {
    if (!this.whistle) return;
    const { o, g } = this.whistle;
    const t = this.ctx.currentTime;
    g.gain.setTargetAtTime(0.0001, t, 0.02);
    o.stop(t + 0.15);
    this.whistle = null;
  }

  boom(radius = 32) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const s = radius / 32;
    this.noise(t, 0.9 + 0.5 * s, { f0: 2600 * Math.min(1.4, s), f1: 90, peak: Math.min(1, 0.65 * s + 0.2), attack: 0.004 });
    this.tone(t, { f0: 90, f1: 32, dur: 0.6 + 0.3 * s, peak: Math.min(1, 0.7 * s + 0.2) });
  }

  thud(amount = 1) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.tone(t, { f0: 110, f1: 45, dur: 0.22, peak: 0.5 * amount });
    this.noise(t, 0.25, { f0: 500, f1: 120, peak: 0.35 * amount });
  }

  pop() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.tone(t, { type: 'triangle', f0: 900, f1: 380, dur: 0.12, peak: 0.25 });
    this.noise(t, 0.08, { type: 'highpass', f0: 2500, peak: 0.2 });
  }

  click() {
    if (!this.ready) return;
    this.tone(this.ctx.currentTime, { type: 'triangle', f0: 1500, f1: 1100, dur: 0.035, peak: 0.08 });
  }

  // Two falling notes, like the door chime on the newer subway cars.
  chime() {
    if (!this.ready) return;
    const t = this.ctx.currentTime + 0.02;
    for (const [i, f] of [[0, 659.25], [1, 523.25]]) {
      this.tone(t + i * 0.34, { f0: f, dur: 0.9, peak: 0.16, attack: 0.012 });
      this.tone(t + i * 0.34, { type: 'triangle', f0: f * 2, dur: 0.5, peak: 0.03, attack: 0.012 });
    }
  }

  win() {
    if (!this.ready) return;
    const t = this.ctx.currentTime + 0.05;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(t + i * 0.11, { type: 'triangle', f0: f, dur: i === 3 ? 0.7 : 0.25, peak: 0.18, attack: 0.01 }));
  }

  lose() {
    if (!this.ready) return;
    const t = this.ctx.currentTime + 0.05;
    [392, 311.13, 261.63].forEach((f, i) => this.tone(t + i * 0.18, { type: 'triangle', f0: f, f1: f * 0.98, dur: i === 2 ? 0.8 : 0.3, peak: 0.16, attack: 0.01 }));
  }
}
