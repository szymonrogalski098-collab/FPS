// AI navigation: a layered grid (ground, stairs, mezzanine) generated from the collision world,
// A* with lazy-deletion heap, greedy path smoothing, and automatic cover-point extraction.

export class NavGrid {
  constructor(physics, bounds, cell = 0.5, radius = 0.32) {
    this.physics = physics;
    this.b = bounds;
    this.cell = cell;
    this.r = radius;
    this.W = Math.ceil((bounds.maxX - bounds.minX) / cell);
    this.H = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
    this.cover = [];
  }

  cellOf(x, z) {
    const i = Math.floor((x - this.b.minX) / this.cell), j = Math.floor((z - this.b.minZ) / this.cell);
    if (i < 0 || j < 0 || i >= this.W || j >= this.H) return -1;
    return j * this.W + i;
  }

  build() {
    const { W, H, cell, r, b } = this;
    const P = this.physics;
    // 1. rasterise blocking intervals per cell
    const blocks = new Array(W * H);
    for (const c of P.colliders) {
      if (!c.move) continue;
      const i0 = Math.max(0, Math.floor((c.minX - r - b.minX) / cell)), i1 = Math.min(W - 1, Math.floor((c.maxX + r - b.minX) / cell));
      const j0 = Math.max(0, Math.floor((c.minZ - r - b.minZ) / cell)), j1 = Math.min(H - 1, Math.floor((c.maxZ + r - b.minZ) / cell));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        // only block if the collider actually overlaps the cell centre footprint expanded by the radius
        const cx = b.minX + (i + 0.5) * cell, cz = b.minZ + (j + 0.5) * cell;
        if (cx < c.minX - r || cx > c.maxX + r || cz < c.minZ - r || cz > c.maxZ + r) continue;
        const k = j * W + i;
        (blocks[k] || (blocks[k] = [])).push(c.minY, c.maxY);
      }
    }
    const navFloors = P.colliders.filter((c) => c.nav);
    // 2. nodes
    const xs = [], ys = [], zs = [];
    this.cellNodes = new Array(W * H);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const cx = b.minX + (i + 0.5) * cell, cz = b.minZ + (j + 0.5) * cell;
        const cand = [0];
        for (const rp of P.ramps) { const h = rp.heightAt(cx, cz); if (h !== null) cand.push(h); }
        for (const c of navFloors) if (cx >= c.minX && cx <= c.maxX && cz >= c.minZ && cz <= c.maxZ) cand.push(c.maxY);
        cand.sort((p, q) => p - q);
        const k = j * W + i;
        for (let a = 0; a < cand.length; a++) {
          const h = cand[a];
          if (a > 0 && h - cand[a - 1] < 0.1) continue;
          if (cand.some((h2) => h2 > h + 0.1 && h2 <= h + 1.9)) continue;
          const bl = blocks[k];
          let blocked = false;
          if (bl) for (let q = 0; q < bl.length; q += 2) if (bl[q] < h + 1.7 && bl[q + 1] > h + 0.35) { blocked = true; break; }
          if (blocked) continue;
          const id = xs.length;
          xs.push(cx); ys.push(h); zs.push(cz);
          (this.cellNodes[k] || (this.cellNodes[k] = [])).push(id);
        }
      }
    }
    const n = xs.length;
    this.n = n;
    this.x = Float32Array.from(xs); this.y = Float32Array.from(ys); this.z = Float32Array.from(zs);
    // 3. links
    const start = new Int32Array(n + 1), list = [], cost = [];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    const nodeAt = (i, j, y) => {
      if (i < 0 || j < 0 || i >= W || j >= H) return -1;
      const ns = this.cellNodes[j * W + i];
      if (!ns) return -1;
      for (const id of ns) if (Math.abs(this.y[id] - y) < 0.45) return id;
      return -1;
    };
    for (let id = 0; id < n; id++) {
      start[id] = list.length;
      const i = Math.floor((this.x[id] - b.minX) / cell), j = Math.floor((this.z[id] - b.minZ) / cell);
      for (const [di, dj] of dirs) {
        const m = nodeAt(i + di, j + dj, this.y[id]);
        if (m < 0) continue;
        if (di && dj && (nodeAt(i + di, j, this.y[id]) < 0 || nodeAt(i, j + dj, this.y[id]) < 0)) continue;
        list.push(m);
        cost.push((di && dj ? 1.4142 : 1) * cell + Math.abs(this.y[m] - this.y[id]));
      }
    }
    start[n] = list.length;
    this.start = start;
    this.list = Int32Array.from(list);
    this.cost = Float32Array.from(cost);
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Int32Array(n);
    this.closed = new Int32Array(n);
    this.stamp = 0;
    this.heapId = new Int32Array(n * 4);
    this.heapF = new Float32Array(n * 4);
  }

  nearestNode(x, y, z, maxRing = 4) {
    const ci = Math.floor((x - this.b.minX) / this.cell), cj = Math.floor((z - this.b.minZ) / this.cell);
    let best = -1, bd = Infinity;
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let j = cj - ring; j <= cj + ring; j++) {
        for (let i = ci - ring; i <= ci + ring; i++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
          if (i < 0 || j < 0 || i >= this.W || j >= this.H) continue;
          const ns = this.cellNodes[j * this.W + i];
          if (!ns) continue;
          for (const id of ns) {
            const dy = Math.abs(this.y[id] - y);
            if (dy > 1.3) continue;
            const d = Math.hypot(this.x[id] - x, this.z[id] - z) + dy * 2;
            if (d < bd) { bd = d; best = id; }
          }
        }
      }
      if (best >= 0 && ring >= 1) break;
    }
    return best;
  }

  heapPush(size, id, f) {
    let i = size;
    this.heapId[i] = id; this.heapF[i] = f;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.heapF[p] <= this.heapF[i]) break;
      [this.heapId[p], this.heapId[i]] = [this.heapId[i], this.heapId[p]];
      [this.heapF[p], this.heapF[i]] = [this.heapF[i], this.heapF[p]];
      i = p;
    }
  }

  heapPop(size) {
    const top = this.heapId[0];
    const last = size - 1;
    this.heapId[0] = this.heapId[last]; this.heapF[0] = this.heapF[last];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < last && this.heapF[l] < this.heapF[m]) m = l;
      if (r < last && this.heapF[r] < this.heapF[m]) m = r;
      if (m === i) break;
      [this.heapId[m], this.heapId[i]] = [this.heapId[i], this.heapId[m]];
      [this.heapF[m], this.heapF[i]] = [this.heapF[i], this.heapF[m]];
      i = m;
    }
    return top;
  }

  /** Returns a smoothed array of {x,y,z} points, or null. */
  findPath(from, to, maxIter = 9000) {
    const s = this.nearestNode(from.x, from.y, from.z);
    const t = this.nearestNode(to.x, to.y, to.z);
    if (s < 0 || t < 0) return null;
    if (s === t) return [{ x: this.x[t], y: this.y[t], z: this.z[t] }];
    const st = ++this.stamp;
    const hx = this.x[t], hy = this.y[t], hz = this.z[t];
    const h = (id) => Math.hypot(this.x[id] - hx, this.z[id] - hz) + Math.abs(this.y[id] - hy) * 1.5;
    let size = 0;
    this.g[s] = 0; this.seen[s] = st; this.parent[s] = -1;
    this.heapPush(size++, s, h(s));
    let found = false, iter = 0;
    while (size > 0 && iter++ < maxIter) {
      const n = this.heapPop(size--);
      if (n === t) { found = true; break; }
      if (this.closed[n] === st) continue;
      this.closed[n] = st;
      for (let k = this.start[n]; k < this.start[n + 1]; k++) {
        const m = this.list[k];
        if (this.closed[m] === st) continue;
        const ng = this.g[n] + this.cost[k];
        if (this.seen[m] !== st || ng < this.g[m]) {
          this.seen[m] = st; this.g[m] = ng; this.parent[m] = n;
          if (size < this.heapId.length) this.heapPush(size++, m, ng + h(m));
        }
      }
    }
    if (!found) return null;
    const ids = [];
    for (let c = t; c !== -1; c = this.parent[c]) ids.push(c);
    ids.reverse();
    return this.smooth(ids);
  }

  smooth(ids) {
    const pts = ids.map((id) => ({ x: this.x[id], y: this.y[id], z: this.z[id] }));
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let best = i + 1;
      for (let j = i + 2; j < Math.min(pts.length, i + 40); j++) {
        if (this.walkable(pts[i], pts[j])) best = j; else break;
      }
      out.push(pts[best]);
      i = best;
    }
    return out;
  }

  walkable(a, b) {
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.ceil(d / (this.cell * 0.5));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, y = a.y + (b.y - a.y) * t;
      const k = this.cellOf(x, z);
      if (k < 0) return false;
      const ns = this.cellNodes[k];
      if (!ns) return false;
      let ok = false;
      for (const id of ns) if (Math.abs(this.y[id] - y) < 0.5) { ok = true; break; }
      if (!ok) return false;
    }
    return true;
  }

  randomNear(x, y, z, radius) {
    for (let tries = 0; tries < 20; tries++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * radius;
      const id = this.nearestNode(x + Math.cos(a) * r, y, z + Math.sin(a) * r, 2);
      if (id >= 0) return { x: this.x[id], y: this.y[id], z: this.z[id] };
    }
    return null;
  }

  /** Extracts cover spots beside every collider flagged as cover. */
  buildCover() {
    const pts = [];
    for (const c of this.physics.colliders) {
      if (!c.cover || !c.move) continue;
      const baseY = c.minY;
      const hgt = c.maxY - baseY;
      if (hgt < 0.75) continue;
      const low = hgt < 1.4;
      const sides = [
        { nx: -1, nz: 0, a0: c.minZ, a1: c.maxZ, fixed: c.minX, axis: 'z' },
        { nx: 1, nz: 0, a0: c.minZ, a1: c.maxZ, fixed: c.maxX, axis: 'z' },
        { nx: 0, nz: -1, a0: c.minX, a1: c.maxX, fixed: c.minZ, axis: 'x' },
        { nx: 0, nz: 1, a0: c.minX, a1: c.maxX, fixed: c.maxZ, axis: 'x' },
      ];
      for (const s of sides) {
        const len = s.a1 - s.a0;
        const cnt = Math.max(1, Math.round(len / 1.2));
        for (let k = 0; k < cnt; k++) {
          const a = s.a0 + ((k + 0.5) / cnt) * len;
          const px = s.axis === 'z' ? s.fixed + s.nx * 0.55 : a;
          const pz = s.axis === 'z' ? a : s.fixed + s.nz * 0.55;
          const id = this.nearestNode(px, baseY, pz, 1);
          if (id < 0 || Math.abs(this.y[id] - baseY) > 0.3) continue;
          if (Math.hypot(this.x[id] - px, this.z[id] - pz) > 0.45) continue;
          const x = this.x[id], y = this.y[id], z = this.z[id];
          if (pts.some((p) => Math.abs(p.y - y) < 0.5 && Math.hypot(p.x - x, p.z - z) < 0.8)) continue;
          pts.push({ x, y, z, nx: -s.nx, nz: -s.nz, low, owner: null });
        }
      }
    }
    this.cover = pts;
    return pts;
  }
}
