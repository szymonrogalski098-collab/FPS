// Audio engine: every sound is synthesised at load time with small DSP routines (no audio files).
// Runtime: 3D panners, distance/occlusion filtering, speed-of-sound delay, indoor/outdoor convolution reverb.
import { clamp, rand, choice } from './util.js';

const SR = 44100;
const TAU = Math.PI * 2;
const N = () => Math.random() * 2 - 1;

class Biquad {
  constructor(type, f, q = 0.707) { this.set(type, f, q); this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  set(type, f, q) {
    const w0 = (TAU * Math.min(f, SR * 0.45)) / SR, c = Math.cos(w0), s = Math.sin(w0), al = s / (2 * q);
    let b0, b1, b2;
    const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
    if (type === 'lowpass') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else if (type === 'highpass') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    else { b0 = al; b1 = 0; b2 = -al; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  p(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const E = (t, a, d) => (t < 0 ? 0 : t < a ? t / a : Math.exp(-(t - a) / d));
const buf = (sec) => new Float32Array(Math.ceil(sec * SR));

function normalize(a, peak = 0.9, fade = true) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  if (m > 0) { const k = peak / m; for (let i = 0; i < a.length; i++) a[i] *= k; }
  // short fade out to avoid clicks
  const f = fade ? Math.min(a.length, 256) : 0;
  for (let i = 0; i < f; i++) a[a.length - 1 - i] *= i / f;
  return a;
}

function modal(out, t0, freqs, decays, amps, gain = 1) {
  const s0 = Math.floor(t0 * SR);
  for (let k = 0; k < freqs.length; k++) {
    const w = (TAU * freqs[k]) / SR, d = decays[k], len = Math.min(out.length - s0, Math.ceil(d * 7 * SR));
    for (let i = 0; i < len; i++) out[s0 + i] += Math.sin(w * i) * Math.exp(-i / SR / d) * amps[k] * gain;
  }
}

function noiseBurst(out, t0, dur, type, f, q, attack, decay, gain) {
  const s0 = Math.floor(t0 * SR), len = Math.min(out.length - s0, Math.ceil(dur * SR));
  const flt = new Biquad(type, f, q);
  for (let i = 0; i < len; i++) out[s0 + i] += flt.p(N()) * E(i / SR, attack, decay) * gain;
}

function thump(out, t0, f0, f1, decay, gain) {
  const s0 = Math.floor(t0 * SR), len = Math.min(out.length - s0, Math.ceil(decay * 7 * SR));
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR, f = f1 + (f0 - f1) * Math.exp(-t / (decay * 0.35));
    ph += (TAU * f) / SR;
    out[s0 + i] += Math.sin(ph) * E(t, 0.001, decay) * gain;
  }
}

// ------------------------------------------------------------------ synthesis recipes

function synthGunshot(p) {
  const o = buf(p.dur || 0.7);
  const hp = new Biquad('highpass', p.crackHP, 0.7), lp = new Biquad('lowpass', p.bodyLP, 0.9);
  const mid = new Biquad('bandpass', p.midF || 700, 1.2), tail = new Biquad('lowpass', p.tailLP, 0.7);
  let ph = 0;
  for (let i = 0; i < o.length; i++) {
    const t = i / SR, n = N();
    let s = hp.p(n) * p.crack * E(t, 0.00015, p.crackD);
    s += lp.p(n) * p.body * E(t, 0.0004, p.bodyD);
    s += mid.p(n) * (p.mid || 0.6) * E(t, 0.001, p.bodyD * 1.4);
    const f = p.f1 + (p.f0 - p.f1) * Math.exp(-t / 0.018);
    ph += (TAU * f) / SR;
    s += Math.sin(ph) * p.thump * E(t, 0.0008, p.thumpD);
    s += tail.p(n) * p.tail * E(t, 0.006, p.tailD);
    o[i] = s;
  }
  if (p.mech) {
    modal(o, p.mech, [2300 * rand(0.9, 1.1), 3900, 5600], [0.012, 0.008, 0.006], [0.12, 0.08, 0.05]);
    noiseBurst(o, p.mech, 0.02, 'bandpass', 3500, 2, 0.0003, 0.003, 0.25);
    noiseBurst(o, p.mech + 0.028, 0.02, 'bandpass', 2600, 2, 0.0003, 0.004, 0.2);
  }
  const drive = p.drive || 2.4, nd = Math.tanh(drive);
  for (let i = 0; i < o.length; i++) o[i] = Math.tanh(o[i] * drive) / nd;
  return normalize(o, 0.97);
}

function vary(base, k = 0.08) {
  const o = {};
  for (const [key, v] of Object.entries(base)) o[key] = typeof v === 'number' && !['mech'].includes(key) ? v * rand(1 - k, 1 + k) : v;
  return o;
}

const GUNS = {
  rifle: { dur: 0.75, crackHP: 1100, crack: 1.25, crackD: 0.0045, bodyLP: 2600, body: 1.0, bodyD: 0.038, midF: 850, mid: 0.7, f0: 150, f1: 48, thump: 1.1, thumpD: 0.075, tailLP: 520, tail: 0.45, tailD: 0.19, mech: 0.03, drive: 2.6 },
  pistol: { dur: 0.6, crackHP: 1500, crack: 1.35, crackD: 0.0035, bodyLP: 3200, body: 0.9, bodyD: 0.028, midF: 1100, mid: 0.6, f0: 190, f1: 70, thump: 0.8, thumpD: 0.05, tailLP: 700, tail: 0.3, tailD: 0.14, mech: 0.022, drive: 2.3 },
  shotgun: { dur: 1.0, crackHP: 700, crack: 1.0, crackD: 0.006, bodyLP: 1800, body: 1.15, bodyD: 0.07, midF: 500, mid: 0.8, f0: 110, f1: 34, thump: 1.4, thumpD: 0.13, tailLP: 380, tail: 0.6, tailD: 0.3, mech: 0, drive: 2.8 },
  enemy: { dur: 0.75, crackHP: 900, crack: 1.1, crackD: 0.005, bodyLP: 2300, body: 1.0, bodyD: 0.042, midF: 780, mid: 0.75, f0: 140, f1: 45, thump: 1.1, thumpD: 0.08, tailLP: 480, tail: 0.5, tailD: 0.2, mech: 0, drive: 2.6 },
  // mountain arsenal: full-power 7.62 rounds are deeper and ring on much longer
  sniper: { dur: 1.4, crackHP: 850, crack: 1.45, crackD: 0.0055, bodyLP: 1900, body: 1.25, bodyD: 0.055, midF: 560, mid: 0.85, f0: 105, f1: 34, thump: 1.5, thumpD: 0.12, tailLP: 360, tail: 0.7, tailD: 0.36, mech: 0, drive: 3.0 },
  dmr: { dur: 1.05, crackHP: 950, crack: 1.35, crackD: 0.005, bodyLP: 2200, body: 1.15, bodyD: 0.048, midF: 680, mid: 0.8, f0: 120, f1: 38, thump: 1.3, thumpD: 0.095, tailLP: 420, tail: 0.58, tailD: 0.28, mech: 0.026, drive: 2.8 },
  ak: { dur: 0.85, crackHP: 780, crack: 1.05, crackD: 0.0052, bodyLP: 1950, body: 1.12, bodyD: 0.046, midF: 640, mid: 0.9, f0: 128, f1: 41, thump: 1.22, thumpD: 0.088, tailLP: 440, tail: 0.52, tailD: 0.23, mech: 0, drive: 2.7 },
  svd: { dur: 1.05, crackHP: 900, crack: 1.25, crackD: 0.0052, bodyLP: 2100, body: 1.15, bodyD: 0.05, midF: 620, mid: 0.8, f0: 116, f1: 37, thump: 1.35, thumpD: 0.1, tailLP: 400, tail: 0.6, tailD: 0.3, mech: 0, drive: 2.8 },
  m4: { dur: 0.8, crackHP: 1050, crack: 1.2, crackD: 0.0046, bodyLP: 2500, body: 1.0, bodyD: 0.04, midF: 820, mid: 0.72, f0: 145, f1: 46, thump: 1.08, thumpD: 0.078, tailLP: 500, tail: 0.46, tailD: 0.2, mech: 0, drive: 2.6 },
};

/** Supersonic crack of a rifle round passing close by: a sharp N-wave and a bright snap. */
function synthCrack() {
  const o = buf(0.3);
  const s0 = Math.floor(0.004 * SR), n = 14 + Math.floor(Math.random() * 6);
  for (let i = 0; i < n; i++) o[s0 + i] += (i < n / 2 ? 1 : -1) * (1 - Math.abs(i - n / 2) / (n / 2)) * 1.4;
  noiseBurst(o, 0.004, 0.03, 'highpass', 4500, 0.7, 0.0001, 0.002, 1.0);
  noiseBurst(o, 0.006, 0.2, 'bandpass', 2600, 0.8, 0.002, 0.04, 0.22);
  return normalize(o, 0.95);
}

function synthBolt(kind) {
  const o = buf(0.5);
  switch (kind) {
    case 'boltUp': click(o, 0, 1900, 0.8, 0.02); scrape(o, 0.005, 0.05, 2400, 0.12); break;
    case 'boltBack': scrape(o, 0, 0.09, 1500, 0.24); click(o, 0.09, 1200, 1.0, 0.03); thump(o, 0.09, 260, 140, 0.02, 0.3);
      modal(o, 0.2, [3300, 5500, 7200], [0.05, 0.04, 0.03], [0.12, 0.08, 0.05]); break;
    case 'boltFwd': scrape(o, 0, 0.08, 1700, 0.22); click(o, 0.08, 1500, 0.9, 0.025); break;
    case 'boltDown': click(o, 0, 1300, 1.0, 0.035); thump(o, 0, 300, 170, 0.02, 0.4); break;
  }
  return normalize(o, 0.8);
}

function synthMedical(kind) {
  if (kind === 'bandageRip') {
    const o = buf(0.6);
    for (let k = 0; k < 34; k++) noiseBurst(o, 0.02 + k * 0.011 + rand(0, 0.004), 0.012, 'bandpass', rand(2200, 4200), 1.4, 0.0005, 0.003, rand(0.3, 0.7));
    cloth(o, 0.35, 0.2, 0.1);
    return normalize(o, 0.55);
  }
  const o = buf(0.9);
  cloth(o, 0, 0.35, 0.16); cloth(o, 0.38, 0.4, 0.13);
  return normalize(o, 0.45);
}

function synthBreath(inhale) {
  const o = buf(inhale ? 0.75 : 1.0);
  const len = o.length, bp = new Biquad('bandpass', inhale ? 1500 : 900, 0.9), lp = new Biquad('lowpass', 3000, 0.7);
  for (let i = 0; i < len; i++) {
    const k = i / len;
    const env = inhale ? Math.sin(Math.PI * Math.min(1, k * 1.2)) * (1 - k * 0.3) : Math.pow(Math.sin(Math.PI * k), 0.8) * (1 - k * 0.5);
    if (i % 128 === 0) bp.set('bandpass', (inhale ? 1300 : 900) + Math.sin(k * 6) * 200, 0.9);
    o[i] = lp.p(bp.p(N())) * env;
  }
  return normalize(o, 0.4);
}

function synthSquelch() {
  const o = buf(0.25);
  click(o, 0, 2600, 0.5, 0.004);
  const hp = new Biquad('highpass', 900, 0.7), lp = new Biquad('lowpass', 3800, 0.7);
  const s0 = Math.floor(0.006 * SR), len = Math.floor(0.12 * SR);
  for (let i = 0; i < len; i++) o[s0 + i] += lp.p(hp.p(N())) * Math.exp(-i / len * 2.5) * 0.5;
  return normalize(o, 0.5);
}

function synthStepNature(surface) {
  const o = buf(0.4);
  thump(o, 0, 110, 55, 0.02, surface === 'dirt' ? 0.7 : 0.45);
  noiseBurst(o, 0, 0.1, 'lowpass', 280, 0.8, 0.001, 0.018, 0.8);
  if (surface === 'grass') {
    for (let k = 0; k < 3; k++) noiseBurst(o, rand(0, 0.05), 0.14, 'bandpass', rand(2800, 5200), 0.6, 0.02, 0.04, rand(0.25, 0.4));
  } else if (surface === 'gravel') {
    for (let k = 0; k < 30; k++) noiseBurst(o, Math.pow(Math.random(), 1.6) * 0.11, 0.01, 'highpass', rand(2200, 5200), 0.7, 0.0002, rand(0.0006, 0.0018), rand(0.18, 0.5));
    noiseBurst(o, 0.003, 0.12, 'bandpass', 1500, 0.8, 0.004, 0.035, 0.35);
  } else {
    for (let k = 0; k < 8; k++) noiseBurst(o, rand(0, 0.06), 0.012, 'highpass', rand(1800, 3500), 0.7, 0.0002, rand(0.001, 0.002), rand(0.08, 0.2));
    noiseBurst(o, 0.004, 0.12, 'bandpass', 900, 0.8, 0.006, 0.03, 0.3);
  }
  return normalize(o, 0.7);
}

/** Rotor thump + turbine whine. far: a distant flyby that fades, otherwise a seamless loop. */
function synthHelo(far) {
  const bladeHz = 4.8, pulses = far ? 34 : 10;
  const o = buf(pulses / bladeHz + (far ? 0.6 : 0));
  const lp = new Biquad('lowpass', far ? 260 : 700, 0.8), lp2 = new Biquad('lowpass', 160, 0.7);
  let ph = 0;
  for (let i = 0; i < o.length; i++) {
    const t = i / SR;
    const bp = (t * bladeHz) % 1;
    const slap = Math.exp(-bp / 0.07) * (0.8 + 0.2 * Math.sin(t * 13));
    const n = N();
    let v = lp.p(n) * slap * 1.2 + lp2.p(n) * 0.35;
    ph += (TAU * (far ? 900 : 2300 + Math.sin(t * 2) * 20)) / SR;
    v += Math.sin(ph) * (far ? 0.01 : 0.05);
    if (far) v *= Math.sin(Math.PI * Math.min(1, t / (o.length / SR))) * (1 - t / (o.length / SR) * 0.6);
    o[i] = v;
  }
  return normalize(o, 0.8, far);
}

function synthRockfall() {
  const o = buf(1.8);
  for (let k = 0; k < 40; k++) {
    const t = Math.pow(Math.random(), 1.4) * 1.5;
    const f = rand(1600, 4200);
    modal(o, t, [f, f * 1.7], [rand(0.006, 0.02), 0.008], [rand(0.08, 0.3), 0.08]);
    noiseBurst(o, t, 0.015, 'highpass', 2500, 0.7, 0.0002, 0.002, rand(0.05, 0.2));
  }
  noiseBurst(o, 0, 1.5, 'lowpass', 300, 0.7, 0.2, 0.5, 0.15);
  return normalize(o, 0.5);
}

/** Mountain acoustics: long, dark tail with discrete slap-back echoes from the valley walls. */
function makeMountainIR(ctx) {
  const sr = ctx.sampleRate, len = Math.floor(5.2 * sr);
  const ir = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const v = N() * Math.exp(-t / 1.25) * 0.1 * Math.min(1, t / 0.08);
      const k = 0.55 + 0.42 * Math.min(1, t / 2.5);
      lp = lp * k + v * (1 - k);
      d[i] = lp * 2.6;
    }
    const echoes = [[0.42, 0.55], [0.78, 0.42], [1.24, 0.34], [1.8, 0.26], [2.45, 0.2], [3.2, 0.13], [4.1, 0.08]];
    for (const [t0, a] of echoes) {
      const t = t0 * (ch ? 1.06 : 1) + rand(-0.02, 0.02);
      const s0 = Math.floor(t * sr), w = Math.floor((0.05 + t0 * 0.05) * sr);
      let e = 0;
      for (let k = 0; k < w && s0 + k < len; k++) {
        const env = Math.sin(Math.PI * k / w);
        e = e * 0.93 + N() * 0.07;
        d[s0 + k] += e * a * env * 3;
      }
    }
  }
  return ir;
}

function click(o, t, f = 2600, g = 0.5, ring = 0.01) {
  modal(o, t, [f * rand(0.95, 1.05), f * 1.63, f * 2.41], [ring, ring * 0.7, ring * 0.5], [0.5 * g, 0.3 * g, 0.2 * g]);
  noiseBurst(o, t, 0.02, 'highpass', 2500, 0.7, 0.0002, 0.0025, g * 0.8);
}
function scrape(o, t, dur, f = 2200, g = 0.15) {
  const s0 = Math.floor(t * SR), len = Math.min(o.length - s0, Math.floor(dur * SR));
  const bp = new Biquad('bandpass', f, 1.5);
  for (let i = 0; i < len; i++) {
    const k = i / len, env = Math.sin(Math.PI * k) * (0.6 + 0.4 * Math.random());
    if (i % 64 === 0) bp.set('bandpass', f * (0.8 + 0.4 * k), 1.5);
    o[s0 + i] += bp.p(N()) * env * g;
  }
}
function cloth(o, t, dur, g = 0.12) {
  const s0 = Math.floor(t * SR), len = Math.min(o.length - s0, Math.floor(dur * SR));
  const bp = new Biquad('bandpass', 1400, 0.6), lp = new Biquad('lowpass', 3500, 0.7);
  for (let i = 0; i < len; i++) {
    const k = i / len, env = Math.sin(Math.PI * k) * (0.5 + 0.5 * Math.sin(k * 23 + Math.sin(k * 7) * 3));
    o[s0 + i] += lp.p(bp.p(N())) * env * g;
  }
}

function synthMech(kind) {
  const o = buf(0.6);
  switch (kind) {
    case 'magOut': cloth(o, 0, 0.12, 0.06); click(o, 0.02, 2100, 0.5, 0.012); scrape(o, 0.035, 0.1, 1800, 0.18); break;
    case 'magIn': scrape(o, 0, 0.09, 1600, 0.16); click(o, 0.09, 1700, 0.9, 0.016); click(o, 0.105, 2600, 0.5, 0.01); thump(o, 0.09, 260, 140, 0.02, 0.25); break;
    case 'boltRelease': click(o, 0, 3200, 0.4, 0.008); click(o, 0.035, 1500, 1.0, 0.03); thump(o, 0.035, 300, 160, 0.025, 0.3); break;
    case 'slideRack': scrape(o, 0, 0.07, 2600, 0.14); click(o, 0.07, 2900, 0.6, 0.012); click(o, 0.16, 1900, 1.0, 0.025); break;
    case 'slideRelease': click(o, 0, 2100, 1.0, 0.025); thump(o, 0, 320, 180, 0.02, 0.3); break;
    case 'pumpBack': scrape(o, 0, 0.06, 1500, 0.2); click(o, 0.055, 1300, 0.9, 0.02); thump(o, 0.055, 200, 110, 0.03, 0.45); break;
    case 'pumpFwd': scrape(o, 0, 0.05, 1700, 0.18); click(o, 0.05, 1600, 1.0, 0.02); thump(o, 0.05, 240, 120, 0.025, 0.45); break;
    case 'shellIn': scrape(o, 0, 0.05, 2000, 0.1); click(o, 0.05, 1900, 0.6, 0.01); thump(o, 0.05, 300, 180, 0.02, 0.25); break;
    case 'dry': click(o, 0, 3400, 0.5, 0.006); break;
    case 'draw': cloth(o, 0, 0.25, 0.14); click(o, 0.2, 2400, 0.35, 0.01); break;
    case 'adsIn': cloth(o, 0, 0.14, 0.09); break;
    case 'switchMode': click(o, 0, 2800, 0.45, 0.006); break;
  }
  return normalize(o, 0.8);
}

function synthStep(surface) {
  const o = buf(0.35);
  thump(o, 0, 120, 60, 0.018, 0.55);
  noiseBurst(o, 0, 0.1, 'lowpass', 300, 0.8, 0.001, 0.014, 0.9);
  if (surface === 'concrete') {
    noiseBurst(o, 0.004, 0.12, 'bandpass', rand(2200, 3200), 1.2, 0.004, 0.025, 0.35);
    for (let k = 0; k < 4; k++) noiseBurst(o, rand(0.005, 0.06), 0.01, 'highpass', 4000, 0.7, 0.0002, 0.0012, rand(0.1, 0.25));
  } else if (surface === 'metal') {
    modal(o, 0, [rand(300, 340), rand(590, 640), rand(930, 990), rand(1450, 1520), rand(2200, 2300)], [0.12, 0.1, 0.07, 0.05, 0.04], [0.16, 0.13, 0.09, 0.06, 0.04]);
    noiseBurst(o, 0.003, 0.05, 'bandpass', 2600, 1.5, 0.002, 0.012, 0.3);
  } else if (surface === 'wood') {
    noiseBurst(o, 0, 0.08, 'bandpass', 500, 2, 0.002, 0.02, 0.5);
    thump(o, 0, 200, 110, 0.03, 0.35);
  } else {
    for (let k = 0; k < 18; k++) noiseBurst(o, rand(0, 0.075), 0.012, 'highpass', rand(2500, 5000), 0.7, 0.0002, rand(0.0008, 0.002), rand(0.15, 0.4));
    noiseBurst(o, 0.004, 0.1, 'bandpass', 1800, 0.8, 0.005, 0.03, 0.25);
  }
  return normalize(o, 0.7);
}

function synthImpact(surface) {
  const o = buf(0.7);
  if (surface === 'metal') {
    const f = rand(0.85, 1.15);
    modal(o, 0, [1850 * f, 3170 * f, 4430 * f, 6290 * f, 8100 * f], [0.28, 0.2, 0.13, 0.08, 0.05], [0.5, 0.35, 0.25, 0.15, 0.1]);
    noiseBurst(o, 0, 0.03, 'highpass', 2000, 0.7, 0.0002, 0.003, 1.0);
  } else if (surface === 'wood') {
    noiseBurst(o, 0, 0.1, 'bandpass', rand(600, 800), 2.2, 0.0005, 0.02, 1.0);
    thump(o, 0, 220, 140, 0.03, 0.5);
    for (let k = 0; k < 6; k++) noiseBurst(o, rand(0.005, 0.08), 0.01, 'highpass', 3000, 0.7, 0.0002, 0.0015, 0.15);
  } else if (surface === 'flesh') {
    noiseBurst(o, 0, 0.12, 'lowpass', 320, 0.8, 0.001, 0.035, 1.0);
    noiseBurst(o, 0, 0.03, 'bandpass', 1300, 1.2, 0.0003, 0.006, 0.6);
    thump(o, 0, 110, 60, 0.04, 0.7);
  } else if (surface === 'glass') {
    noiseBurst(o, 0, 0.03, 'highpass', 3000, 0.7, 0.0002, 0.004, 1.0);
    for (let k = 0; k < 28; k++) {
      const t = rand(0.005, 0.45) * Math.pow(Math.random(), 0.6);
      modal(o, t, [rand(2500, 7500)], [rand(0.01, 0.04)], [rand(0.08, 0.3) * (1 - t)]);
    }
  } else if (surface === 'dirt' || surface === 'fabric') {
    noiseBurst(o, 0, 0.12, 'lowpass', 450, 0.8, 0.001, 0.03, 1.0);
    noiseBurst(o, 0.004, 0.25, 'bandpass', 3000, 0.7, 0.01, 0.06, 0.2);
  } else {
    // concrete / asphalt
    noiseBurst(o, 0, 0.03, 'highpass', 1500, 0.7, 0.0002, 0.003, 1.1);
    noiseBurst(o, 0, 0.08, 'bandpass', rand(800, 1100), 1.2, 0.0005, 0.016, 0.7);
    for (let k = 0; k < 14; k++) {
      const t = 0.01 + Math.pow(Math.random(), 1.8) * 0.3;
      noiseBurst(o, t, 0.01, 'highpass', rand(2500, 5000), 0.7, 0.0002, 0.0012, rand(0.05, 0.2) * (1 - t * 2));
    }
  }
  return normalize(o, 0.85);
}

function synthWhizz() {
  const o = buf(0.35);
  const s0 = Math.floor(0.01 * SR);
  for (let i = 0; i < 40; i++) o[s0 + i] += (i < 20 ? 1 : -1) * (1 - Math.abs(i - 20) / 20) * 0.9;
  noiseBurst(o, 0.01, 0.02, 'highpass', 3000, 0.7, 0.0002, 0.003, 0.7);
  const len = Math.floor(0.25 * SR), bp = new Biquad('bandpass', 2500, 3);
  for (let i = 0; i < len; i++) {
    const k = i / len;
    if (i % 32 === 0) bp.set('bandpass', 2600 - k * 1700, 3);
    o[i] += bp.p(N()) * Math.sin(Math.PI * Math.min(1, k * 1.6)) * (1 - k) * 0.45;
  }
  return normalize(o, 0.85);
}

function synthCasing(kind) {
  const o = buf(0.5);
  const hits = [0, rand(0.1, 0.15), rand(0.21, 0.27), rand(0.3, 0.34)];
  hits.forEach((t, k) => {
    const g = [1, 0.55, 0.3, 0.15][k];
    if (kind === 'shell') {
      noiseBurst(o, t, 0.04, 'bandpass', 1100, 1.5, 0.0005, 0.01, g * 0.8);
      thump(o, t, 260, 180, 0.015, g * 0.4);
    } else {
      const f = kind === 'brass9' ? 1.25 : 1;
      modal(o, t, [3400 * f * rand(0.97, 1.03), 5600 * f, 7300 * f, 9100 * f], [0.06, 0.045, 0.03, 0.02], [0.4 * g, 0.3 * g, 0.2 * g, 0.12 * g]);
    }
  });
  return normalize(o, 0.6);
}

function formantVoice(o, t0, dur, f0a, f0b, formants, gain, breath = 0.15) {
  const s0 = Math.floor(t0 * SR), len = Math.min(o.length - s0, Math.floor(dur * SR));
  const flts = formants.map(([f, q]) => new Biquad('bandpass', f, q));
  const lp = new Biquad('lowpass', 3500, 0.7);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const k = i / len, f0 = f0a + (f0b - f0a) * k + Math.sin(i / SR * 30) * 2;
    ph += f0 / SR; if (ph > 1) ph -= 1;
    const src = lp.p((2 * ph - 1) * 0.8 + N() * breath);
    let s = 0;
    flts.forEach((f, j) => { s += f.p(src) * formants[j][2]; });
    const env = Math.min(1, k * 12) * Math.pow(1 - k, 1.5);
    o[s0 + i] += s * env * gain;
  }
}

function synthGrunt(death) {
  const o = buf(death ? 0.9 : 0.4);
  const f0 = rand(105, 135);
  if (death) {
    formantVoice(o, 0, 0.7, f0 * 1.1, f0 * 0.6, [[650, 6, 1], [1050, 7, 0.6], [2450, 8, 0.25]], 1.0, 0.25);
    noiseBurst(o, 0.55, 0.3, 'bandpass', 900, 1, 0.05, 0.12, 0.08);
  } else {
    formantVoice(o, 0, 0.2 + Math.random() * 0.08, f0 * 1.15, f0 * 0.85, [[rand(560, 700), 6, 1], [rand(1050, 1250), 7, 0.55], [2500, 8, 0.2]], 1.0, 0.3);
  }
  return normalize(o, 0.75);
}

function synthRadio(chatter) {
  const o = buf(chatter ? 1.5 : 0.3);
  click(o, 0, 2400, 0.4, 0.004);
  noiseBurst(o, 0.004, 0.14, 'bandpass', 1800, 0.8, 0.002, 0.09, 0.35);
  if (chatter) {
    const syl = 5 + Math.floor(Math.random() * 4);
    let t = 0.12;
    for (let k = 0; k < syl; k++) {
      const d = rand(0.08, 0.17);
      formantVoice(o, t, d, rand(115, 150), rand(100, 140), [[rand(500, 800), 5, 1], [rand(1000, 1900), 6, 0.7], [2500, 7, 0.3]], 0.9, 0.35);
      t += d + rand(0.01, 0.06);
    }
    // radio band-limit + grit
    const hp = new Biquad('highpass', 400, 0.7), lp = new Biquad('lowpass', 2800, 0.7);
    for (let i = 0; i < o.length; i++) o[i] = Math.tanh(lp.p(hp.p(o[i])) * 3) * 0.6 + N() * 0.01 * (i / SR < t ? 1 : 0);
    click(o, t + 0.02, 2200, 0.35, 0.004);
    noiseBurst(o, t + 0.025, 0.12, 'bandpass', 1800, 0.8, 0.002, 0.05, 0.3);
  }
  return normalize(o, 0.6);
}

function synthUI(kind) {
  const o = buf(kind === 'objective' ? 1.2 : 0.12);
  if (kind === 'click') { modal(o, 0, [1900], [0.012], [0.6]); noiseBurst(o, 0, 0.01, 'highpass', 3000, 0.7, 0.0002, 0.001, 0.3); }
  else if (kind === 'hover') { modal(o, 0, [2600], [0.006], [0.3]); }
  else if (kind === 'objective') { modal(o, 0, [660, 1320], [0.35, 0.2], [0.35, 0.1]); modal(o, 0.14, [990, 1980], [0.5, 0.25], [0.35, 0.08]); }
  return normalize(o, kind === 'hover' ? 0.35 : 0.6);
}

function synthMisc(kind) {
  if (kind === 'heart') {
    const o = buf(0.7);
    thump(o, 0, 70, 40, 0.06, 1); thump(o, 0.22, 60, 38, 0.07, 0.7);
    return normalize(o, 0.7);
  }
  if (kind === 'medkit') {
    const o = buf(0.8);
    scrape(o, 0, 0.3, 1200, 0.15); cloth(o, 0.2, 0.4, 0.12); click(o, 0.55, 1500, 0.4, 0.01);
    return normalize(o, 0.6);
  }
  if (kind === 'pickup') {
    const o = buf(0.4);
    cloth(o, 0, 0.18, 0.12); click(o, 0.12, 1700, 0.5, 0.012); click(o, 0.2, 2300, 0.4, 0.01);
    return normalize(o, 0.6);
  }
  if (kind === 'bodyfall') {
    const o = buf(0.8);
    noiseBurst(o, 0, 0.25, 'lowpass', 260, 0.9, 0.003, 0.06, 1.0);
    thump(o, 0, 90, 45, 0.08, 0.8);
    noiseBurst(o, 0.18, 0.2, 'lowpass', 400, 0.9, 0.003, 0.04, 0.4);
    return normalize(o, 0.8);
  }
  if (kind === 'gunDrop') {
    const o = buf(0.7);
    modal(o, 0, [900, 1650, 2700], [0.05, 0.04, 0.03], [0.4, 0.3, 0.2]);
    noiseBurst(o, 0, 0.05, 'bandpass', 1400, 1, 0.0005, 0.01, 0.6);
    modal(o, 0.18, [950, 1700], [0.04, 0.03], [0.15, 0.1]);
    return normalize(o, 0.6);
  }
  if (kind === 'creak') {
    const o = buf(1.6);
    const len = o.length, bp = new Biquad('bandpass', 400, 12);
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const k = i / len, f = 90 + Math.sin(k * 9) * 12 + k * 25;
      ph += f / SR; if (ph > 1) ph -= 1;
      const pulse = ph < 0.08 ? 1 : 0;
      o[i] = bp.p(pulse + N() * 0.05) * Math.sin(Math.PI * k);
    }
    return normalize(o, 0.5);
  }
  if (kind === 'drip') {
    const o = buf(0.15);
    const len = o.length;
    let ph = 0;
    for (let i = 0; i < len; i++) { const t = i / SR, f = 1500 - t * 7000; ph += (TAU * Math.max(300, f)) / SR; o[i] = Math.sin(ph) * E(t, 0.001, 0.02); }
    return normalize(o, 0.4);
  }
  if (kind === 'rumble') {
    const o = buf(3);
    noiseBurst(o, 0, 3, 'lowpass', 120, 0.7, 0.3, 0.8, 1.0);
    return normalize(o, 0.6);
  }
  if (kind === 'cloth') {
    const o = buf(0.5);
    cloth(o, 0, 0.35, 0.14);
    return normalize(o, 0.5);
  }
  if (kind === 'click') {
    const o = buf(0.08);
    click(o, 0, 3000, 0.5, 0.004);
    return normalize(o, 0.5);
  }
  if (kind === 'pigeons') {
    const o = buf(1.6);
    for (let k = 0; k < 26; k++) noiseBurst(o, k * 0.055 + rand(0, 0.02), 0.04, 'bandpass', rand(500, 900), 1, 0.004, 0.012, 0.6 * (1 - k / 30));
    return normalize(o, 0.5);
  }
  return buf(0.1);
}

function makeLoop(kind, seconds) {
  const o = buf(seconds);
  if (kind === 'wind') {
    let b = 0;
    for (let i = 0; i < o.length; i++) { b = b * 0.985 + N() * 0.015; o[i] = b; }
  } else if (kind === 'room') {
    const lp = new Biquad('lowpass', 160, 0.7);
    for (let i = 0; i < o.length; i++) o[i] = lp.p(N()) + Math.sin((TAU * 50 * i) / SR) * 0.02;
  } else if (kind === 'generator') {
    const lp = new Biquad('lowpass', 900, 0.8);
    for (let i = 0; i < o.length; i++) {
      const t = i / SR;
      const saw = ((t * 30) % 1) * 2 - 1;
      o[i] = lp.p(saw * 0.5 + Math.sin(TAU * 60 * t) * 0.3 + Math.sin(TAU * 120 * t) * 0.15 + N() * 0.25) * (0.8 + 0.2 * Math.sin(TAU * 7.5 * t));
    }
  } else if (kind === 'buzz') {
    for (let i = 0; i < o.length; i++) {
      const t = i / SR;
      o[i] = Math.sin(TAU * 100 * t) * 0.4 + Math.sin(TAU * 200 * t) * 0.25 + Math.sin(TAU * 300 * t) * 0.12 + N() * 0.03;
    }
  }
  // crossfade loop seam
  const f = Math.floor(0.2 * SR);
  for (let i = 0; i < f; i++) { const k = i / f; o[i] = o[i] * k + o[o.length - f + i] * (1 - k); }
  return normalize(o.subarray(0, o.length - f), 0.8, false);
}

function makeIR(ctx, seconds, outdoor) {
  const len = Math.floor(seconds * ctx.sampleRate), sr = ctx.sampleRate;
  const ir = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      let v;
      if (outdoor) {
        v = N() * Math.exp(-t / 0.7) * 0.18 * Math.min(1, t / 0.05);
        const k = 0.35 + 0.6 * Math.min(1, t / 1.2);
        lp = lp * k + v * (1 - k);
        v = lp * 2.2;
      } else {
        v = N() * Math.exp(-t / 0.34) * Math.min(1, t / 0.006);
        const k = 0.15 + 0.75 * Math.min(1, t / 1.6);
        lp = lp * k + v * (1 - k);
        v = lp;
      }
      d[i] = v;
    }
    const echoes = outdoor ? [[0.085, 0.45], [0.16, 0.32], [0.29, 0.25], [0.47, 0.18], [0.74, 0.12], [1.1, 0.07]] : [[0.007, 0.5], [0.013, 0.4], [0.021, 0.35], [0.034, 0.28]];
    for (const [t, a] of echoes) {
      const s = Math.floor((t + (ch ? 0.004 : 0)) * sr);
      for (let k = 0; k < 400 && s + k < len; k++) d[s + k] += N() * a * Math.exp(-k / 90) * (outdoor ? 0.6 : 1);
    }
  }
  return ir;
}

// sounds that only exist once the mountain set is generated fall back to their closest depot sound
const FALLBACK = { step_dirt: 'step_asphalt', step_grass: 'step_asphalt', step_gravel: 'step_concrete', crack: 'whizz', radioSquelch: 'radio', cloth: 'adsIn' };

// ------------------------------------------------------------------ engine

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.buffers = {};
    this.active = 0;
    this.volume = 0.8;
    this.listener = { x: 0, y: 0, z: 0 };
    this.indoor = 0;
    this.hrtf = false;
  }

  /** Synthesises every sound. Split into chunks so the loading bar can update. */
  async generate(progress) {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    const jobs = [];
    const add = (name, count, fn) => jobs.push([name, count, fn]);
    add('rifle', 4, () => synthGunshot(vary(GUNS.rifle)));
    add('pistol', 3, () => synthGunshot(vary(GUNS.pistol)));
    add('shotgun', 3, () => synthGunshot(vary(GUNS.shotgun)));
    add('enemyShot', 4, () => synthGunshot(vary(GUNS.enemy, 0.1)));
    for (const m of ['magOut', 'magIn', 'boltRelease', 'slideRack', 'slideRelease', 'pumpBack', 'pumpFwd', 'shellIn', 'dry', 'draw', 'adsIn', 'switchMode']) add(m, 2, () => synthMech(m));
    for (const s of ['concrete', 'metal', 'asphalt', 'wood']) add('step_' + s, 5, () => synthStep(s));
    for (const s of ['concrete', 'metal', 'wood', 'flesh', 'glass', 'dirt']) add('impact_' + s, 3, () => synthImpact(s));
    add('whizz', 3, synthWhizz);
    add('casing_brass', 4, () => synthCasing('brass'));
    add('casing_brass9', 3, () => synthCasing('brass9'));
    add('casing_shell', 3, () => synthCasing('shell'));
    add('grunt', 5, () => synthGrunt(false));
    add('death', 3, () => synthGrunt(true));
    add('radio', 2, () => synthRadio(false));
    add('chatter', 4, () => synthRadio(true));
    for (const u of ['click', 'hover', 'objective']) add('ui_' + u, 1, () => synthUI(u));
    for (const m of ['heart', 'medkit', 'pickup', 'bodyfall', 'gunDrop', 'creak', 'drip', 'rumble', 'pigeons', 'cloth', 'click']) add(m, m === 'drip' || m === 'creak' ? 3 : 1, () => synthMisc(m));
    add('loop_wind', 1, () => makeLoop('wind', 8));
    add('loop_room', 1, () => makeLoop('room', 5));
    add('loop_generator', 1, () => makeLoop('generator', 2.2));
    add('loop_buzz', 1, () => makeLoop('buzz', 1.2));
    await this.runJobs(jobs, progress);
    this.buildGraph();
    this.ready = true;
  }

  async runJobs(jobs, progress) {
    for (let j = 0; j < jobs.length; j++) {
      const [name, count, fn] = jobs[j];
      this.buffers[name] = [];
      for (let k = 0; k < count; k++) {
        const data = fn();
        const b = this.ctx.createBuffer(1, data.length, SR);
        b.copyToChannel(data, 0);
        this.buffers[name].push(b);
      }
      if (j % 6 === 5 && progress) await progress(j / jobs.length);
    }
  }

  /** Sounds only the mountain needs (built when that world is first loaded). */
  async generateMountain(progress) {
    if (this.mountainReady || !this.ctx) return;
    const jobs = [];
    const add = (name, count, fn) => jobs.push([name, count, fn]);
    add('sniper', 3, () => synthGunshot(vary(GUNS.sniper, 0.05)));
    add('dmr', 3, () => synthGunshot(vary(GUNS.dmr, 0.05)));
    add('akShot', 4, () => synthGunshot(vary(GUNS.ak, 0.1)));
    add('svdShot', 3, () => synthGunshot(vary(GUNS.svd, 0.08)));
    add('m4Shot', 4, () => synthGunshot(vary(GUNS.m4, 0.08)));
    add('dmrShot', 3, () => synthGunshot(vary(GUNS.dmr, 0.08)));
    add('crack', 4, synthCrack);
    for (const b of ['boltUp', 'boltBack', 'boltFwd', 'boltDown']) add(b, 2, () => synthBolt(b));
    add('bandageRip', 2, () => synthMedical('bandageRip'));
    add('bandageWrap', 3, () => synthMedical('bandageWrap'));
    add('breathIn', 2, () => synthBreath(true));
    add('breathOut', 2, () => synthBreath(false));
    add('radioSquelch', 3, synthSquelch);
    for (const sf of ['grass', 'gravel', 'dirt']) add('step_' + sf, 5, () => synthStepNature(sf));
    add('heloFar', 1, () => synthHelo(true));
    add('heloLoop', 1, () => synthHelo(false));
    add('rockfall', 2, synthRockfall);
    await this.runJobs(jobs, progress);
    this.irMountain = makeMountainIR(this.ctx);
    this.mountainReady = true;
  }

  /** Outdoor acoustics per world: the depot yard or the mountain valleys (long echoes). */
  setEnvironment(id) {
    this.env = id;
    if (!this.ready) return;
    if (id === 'mountain' && this.irMountain) { this.revOut.buffer = this.irMountain; this.revOutGain.gain.value = 0.9; }
    else if (this.irDepot) { this.revOut.buffer = this.irDepot; this.revOutGain.gain.value = 0.7; }
  }

  /** A looping positional source (helicopter). Returns { set(pos, volume), stop() }. */
  loop(name, opts = {}) {
    if (!this.ready || !this.buffers[name]) return { set() {}, stop() {} };
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.buffers[name][0];
    src.loop = true;
    const g = c.createGain();
    g.gain.value = opts.volume ?? 1;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 18000;
    const p = c.createPanner();
    p.panningModel = 'equalpower'; p.distanceModel = 'inverse'; p.refDistance = opts.ref || 30; p.rolloffFactor = opts.rolloff ?? 1; p.maxDistance = 5000;
    src.connect(f).connect(g).connect(p).connect(this.sfx);
    const sOut = c.createGain(); sOut.gain.value = opts.reverb ?? 0.3;
    p.connect(sOut).connect(this.revOut);
    src.start();
    const L = this.listener;
    return {
      set: (pos, vol) => {
        const t = c.currentTime;
        if (p.positionX) { p.positionX.setTargetAtTime(pos.x, t, 0.05); p.positionY.setTargetAtTime(pos.y, t, 0.05); p.positionZ.setTargetAtTime(pos.z, t, 0.05); }
        else p.setPosition(pos.x, pos.y, pos.z);
        g.gain.setTargetAtTime(vol, t, 0.2);
        const d = Math.hypot(pos.x - L.x, pos.y - L.y, pos.z - L.z);
        f.frequency.setTargetAtTime(19000 * Math.exp(-d / 350) + 500, t, 0.2);
      },
      stop: () => { try { g.gain.setTargetAtTime(0, c.currentTime, 0.3); src.stop(c.currentTime + 1.2); } catch (e) { /* stopped */ } },
    };
  }

  buildGraph() {
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = this.volume;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.002; comp.release.value = 0.2;
    this.master.connect(comp).connect(c.destination);
    this.sfx = c.createGain();
    this.muffle = c.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.sfx.connect(this.muffle).connect(this.master);
    this.ui = c.createGain();
    this.ui.connect(this.master);
    this.amb = c.createGain();
    this.amb.gain.value = 1;
    this.amb.connect(this.master);
    this.revIn = c.createConvolver();
    this.revIn.buffer = makeIR(c, 2.0, false);
    this.revOut = c.createConvolver();
    this.irDepot = makeIR(c, 2.6, true);
    this.revOut.buffer = this.irDepot;
    this.revInGain = c.createGain(); this.revInGain.gain.value = 0.55;
    this.revOutGain = c.createGain(); this.revOutGain.gain.value = 0.7;
    this.revIn.connect(this.revInGain).connect(this.muffle);
    this.revOut.connect(this.revOutGain).connect(this.muffle);
    this.hrtf = !(/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent));
  }

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (e) { /* ignored */ } }
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setListener(pos, fwd, up) {
    if (!this.ready) return;
    const L = this.ctx.listener, t = this.ctx.currentTime;
    this.listener.x = pos.x; this.listener.y = pos.y; this.listener.z = pos.z;
    if (L.positionX) {
      L.positionX.setValueAtTime(pos.x, t); L.positionY.setValueAtTime(pos.y, t); L.positionZ.setValueAtTime(pos.z, t);
      L.forwardX.setValueAtTime(fwd.x, t); L.forwardY.setValueAtTime(fwd.y, t); L.forwardZ.setValueAtTime(fwd.z, t);
      L.upX.setValueAtTime(up.x, t); L.upY.setValueAtTime(up.y, t); L.upZ.setValueAtTime(up.z, t);
    } else {
      L.setPosition(pos.x, pos.y, pos.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  /** 0 = outdoors, 1 = inside the building (drives ambience & reverb mix). */
  setIndoor(f) { this.indoor = f; }

  setMuffle(amount) {
    if (!this.ready) return;
    const f = 20000 * Math.pow(0.04, amount);
    this.muffle.frequency.setTargetAtTime(Math.max(500, f), this.ctx.currentTime, 0.15);
  }

  /**
   * Plays a sound. opts: pos {x,y,z}, volume, rate, rateVar, ref, rolloff, occluded (bool),
   * reverb (send 0..1), indoor (0..1 for the source), delay (s), priority ('low' can be dropped), ui (bool)
   */
  play(name, opts = {}) {
    if (!this.ready || this.ctx.state !== 'running') return null;
    let list = this.buffers[name];
    if (!list || !list.length) list = this.buffers[FALLBACK[name]];
    if (!list || !list.length) return null;
    if (opts.priority === 'low' && this.active > 28) return null;
    if (this.active > 48) return null;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = choice(list);
    const rv = opts.rateVar ?? 0.04;
    src.playbackRate.value = (opts.rate || 1) * (1 + (Math.random() * 2 - 1) * rv);
    const g = c.createGain();
    g.gain.value = opts.volume ?? 1;
    let head = src;
    let dist = 0;
    if (opts.pos) {
      const dx = opts.pos.x - this.listener.x, dy = opts.pos.y - this.listener.y, dz = opts.pos.z - this.listener.z;
      dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let cutoff = 19000 * Math.exp(-dist / 70) + 900;
      if (opts.occluded) { cutoff *= 0.22; g.gain.value *= 0.55; }
      if (cutoff < 16000) {
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = cutoff;
        head.connect(f);
        head = f;
      }
    }
    head.connect(g);
    let out = g;
    if (opts.pos) {
      const p = c.createPanner();
      p.panningModel = this.hrtf ? 'HRTF' : 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = opts.distant ? Math.max(opts.ref || 2, 14) : opts.ref || 2;
      p.rolloffFactor = opts.distant ? 0.55 : opts.rolloff ?? 1;
      p.maxDistance = opts.distant ? 3000 : 250;
      if (p.positionX) { p.positionX.value = opts.pos.x; p.positionY.value = opts.pos.y; p.positionZ.value = opts.pos.z; }
      else p.setPosition(opts.pos.x, opts.pos.y, opts.pos.z);
      g.connect(p);
      out = p;
    }
    out.connect(opts.ui ? this.ui : this.sfx);
    const rev = opts.reverb ?? 0.25;
    if (rev > 0 && !opts.ui) {
      const ind = opts.indoor ?? this.indoor;
      const sIn = c.createGain(), sOut = c.createGain();
      const far = Math.min(1, dist / 40);
      const vast = opts.distant ? Math.min(1, dist / 400) : 0;
      sIn.gain.value = rev * ind * (1 + far);
      sOut.gain.value = rev * (1 - ind) * (1 + far * 1.5 + vast * 2.5);
      out.connect(sIn).connect(this.revIn);
      out.connect(sOut).connect(this.revOut);
    }
    const when = c.currentTime + (opts.delay || 0) + (opts.pos && opts.soundDelay ? dist / 343 : 0);
    src.start(when);
    this.active++;
    src.onended = () => { this.active--; };
    return src;
  }

  playUI(name) { return this.play('ui_' + name, { ui: true, reverb: 0, rateVar: 0.02 }); }

  // ------------------------------------------------------------------ ambience

  startAmbience(sources) {
    if (!this.ready || this.ambNodes) return;
    const c = this.ctx;
    const loop = (name, gain) => {
      const s = c.createBufferSource();
      s.buffer = this.buffers[name][0];
      s.loop = true;
      const g = c.createGain();
      g.gain.value = gain;
      s.connect(g);
      s.start();
      return { s, g };
    };
    const wind = loop('loop_wind', 0);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 380; bp.Q.value = 0.6;
    wind.g.connect(bp).connect(this.amb);
    const whistle = c.createBiquadFilter();
    whistle.type = 'bandpass'; whistle.frequency.value = 1150; whistle.Q.value = 14;
    const wg = c.createGain(); wg.gain.value = 0;
    wind.g.connect(whistle).connect(wg).connect(this.amb);
    const room = loop('loop_room', 0);
    room.g.connect(this.amb);
    const positional = (name, pos, gain, ref) => {
      const l = loop(name, gain);
      const p = c.createPanner();
      p.panningModel = 'equalpower'; p.distanceModel = 'inverse'; p.refDistance = ref; p.rolloffFactor = 1.6;
      if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z);
      l.g.connect(p).connect(this.amb);
      return l;
    };
    const gen = sources.generator ? positional('loop_generator', sources.generator, 0.35, 1.5) : null;
    const buzz = sources.buzz ? positional('loop_buzz', sources.buzz, 0.05, 1.0) : null;
    this.ambNodes = { wind, bp, wg, room, gen, buzz };
    this.ambTimer = { creak: 8, drip: 3, rumble: 25 };
  }

  stopAmbience() {
    if (!this.ambNodes) return;
    for (const n of Object.values(this.ambNodes)) if (n && n.s) { try { n.s.stop(); } catch (e) { /* ignore */ } }
    this.ambNodes = null;
  }

  updateAmbience(dt, time, buzzLevel, worldGust = 1) {
    const a = this.ambNodes;
    if (!a) return;
    const t = this.ctx.currentTime;
    const mtn = this.env === 'mountain';
    const gust = (0.55 + 0.45 * Math.sin(time * 0.13) * Math.sin(time * 0.071 + 1.3)) * (mtn ? 0.6 + worldGust * 0.55 : 1);
    a.wind.g.gain.setTargetAtTime((mtn ? 0.95 - this.indoor * 0.5 : 0.5 - this.indoor * 0.32) * gust, t, 0.4);
    a.bp.frequency.setTargetAtTime((mtn ? 360 : 300) + gust * (mtn ? 420 : 260), t, 0.5);
    a.wg.gain.setTargetAtTime((mtn ? 0.035 + this.indoor * 0.06 : this.indoor * 0.05) * gust, t, 0.5);
    a.room.g.gain.setTargetAtTime(this.indoor * (mtn ? 0.08 : 0.22), t, 0.5);
    if (a.gen) a.gen.g.gain.setTargetAtTime(mtn ? 0 : 0.35, t, 0.1);
    if (a.buzz) a.buzz.g.gain.setTargetAtTime(mtn ? 0 : 0.05 * buzzLevel, t, 0.02);
    if (mtn) {
      const T = this.ambTimer;
      T.rock = (T.rock ?? 20) - dt;
      if (T.rock <= 0) {
        T.rock = rand(25, 60);
        const L = this.listener, a2 = rand(0, 6.28), d = rand(40, 160);
        this.play('rockfall', { pos: { x: L.x + Math.cos(a2) * d, y: L.y + rand(5, 40), z: L.z + Math.sin(a2) * d }, volume: 0.5, ref: 12, reverb: 0.6, priority: 'low', distant: true });
      }
      return;
    }
    const T = this.ambTimer;
    T.creak -= dt; T.drip -= dt; T.rumble -= dt;
    const L = this.listener;
    if (T.creak <= 0) {
      T.creak = rand(14, 32);
      if (this.indoor > 0.5) this.play('creak', { pos: { x: L.x + rand(-12, 12), y: 6.5, z: L.z + rand(-12, 12) }, volume: 0.3, rate: rand(0.8, 1.2), ref: 6, reverb: 0.7, priority: 'low' });
    }
    if (T.drip <= 0) {
      T.drip = rand(2, 6);
      if (this.indoor > 0.5) this.play('drip', { pos: { x: L.x + rand(-6, 6), y: 0.1, z: L.z + rand(-6, 6) }, volume: 0.18, rate: rand(0.85, 1.2), ref: 1.5, reverb: 0.6, priority: 'low' });
    }
    if (T.rumble <= 0) {
      T.rumble = rand(35, 70);
      this.play('rumble', { volume: 0.25 + (1 - this.indoor) * 0.2, reverb: 0.4, rate: rand(0.7, 1.1), priority: 'low' });
    }
  }
}
