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

export class PhysicsWorld {
  constructor() {
    this.colliders = [];
    this.ramps = [];
    this.glass = [];     // thin panes: bullets pass through & shatter them
    this.groundSurfaceFn = () => 'concrete';
    this._hit = hitResult();
  }

  addBox(minX, minY, minZ, maxX, maxY, maxZ, opts) {
    const c = new Collider(
      Math.min(minX, maxX), Math.min(minY, maxY), Math.min(minZ, maxZ),
      Math.max(minX, maxX), Math.max(minY, maxY), Math.max(minZ, maxZ), opts);
    this.colliders.push(c);
    return c;
  }

  addRamp(r) { this.ramps.push(r); return r; }

  addGlass(pane) { this.glass.push(pane); return pane; }

  /** Highest standable surface at (x,z) whose top is <= maxY. */
  floorAt(x, z, maxY, out = { y: 0, surface: 'concrete' }) {
    let best = 0, surface = this.groundSurfaceFn(x, z);
    const cs = this.colliders;
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
    out.surface = surface;
    return out;
  }

  /**
   * Resolves a vertical cylinder (feet at pos.y) against the boxes.
   * Boxes whose top is below feet + stepUp are ignored (you step onto them instead).
   */
  resolveCircle(pos, radius, height, stepUp) {
    const cs = this.colliders;
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
    const cs = this.colliders;
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
