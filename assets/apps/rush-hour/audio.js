// Synthesized sound effects, so there are no audio files to download.
// The context is created on the first user gesture; browsers refuse to start one earlier.

const MUTE_KEY = 'rush-hour:muted';

function readMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function createAudio() {
  let ctx = null;
  let master = null;
  let noise = null;
  let muted = readMuted();
  let lastClick = 0;

  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        ctx = new AC();
      } catch {
        return null;
      }
      master = ctx.createGain();
      master.gain.value = 0.55;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function noiseBuffer() {
    if (!noise) {
      const len = ctx.sampleRate;
      noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return noise;
  }

  const ready = () => !muted && ctx && ctx.state === 'running';

  function tone({ freq, type = 'sine', at = 0, dur = 0.2, gain = 0.2, attack = 0.005, to = null, filter = null }) {
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = osc.connect(g);
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = filter.type || 'lowpass';
      f.frequency.value = filter.freq;
      node = node.connect(f);
    }
    node.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function hiss({ at = 0, dur = 0.1, gain = 0.1, freq = 2000, q = 1, type = 'bandpass', sweepTo = null }) {
    const t0 = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer();
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t0);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.02, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.02);
  }

  const sfx = {
    key() {
      // Typing fast shouldn't turn into a buzz; skip clicks closer than 25ms apart.
      const now = performance.now();
      if (now - lastClick < 25) return;
      lastClick = now;
      hiss({ dur: 0.03, gain: 0.08, freq: 3200, q: 2 });
    },
    clear(streak = 0) {
      // Fare-gate style beep, nudged up as the streak grows.
      const lift = Math.min(streak, 30) * 6;
      tone({ freq: 1320 + lift, type: 'square', dur: 0.08, gain: 0.05, filter: { freq: 3000 } });
      tone({ freq: 1760 + lift, type: 'sine', at: 0.05, dur: 0.12, gain: 0.07 });
    },
    typo() {
      tone({ freq: 140, type: 'triangle', dur: 0.09, gain: 0.12 });
    },
    miss() {
      tone({ freq: 98, type: 'sawtooth', dur: 0.32, gain: 0.12, filter: { freq: 700 } });
      tone({ freq: 104, type: 'square', dur: 0.32, gain: 0.05, filter: { freq: 500 } });
    },
    chime() {
      // Two-note door chime, high then low.
      tone({ freq: 1244, type: 'sine', dur: 0.55, gain: 0.16, attack: 0.008 });
      tone({ freq: 2488, type: 'sine', dur: 0.3, gain: 0.025 });
      tone({ freq: 988, type: 'sine', at: 0.32, dur: 0.75, gain: 0.16, attack: 0.008 });
      tone({ freq: 1976, type: 'sine', at: 0.32, dur: 0.4, gain: 0.025 });
    },
    express() {
      [784, 988, 1175, 1568].forEach((f, i) => tone({ freq: f, type: 'triangle', at: i * 0.055, dur: 0.18, gain: 0.09 }));
    },
    delay() {
      tone({ freq: 440, type: 'sine', dur: 0.5, gain: 0.12, to: 220 });
      hiss({ at: 0.05, dur: 0.6, gain: 0.05, freq: 600, q: 0.7, type: 'lowpass', sweepTo: 200 });
    },
    sweep() {
      hiss({ dur: 1.1, gain: 0.22, freq: 300, q: 0.8, sweepTo: 3200 });
      tone({ freq: 70, type: 'sawtooth', dur: 0.9, gain: 0.06, to: 140, filter: { freq: 400 } });
    },
    over() {
      [523, 440, 349, 262].forEach((f, i) => tone({ freq: f, type: 'triangle', at: i * 0.16, dur: 0.35, gain: 0.12 }));
    },
    start() {
      tone({ freq: 659, type: 'sine', dur: 0.12, gain: 0.1 });
      tone({ freq: 988, type: 'sine', at: 0.1, dur: 0.22, gain: 0.1 });
    },
  };

  const api = {
    unlock,
    get muted() {
      return muted;
    },
    setMuted(v) {
      muted = Boolean(v);
      try {
        localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
      } catch {
        /* not persisted, still applies for this visit */
      }
    },
    play(name, ...args) {
      if (!ready() || !sfx[name]) return;
      try {
        sfx[name](...args);
      } catch {
        /* a failed sound effect is never worth breaking the game over */
      }
    },
    suspend() {
      if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
    },
    resume() {
      if (ctx && ctx.state === 'suspended' && !muted) ctx.resume().catch(() => {});
    },
  };
  return api;
}
