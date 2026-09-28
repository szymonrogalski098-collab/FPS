// Heightfield terrain for the mountain map: designed + procedural relief, fast CPU queries (height,
// normal, ray cast, surface type), chunked render meshes, road/wadi masks and GPU-baked lighting
// (soft sun shadows cast by the mountains + horizon-based ambient occlusion).
import * as THREE from 'three';
import { mulberry32, smoothstep, clamp, lerp } from './util.js';

// ------------------------------------------------------------------ noise

function makeSimplex(seed) {
  const rng = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const gx = [1, -1, 1, -1, 1, -1, 0, 0], gy = [1, 1, -1, -1, 0, 0, 1, -1];
  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  return function (x, y) {
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = perm[ii + perm[jj]] & 7; t0 *= t0; n += t0 * t0 * (gx[g] * x0 + gy[g] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = perm[ii + i1 + perm[jj + j1]] & 7; t1 *= t1; n += t1 * t1 * (gx[g] * x1 + gy[g] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = perm[ii + 1 + perm[jj + 1]] & 7; t2 *= t2; n += t2 * t2 * (gx[g] * x2 + gy[g] * y2); }
    return 70 * n;
  };
}

function distToSeg(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az, wx = px - ax, wz = pz - az;
  const L = vx * vx + vz * vz;
  const t = L > 0 ? clamp((wx * vx + wz * vz) / L, 0, 1) : 0;
  const dx = wx - vx * t, dz = wz - vz * t;
  return { d: Math.sqrt(dx * dx + dz * dz), t };
}

export function distToPolyline(px, pz, pts) {
  let best = Infinity, bi = 0, bt = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const r = distToSeg(px, pz, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (r.d < best) { best = r.d; bi = i; bt = r.t; }
  }
  return { d: best, i: bi, t: bt };
}

// ------------------------------------------------------------------ terrain

export class Terrain {
  /**
   * layout: { ridges:[{a:[x,z],b:[x,z],h,w,jag}], valley:[[x,z]...], valleyWidth, roads:[{pts,width}],
   *           trails:[{pts,width}], pads:[{x,z,r,blend,dy}] }
   */
  constructor(layout, opts = {}) {
    this.layout = layout;
    this.size = opts.size || 800;          // half extent of the detailed grid
    this.step = opts.step || 2;
    this.N = Math.round((this.size * 2) / this.step) + 1;
    this.farSize = opts.farSize || 12000;
    this.farN = opts.farN || 241;
    this.farStep = (this.farSize * 2) / (this.farN - 1);
    this.playRadius = opts.playRadius || 620;
    this.seed = opts.seed || 20260927;
    this.n1 = makeSimplex(this.seed);
    this.n2 = makeSimplex(this.seed + 17);
    this.n3 = makeSimplex(this.seed + 331);
    this.maxHeight = 0;
  }

  fbm(noise, x, z, oct, gain = 0.5, lac = 2.03) {
    let a = 1, f = 1, s = 0, n = 0;
    for (let o = 0; o < oct; o++) { s += noise(x * f, z * f) * a; n += a; a *= gain; f *= lac; }
    return s / n;
  }

  ridged(noise, x, z, oct) {
    let a = 1, f = 1, s = 0, n = 0, w = 1;
    for (let o = 0; o < oct; o++) {
      let r = 1 - Math.abs(noise(x * f, z * f));
      r *= r;
      r *= w;
      w = clamp(r * 1.6, 0, 1);
      s += r * a; n += a;
      a *= 0.5; f *= 2.07;
    }
    return s / n;
  }

  /** Raw designed relief before pads / roads are cut in. */
  designHeight(x, z) {
    const L = this.layout;
    let h = 34 + this.fbm(this.n1, x / 900, z / 900, 3) * 30;
    // ridges: broad massifs across their axis, tapering out at the ends (spurs, not domes)
    let env = 0;
    for (let ri = 0; ri < L.ridges.length; ri++) {
      const r = L.ridges[ri];
      const ax = r.a[0], az = r.a[1], vx = r.b[0] - ax, vz = r.b[1] - az;
      const len = Math.hypot(vx, vz);
      const along = ((x - ax) * vx + (z - az) * vz) / len;
      const dLat = Math.abs((x - ax) * vz - (z - az) * vx) / len;
      const k = dLat / r.w;
      if (k > 3.2) continue;
      const taper = smoothstep(-r.w * 0.9, r.w * 0.4, along) * smoothstep(len + r.w * 0.9, len - r.w * 0.4, along);
      if (taper <= 0) continue;
      const g = Math.exp(-k * k * 1.15) * taper;
      const var1 = this.fbm(this.n2, along / (r.jag || 300) + ri * 7.1, ri * 3.3, 3);
      h += r.h * g * (0.85 + 0.3 * var1);
      env = Math.max(env, g);
    }
    // erosion: domain-warped ridged noise carves spurs and ravines into the mountain flanks
    if (env > 0.02) {
      const wx = x + this.fbm(this.n1, x / 420 + 11, z / 420, 2) * 95;
      const wz = z + this.fbm(this.n2, x / 420, z / 420 + 5, 2) * 95;
      const rid = this.ridged(this.n3, wx / 240, wz / 240, 4);
      h += (rid - 0.42) * 75 * env;
    }
    const dc = Math.hypot(x, z * 1.05);
    if (dc > 560) {
      // enclosing ranges: big shapes, sharp ridgelines, snow on the far giants
      const frame = smoothstep(620, 1900, dc);
      const shape = 0.6 * this.ridged(this.n3, x / 2400, z / 2400, 4) + 0.4 * (this.fbm(this.n1, x / 1700 + 3, z / 1700, 3) * 0.5 + 0.5);
      h += frame * (260 + 1150 * shape * shape);
      h += smoothstep(2500, 9000, dc) * 1400 * this.ridged(this.n1, x / 6000 + 7, z / 6000, 4);
    }
    // valley carving: a broad glacial profile with the wadi at the bottom
    if (dc < 1800) {
      const v = distToPolyline(x, z, L.valley);
      const s = smoothstep(0, L.valleyWidth, v.d);
      const floor = 8 + z * 0.02 + this.fbm(this.n2, x / 320, z / 320, 2) * 7;
      const keep = 0.05 + 0.95 * Math.pow(s, 1.3);
      const fade = 1 - smoothstep(1100, 1800, dc);
      // valley walls stay climbable near the floor (~37°), steeper ground only further up
      let rise = (h - floor) * keep;
      const allowed = Math.max(0, v.d - 25) * 0.76 + 6;
      if (rise > allowed) rise = allowed + (rise - allowed) * 0.22;
      h = lerp(h, floor + rise, fade);
      h -= 1.8 * Math.exp(-((v.d / 7) ** 2)) * fade;
      // terraces of the valley floor
      h += this.fbm(this.n3, x / 60, z / 60, 2) * 2.5 * (1 - s);
    }
    // outcrops and small-scale relief
    h += this.ridged(this.n3, x / 90, z / 90, 3) * 4 - 1.8;
    h += this.fbm(this.n1, x / 12, z / 12, 2) * 0.5;
    return h;
  }

  async generate(progress) {
    const N = this.N, S = this.size, st = this.step;
    this.h = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      const z = -S + j * st;
      for (let i = 0; i < N; i++) this.h[j * N + i] = this.designHeight(-S + i * st, z);
      if (progress && j % 80 === 0) await progress(j / N * 0.8);
    }
    this.applyPads();
    this.applyRoads();
    // far grid
    const F = this.farN;
    this.fh = new Float32Array(F * F);
    for (let j = 0; j < F; j++) {
      const z = -this.farSize + j * this.farStep;
      for (let i = 0; i < F; i++) {
        const x = -this.farSize + i * this.farStep;
        this.fh[j * F + i] = Math.abs(x) < S - 1 && Math.abs(z) < S - 1 ? this.sampleNear(x, z) : this.designHeight(x, z);
      }
    }
    let mx = -Infinity;
    for (let i = 0; i < this.fh.length; i++) mx = Math.max(mx, this.fh[i]);
    for (let i = 0; i < this.h.length; i++) mx = Math.max(mx, this.h[i]);
    this.maxHeight = mx;
    if (progress) await progress(1);
  }

  forEachNear(minX, minZ, maxX, maxZ, fn) {
    const N = this.N, S = this.size, st = this.step;
    const i0 = Math.max(0, Math.floor((minX + S) / st)), i1 = Math.min(N - 1, Math.ceil((maxX + S) / st));
    const j0 = Math.max(0, Math.floor((minZ + S) / st)), j1 = Math.min(N - 1, Math.ceil((maxZ + S) / st));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(i, j, -S + i * st, -S + j * st, j * N + i);
  }

  /** Flatten building / observation-post pads (target height = natural height at the pad centre + dy). */
  applyPads() {
    for (const p of this.layout.pads || []) {
      const target = (p.y !== undefined ? p.y : this.sampleNear(p.x, p.z)) + (p.dy || 0);
      p.y = target;
      const R = p.r + p.blend;
      this.forEachNear(p.x - R, p.z - R, p.x + R, p.z + R, (i, j, x, z, k) => {
        const d = p.square ? Math.max(Math.abs(x - p.x), Math.abs(z - p.z)) : Math.hypot(x - p.x, z - p.z);
        const w = 1 - smoothstep(p.r, R, d);
        if (w > 0) this.h[k] = lerp(this.h[k], target, w);
      });
    }
  }

  /** Cut roads and trails as smooth ribbons following a low-passed height profile. */
  applyRoads() {
    const all = [...(this.layout.roads || []), ...(this.layout.trails || [])];
    for (const r of all) {
      // resample the polyline and build a smoothed height profile
      const pts = [];
      for (let i = 0; i < r.pts.length - 1; i++) {
        const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
        const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 2));
        for (let k = 0; k < n; k++) pts.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
      }
      pts.push(r.pts[r.pts.length - 1]);
      const raw = pts.map(([x, z]) => this.sampleNear(x, z));
      const win = r.smooth || 12;
      const prof = raw.map((_, i) => {
        let s = 0, c = 0;
        for (let k = -win; k <= win; k++) { const q = raw[clamp(i + k, 0, raw.length - 1)]; s += q; c++; }
        return s / c;
      });
      r.profile = prof;
      r.samples = pts;
      const W = r.width, B = r.width * 1.6 + 2;
      for (let i = 0; i < pts.length; i++) {
        const [x, z] = pts[i];
        this.forEachNear(x - W - B, z - W - B, x + W + B, z + W + B, (ii, jj, gx, gz, k) => {
          const d = Math.hypot(gx - x, gz - z);
          const w = 1 - smoothstep(W, W + B, d);
          if (w <= 0) return;
          const target = prof[i] - (r.sunk || 0.15);
          // blend gently (multiple samples overlap; take the strongest pull)
          const cur = this.h[k];
          const want = lerp(cur, target, w);
          if (Math.abs(want - target) < Math.abs(cur - target)) this.h[k] = want;
        });
      }
    }
  }

  sampleNear(x, z) {
    const N = this.N, S = this.size, st = this.step;
    const gx = clamp((x + S) / st, 0, N - 1.0001), gz = clamp((z + S) / st, 0, N - 1.0001);
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    const k = j * N + i;
    const a = this.h[k], b = this.h[k + 1], c = this.h[k + N], d = this.h[k + N + 1];
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  }

  sampleFar(x, z) {
    const F = this.farN, S = this.farSize, st = this.farStep;
    const gx = clamp((x + S) / st, 0, F - 1.0001), gz = clamp((z + S) / st, 0, F - 1.0001);
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    const k = j * F + i;
    const a = this.fh[k], b = this.fh[k + 1], c = this.fh[k + F], d = this.fh[k + F + 1];
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  }

  heightAt(x, z) {
    return Math.abs(x) < this.size - 0.01 && Math.abs(z) < this.size - 0.01 ? this.sampleNear(x, z) : this.sampleFar(x, z);
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const e = this.step;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  slopeAt(x, z) { return 1 - this.normalAt(x, z, _n).y; }

  /** Surface type for footsteps / impacts. */
  surfaceAt(x, z) {
    // cached per 2 m cell (footsteps and floor queries hit this every frame)
    const N = this.N, S = this.size;
    const i = Math.floor((x + S) / this.step), j = Math.floor((z + S) / this.step);
    if (i < 0 || j < 0 || i >= N || j >= N) return 'rock';
    if (!this._surf) this._surf = new Uint8Array(N * N);
    const k = j * N + i;
    let v = this._surf[k];
    if (!v) { v = SURF_IDS[this.surfaceCalc(-S + (i + 0.5) * this.step, -S + (j + 0.5) * this.step)]; this._surf[k] = v; }
    return SURF_NAMES[v];
  }

  surfaceCalc(x, z) {
    const slope = this.slopeAt(x, z);
    if (this.roadMask && this.maskAt(x, z) > 0.45) return 'gravel';
    if (slope > 0.3) return 'rock';
    if (slope > 0.16) return 'gravel';
    const g = this.fbm(this.n1, x / 60, z / 60, 2);
    return g > 0.05 ? 'grass' : 'dirt';
  }

  maskAt(x, z) {
    let best = 0;
    for (const r of [...(this.layout.roads || []), ...(this.layout.trails || [])]) {
      const d = distToPolyline(x, z, r.pts).d;
      best = Math.max(best, 1 - smoothstep(r.width * 0.6, r.width * 1.2, d));
    }
    return best;
  }

  /** Ray march against the heightfield; returns distance or null. */
  raycast(ox, oy, oz, dx, dy, dz, maxT) {
    let diff = oy - this.heightAt(ox, oz);
    if (diff < -0.05) return null;
    if (dy > 0 && oy > this.maxHeight) return null;
    let t = 0, prevT = 0;
    while (t < maxT) {
      prevT = t;
      t = Math.min(maxT, t + Math.max(0.45, diff * 0.35));
      const y = oy + dy * t;
      if (dy >= 0 && y > this.maxHeight) return null;
      const nd = y - this.heightAt(ox + dx * t, oz + dz * t);
      if (nd < 0) {
        let a = prevT, b = t;
        for (let k = 0; k < 10; k++) {
          const m = (a + b) * 0.5;
          if (oy + dy * m - this.heightAt(ox + dx * m, oz + dz * m) < 0) b = m; else a = m;
        }
        return b;
      }
      diff = nd;
      if (t >= maxT) break;
    }
    return null;
  }

  // ------------------------------------------------------------------ meshes

  buildMeshes(material, farMaterial, chunks = 8) {
    const out = [];
    const N = this.N, S = this.size, st = this.step;
    const per = (N - 1) / chunks;
    for (let cj = 0; cj < chunks; cj++) {
      for (let ci = 0; ci < chunks; ci++) {
        const i0 = Math.round(ci * per), i1 = Math.round((ci + 1) * per);
        const j0 = Math.round(cj * per), j1 = Math.round((cj + 1) * per);
        const w = i1 - i0 + 1, hgt = j1 - j0 + 1;
        const pos = new Float32Array(w * hgt * 3), nor = new Float32Array(w * hgt * 3);
        for (let j = 0; j < hgt; j++) {
          for (let i = 0; i < w; i++) {
            const gi = i0 + i, gj = j0 + j, k = (j * w + i) * 3;
            const x = -S + gi * st, z = -S + gj * st;
            let y = this.h[gj * N + gi];
            // skirt the outer border down so the far mesh can take over without cracks
            if (gi === 0 || gj === 0 || gi === N - 1 || gj === N - 1) y -= 6;
            pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
            const hl = this.h[gj * N + Math.max(0, gi - 1)], hr = this.h[gj * N + Math.min(N - 1, gi + 1)];
            const hd = this.h[Math.max(0, gj - 1) * N + gi], hu = this.h[Math.min(N - 1, gj + 1) * N + gi];
            const nx = hl - hr, nz = hd - hu, ny = 2 * st, inv = 1 / Math.hypot(nx, ny, nz);
            nor[k] = nx * inv; nor[k + 1] = ny * inv; nor[k + 2] = nz * inv;
          }
        }
        const idx = new Uint32Array((w - 1) * (hgt - 1) * 6);
        let q = 0;
        for (let j = 0; j < hgt - 1; j++) {
          for (let i = 0; i < w - 1; i++) {
            const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
            // alternate the diagonal for a less regular look
            if ((i + j) % 2 === 0) { idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d; }
            else { idx[q++] = a; idx[q++] = c; idx[q++] = d; idx[q++] = a; idx[q++] = d; idx[q++] = b; }
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        g.computeBoundingSphere();
        g.computeBoundingBox();
        const m = new THREE.Mesh(g, material);
        m.receiveShadow = true;
        m.castShadow = false;
        m.matrixAutoUpdate = false;
        m.userData.terrain = true;
        out.push(m);
      }
    }
    // far ring (inner area sunk below the detailed grid)
    const F = this.farN, FS = this.farSize, fst = this.farStep;
    const pos = new Float32Array(F * F * 3), nor = new Float32Array(F * F * 3);
    for (let j = 0; j < F; j++) {
      for (let i = 0; i < F; i++) {
        const x = -FS + i * fst, z = -FS + j * fst, k = (j * F + i) * 3;
        let y = this.fh[j * F + i];
        if (Math.abs(x) < S - fst * 0.5 && Math.abs(z) < S - fst * 0.5) y -= 60;
        pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
        const hl = this.fh[j * F + Math.max(0, i - 1)], hr = this.fh[j * F + Math.min(F - 1, i + 1)];
        const hd = this.fh[Math.max(0, j - 1) * F + i], hu = this.fh[Math.min(F - 1, j + 1) * F + i];
        const nx = hl - hr, nz = hd - hu, ny = 2 * fst, inv = 1 / Math.hypot(nx, ny, nz);
        nor[k] = nx * inv; nor[k + 1] = ny * inv; nor[k + 2] = nz * inv;
      }
    }
    const idx = new Uint32Array((F - 1) * (F - 1) * 6);
    let q = 0;
    for (let j = 0; j < F - 1; j++) for (let i = 0; i < F - 1; i++) {
      const a = j * F + i, b = a + 1, c = a + F, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    const far = new THREE.Mesh(g, farMaterial);
    far.receiveShadow = false;
    far.matrixAutoUpdate = false;
    far.userData.terrain = true;
    far.userData.far = true;
    out.push(far);
    return out;
  }

  /** Road / wadi / trail mask texture (R road, G dry riverbed, B foot trail) over the detailed area. */
  buildMaskTexture(res = 2048) {
    const c = document.createElement('canvas');
    c.width = c.height = res;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, res, res);
    const S = this.size, k = res / (S * 2);
    const px = (x) => (x + S) * k, pz = (z) => (z + S) * k;
    const stroke = (pts, width, color, passes = 6) => {
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (let p = passes; p >= 1; p--) {
        g.strokeStyle = color.replace('A', (0.9 / passes).toFixed(3));
        g.lineWidth = Math.max(1, width * k * (0.7 + p * 0.22));
        g.beginPath();
        pts.forEach(([x, z], i) => (i ? g.lineTo(px(x), pz(z)) : g.moveTo(px(x), pz(z))));
        g.stroke();
      }
    };
    g.globalCompositeOperation = 'lighter';
    stroke(this.layout.valley, 7, 'rgba(0,255,0,A)');
    for (const r of this.layout.roads || []) stroke(r.pts, r.width * 1.1, 'rgba(255,0,0,A)');
    for (const r of this.layout.trails || []) stroke(r.pts, r.width * 1.2, 'rgba(0,0,255,A)');
    const t = new THREE.CanvasTexture(c);
    t.flipY = false;
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    this.roadMask = true;
    return t;
  }

  heightTextures() {
    const near = new THREE.DataTexture(this.h, this.N, this.N, THREE.RedFormat, THREE.FloatType);
    near.needsUpdate = true;
    const far = new THREE.DataTexture(this.fh, this.farN, this.farN, THREE.RedFormat, THREE.FloatType);
    far.needsUpdate = true;
    return { near, far };
  }

  /**
   * Bakes soft sun visibility (R) and horizon ambient occlusion (G) on the GPU for a square region.
   * Returns a texture usable directly by the terrain and object shaders.
   */
  bakeLighting(renderer, sunDir, res, half) {
    if (!this._hTex) this._hTex = this.heightTextures();
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        tNear: { value: this._hTex.near }, tFar: { value: this._hTex.far },
        uNear: { value: new THREE.Vector3(this.size, this.N, this.step) },
        uFar: { value: new THREE.Vector3(this.farSize, this.farN, this.farStep) },
        uSun: { value: sunDir.clone().normalize() }, uHalf: { value: half },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        precision highp float;
        uniform sampler2D tNear; uniform sampler2D tFar; uniform vec3 uNear; uniform vec3 uFar; uniform vec3 uSun; uniform float uHalf;
        varying vec2 vUv;
        float fetchGrid(sampler2D t, vec3 g, vec2 p) {
          vec2 q = clamp((p + g.x) / g.z, vec2(0.0), vec2(g.y - 1.001));
          ivec2 i = ivec2(floor(q)); vec2 f = q - vec2(i);
          float a = texelFetch(t, i, 0).r, b = texelFetch(t, i + ivec2(1, 0), 0).r;
          float c = texelFetch(t, i + ivec2(0, 1), 0).r, d = texelFetch(t, i + ivec2(1, 1), 0).r;
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        float height(vec2 p) {
          vec2 a = abs(p);
          if (a.x < uNear.x - 1.0 && a.y < uNear.x - 1.0) return fetchGrid(tNear, uNear, p);
          return fetchGrid(tFar, uFar, p);
        }
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main() {
          vec2 p = (vUv * 2.0 - 1.0) * uHalf;
          float h0 = height(p) + 0.25;
          vec2 sd = normalize(uSun.xz);
          float tanE = uSun.y / length(uSun.xz);
          float vis = 1.0, t = 0.8;
          for (int i = 0; i < 220; i++) {
            t *= 1.04;
            float rayH = h0 + t * tanE;
            float th = height(p + sd * t);
            vis = min(vis, clamp((rayH - th) / (t * 0.045) + 0.35, 0.0, 1.0));
            if (vis <= 0.0 || rayH > 3600.0) break;
          }
          float occ = 0.0;
          float jit = hash(p) * 6.2831853;
          for (int d = 0; d < 16; d++) {
            float a = float(d) * 0.39269908 + jit;
            vec2 dir = vec2(cos(a), sin(a));
            float m = 0.0, r = 2.0;
            for (int s = 0; s < 11; s++) {
              r *= 1.6;
              m = max(m, (height(p + dir * r) - h0) / r);
            }
            occ += 1.0 - m / sqrt(1.0 + m * m);
          }
          float ao = pow(clamp(occ / 16.0, 0.0, 1.0), 1.0);
          gl_FragColor = vec4(vis, ao, 0.0, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const rt = new THREE.WebGLRenderTarget(res, res, { type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev);
    mat.dispose();
    quad.geometry.dispose();
    rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    return rt;
  }

  /** CPU read-back of a baked lighting texture region for gameplay (AI concealment, view-model light). */
  readLighting(renderer, rt) {
    const w = rt.width, h = rt.height;
    const buf = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    return { buf, w, h };
  }
}

const _n = new THREE.Vector3();
const SURF_NAMES = [null, 'rock', 'gravel', 'grass', 'dirt'];
const SURF_IDS = { rock: 1, gravel: 2, grass: 3, dirt: 4 };
