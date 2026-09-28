// Lightweight collision world: axis-aligned boxes, stair ramps, floor queries and ray casts.
// The whole level is built from AABBs, which keeps collision and bullet tests exact and cheap.

export class Collider {
  constructor(minX, minY, minZ, maxX, maxY, maxZ, opts = {}) {
    this.minX = minX; this.minY = minY; this.minZ = minZ;
    this.maxX = maxX; this.maxY = maxY; this.maxZ = maxZ;
    this.move = opts.move !== false;       // blocks movement
    this.bullet = opts.bullet !== false;   // stops bullets
    this.sight = opts.sight !== false;     // blocks AI line of sight
    this.walkTop = opts.walkTop !== false; // top face is a floor you can stand on
    this.nav = !!opts.nav;                 // top face is part of the AI nav mesh
    this.cover = !!opts.cover;             // AI considers it for cover points
    this.surface = opts.surface || 'concrete';
    this.thin = !!opts.thin;               // bullets penetrate (wood / sheet metal)
    this.glass = null;
  }
}

export class Ramp {
  constructor(minX, maxX, minZ, maxZ, axis, y0, y1, surface = 'metal') {
    // y0 at the min side of the axis, y1 at the max side
    Object.assign(this, { minX, maxX, minZ, maxZ, axis, y0, y1, surface });
  }
  heightAt(x, z) {
    if (x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return null;
    const t = this.axis === 'z' ? (z - this.minZ) / (this.maxZ - this.minZ) : (x - this.minX) / (this.maxX - this.minX);
    return this.y0 + (this.y1 - this.y0) * t;
  }
}

const hitResult = () => ({ t: Infinity, nx: 0, ny: 0, nz: 0, collider: null });
const EMPTY = [];
const _tn = { x: 0, y: 1, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }, normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; this.x /= l; this.y /= l; this.z /= l; return this; } };

export class PhysicsWorld {
  constructor() {
    this.colliders = [];
    this.ramps = [];
    this.glass = [];     // thin panes: bullets pass through & shatter them
    this.groundSurfaceFn = () => 'concrete';
    this.terrain = null; // optional heightfield (mountain map)
    this.grid = null;    // optional broad phase for large open maps
    this._hit = hitResult();
    this._terrHit = { terrain: true, surface: 'dirt', move: false, bullet: true, sight: true, thin: false };
  }

  addBox(minX, minY, minZ, maxX, maxY, maxZ, opts) {
    const c = new Collider(
      Math.min(minX, maxX), Math.min(minY, maxY), Math.min(minZ, maxZ),
      Math.max(minX, maxX), Math.max(minY, maxY), Math.max(minZ, maxZ), opts);
    this.colliders.push(c);
    if (this.grid) this._gridInsert(c, this.colliders.length - 1);
    return c;
  }

  /** Heightfield ground: floors never go below it and rays / sight lines hit it. */
  setTerrain(terrain) {
    this.terrain = terrain;
    this.groundSurfaceFn = (x, z) => terrain.surfaceAt(x, z);
  }

  /**
   * Uniform 2D grid over the collider set so point queries and long rays only touch nearby boxes.
   * Colliders are inserted with a margin, so circle queries up to that radius need a single cell.
   */
  enableGrid(minX, minZ, maxX, maxZ, cell = 8, margin = 1.2) {
    const W = Math.ceil((maxX - minX) / cell), H = Math.ceil((maxZ - minZ) / cell);
    this.grid = { minX, minZ, maxX: minX + W * cell, maxZ: minZ + H * cell, cell, margin, W, H, cells: new Array(W * H), outside: [] };
    this._mark = new Uint32Array(Math.max(1024, this.colliders.length * 2));
    this._stamp = 0;
    this.colliders.forEach((c, i) => this._gridInsert(c, i));
  }

  _gridInsert(c, idx) {
    const G = this.grid, m = G.margin;
    if (c.minX - m < G.minX || c.maxX + m > G.maxX || c.minZ - m < G.minZ || c.maxZ + m > G.maxZ) G.outside.push(c);
    const i0 = Math.max(0, Math.floor((c.minX - m - G.minX) / G.cell)), i1 = Math.min(G.W - 1, Math.floor((c.maxX + m - G.minX) / G.cell));
    const j0 = Math.max(0, Math.floor((c.minZ - m - G.minZ) / G.cell)), j1 = Math.min(G.H - 1, Math.floor((c.maxZ + m - G.minZ) / G.cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * G.W + i;
      (G.cells[k] || (G.cells[k] = [])).push(c);
    }
    if (idx >= this._mark.length) { const n = new Uint32Array(idx * 2); n.set(this._mark); this._mark = n; }
    c._id = idx;
  }

  /** Colliders relevant to a point (the whole list without a grid). */
  near(x, z) {
    const G = this.grid;
    if (!G) return this.colliders;
    const i = Math.floor((x - G.minX) / G.cell), j = Math.floor((z - G.minZ) / G.cell);
    if (i < 0 || j < 0 || i >= G.W || j >= G.H) return G.outside;
    return G.cells[j * G.W + i] || EMPTY;
  }

  groundAt(x, z) { return this.terrain ? this.terrain.heightAt(x, z) : 0; }

  addRamp(r) { this.ramps.push(r); return r; }

  addGlass(pane) { this.glass.push(pane); return pane; }

  /** Highest standable surface at (x,z) whose top is <= maxY. */
  floorAt(x, z, maxY, out = { y: 0, surface: 'concrete' }) {
    let best = this.terrain ? this.terrain.heightAt(x, z) : 0, surface = null;
    const cs = this.near(x, z);
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (!c.walkTop || c.maxY > maxY || c.maxY <= best) continue;
      if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) continue;
      best = c.maxY; surface = c.surface;
    }
    for (let i = 0; i < this.ramps.length; i++) {
      const r = this.ramps[i];
      const h = r.heightAt(x, z);
      if (h !== null && h <= maxY && h > best) { best = h; surface = r.surface; }
    }
    out.y = best;
    out.surface = surface || this.groundSurfaceFn(x, z);
    return out;
  }

  /**
   * Resolves a vertical cylinder (feet at pos.y) against the boxes.
   * Boxes whose top is below feet + stepUp are ignored (you step onto them instead).
   */
  resolveCircle(pos, radius, height, stepUp) {
    const cs = this.near(pos.x, pos.z);
    let hitWall = false;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        if (!c.move) continue;
        if (c.maxY <= pos.y + stepUp || c.minY >= pos.y + height) continue;
        if (pos.x + radius < c.minX || pos.x - radius > c.maxX || pos.z + radius < c.minZ || pos.z - radius > c.maxZ) continue;
        const cx = Math.max(c.minX, Math.min(pos.x, c.maxX));
        const cz = Math.max(c.minZ, Math.min(pos.z, c.maxZ));
        let dx = pos.x - cx, dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > radius * radius) continue;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          const push = radius - d;
          pos.x += (dx / d) * push;
          pos.z += (dz / d) * push;
        } else {
          // centre inside the box: push out along the smallest penetration axis
          const pl = pos.x - c.minX, pr = c.maxX - pos.x, pb = pos.z - c.minZ, pf = c.maxZ - pos.z;
          const m = Math.min(pl, pr, pb, pf);
          if (m === pl) pos.x = c.minX - radius;
          else if (m === pr) pos.x = c.maxX + radius;
          else if (m === pb) pos.z = c.minZ - radius;
          else pos.z = c.maxZ + radius;
        }
        moved = true;
        hitWall = true;
      }
      if (!moved) break;
    }
    return hitWall;
  }

  /** True if a vertical cylinder at pos overlaps any blocking box (used for stand-up checks). */
  overlaps(x, y, z, radius, height) {
    const cs = this.near(x, z);
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (!c.move || c.maxY <= y + 0.05 || c.minY >= y + height) continue;
      if (x + radius <= c.minX || x - radius >= c.maxX || z + radius <= c.minZ || z - radius >= c.maxZ) continue;
      return true;
    }
    return false;
  }

  /**
   * Ray vs all boxes. mask: 'bullet' | 'sight' | 'move' | 'any'.
   * Returns the shared hit object (copy it if you need to keep it) or null.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, mask = 'bullet', ignoreThin = false) {
    if (this.grid) return this._raycastGrid(ox, oy, oz, dx, dy, dz, maxDist, mask, ignoreThin);
    const cs = this.colliders;
    const ix = 1 / (dx || 1e-12), iy = 1 / (dy || 1e-12), iz = 1 / (dz || 1e-12);
    let bestT = maxDist, best = null, bnx = 0, bny = 0, bnz = 0;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (mask === 'bullet' ? !c.bullet : mask === 'sight' ? !c.sight : mask === 'move' ? !c.move : false) continue;
      if (ignoreThin && c.thin) continue;
      let t1 = (c.minX - ox) * ix, t2 = (c.maxX - ox) * ix;
      let tmin, tmax, ax = 0;
      if (t1 > t2) { tmin = t2; tmax = t1; } else { tmin = t1; tmax = t2; }
      t1 = (c.minY - oy) * iy; t2 = (c.maxY - oy) * iy;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      if (t1 > tmin) { tmin = t1; ax = 1; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) continue;
      t1 = (c.minZ - oz) * iz; t2 = (c.maxZ - oz) * iz;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      if (t1 > tmin) { tmin = t1; ax = 2; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax || tmax < 0 || tmin < 0) continue; // tmin<0: origin inside box, ignore
      if (tmin < bestT) {
        bestT = tmin; best = c;
        bnx = ax === 0 ? -Math.sign(dx) : 0;
        bny = ax === 1 ? -Math.sign(dy) : 0;
        bnz = ax === 2 ? -Math.sign(dz) : 0;
      }
    }
    // ramps (stairs) act as solid inclined planes for bullets / sight
    if (mask !== 'move') {
      for (let i = 0; i < this.ramps.length; i++) {
        const r = this.ramps[i];
        const t = this._rayRamp(r, ox, oy, oz, dx, dy, dz, bestT);
        if (t !== null) {
          bestT = t; best = r;
          const len = r.axis === 'z' ? r.maxZ - r.minZ : r.maxX - r.minX;
          const slope = (r.y1 - r.y0) / len;
          const n = 1 / Math.hypot(1, slope);
          bnx = r.axis === 'x' ? -slope * n : 0; bnz = r.axis === 'z' ? -slope * n : 0; bny = n;
        }
      }
    }
    if (!best) return null;
    const h = this._hit;
    h.t = bestT; h.nx = bnx; h.ny = bny; h.nz = bnz; h.collider = best;
    h.surface = best.surface;
    return h;
  }

  /** Grid traversal (2D DDA over xz) + heightfield march. Same contract as raycast(). */
  _raycastGrid(ox, oy, oz, dx, dy, dz, maxDist, mask, ignoreThin) {
    const G = this.grid;
    const ix = 1 / (dx || 1e-12), iy = 1 / (dy || 1e-12), iz = 1 / (dz || 1e-12);
    const st = ++this._stamp, mark = this._mark;
    let bestT = maxDist, best = null, bnx = 0, bny = 0, bnz = 0;
    const test = (cs) => {
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        if (mark[c._id] === st) continue;
        mark[c._id] = st;
        if (mask === 'bullet' ? !c.bullet : mask === 'sight' ? !c.sight : mask === 'move' ? !c.move : false) continue;
        if (ignoreThin && c.thin) continue;
        let t1 = (c.minX - ox) * ix, t2 = (c.maxX - ox) * ix;
        let tmin, tmax, ax = 0;
        if (t1 > t2) { tmin = t2; tmax = t1; } else { tmin = t1; tmax = t2; }
        t1 = (c.minY - oy) * iy; t2 = (c.maxY - oy) * iy;
        if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
        if (t1 > tmin) { tmin = t1; ax = 1; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) continue;
        t1 = (c.minZ - oz) * iz; t2 = (c.maxZ - oz) * iz;
        if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
        if (t1 > tmin) { tmin = t1; ax = 2; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax || tmax < 0 || tmin < 0) continue;
        if (tmin < bestT) {
          bestT = tmin; best = c;
          bnx = ax === 0 ? -Math.sign(dx) : 0;
          bny = ax === 1 ? -Math.sign(dy) : 0;
          bnz = ax === 2 ? -Math.sign(dz) : 0;
        }
      }
    };
    if (G.outside.length) test(G.outside);
    // clip the ray to the grid rectangle, then walk the cells it crosses (nearest first)
    let t0 = 0, t1 = maxDist;
    if (Math.abs(dx) < 1e-9) { if (ox < G.minX || ox > G.maxX) t1 = -1; }
    else { let a = (G.minX - ox) * ix, b = (G.maxX - ox) * ix; if (a > b) { const s = a; a = b; b = s; } t0 = Math.max(t0, a); t1 = Math.min(t1, b); }
    if (Math.abs(dz) < 1e-9) { if (oz < G.minZ || oz > G.maxZ) t1 = -1; }
    else { let a = (G.minZ - oz) * iz, b = (G.maxZ - oz) * iz; if (a > b) { const s = a; a = b; b = s; } t0 = Math.max(t0, a); t1 = Math.min(t1, b); }
    if (t0 <= t1) {
      const px = ox + dx * (t0 + 1e-4), pz = oz + dz * (t0 + 1e-4);
      let i = Math.min(G.W - 1, Math.max(0, Math.floor((px - G.minX) / G.cell)));
      let j = Math.min(G.H - 1, Math.max(0, Math.floor((pz - G.minZ) / G.cell)));
      const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
      const flatX = Math.abs(dx) < 1e-9, flatZ = Math.abs(dz) < 1e-9;
      const tdx = flatX ? Infinity : G.cell / Math.abs(dx);
      const tdz = flatZ ? Infinity : G.cell / Math.abs(dz);
      let tmx = flatX ? Infinity : ((G.minX + (i + (sx > 0 ? 1 : 0)) * G.cell) - ox) * ix;
      let tmz = flatZ ? Infinity : ((G.minZ + (j + (sz > 0 ? 1 : 0)) * G.cell) - oz) * iz;
      let tEnter = t0;
      for (let guard = 0; guard < 8192; guard++) {
        if (tEnter > bestT || tEnter > t1) break;
        const cs = G.cells[j * G.W + i];
        if (cs) test(cs);
        if (tmx < tmz) { tEnter = tmx; tmx += tdx; i += sx; } else { tEnter = tmz; tmz += tdz; j += sz; }
        if (i < 0 || j < 0 || i >= G.W || j >= G.H) break;
      }
    }
    if (mask !== 'move') {
      for (let i = 0; i < this.ramps.length; i++) {
        const r = this.ramps[i];
        const t = this._rayRamp(r, ox, oy, oz, dx, dy, dz, bestT);
        if (t !== null) { bestT = t; best = r; bnx = 0; bny = 1; bnz = 0; }
      }
    }
    const h = this._hit;
    if (this.terrain && mask !== 'move') {
      const tt = this.terrain.raycast(ox, oy, oz, dx, dy, dz, bestT);
      if (tt !== null && tt < bestT) {
        const x = ox + dx * tt, z = oz + dz * tt;
        const n = this.terrain.normalAt(x, z, _tn);
        h.t = tt; h.nx = n.x; h.ny = n.y; h.nz = n.z;
        h.collider = this._terrHit;
        h.surface = this.terrain.surfaceAt(x, z);
        return h;
      }
    }
    if (!best) return null;
    h.t = bestT; h.nx = bnx; h.ny = bny; h.nz = bnz; h.collider = best;
    h.surface = best.surface;
    return h;
  }

  _rayRamp(r, ox, oy, oz, dx, dy, dz, maxT) {
    // plane: y = y0 + slope * (a - a0) where a is x or z
    const len = r.axis === 'z' ? r.maxZ - r.minZ : r.maxX - r.minX;
    const slope = (r.y1 - r.y0) / len;
    const a0 = r.axis === 'z' ? r.minZ : r.minX;
    const oa = r.axis === 'z' ? oz : ox, da = r.axis === 'z' ? dz : dx;
    const denom = dy - slope * da;
    if (Math.abs(denom) < 1e-8) return null;
    const t = (r.y0 + slope * (oa - a0) - oy) / denom;
    if (t <= 0.001 || t >= maxT) return null;
    const x = ox + dx * t, z = oz + dz * t;
    if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) return null;
    return t;
  }

  /** Line of sight between two points. */
  clearLine(ax, ay, az, bx, by, bz, mask = 'sight') {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-4) return true;
    return this.raycast(ax, ay, az, dx / d, dy / d, dz / d, d - 0.05, mask) === null;
  }

  /** Glass panes crossed by a ray segment (for shatter effects). */
  glassAlong(ox, oy, oz, dx, dy, dz, maxT, out) {
    out.length = 0;
    for (const g of this.glass) {
      if (g.broken) continue;
      const t = this._rayBox(g, ox, oy, oz, dx, dy, dz);
      if (t !== null && t < maxT) out.push({ pane: g, t });
    }
    return out;
  }

  _rayBox(c, ox, oy, oz, dx, dy, dz) {
    const ix = 1 / (dx || 1e-12), iy = 1 / (dy || 1e-12), iz = 1 / (dz || 1e-12);
    let t1 = (c.minX - ox) * ix, t2 = (c.maxX - ox) * ix;
    let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
    t1 = (c.minY - oy) * iy; t2 = (c.maxY - oy) * iy;
    tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
    t1 = (c.minZ - oz) * iz; t2 = (c.maxZ - oz) * iz;
    tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
    if (tmax < Math.max(tmin, 0)) return null;
    return tmin > 0 ? tmin : null;
  }
}
