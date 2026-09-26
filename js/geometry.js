// Geometry helpers: world-UV boxes, prop primitives, and a static batcher that merges
// everything sharing a material into a single draw call.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const KEEP = new Set(['position', 'normal', 'uv', 'uv1']);

/**
 * Axis-aligned box baked in world space. UVs are planar in metres so textures line up across
 * adjacent pieces; uv1.y stores height above the box base (drives the AO ramp texture).
 */
export function worldBox(minX, minY, minZ, maxX, maxY, maxZ, ao = true) {
  const w = maxX - minX, h = maxY - minY, d = maxZ - minZ;
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
  const uv1 = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
    let u, v;
    if (Math.abs(nx) > 0.5) { u = nx > 0 ? -z : z; v = y; }
    else if (Math.abs(ny) > 0.5) { u = x; v = ny > 0 ? -z : z; }
    else { u = nz > 0 ? x : -x; v = y; }
    uv.setXY(i, u, v);
    let a;
    if (!ao || ny > 0.5) a = 1;
    else if (ny < -0.5) a = 0.4;
    else a = y - minY;
    uv1[i * 2] = 0.5; uv1[i * 2 + 1] = a;
  }
  g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  return g;
}

/** Local-space box whose UVs are scaled to metres (for rotated props). */
export function propBox(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d);
  const nor = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
    const su = nx > 0.5 ? d : w;
    const sv = ny > 0.5 ? d : h;
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  return g;
}

export function propCylinder(rt, rb, h, seg = 12, open = false) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
  const uv = g.attributes.uv;
  const circ = Math.PI * 2 * Math.max(rt, rb);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * h);
  return g;
}

/** Finalises a transformed prop geometry: strips extra attributes, adds uv1 (height above base). */
export function finishGeometry(g, ao = true, baseY = null) {
  for (const name of Object.keys(g.attributes)) if (!KEEP.has(name)) g.deleteAttribute(name);
  if (!g.index) {
    const idx = new Uint32Array(g.attributes.position.count);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  const pos = g.attributes.position;
  if (baseY === null) {
    baseY = Infinity;
    for (let i = 0; i < pos.count; i++) baseY = Math.min(baseY, pos.getY(i));
  }
  const uv1 = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv1[i * 2] = 0.5;
    uv1[i * 2 + 1] = ao ? pos.getY(i) - baseY : 1;
  }
  g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  return g;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();

/** Builds a transform matrix from position + euler rotation (radians). */
export function trs(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  return _m.clone().compose(_p, _q, _s);
}

export class StaticBatch {
  constructor() {
    this.groups = new Map();
  }

  add(geometry, material, { cast = true, receive = true } = {}) {
    const key = `${material.uuid}|${cast ? 1 : 0}|${receive ? 1 : 0}`;
    let grp = this.groups.get(key);
    if (!grp) { grp = { material, cast, receive, geos: [] }; this.groups.set(key, grp); }
    if (!geometry.attributes.uv1 || Object.keys(geometry.attributes).some((n) => !KEEP.has(n)) || !geometry.index) {
      finishGeometry(geometry, false);
    }
    grp.geos.push(geometry);
  }

  build(parent) {
    const meshes = [];
    for (const grp of this.groups.values()) {
      if (!grp.geos.length) continue;
      const merged = mergeGeometries(grp.geos, false);
      if (!merged) { console.warn('merge failed for', grp.material.name); continue; }
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, grp.material);
      mesh.castShadow = grp.cast;
      mesh.receiveShadow = grp.receive;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      parent.add(mesh);
      meshes.push(mesh);
      for (const g of grp.geos) g.dispose();
    }
    this.groups.clear();
    return meshes;
  }
}
