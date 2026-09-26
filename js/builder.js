// LevelBuilder: the small API the map and props are authored with.
// Every solid() call creates both the render geometry (batched) and the matching collider.
import * as THREE from 'three';
import { worldBox, finishGeometry, StaticBatch } from './geometry.js';
import { mulberry32 } from './util.js';

export class LevelBuilder {
  constructor(scene, physics, mats, quality) {
    this.scene = scene;
    this.physics = physics;
    this.M = mats;
    this.quality = quality;
    this.batch = new StaticBatch();
    this.rng = mulberry32(2024);
    this.panes = [];        // glass panes -> one InstancedMesh
    this.baseY = 0;         // floor height used by props that support elevated placement
  }

  /** Visual box + collider. opts: collide, ao, cast, and any Collider flag. */
  solid(minX, minY, minZ, maxX, maxY, maxZ, mat, opts = {}) {
    const ao = opts.ao !== undefined ? opts.ao : true;
    const g = worldBox(minX, minY, minZ, maxX, maxY, maxZ, ao);
    if (opts.uvSwap) swapUV(g);
    this.batch.add(g, mat, { cast: opts.cast !== false, receive: true });
    if (opts.collide === false) return null;
    return this.physics.addBox(minX, minY, minZ, maxX, maxY, maxZ, {
      surface: mat.userData.surface || 'concrete', ...opts,
    });
  }

  vis(minX, minY, minZ, maxX, maxY, maxZ, mat, opts = {}) {
    return this.solid(minX, minY, minZ, maxX, maxY, maxZ, mat, { ...opts, collide: false });
  }

  collider(minX, minY, minZ, maxX, maxY, maxZ, opts = {}) {
    return this.physics.addBox(minX, minY, minZ, maxX, maxY, maxZ, opts);
  }

  /** Arbitrary (possibly rotated) geometry. */
  mesh(geometry, mat, matrix = null, opts = {}) {
    if (matrix) geometry.applyMatrix4(matrix);
    finishGeometry(geometry, opts.ao !== undefined ? opts.ao : false, opts.baseY ?? null);
    this.batch.add(geometry, mat, { cast: opts.cast !== false, receive: opts.receive !== false });
  }

  /**
   * Wall with openings. axis 'x' = wall runs along X at z=c; axis 'z' = runs along Z at x=c.
   * openings: [{a, b, bottom, top, kind:'window'|'door'|'open', glass:'intact'|'broken'|'none'}]
   */
  wall(axis, c, from, to, thick, y0, y1, mat, openings = [], opts = {}) {
    const ops = [...openings].sort((p, q) => p.a - q.a);
    let cur = from;
    const seg = (a, b, ya, yb, ao) => {
      if (b - a < 0.001 || yb - ya < 0.001) return;
      if (axis === 'x') this.solid(a, ya, c - thick / 2, b, yb, c + thick / 2, mat, { ...opts, ao });
      else this.solid(c - thick / 2, ya, a, c + thick / 2, yb, b, mat, { ...opts, ao });
    };
    for (const o of ops) {
      seg(cur, o.a, y0, y1, true);
      if (o.bottom > y0) seg(o.a, o.b, y0, o.bottom, true);
      if (o.top < y1) seg(o.a, o.b, o.top, y1, false);
      if (o.kind === 'window') this.windowDetail(axis, c, thick, o);
      else if (o.kind === 'door') this.doorFrame(axis, c, thick, o);
      cur = o.b;
    }
    seg(cur, to, y0, y1, true);
  }

  /** Steel industrial window: frame, mullion grid and glass panes (some broken). */
  windowDetail(axis, c, thick, o) {
    const M = this.M, fr = 0.05, fd = 0.06;
    const len = o.b - o.a, hgt = o.top - o.bottom;
    const box = (a0, y0, a1, y1, d0, d1, mat) => {
      if (axis === 'x') this.vis(a0, y0, c + d0, a1, y1, c + d1, mat, { ao: false });
      else this.vis(c + d0, y0, a0, c + d1, y1, a1, mat, { ao: false });
    };
    // sill (concrete, protruding slightly on both sides)
    box(o.a - 0.04, o.bottom - 0.05, o.b + 0.04, o.bottom, -thick / 2 - 0.05, thick / 2 + 0.05, M.concreteDark);
    const d0 = -fd / 2, d1 = fd / 2;
    box(o.a, o.bottom, o.a + fr, o.top, d0, d1, M.steelDark);
    box(o.b - fr, o.bottom, o.b, o.top, d0, d1, M.steelDark);
    box(o.a, o.top - fr, o.b, o.top, d0, d1, M.steelDark);
    box(o.a, o.bottom, o.b, o.bottom + fr, d0, d1, M.steelDark);
    const cols = Math.max(1, Math.round(len / 0.6)), rows = Math.max(1, Math.round(hgt / 0.5));
    const cw = len / cols, rh = hgt / rows, mw = 0.025;
    for (let i = 1; i < cols; i++) box(o.a + i * cw - mw, o.bottom, o.a + i * cw + mw, o.top, d0 * 0.8, d1 * 0.8, M.steelDark);
    for (let j = 1; j < rows; j++) box(o.a, o.bottom + j * rh - mw, o.b, o.bottom + j * rh + mw, d0 * 0.8, d1 * 0.8, M.steelDark);
    if (o.glass === 'none') return;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const broken = o.glass === 'broken' ? this.rng() < 0.55 : false;
        if (broken) continue;
        const a0 = o.a + i * cw + 0.01, a1 = o.a + (i + 1) * cw - 0.01;
        const y0 = o.bottom + j * rh + 0.01, y1 = o.bottom + (j + 1) * rh - 0.01;
        this.addPane(axis, c, a0, a1, y0, y1);
      }
    }
  }

  addPane(axis, c, a0, a1, y0, y1) {
    const t = 0.006;
    const pane = axis === 'x'
      ? { minX: a0, maxX: a1, minY: y0, maxY: y1, minZ: c - t, maxZ: c + t }
      : { minX: c - t, maxX: c + t, minY: y0, maxY: y1, minZ: a0, maxZ: a1 };
    pane.broken = false;
    pane.axis = axis;
    pane.index = this.panes.length;
    // glass stops walking through low windows until shattered
    pane.collider = this.physics.addBox(pane.minX, pane.minY, pane.minZ, pane.maxX, pane.maxY, pane.maxZ,
      { bullet: false, sight: false, walkTop: false, surface: 'glass' });
    this.physics.addGlass(pane);
    this.panes.push(pane);
    return pane;
  }

  doorFrame(axis, c, thick, o) {
    const M = this.M, fw = 0.06, ext = thick / 2 + 0.015;
    const box = (a0, y0, a1, y1) => {
      if (axis === 'x') this.vis(a0, y0, c - ext, a1, y1, c + ext, M.steelDark, { ao: false });
      else this.vis(c - ext, y0, a0, c + ext, y1, a1, M.steelDark, { ao: false });
    };
    box(o.a - fw, o.bottom, o.a, o.top + fw);
    box(o.b, o.bottom, o.b + fw, o.top + fw);
    box(o.a - fw, o.top, o.b + fw, o.top + fw);
    if (o.leaf) this.doorLeaf(axis, c, o);
  }

  /** Door leaf swung fully open against the wall (axis-aligned so it can collide). */
  doorLeaf(axis, c, o) {
    const M = this.M, w = o.b - o.a, t = 0.045, side = o.leaf === 'neg' ? -1 : 1;
    const hingeA = o.hinge === 'b' ? o.b : o.a;
    const mat = o.leafMat || M.steelGrey;
    const y0 = o.bottom + 0.01, y1 = o.top - 0.01;
    if (axis === 'x') {
      const z0 = c + side * 0.1, z1 = z0 + side * w;
      const x0 = o.hinge === 'b' ? hingeA + 0.02 : hingeA - 0.02 - t;
      this.solid(x0, y0, Math.min(z0, z1), x0 + t, y1, Math.max(z0, z1), mat, { ao: false, bullet: true, thin: true, walkTop: false });
    } else {
      const x0 = c + side * 0.1, x1 = x0 + side * w;
      const z0 = o.hinge === 'b' ? hingeA + 0.02 : hingeA - 0.02 - t;
      this.solid(Math.min(x0, x1), y0, z0, Math.max(x0, x1), y1, z0 + t, mat, { ao: false, bullet: true, thin: true, walkTop: false });
    }
  }

  /** Creates the instanced glass mesh once the level is authored. */
  buildGlass() {
    if (!this.panes.length) return null;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.InstancedMesh(geo, this.M.glass, this.panes.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    this.panes.forEach((pn, i) => {
      p.set((pn.minX + pn.maxX) / 2, (pn.minY + pn.maxY) / 2, (pn.minZ + pn.maxZ) / 2);
      if (pn.axis === 'x') { q.identity(); s.set(pn.maxX - pn.minX, pn.maxY - pn.minY, 1); }
      else { q.setFromAxisAngle(up, Math.PI / 2); s.set(pn.maxZ - pn.minZ, pn.maxY - pn.minY, 1); }
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.glassMesh = mesh;
    return mesh;
  }

  finish() {
    this.buildGlass();
    return this.batch.build(this.scene);
  }
}

function swapUV(g) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    uv.setXY(i, v, u);
  }
}
