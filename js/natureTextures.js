// Procedural natural surfaces for the mountain map (rock strata, dry soil, scree, dry grass, adobe,
// dry-stone walls, grass blades, macro variation, cloud shadows). Extends the existing TextureFactory
// so it shares the same tileable noise fields and texture helpers.
import * as THREE from 'three';
import { TextureFactory, dataTexture } from './textures.js';
import { mulberry32, smoothstep, clamp } from './util.js';

const hash1 = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

/** Tileable Worley noise with an independent cell count per axis (elongated cells when cx != cy). */
function worley(S, cx, cy, seed) {
  const rng = mulberry32(seed);
  const fx = new Float32Array(cx * cy), fy = new Float32Array(cx * cy);
  for (let k = 0; k < fx.length; k++) { fx[k] = rng(); fy[k] = rng(); }
  const f1 = new Float32Array(S * S), f2 = new Float32Array(S * S), id = new Int32Array(S * S);
  for (let y = 0; y < S; y++) {
    const v = (y / S) * cy, cj = Math.floor(v);
    for (let x = 0; x < S; x++) {
      const u = (x / S) * cx, ci = Math.floor(u);
      let d1 = 1e9, d2 = 1e9, best = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = (cj + dj + cy) % cy;
        for (let di = -1; di <= 1; di++) {
          const ii = (ci + di + cx) % cx, k = jj * cx + ii;
          const dx = ci + di + fx[k] - u, dy = cj + dj + fy[k] - v;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < d1) { d2 = d1; d1 = d; best = k; } else if (d < d2) d2 = d;
        }
      }
      const i = y * S + x;
      f1[i] = d1; f2[i] = d2; id[i] = best;
    }
  }
  return { f1, f2, id };
}

export class NatureTextureFactory extends TextureFactory {
  constructor(size, aniso) {
    super(size, aniso);
    this.rngN = mulberry32(9917);
  }

  /** Albedo (sRGB) + packed NRH texture: R,G = normal xy, B = roughness, A = height. */
  makePacked(fn, strength = 1) {
    const S = this.S, N = S * S;
    const col = new Uint8ClampedArray(N * 4);
    const hgt = new Float32Array(N), rough = new Float32Array(N);
    const o = { r: 0, g: 0, b: 0, h: 0.5, rough: 0.9 };
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        o.h = 0.5; o.rough = 0.9;
        fn(x, y, i, o);
        const j = i * 4;
        col[j] = o.r * 255; col[j + 1] = o.g * 255; col[j + 2] = o.b * 255; col[j + 3] = 255;
        hgt[i] = o.h; rough[i] = o.rough;
      }
    }
    const nrh = new Uint8ClampedArray(N * 4);
    const s = strength * (S / 256);
    for (let y = 0; y < S; y++) {
      const yu = ((y + 1) % S) * S, yd = ((y - 1 + S) % S) * S, yr = y * S;
      for (let x = 0; x < S; x++) {
        const xr = (x + 1) % S, xl = (x - 1 + S) % S;
        let nx = -(hgt[yr + xr] - hgt[yr + xl]) * s, ny = -(hgt[yu + x] - hgt[yd + x]) * s;
        const inv = 1 / Math.hypot(nx, ny, 1);
        nx *= inv; ny *= inv;
        const j = (yr + x) * 4;
        nrh[j] = (nx * 0.5 + 0.5) * 255; nrh[j + 1] = (ny * 0.5 + 0.5) * 255;
        nrh[j + 2] = rough[yr + x] * 255; nrh[j + 3] = clamp(hgt[yr + x], 0, 1) * 255;
      }
    }
    const map = dataTexture(col, S, S, true);
    const nrhT = dataTexture(nrh, S, S, false);
    map.anisotropy = nrhT.anisotropy = this.aniso;
    return { map, nrh: nrhT };
  }

  // ------------------------------------------------------------------ terrain layers

  /** Weathered sedimentary rock: warped strata, ledges, fractures, lichen and dust. */
  rock() {
    const S = this.S, cr = this.crackMask(18, S * 0.35, 311);
    return this.makePacked((x, y, i, o) => {
      const L = this.L[i], M = this.M[i], F = this.F[i], W = this.W[i];
      const band = (y / S) * 7 + (this.s(this.L, x * 2, y) - 0.5) * 3.4 + (M - 0.5) * 0.9;
      const bi = Math.floor(band), bf = band - bi;
      const ledge = smoothstep(0.0, 0.1, bf) * (1 - smoothstep(0.82, 1.0, bf));
      const tint = hash1(((bi % 9) + 9) % 9);
      const ridge = 1 - Math.abs(this.s(this.M, x, y * 2 + 17) * 2 - 1);
      const frac = cr[i];
      const lichen = smoothstep(0.76, 0.8, this.s(this.M, x + 77, y + 13)) * smoothstep(0.35, 0.6, L);
      const dust = smoothstep(0.55, 0.9, this.s(this.L, x + 211, y + 5)) * 0.35;
      let r = 0.47, g = 0.43, b = 0.385;
      if (tint > 0.62) { r = 0.54; g = 0.45; b = 0.35; }
      else if (tint < 0.25) { r = 0.4; g = 0.38; b = 0.36; }
      const k = (0.88 + tint * 0.12) * (0.88 + (F - 0.5) * 0.25 + (W - 0.5) * 0.08) * (0.88 + 0.12 * ledge) * (1 - frac * 0.4);
      r *= k; g *= k; b *= k;
      r = r * (1 - lichen * 0.5) + 0.5 * lichen * 0.5; g = g * (1 - lichen * 0.5) + 0.52 * lichen * 0.5; b = b * (1 - lichen * 0.5) + 0.42 * lichen * 0.5;
      r = r * (1 - dust) + 0.66 * dust; g = g * (1 - dust) + 0.57 * dust; b = b * (1 - dust) + 0.44 * dust;
      o.r = r; o.g = g; o.b = b;
      o.h = 0.42 * ledge + 0.26 * ridge + 0.16 * F + 0.06 * W - frac * 0.45;
      o.rough = 0.9 - lichen * 0.05 + (M - 0.5) * 0.06;
    }, 2.6);
  }

  /** Dry compacted soil with pebbles and patches of cracked, sun-baked mud. */
  dirt() {
    const S = this.S;
    const mud = worley(S, 14, 14, 71), peb = worley(S, 44, 44, 72);
    return this.makePacked((x, y, i, o) => {
      const L = this.L[i], L2 = this.s(this.L, x + 150, y + 260), M = this.M[i], F = this.F[i], W = this.W[i];
      const mudPatch = smoothstep(0.6, 0.72, L2);
      const crack = (1 - smoothstep(0.0, 0.06, mud.f2[i] - mud.f1[i])) * mudPatch;
      const pebCell = hash1(peb.id[i]);
      const pebble = pebCell < 0.11 ? Math.sqrt(Math.max(0, 1 - (peb.f1[i] / (0.22 + pebCell))) ** 2) : 0;
      const bump = pebble > 0 ? smoothstep(0.0, 0.5, pebble) : 0;
      let v = 0.9 + (L - 0.5) * 0.22 + (M - 0.5) * 0.1 + (W - 0.5) * 0.06;
      let r = 0.64 * v, g = 0.545 * v, b = 0.415 * v;
      r *= 1 - mudPatch * 0.08; g *= 1 - mudPatch * 0.1; b *= 1 - mudPatch * 0.12;
      if (bump > 0) { const pc = (0.82 + hash1(peb.id[i] + 9) * 0.25) * v; r = r * (1 - bump) + 0.6 * pc * bump; g = g * (1 - bump) + 0.54 * pc * bump; b = b * (1 - bump) + 0.46 * pc * bump; }
      r *= 1 - crack * 0.24; g *= 1 - crack * 0.24; b *= 1 - crack * 0.26;
      o.r = r; o.g = g; o.b = b;
      o.h = 0.5 + (M - 0.5) * 0.25 + (F - 0.5) * 0.25 + (W - 0.5) * 0.1 + bump * 0.25 - crack * 0.25;
      o.rough = 0.95 - bump * 0.12;
    }, 1.6);
  }

  /** Loose scree: scattered angular stones of many sizes lying in dusty soil. */
  gravel() {
    const S = this.S, st = worley(S, 26, 26, 91), small = worley(S, 70, 70, 92);
    return this.makePacked((x, y, i, o) => {
      const L = this.L[i], M = this.M[i], F = this.F[i], W = this.W[i];
      const h1 = hash1(st.id[i]), h2 = hash1(small.id[i] + 3);
      // only some cells hold a stone, and each stone is smaller than its cell
      const big = h1 > 0.42 ? smoothstep(0.05, 0.3, st.f2[i] - st.f1[i]) * smoothstep(0.62 + h1 * 0.25, 0.35, st.f1[i]) : 0;
      const sm = h2 > 0.35 ? smoothstep(0.04, 0.2, small.f2[i] - small.f1[i]) * smoothstep(0.55, 0.3, small.f1[i]) * (1 - big) : 0;
      const stone = Math.max(big, sm * 0.85);
      const soil = 0.9 + (L - 0.5) * 0.18 + (M - 0.5) * 0.12;
      const dr = 0.6 * soil, dg = 0.52 * soil, db = 0.41 * soil;
      const sc = big > 0.01 ? 0.5 + h1 * 0.2 : 0.47 + h2 * 0.2;
      const warm = h1 > 0.75 ? 1.07 : 1;
      const f = 0.92 + (F - 0.5) * 0.2 + (W - 0.5) * 0.06;
      o.r = (dr * (1 - stone) + sc * warm * stone) * f;
      o.g = (dg * (1 - stone) + sc * 0.95 * stone) * f;
      o.b = (db * (1 - stone) + sc * 0.86 * stone) * f;
      o.h = 0.35 + big * 0.55 + sm * 0.3 + (F - 0.5) * 0.1;
      o.rough = 0.9 - stone * 0.06;
    }, 1.8);
  }

  /** Thin, sun-bleached grass over dry soil. */
  grass() {
    const S = this.S;
    return this.makePacked((x, y, i, o) => {
      const L = this.L[i], M = this.M[i], F = this.F[i], W = this.W[i];
      const s1 = 1 - Math.abs(this.s(this.F, x * 3, y) * 2 - 1);
      const s2 = 1 - Math.abs(this.s(this.F, x, y * 3 + 41) * 2 - 1);
      const s3 = 1 - Math.abs(this.s(this.M, x * 4 + 13, y * 2) * 2 - 1);
      const strand = Math.max(Math.pow(s1, 6), Math.pow(s2, 6), Math.pow(s3, 5));
      const cover = smoothstep(0.28, 0.62, L * 0.7 + M * 0.4);
      const green = smoothstep(0.55, 0.8, this.s(this.L, x + 333, y + 91));
      let gr = 0.66, gg = 0.585, gb = 0.39;
      gr = gr * (1 - green * 0.35) + 0.44 * green * 0.35; gg = gg * (1 - green * 0.35) + 0.47 * green * 0.35; gb = gb * (1 - green * 0.35) + 0.3 * green * 0.35;
      const gk = 0.72 + strand * 0.38 + (W - 0.5) * 0.1;
      const dr = 0.6, dg = 0.51, db = 0.39;
      const t = cover * (0.55 + strand * 0.45);
      o.r = dr * (1 - t) + gr * gk * t; o.g = dg * (1 - t) + gg * gk * t; o.b = db * (1 - t) + gb * gk * t;
      const d = 0.92 + (F - 0.5) * 0.14;
      o.r *= d; o.g *= d; o.b *= d;
      o.h = 0.4 + strand * 0.5 * cover + (F - 0.5) * 0.15;
      o.rough = 0.93;
    }, 1.4);
  }

  /** Large-scale variation used to break tiling (R: very large, G: medium, B: fine). */
  macro() {
    const S = this.S, N = S * S, col = new Uint8ClampedArray(N * 4);
    for (let i = 0; i < N; i++) {
      col[i * 4] = this.L[i] * 255; col[i * 4 + 1] = this.M[i] * 255; col[i * 4 + 2] = this.F[i] * 255; col[i * 4 + 3] = 255;
    }
    return dataTexture(col, S, S, false);
  }

  /** Soft cloud cover used to cast slowly drifting cloud shadows over the terrain. */
  clouds() {
    const S = this.S, N = S * S, col = new Uint8ClampedArray(N * 4);
    for (let i = 0; i < N; i++) {
      const x = i % S, y = (i / S) | 0;
      const n = this.L[i] * 0.7 + this.s(this.M, x + 51, y + 17) * 0.3;
      const c = smoothstep(0.5, 0.72, n);
      col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = c * 255; col[i * 4 + 3] = 255;
    }
    return dataTexture(col, S, S, false);
  }

  // ------------------------------------------------------------------ built structures

  /** Mud plaster over sun-dried brick, with cracks, bare patches and straw flecks. */
  adobe() {
    const S = this.S, cr = this.crackMask(10, S * 0.3, 55);
    const bw = S / 5, bh = S / 14;
    return this.make((x, y, i, o) => {
      const L = this.L[i], L2 = this.s(this.L, x + 91, y + 7), M = this.M[i], F = this.F[i], W = this.W[i];
      const peel = smoothstep(0.74, 0.78, L2 * 0.8 + F * 0.25);
      const row = Math.floor(y / bh), bx = (x + (row % 2) * bw * 0.5) % bw, by = y % bh;
      const mortar = 1 - smoothstep(1, 3, Math.min(bx, bw - bx, by, bh - by));
      const trowel = (this.s(this.M, x * 2, y) - 0.5) * 0.08;
      let pr = 0.76, pg = 0.66, pb = 0.51;
      const pk = 0.95 + trowel + (F - 0.5) * 0.06 - smoothstep(0.5, 0.95, L) * 0.1;
      pr *= pk; pg *= pk; pb *= pk;
      const brick = 0.62 + hash1(row * 31 + Math.floor((x + (row % 2) * bw * 0.5) / bw)) * 0.08;
      let br = brick, bg = brick * 0.82, bb = brick * 0.62;
      br *= 1 - mortar * 0.25; bg *= 1 - mortar * 0.25; bb *= 1 - mortar * 0.25;
      let r = pr * (1 - peel) + br * peel, g = pg * (1 - peel) + bg * peel, b = pb * (1 - peel) + bb * peel;
      if (W > 0.992) { r *= 1.12; g *= 1.08; b *= 0.95; }
      r *= 1 - cr[i] * 0.35; g *= 1 - cr[i] * 0.35; b *= 1 - cr[i] * 0.35;
      o.r = r; o.g = g; o.b = b;
      o.h = 0.6 - peel * 0.22 - mortar * peel * 0.2 + (F - 0.5) * 0.1 + trowel - cr[i] * 0.3;
      o.rough = 0.93;
    }, { normal: 1.3 });
  }

  /** Dry-stacked field stone (sangars, terraces, ruined walls). */
  stoneWall() {
    const S = this.S, st = worley(S, 5, 11, 131);
    return this.make((x, y, i, o) => {
      const F = this.F[i], W = this.W[i], M = this.M[i];
      const edge = st.f2[i] - st.f1[i];
      const stone = smoothstep(0.02, 0.14, edge);
      const ch = hash1(st.id[i]);
      const c = (0.44 + ch * 0.22) * (0.9 + (F - 0.5) * 0.24 + (W - 0.5) * 0.08 + (M - 0.5) * 0.1);
      const k = 0.55 + 0.45 * stone;
      o.r = c * k * (ch > 0.7 ? 1.08 : 1); o.g = c * k * 0.95; o.b = c * k * 0.86;
      o.h = stone * 0.8 + (F - 0.5) * 0.12 + (M - 0.5) * 0.08;
      o.rough = 0.92;
    }, { normal: 1.6 });
  }

  /** Alpha texture of dry grass blades for instanced tufts. */
  grassBlades() {
    const W = 256, H = 256;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const rng = mulberry32(4411);
    for (let k = 0; k < 34; k++) {
      const x0 = 20 + rng() * (W - 40), h = H * (0.45 + rng() * 0.53), lean = (rng() - 0.5) * 90, w = 3 + rng() * 4;
      const tone = rng();
      const top = tone < 0.3 ? [150, 146, 96] : tone < 0.75 ? [196, 176, 118] : [170, 150, 96];
      const grad = g.createLinearGradient(0, H, 0, H - h);
      grad.addColorStop(0, 'rgb(84,74,50)');
      grad.addColorStop(0.35, `rgb(${top[0] - 30},${top[1] - 30},${top[2] - 24})`);
      grad.addColorStop(1, `rgb(${top[0]},${top[1]},${top[2]})`);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(x0 - w, H);
      g.quadraticCurveTo(x0 - w * 0.5 + lean * 0.3, H - h * 0.5, x0 + lean, H - h);
      g.quadraticCurveTo(x0 + w * 0.5 + lean * 0.3, H - h * 0.5, x0 + w, H);
      g.closePath();
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.aniso;
    return t;
  }
}
