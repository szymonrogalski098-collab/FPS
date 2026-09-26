// Procedural PBR texture generation (albedo + normal + roughness/metalness) on the CPU.
// Everything is tileable and generated once at load, so the game ships with zero image assets.
import * as THREE from 'three';
import { mulberry32, smoothstep, clamp } from './util.js';

function valueNoise(S, freq, rng) {
  const lat = new Float32Array(freq * freq);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();
  const out = new Float32Array(S * S);
  const scale = freq / S;
  for (let y = 0; y < S; y++) {
    const fy = y * scale, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
    const r0 = (y0 % freq) * freq, r1 = ((y0 + 1) % freq) * freq;
    for (let x = 0; x < S; x++) {
      const fx = x * scale, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
      const c0 = x0 % freq, c1 = (x0 + 1) % freq;
      const a = lat[r0 + c0], b = lat[r0 + c1], c = lat[r1 + c0], d = lat[r1 + c1];
      const top = a + (b - a) * sx;
      const bot = c + (d - c) * sx;
      out[y * S + x] = top + (bot - top) * sy;
    }
  }
  return out;
}

function fbmField(S, baseFreq, octaves, gain, rng) {
  const out = new Float32Array(S * S);
  let amp = 1, f = baseFreq;
  for (let o = 0; o < octaves && f <= S; o++) {
    const n = valueNoise(S, f, rng);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    amp *= gain;
    f *= 2;
  }
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < out.length; i++) { if (out[i] < mn) mn = out[i]; if (out[i] > mx) mx = out[i]; }
  const inv = 1 / (mx - mn || 1);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - mn) * inv;
  return out;
}

function dataTexture(bytes, w, h, srgb, wrap = true) {
  const t = new THREE.DataTexture(new Uint8Array(bytes.buffer), w, h, THREE.RGBAFormat);
  t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export class TextureFactory {
  constructor(size = 512, anisotropy = 4) {
    this.S = size;
    this.m = size - 1;
    this.aniso = anisotropy;
    const rng = mulberry32(7331);
    this.L = fbmField(size, 4, 5, 0.55, rng);
    this.M = fbmField(size, 16, 4, 0.5, rng);
    this.F = fbmField(size, 64, 2, 0.5, rng);
    this.W = new Float32Array(size * size);
    for (let i = 0; i < this.W.length; i++) this.W[i] = rng();
  }

  s(field, x, y) { return field[(y & this.m) * this.S + (x & this.m)]; }

  /** Runs a per-pixel shader function and packs the outputs into PBR textures. */
  make(fn, { normal = 1, rough = true } = {}) {
    const S = this.S, N = S * S;
    const col = new Uint8ClampedArray(N * 4);
    const hgt = new Float32Array(N);
    const rm = rough ? new Uint8ClampedArray(N * 4) : null;
    const o = { r: 0, g: 0, b: 0, a: 1, h: 0.5, rough: 0.8, metal: 0 };
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        o.a = 1; o.h = 0.5; o.rough = 0.8; o.metal = 0;
        fn(x, y, i, o);
        const j = i * 4;
        col[j] = o.r * 255; col[j + 1] = o.g * 255; col[j + 2] = o.b * 255; col[j + 3] = o.a * 255;
        hgt[i] = o.h;
        if (rm) { rm[j] = 255; rm[j + 1] = o.rough * 255; rm[j + 2] = o.metal * 255; rm[j + 3] = 255; }
      }
    }
    const map = dataTexture(col, S, S, true);
    map.anisotropy = this.aniso;
    const normalMap = normal > 0 ? dataTexture(this.heightToNormal(hgt, S, S, normal), S, S, false) : null;
    if (normalMap) normalMap.anisotropy = this.aniso;
    const roughMap = rm ? dataTexture(rm, S, S, false) : null;
    return { map, normalMap, roughMap };
  }

  heightToNormal(h, W, H, strength) {
    const out = new Uint8ClampedArray(W * H * 4);
    const s = strength * (W / 256);
    for (let y = 0; y < H; y++) {
      const yu = ((y + 1) % H) * W, yd = ((y - 1 + H) % H) * W, yr = y * W;
      for (let x = 0; x < W; x++) {
        const xr = (x + 1) % W, xl = (x - 1 + W) % W;
        let nx = -(h[yr + xr] - h[yr + xl]) * s;
        let ny = -(h[yu + x] - h[yd + x]) * s;
        let nz = 1;
        const inv = 1 / Math.hypot(nx, ny, nz);
        nx *= inv; ny *= inv; nz *= inv;
        const j = (yr + x) * 4;
        out[j] = (nx * 0.5 + 0.5) * 255;
        out[j + 1] = (ny * 0.5 + 0.5) * 255;
        out[j + 2] = (nz * 0.5 + 0.5) * 255;
        out[j + 3] = 255;
      }
    }
    return out;
  }

  crackMask(count, maxLen, seed) {
    const S = this.S, m = this.m, rng = mulberry32(seed);
    const out = new Float32Array(S * S);
    const put = (x, y, v) => { const k = (y & m) * S + (x & m); if (out[k] < v) out[k] = v; };
    for (let c = 0; c < count; c++) {
      let x = rng() * S, y = rng() * S, a = rng() * Math.PI * 2;
      const len = maxLen * (0.4 + 0.6 * rng());
      for (let s = 0; s < len; s++) {
        a += (rng() - 0.5) * 0.55;
        x += Math.cos(a); y += Math.sin(a);
        const xi = Math.round(x), yi = Math.round(y);
        put(xi, yi, 1);
        put(xi + 1, yi, 0.35); put(xi, yi + 1, 0.35);
        if (rng() < 0.015) a += (rng() - 0.5) * 2.2;
      }
    }
    return out;
  }

  scratchMask(count, maxLen, seed) {
    const S = this.S, m = this.m, rng = mulberry32(seed);
    const out = new Float32Array(S * S);
    for (let c = 0; c < count; c++) {
      const x0 = rng() * S, y0 = rng() * S, a = rng() * Math.PI * 2, len = maxLen * rng();
      const dx = Math.cos(a), dy = Math.sin(a), v = 0.4 + rng() * 0.6;
      for (let s = 0; s < len; s++) {
        const k = (Math.round(y0 + dy * s) & m) * S + (Math.round(x0 + dx * s) & m);
        out[k] = Math.max(out[k], v);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- surfaces

  concreteFloor() {
    const S = this.S, cr = this.crackMask(7, S * 0.45, 11);
    const jw = Math.max(1.2, S * 0.0035);
    return this.make((x, y, i, o) => {
      const L = this.L[i], L2 = this.s(this.L, x + 211, y + 97), M = this.M[i], F = this.F[i], W = this.W[i];
      let c = 0.5 + (L - 0.5) * 0.17 + (M - 0.5) * 0.1 + (F - 0.5) * 0.07 + (W - 0.5) * 0.05;
      if (W > 0.985) c += 0.07; else if (W < 0.012) c -= 0.09;
      const stain = smoothstep(0.6, 0.82, L2);
      const tyre = smoothstep(0.55, 0.7, this.s(this.L, x * 4, y + 33)) * 0.15;
      c *= 1 - stain * 0.42 - tyre * 0.4;
      const jx = Math.min(x, S - x), jy = Math.min(y, S - y);
      const joint = Math.max(1 - smoothstep(0, jw, jx), 1 - smoothstep(0, jw, jy));
      c *= 1 - joint * 0.55;
      c *= 1 - cr[i] * 0.45;
      o.r = c; o.g = c * 0.985; o.b = c * 0.955;
      o.h = 0.5 + (M - 0.5) * 0.25 + (F - 0.5) * 0.35 + (W - 0.5) * 0.12 - joint * 0.7 - cr[i] * 0.45;
      o.rough = clamp(0.84 + (M - 0.5) * 0.14 - stain * 0.5, 0.25, 1);
    }, { normal: 1.4 });
  }

  concreteWall() {
    const S = this.S, cr = this.crackMask(4, S * 0.3, 23);
    const holeR = Math.max(2, S * 0.007);
    return this.make((x, y, i, o) => {
      const L = this.L[i], M = this.M[i], F = this.F[i], W = this.W[i];
      const streak = this.s(this.L, x * 4 + 50, y + 170);
      let c = 0.6 + (L - 0.5) * 0.14 + (M - 0.5) * 0.08 + (F - 0.5) * 0.06 + (W - 0.5) * 0.04;
      c *= 1 - smoothstep(0.45, 0.85, streak) * 0.22;
      // tilt-up panel seam + form-tie holes on a 1 m grid
      const seam = 1 - smoothstep(0, Math.max(1.2, S * 0.003), Math.min(x, S - x));
      const cell = S / 4;
      const hx = (x % cell) - cell / 2, hy = (y % cell) - cell / 2;
      const hole = 1 - smoothstep(holeR * 0.6, holeR, Math.hypot(hx, hy));
      const pit = W > 0.992 ? 1 : 0;
      c *= 1 - seam * 0.5 - hole * 0.45 - pit * 0.25 - cr[i] * 0.35;
      o.r = c * 0.99; o.g = c * 0.975; o.b = c * 0.95;
      o.h = 0.5 + (M - 0.5) * 0.2 + (F - 0.5) * 0.3 + (W - 0.5) * 0.08 - seam * 0.6 - hole * 0.8 - pit * 0.3 - cr[i] * 0.3;
      o.rough = 0.9 - smoothstep(0.6, 0.9, streak) * 0.1;
    }, { normal: 1.3 });
  }

  /** Painted concrete-block (CMU) wall. White-ish so material.color picks the paint. */
  paintedBlock() {
    const S = this.S, bw = S / 4, bh = S / 8, mw = Math.max(1.2, S * 0.004);
    return this.make((x, y, i, o) => {
      const L2 = this.s(this.L, x + 300, y + 41), L = this.L[i], M = this.M[i], F = this.F[i], W = this.W[i];
      const row = Math.floor(y / bh);
      const bx = (x + (row % 2) * bw * 0.5) % bw, by = y % bh;
      const dx = Math.min(bx, bw - bx), dy = Math.min(by, bh - by);
      const mortar = 1 - smoothstep(mw * 0.4, mw, Math.min(dx, dy));
      const peel = smoothstep(0.7, 0.74, L2 * 0.8 + F * 0.25);
      const grime = smoothstep(0.35, 0.9, L) * 0.18 + (M - 0.5) * 0.06;
      let paint = 0.9 - grime - (W - 0.5) * 0.03;
      const blockGrey = 0.5 + (F - 0.5) * 0.12;
      let c = paint * (1 - peel) + blockGrey * peel;
      c *= 1 - mortar * 0.28;
      o.r = c; o.g = c; o.b = c * 0.98;
      o.h = 0.55 - mortar * 0.5 - peel * 0.15 + (F - 0.5) * 0.12 + (W - 0.5) * 0.05;
      o.rough = 0.62 * (1 - peel) + 0.92 * peel + grime * 0.3;
    }, { normal: 1.1 });
  }

  corrugated() {
    const S = this.S;
    return this.make((x, y, i, o) => {
      const L = this.L[i], L2 = this.s(this.L, x + 17, y + 400), M = this.M[i], F = this.F[i];
      const ph = (x / S) * 16 * Math.PI * 2;
      const ridge = 0.5 + 0.5 * Math.sin(ph);
      const streak = this.s(this.L, x * 4 + 91, y);
      const rust = smoothstep(0.58, 0.86, streak * 0.55 + L2 * 0.6 + (F - 0.5) * 0.2);
      const base = 0.82 - (M - 0.5) * 0.1 - smoothstep(0.4, 0.9, L) * 0.12;
      o.r = base * (1 - rust) + 0.44 * rust;
      o.g = base * (1 - rust) + 0.26 * rust;
      o.b = base * (1 - rust) + 0.15 * rust;
      o.h = ridge * 0.9 + (F - 0.5) * 0.05 * (1 + rust * 3);
      o.rough = 0.5 + (M - 0.5) * 0.2 + rust * 0.4;
      o.metal = 0.7 * (1 - rust);
    }, { normal: 2.2 });
  }

  steelPaint() {
    const S = this.S, sc = this.scratchMask(60, S * 0.08, 5);
    return this.make((x, y, i, o) => {
      const L = this.L[i], M = this.M[i], F = this.F[i], W = this.W[i];
      const chip = smoothstep(0.74, 0.78, F * 0.7 + this.s(this.M, x + 60, y + 11) * 0.45);
      const worn = Math.max(chip, sc[i] * 0.8);
      const grime = smoothstep(0.4, 0.95, L) * 0.22;
      const paint = 0.86 - grime - (M - 0.5) * 0.05 - (W - 0.5) * 0.02;
      const steel = 0.32 + (F - 0.5) * 0.1;
      const c = paint * (1 - worn) + steel * worn;
      o.r = c; o.g = c; o.b = c;
      o.h = 0.5 - chip * 0.3 - sc[i] * 0.15 + (F - 0.5) * 0.05;
      o.rough = 0.55 * (1 - worn) + 0.38 * worn + grime * 0.3;
      o.metal = worn * 0.9;
    }, { normal: 0.9 });
  }

  bareMetal() {
    const S = this.S, sc = this.scratchMask(140, S * 0.12, 9);
    return this.make((x, y, i, o) => {
      const L = this.L[i], M = this.M[i], F = this.F[i];
      const brushed = this.s(this.F, x, y * 8 + 7);
      const c = 0.62 + (brushed - 0.5) * 0.08 + (M - 0.5) * 0.08 - smoothstep(0.5, 0.95, L) * 0.18 + sc[i] * 0.1;
      o.r = c; o.g = c; o.b = c * 1.01;
      o.h = 0.5 + (brushed - 0.5) * 0.1 - sc[i] * 0.2;
      o.rough = 0.35 + (M - 0.5) * 0.15 + smoothstep(0.5, 0.95, L) * 0.3 - sc[i] * 0.1;
      o.metal = 1;
    }, { normal: 0.5 });
  }

  wood() {
    const S = this.S, boards = 5, bh = S / boards, sw = Math.max(1.2, S * 0.004);
    return this.make((x, y, i, o) => {
      const board = Math.floor(y / bh);
      const by = y % bh;
      const seam = 1 - smoothstep(0, sw, Math.min(by, bh - by));
      const g = this.s(this.L, x + board * 97, y * 8 + board * 31);
      const grain = 0.5 + 0.5 * Math.sin(g * 38 + board * 2.3);
      const knot = smoothstep(0.93, 0.99, this.s(this.M, x + board * 50, y * 2));
      const bv = 0.88 + ((board * 7919) % 13) / 13 * 0.2;
      const F = this.F[i], W = this.W[i];
      let c = bv * (0.78 + grain * 0.18 + (F - 0.5) * 0.08 + (W - 0.5) * 0.04) * (1 - knot * 0.45);
      c *= 1 - seam * 0.6;
      const dirt = smoothstep(0.5, 0.95, this.L[i]) * 0.25;
      c *= 1 - dirt;
      o.r = c * 0.86; o.g = c * 0.66; o.b = c * 0.44;
      o.h = 0.5 + grain * 0.12 - seam * 0.7 + (F - 0.5) * 0.1;
      o.rough = 0.78 + dirt * 0.2;
    }, { normal: 1.1 });
  }

  asphalt() {
    const S = this.S, cr = this.crackMask(10, S * 0.5, 71);
    return this.make((x, y, i, o) => {
      const L = this.L[i], L2 = this.s(this.L, x + 150, y + 260), M = this.M[i], F = this.F[i], W = this.W[i];
      let c = 0.2 + (L - 0.5) * 0.06 + (M - 0.5) * 0.05 + (W - 0.5) * 0.07;
      if (W > 0.92) c += 0.09 * (W - 0.92) / 0.08;
      const puddle = smoothstep(0.68, 0.73, L2);
      const oil = smoothstep(0.72, 0.85, this.s(this.M, x + 33, y + 90)) * 0.4;
      c *= 1 - puddle * 0.35 - oil * 0.4 - cr[i] * 0.4;
      const dust = smoothstep(0.4, 0.8, this.s(this.L, x + 500, y + 20)) * 0.07;
      o.r = c + dust * 1.05; o.g = c + dust; o.b = c * 1.02 + dust * 0.85;
      o.h = 0.5 + (W - 0.5) * 0.35 * (1 - puddle) + (F - 0.5) * 0.3 * (1 - puddle) - cr[i] * 0.5;
      o.rough = clamp(0.93 - puddle * 0.88 - oil * 0.4 + (M - 0.5) * 0.05, 0.04, 1);
    }, { normal: 1.6 });
  }

  checkerPlate() {
    const S = this.S, cells = 8, cs = S / cells;
    return this.make((x, y, i, o) => {
      const cx = Math.floor(x / cs), cy = Math.floor(y / cs);
      const lx = (x % cs) / cs - 0.5, ly = (y % cs) / cs - 0.5;
      const sgn = (cx + cy) % 2 === 0 ? 1 : -1;
      const rx = (lx + sgn * ly) * 0.7071, ry = (-sgn * lx + ly) * 0.7071;
      const d = (rx / 0.36) ** 2 + (ry / 0.085) ** 2;
      const raised = 1 - smoothstep(0.6, 1.0, d);
      const L = this.L[i], M = this.M[i], F = this.F[i];
      const rust = smoothstep(0.66, 0.85, this.s(this.L, x + 70, y + 310)) * (1 - raised * 0.7);
      const base = 0.5 + (M - 0.5) * 0.1 + raised * 0.12 - smoothstep(0.45, 0.95, L) * 0.15;
      o.r = base * (1 - rust) + 0.36 * rust;
      o.g = base * (1 - rust) + 0.22 * rust;
      o.b = base * (1 - rust) + 0.14 * rust;
      o.h = 0.4 + raised * 0.6 + (F - 0.5) * 0.05;
      o.rough = 0.52 - raised * 0.18 + rust * 0.4 + (M - 0.5) * 0.1;
      o.metal = 0.85 * (1 - rust);
    }, { normal: 1.8 });
  }

  fabric() {
    const S = this.S, t = S / 4;
    return this.make((x, y, i, o) => {
      const wx = Math.sin((x / S) * t * Math.PI * 2), wy = Math.sin((y / S) * t * Math.PI * 2);
      const weave = (wx * 0.5 + 0.5) * (wy > 0 ? 1 : 0.6);
      const L = this.L[i], M = this.M[i], F = this.F[i];
      const blotA = smoothstep(0.52, 0.56, L), blotB = smoothstep(0.55, 0.6, this.s(this.M, x + 200, y + 13));
      let c = 0.86 - blotA * 0.14 + blotB * 0.1 - (F - 0.5) * 0.06 - weave * 0.05;
      c *= 1 - smoothstep(0.6, 0.95, M) * 0.12;
      o.r = c; o.g = c; o.b = c;
      o.h = 0.5 + weave * 0.3 + (F - 0.5) * 0.2;
      o.rough = 0.95;
    }, { normal: 1.0 });
  }

  ceilingTile() {
    const S = this.S, bar = Math.max(2, S * 0.008);
    return this.make((x, y, i, o) => {
      const half = S / 2;
      const dx = Math.min(x % half, half - (x % half)), dy = Math.min(y % half, half - (y % half));
      const t = 1 - smoothstep(bar * 0.6, bar, Math.min(dx, dy));
      const L2 = this.s(this.L, x + 90, y + 777), W = this.W[i], F = this.F[i];
      const ring = smoothstep(0.66, 0.69, L2) - smoothstep(0.7, 0.76, L2) * 0.6;
      const stainIn = smoothstep(0.69, 0.8, L2) * 0.35;
      let c = 0.8 + (F - 0.5) * 0.06 - (W > 0.9 ? 0.12 : 0);
      let r = c, g = c, b = c * 0.97;
      const st = Math.max(0, ring) * 0.5 + stainIn;
      r = r * (1 - st) + 0.55 * st; g = g * (1 - st) + 0.45 * st; b = b * (1 - st) + 0.3 * st;
      const barC = 0.7;
      o.r = r * (1 - t) + barC * t; o.g = g * (1 - t) + barC * t; o.b = b * (1 - t) + barC * t;
      o.h = 0.5 + t * 0.3 - (W > 0.9 ? 0.2 : 0) + (F - 0.5) * 0.1;
      o.rough = 0.92 - t * 0.4;
      o.metal = t * 0.5;
    }, { normal: 0.9 });
  }

  linoleum() {
    const S = this.S, n = 4, ts = S / n, sw = Math.max(1, S * 0.002);
    return this.make((x, y, i, o) => {
      const tx = Math.floor(x / ts), ty = Math.floor(y / ts);
      const lx = x % ts, ly = y % ts;
      const seam = 1 - smoothstep(0, sw, Math.min(lx, ts - lx, ly, ts - ly));
      const alt = (tx + ty) % 2 === 0 ? 1 : 0.9;
      const L = this.L[i], M = this.M[i], F = this.F[i];
      const wear = smoothstep(0.55, 0.85, L);
      let c = (0.6 * alt + (F - 0.5) * 0.04) * (1 - smoothstep(0.6, 0.9, M) * 0.2) + wear * 0.05;
      c *= 1 - seam * 0.35;
      o.r = c * 1.02; o.g = c * 0.98; o.b = c * 0.9;
      o.h = 0.5 - seam * 0.5 + (F - 0.5) * 0.05;
      o.rough = 0.42 + wear * 0.25 + (M - 0.5) * 0.1;
    }, { normal: 0.6 });
  }

  // ---------------------------------------------------------------- special / alpha

  chainLink() {
    const S = 256, N = 10, wire = 0.07;
    const col = new Uint8ClampedArray(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        const a = (u + v) * N, b = (u - v) * N;
        const fa = Math.abs(a - Math.round(a)), fb = Math.abs(b - Math.round(b));
        const w = Math.max(1 - smoothstep(wire * 0.5, wire, fa), 1 - smoothstep(wire * 0.5, wire, fb));
        const j = (y * S + x) * 4;
        const c = 150 + Math.random() * 30;
        col[j] = c; col[j + 1] = c; col[j + 2] = c + 4; col[j + 3] = w * 255;
      }
    }
    return dataTexture(col, S, S, true);
  }

  glassGrime() {
    const S = this.S;
    const col = new Uint8ClampedArray(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const streak = this.s(this.L, x * 4 + 13, y + 9);
        const g = smoothstep(0.2, 0.95, this.L[i] * 0.6 + streak * 0.5);
        const j = i * 4;
        col[j] = 150 + g * 30; col[j + 1] = 145 + g * 25; col[j + 2] = 135 + g * 15;
        col[j + 3] = (0.12 + g * 0.45 + this.F[i] * 0.08) * 255;
      }
    }
    return dataTexture(col, S, S, true);
  }

  /** 1D ambient-occlusion ramp mapped over the first metre above an object's base (uv1.y in metres). */
  aoRamp() {
    const H = 64, col = new Uint8ClampedArray(4 * H * 4);
    for (let y = 0; y < H; y++) {
      const v = y / (H - 1);
      const ao = 0.42 + 0.58 * Math.pow(smoothstep(0, 0.75, v), 0.85);
      for (let x = 0; x < 4; x++) {
        const j = (y * 4 + x) * 4;
        col[j] = col[j + 1] = col[j + 2] = ao * 255; col[j + 3] = 255;
      }
    }
    const t = dataTexture(col, 4, H, false, false);
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.channel = 1;
    return t;
  }

  /** Decal atlas: 4x2 cells — [concrete hole, concrete hole, metal, wood, blood, blood, blood pool, glass crack]. */
  decalAtlas() {
    const C = 128, W = C * 4, H = C * 2;
    const col = new Uint8ClampedArray(W * H * 4);
    const hgt = new Float32Array(W * H).fill(0.5);
    const rng = mulberry32(4242);
    const cellNoise = fbmField(C, 8, 3, 0.5, rng);
    const put = (cx, cy, x, y, r, g, b, a, h) => {
      const px = cx * C + x, py = cy * C + y, j = (py * W + px) * 4;
      col[j] = r * 255; col[j + 1] = g * 255; col[j + 2] = b * 255; col[j + 3] = a * 255;
      hgt[py * W + px] = h;
    };
    const paint = (cell, fn) => {
      const cx = cell % 4, cy = Math.floor(cell / 4);
      for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) {
        const dx = (x - C / 2) / (C / 2), dy = (y - C / 2) / (C / 2);
        const r = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
        const n = cellNoise[y * C + x];
        const o = fn(r, ang, n, dx, dy);
        put(cx, cy, x, y, o[0], o[1], o[2], o[3], o[4]);
      }
    };
    const concrete = (seed) => (r, ang, n) => {
      const jag = 0.55 + 0.25 * Math.sin(ang * 7 + seed) * Math.sin(ang * 3 + seed * 2) + (n - 0.5) * 0.4;
      const hole = 1 - smoothstep(0.1, 0.16, r);
      const chip = 1 - smoothstep(jag * 0.7, jag, r);
      const dust = (1 - smoothstep(0.3, 1.0, r)) * 0.35 * n;
      const c = hole ? 0.05 : 0.62 + n * 0.15;
      const a = Math.max(hole, chip * 0.9, dust);
      return [c, c * 0.98, c * 0.95, a, 0.5 - hole * 0.5 - chip * 0.2];
    };
    paint(0, concrete(1));
    paint(1, concrete(4));
    paint(2, (r, ang, n) => {
      const hole = 1 - smoothstep(0.08, 0.12, r);
      const ring = (1 - smoothstep(0.12, 0.3, r)) * (1 - hole);
      const scorch = (1 - smoothstep(0.25, 0.55, r)) * 0.4;
      const c = hole ? 0.03 : 0.72 + n * 0.2;
      return [c, c * 0.97, c * 0.92, Math.max(hole, ring, scorch * n), 0.5 - hole * 0.5 + ring * 0.25];
    });
    paint(3, (r, ang, n) => {
      const splinter = Math.pow(Math.abs(Math.sin(ang * 5 + n * 3)), 6);
      const hole = 1 - smoothstep(0.1, 0.15, r);
      const sp = (1 - smoothstep(0.15, 0.6, r)) * splinter;
      const c = hole ? 0.04 : 0.72;
      return [c, c * 0.62, c * 0.4, Math.max(hole, sp * 0.9), 0.5 - hole * 0.5 + sp * 0.2];
    });
    const blood = (seed) => (r, ang, n, dx, dy) => {
      const blob = smoothstep(0.62, 0.5, r + (n - 0.5) * 0.5 + Math.sin(ang * 5 + seed) * 0.06);
      let drops = 0;
      for (let k = 0; k < 7; k++) {
        const a = seed * 3 + k * 0.9, dd = 0.55 + ((k * 37) % 10) / 25;
        const ddx = dx - Math.cos(a) * dd, ddy = dy - Math.sin(a) * dd;
        drops = Math.max(drops, 1 - smoothstep(0.03, 0.07, Math.hypot(ddx, ddy)));
      }
      const a = Math.max(blob * (0.7 + n * 0.3), drops) * 0.92;
      return [0.24 + n * 0.08, 0.02, 0.02, a, 0.5 + a * 0.08];
    };
    paint(4, blood(1));
    paint(5, blood(2.7));
    paint(6, (r, ang, n) => {
      const pool = smoothstep(0.85, 0.7, r + (n - 0.5) * 0.35 + Math.sin(ang * 3) * 0.05);
      return [0.16 + n * 0.05, 0.015, 0.015, pool * 0.9, 0.5 + pool * 0.05];
    });
    paint(7, (r, ang, n) => {
      const rays = Math.pow(Math.abs(Math.cos(ang * 4 + n * 2)), 40) * (1 - smoothstep(0.2, 0.95, r));
      const ringC = (1 - smoothstep(0.0, 0.02, Math.abs(r - 0.28 - n * 0.05))) * 0.8;
      const center = 1 - smoothstep(0.03, 0.07, r);
      const a = Math.max(rays, ringC, center);
      return [0.92, 0.94, 0.95, a * 0.85, 0.5];
    });
    const map = dataTexture(col, W, H, true, false);
    const normalMap = dataTexture(this.heightToNormal(hgt, W, H, 2.5), W, H, false, false);
    return { map, normalMap };
  }

  // ---------------------------------------------------------------- particles / fx

  puff() {
    const S = 64, col = new Uint8ClampedArray(S * S * 4), rng = mulberry32(99);
    const n = fbmField(S, 4, 4, 0.55, rng);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = (x - S / 2 + 0.5) / (S / 2), dy = (y - S / 2 + 0.5) / (S / 2);
      const r = Math.hypot(dx, dy);
      const a = Math.pow(clamp(1 - r, 0, 1), 1.6) * (0.55 + n[y * S + x] * 0.6);
      const j = (y * S + x) * 4;
      col[j] = col[j + 1] = col[j + 2] = 255; col[j + 3] = clamp(a, 0, 1) * 255;
    }
    return dataTexture(col, S, S, true, false);
  }

  muzzleFlash() {
    const S = 128, col = new Uint8ClampedArray(S * S * 4), rng = mulberry32(5);
    const spikes = 7, off = rng() * 6;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = (x - S / 2 + 0.5) / (S / 2), dy = (y - S / 2 + 0.5) / (S / 2);
      const r = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
      const spike = Math.pow(Math.abs(Math.cos(ang * spikes * 0.5 + off)), 10) * (1 - smoothstep(0.1, 1.0, r));
      const core = 1 - smoothstep(0.0, 0.35, r);
      const glow = (1 - smoothstep(0.1, 0.8, r)) * 0.35;
      const v = clamp(core + spike * 0.9 + glow, 0, 1);
      const j = (y * S + x) * 4;
      col[j] = 255; col[j + 1] = 200 + 55 * core; col[j + 2] = 120 + 135 * core * core; col[j + 3] = v * 255;
    }
    return dataTexture(col, S, S, true, false);
  }

  muzzleFlashSide() {
    const W = 128, H = 64, col = new Uint8ClampedArray(W * H * 4), rng = mulberry32(8);
    const n = fbmField(64, 8, 3, 0.5, rng);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = x / W, v = (y - H / 2 + 0.5) / (H / 2);
      const width = 0.15 + u * 0.55 * (1 - u * 0.6);
      const body = 1 - smoothstep(width * 0.3, width, Math.abs(v));
      const fade = (1 - smoothstep(0.55, 1.0, u)) * smoothstep(0.0, 0.06, u);
      const flick = 0.6 + n[(y % 64) * 64 + (x % 64)] * 0.7;
      const a = clamp(body * fade * flick, 0, 1);
      const hot = 1 - smoothstep(0, 0.4, u);
      const j = (y * W + x) * 4;
      col[j] = 255; col[j + 1] = 170 + 80 * hot; col[j + 2] = 90 + 140 * hot * hot; col[j + 3] = a * 255;
    }
    return dataTexture(col, W, H, true, false);
  }

  /** Canvas based signage with text (the only textures using fonts). */
  sign(lines, { w = 512, h = 256, bg = '#d9d4c5', fg = '#1f1f1f', border = null, font = 'bold 72px Arial', stripe = null } = {}) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    if (stripe) {
      g.save();
      g.beginPath(); g.rect(0, 0, w, h); g.clip();
      g.fillStyle = stripe;
      for (let x = -h; x < w; x += 60) {
        g.beginPath(); g.moveTo(x, h); g.lineTo(x + 30, h); g.lineTo(x + 30 + h, 0); g.lineTo(x + h, 0); g.fill();
      }
      g.restore();
    }
    if (border) { g.strokeStyle = border; g.lineWidth = 14; g.strokeRect(12, 12, w - 24, h - 24); }
    g.fillStyle = fg; g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    lines.forEach((ln, k) => g.fillText(ln, w / 2, h / 2 + (k - (lines.length - 1) / 2) * (h / (lines.length + 0.6))));
    // weathering
    const img = g.getImageData(0, 0, w, h), d = img.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const n = this.s(this.L, x * 2, y * 2), f = this.s(this.F, x, y);
      const k = 1 - smoothstep(0.5, 0.95, n) * 0.35 - (f - 0.5) * 0.1;
      const j = (y * w + x) * 4;
      d[j] *= k; d[j + 1] *= k; d[j + 2] *= k;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.aniso;
    return t;
  }

  laptopScreen() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 160;
    const g = c.getContext('2d');
    g.fillStyle = '#0b1210'; g.fillRect(0, 0, 256, 160);
    g.fillStyle = '#6f8f86'; g.font = 'bold 12px monospace';
    g.fillText('SECURE TRANSFER // NODE 7', 12, 20);
    g.fillStyle = '#44584f';
    for (let i = 0; i < 7; i++) g.fillRect(12, 34 + i * 12, 60 + ((i * 53) % 150), 5);
    g.strokeStyle = '#6f8f86'; g.strokeRect(12, 124, 232, 12);
    g.fillStyle = '#86a89d'; g.fillRect(14, 126, 160, 8);
    g.fillText('ARCHIVE_KFD_0419.enc   68%', 12, 152);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  whiteboard() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#e6e6e1'; g.fillRect(0, 0, 512, 256);
    g.strokeStyle = 'rgba(40,40,60,0.75)'; g.lineWidth = 3;
    g.font = '28px "Comic Sans MS", cursive'; g.fillStyle = 'rgba(30,40,90,0.8)';
    g.fillText('BAY 2 → TRUCK 19:30', 30, 50);
    g.fillText('drive stays w/ R.', 30, 95);
    g.fillStyle = 'rgba(120,30,30,0.8)';
    g.fillText('NO RADIOS INSIDE', 30, 140);
    g.beginPath(); g.moveTo(300, 150); g.lineTo(460, 150); g.lineTo(460, 230); g.lineTo(300, 230); g.closePath(); g.stroke();
    g.beginPath(); g.moveTo(330, 200); g.lineTo(420, 180); g.stroke();
    g.beginPath(); g.arc(380, 190, 14, 0, Math.PI * 2); g.stroke();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
}
