// Projectile ballistics for open terrain: gravity and quadratic air drag, sub-stepped flight with each
// segment resolved by the same hit code as hitscan (world, glass, soldiers, player, near misses),
// retained energy scaling damage, scope zeroing and time-of-flight prediction for AI marksmen.
import * as THREE from 'three';
import { GRAVITY } from './config.js';
import { clamp } from './util.js';

const _d = new THREE.Vector3();
const STEP = 1 / 60;

export class Ballistics {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.pool = [];
    this.zeroCache = new Map();
    this.predCache = new Map();
  }

  clear() {
    for (const b of this.list) this.pool.push(b);
    this.list.length = 0;
  }

  /** Launches a round from o along unit direction d with the weapon's muzzle velocity. */
  fire(o, d, w, shooter, primary) {
    const b = this.pool.pop() || { p: new THREE.Vector3(), v: new THREE.Vector3() };
    b.p.copy(o);
    b.v.copy(d).multiplyScalar(w.velocity);
    b.w = w;
    b.shooter = shooter;
    b.primary = primary;
    b.dist = 0;
    b.t = 0;
    b.v0 = w.velocity;
    b.first = true;
    // resolve the first metres at once so point-blank shots are not a frame late
    if (this.step(b, 1 / 120)) this.list.push(b);
    else this.pool.push(b);
  }

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i];
      let rem = dt, alive = true;
      while (rem > 1e-6 && alive) {
        const h = Math.min(rem, STEP);
        alive = this.step(b, h);
        rem -= h;
      }
      if (!alive) { this.list.splice(i, 1); this.pool.push(b); }
    }
  }

  /** Advances one round by h seconds. Returns false once it has stopped or expired. */
  step(b, h) {
    const k = b.w.drag || 0.0008, v = b.v;
    const sp = v.length();
    const ax = -k * sp * v.x, ay = -GRAVITY - k * sp * v.y, az = -k * sp * v.z;
    const nx = b.p.x + v.x * h + 0.5 * ax * h * h;
    const ny = b.p.y + v.y * h + 0.5 * ay * h * h;
    const nz = b.p.z + v.z * h + 0.5 * az * h * h;
    v.x += ax * h; v.y += ay * h; v.z += az * h;
    _d.set(nx - b.p.x, ny - b.p.y, nz - b.p.z);
    const len = _d.length();
    if (len < 1e-6) return false;
    _d.divideScalar(len);
    // kinetic energy falls with speed; lethality holds up well until the round slows a lot
    const energy = clamp((sp / b.v0) * 1.15, 0.45, 1);
    const stopped = this.game.traceBullet(b.p, _d, len, b.w, b.shooter, b.primary, b.dist, energy, b.first);
    b.first = false;
    b.p.set(nx, ny, nz);
    b.dist += len;
    b.t += h;
    if (stopped) return false;
    if (b.dist > (b.w.range || 1200) * 1.25 || b.t > 4.5 || sp < 80) return false;
    return true;
  }

  /** Bore elevation (radians) that brings the round back onto the line of sight at `range` metres. */
  zeroAngle(w, range) {
    const key = `${w.velocity}|${w.drag}|${range}`;
    let a = this.zeroCache.get(key);
    if (a !== undefined) return a;
    a = 0;
    for (let it = 0; it < 5; it++) a += Math.atan2(-this.simulate(w.velocity, w.drag, a, range).y, range);
    this.zeroCache.set(key, a);
    return a;
  }

  /** Flight time and drop below the bore line at horizontal distance `dist` (for AI hold-over). */
  predict(velocity, drag, dist) {
    const key = `${velocity}|${drag}|${Math.round(dist / 5)}`;
    let r = this.predCache.get(key);
    if (r) return r;
    const s = this.simulate(velocity, drag, 0, Math.round(dist / 5) * 5);
    r = { t: s.t, drop: -s.y };
    this.predCache.set(key, r);
    return r;
  }

  simulate(velocity, drag, ang, range) {
    let x = 0, y = 0, t = 0;
    let vx = velocity * Math.cos(ang), vy = velocity * Math.sin(ang);
    const h = 0.002;
    while (x < range && t < 6) {
      const sp = Math.hypot(vx, vy);
      const ax = -drag * sp * vx, ay = -GRAVITY - drag * sp * vy;
      x += vx * h; y += vy * h;
      vx += ax * h; vy += ay * h;
      t += h;
      if (vx < 5) break;
    }
    return { y, t };
  }
}
