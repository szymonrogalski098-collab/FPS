// Procedural first-person weapon models, arms and the enemy rifle.
// Weapon space: origin at the pistol grip, -Z = muzzle direction, +Y up, +X right.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { propBox, propCylinder } from './geometry.js';

const PI = Math.PI;

function tex(t, rep) {
  if (!t) return null;
  const c = t.clone();
  c.repeat.set(rep, rep);
  c.needsUpdate = true;
  return c;
}

export function createWeaponMaterials(T) {
  const M = {};
  M.metal = new THREE.MeshStandardMaterial({ color: 0x2b2d30, metalness: 0.85, roughness: 1, roughnessMap: tex(T.bare.roughMap, 3), normalMap: tex(T.bare.normalMap, 3), envMapIntensity: 1 });
  M.metalWorn = new THREE.MeshStandardMaterial({ color: 0x3a3c3e, metalness: 0.9, roughness: 1, roughnessMap: tex(T.bare.roughMap, 4), map: tex(T.bare.map, 4) });
  M.polymer = new THREE.MeshStandardMaterial({ color: 0x1d1e1f, metalness: 0, roughness: 0.62, normalMap: tex(T.fabric.normalMap, 10), normalScale: new THREE.Vector2(0.4, 0.4) });
  M.fde = new THREE.MeshStandardMaterial({ color: 0x86765a, metalness: 0, roughness: 0.66, normalMap: tex(T.fabric.normalMap, 10), normalScale: new THREE.Vector2(0.4, 0.4) });
  M.wood = new THREE.MeshStandardMaterial({ color: 0x7a5236, metalness: 0, roughness: 1, map: tex(T.wood.map, 3), roughnessMap: tex(T.wood.roughMap, 3), normalMap: tex(T.wood.normalMap, 3) });
  M.wood.roughness = 0.62;
  M.rubber = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9, metalness: 0 });
  M.lens = new THREE.MeshStandardMaterial({ color: 0x223838, metalness: 0.3, roughness: 0.04, transparent: true, opacity: 0.28, envMapIntensity: 2.5, depthWrite: false });
  M.reticle = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.35, 0.22), depthTest: false, transparent: true });
  M.tritium = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.1, 1.6, 1.0) });
  M.brass = new THREE.MeshStandardMaterial({ color: 0xc9a25a, metalness: 1, roughness: 0.3 });
  M.shellRed = new THREE.MeshStandardMaterial({ color: 0x7a2419, metalness: 0.1, roughness: 0.55 });
  M.sleeve = new THREE.MeshStandardMaterial({ color: 0x474c3d, roughness: 1, map: tex(T.fabric.map, 5), normalMap: tex(T.fabric.normalMap, 5) });
  M.glove = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.86, normalMap: tex(T.fabric.normalMap, 12), normalScale: new THREE.Vector2(0.6, 0.6) });
  M.watch = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4, metalness: 0.2 });
  return M;
}

/** Collects parts per material and merges them into as few meshes as possible. */
class Assembler {
  constructor() { this.parts = new Map(); }
  add(geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
    const g = geo.clone ? geo : geo;
    g.applyMatrix4(m);
    for (const n of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(n)) g.deleteAttribute(n);
    if (!g.index) {
      const idx = new Uint32Array(g.attributes.position.count);
      for (let i = 0; i < idx.length; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    if (!this.parts.has(mat)) this.parts.set(mat, []);
    this.parts.get(mat).push(g);
    return this;
  }
  box(w, h, d, mat, x, y, z, rx, ry, rz) { return this.add(propBox(w, h, d), mat, x, y, z, rx, ry, rz); }
  cylZ(r, len, mat, x, y, z, seg = 12, r2 = null) { return this.add(propCylinder(r, r2 ?? r, len, seg), mat, x, y, z, PI / 2, 0, 0); }
  build() {
    const g = new THREE.Group();
    for (const [mat, geos] of this.parts) {
      const merged = mergeGeometries(geos, false);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.frustumCulled = false;
      g.add(mesh);
    }
    return g;
  }
}

function railTeeth(a, mat, y, z0, z1, w = 0.022) {
  for (let z = z0; z < z1; z += 0.0105) a.box(w + 0.002, 0.004, 0.005, mat, 0, y, z);
}

// ------------------------------------------------------------------ rifle

export function buildRifle(M) {
  const root = new THREE.Group();
  const a = new Assembler();
  // lower + upper receiver
  a.box(0.03, 0.042, 0.16, M.metal, 0, 0.002, -0.04);
  a.box(0.033, 0.05, 0.21, M.metal, 0, 0.045, -0.035);
  a.box(0.036, 0.052, 0.075, M.metal, 0, -0.028, -0.07);   // magwell
  a.box(0.002, 0.018, 0.05, M.rubber, 0.0172, 0.047, -0.03); // ejection port
  a.cylZ(0.006, 0.02, M.metal, 0.021, 0.052, 0.035, 8);     // forward assist
  a.box(0.008, 0.012, 0.02, M.metalWorn, -0.017, 0.012, -0.045); // mag release
  a.box(0.01, 0.006, 0.03, M.metalWorn, -0.017, 0.02, 0.005);    // selector
  // pistol grip + trigger guard + trigger
  a.box(0.029, 0.105, 0.043, M.polymer, 0, -0.058, 0.03, -0.3, 0, 0);
  a.box(0.006, 0.004, 0.07, M.metal, 0, -0.035, -0.015);
  a.box(0.004, 0.02, 0.006, M.metalWorn, 0, -0.022, -0.012, 0.25, 0, 0);
  // handguard (FDE, octagonal) with rail
  a.add(propCylinder(0.026, 0.026, 0.27, 8), M.fde, 0, 0.042, -0.275, PI / 2, PI / 8, 0);
  for (const s of [-1, 1]) for (let z = -0.37; z < -0.17; z += 0.045) a.box(0.004, 0.012, 0.024, M.rubber, s * 0.025, 0.042, z);
  a.box(0.022, 0.009, 0.44, M.metal, 0, 0.074, -0.19);
  railTeeth(a, M.metal, 0.08, -0.4, 0.02);
  // barrel, gas block, muzzle device
  a.cylZ(0.0075, 0.17, M.metal, 0, 0.042, -0.49, 10);
  a.box(0.018, 0.02, 0.02, M.metal, 0, 0.05, -0.43);
  a.cylZ(0.012, 0.058, M.metal, 0, 0.042, -0.595, 10);
  a.cylZ(0.0125, 0.008, M.metalWorn, 0, 0.042, -0.568, 10);
  // folded rear/front back-up sights
  a.box(0.018, 0.008, 0.02, M.metal, 0, 0.088, 0.005);
  a.box(0.016, 0.008, 0.018, M.metal, 0, 0.088, -0.39);
  // buffer tube + stock
  a.cylZ(0.0145, 0.17, M.metal, 0, 0.04, 0.145, 12);
  a.box(0.04, 0.072, 0.15, M.fde, 0, 0.027, 0.2);
  a.box(0.036, 0.022, 0.1, M.fde, 0, -0.012, 0.215, 0.12, 0, 0);
  a.box(0.042, 0.1, 0.018, M.rubber, 0, 0.018, 0.28);
  // holographic sight: low battery housing, thin frame and hood, clear window
  a.box(0.03, 0.01, 0.075, M.metal, 0, 0.089, -0.05);
  a.box(0.034, 0.016, 0.072, M.metal, 0, 0.1, -0.046);
  a.box(0.004, 0.036, 0.042, M.metal, -0.019, 0.125, -0.066);
  a.box(0.004, 0.036, 0.042, M.metal, 0.019, 0.125, -0.066);
  a.box(0.042, 0.004, 0.046, M.metal, 0, 0.1445, -0.066);
  a.box(0.008, 0.008, 0.014, M.metalWorn, 0.021, 0.1, -0.03);
  a.box(0.008, 0.008, 0.014, M.metalWorn, 0.021, 0.1, -0.05);
  const body = a.build();
  root.add(body);
  const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.034, 0.034), M.lens);
  lens.position.set(0, 0.125, -0.08);
  root.add(lens);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0009, 12), M.reticle);
  dot.position.set(0, 0.125, -0.0805);
  dot.renderOrder = 10;
  root.add(dot);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.0056, 0.0062, 40), M.reticle);
  ring.position.copy(dot.position);
  ring.renderOrder = 10;
  root.add(ring);
  // moving parts
  const mag = new THREE.Group();
  mag.position.set(0, -0.045, -0.07);
  mag.rotation.x = 0.2;
  const ma = new Assembler();
  ma.box(0.024, 0.17, 0.066, M.polymer, 0, -0.085, 0);
  ma.box(0.028, 0.018, 0.072, M.polymer, 0, -0.172, 0.002);
  for (let k = 0; k < 4; k++) ma.box(0.026, 0.004, 0.06, M.polymer, 0, -0.03 - k * 0.03, 0);
  ma.box(0.012, 0.006, 0.05, M.brass, 0, 0.002, 0.004);
  mag.add(ma.build());
  root.add(mag);
  const ch = new THREE.Group();
  ch.position.set(0, 0.066, 0.07);
  const ca = new Assembler();
  ca.box(0.046, 0.008, 0.016, M.metal, 0, 0, 0.004);
  ca.box(0.012, 0.007, 0.04, M.metal, 0, 0, -0.02);
  ch.add(ca.build());
  root.add(ch);
  return {
    id: 'rifle', group: root, parts: { mag, charging: ch },
    magRest: mag.position.clone(), chRest: ch.position.clone(),
    muzzle: new THREE.Vector3(0, 0.042, -0.63), eject: new THREE.Vector3(0.022, 0.047, -0.03),
    sight: new THREE.Vector3(0, 0.125, -0.08), adsDist: 0.235,
    hip: new THREE.Vector3(0.135, -0.172, -0.3),
    rightHand: new THREE.Vector3(0, -0.045, 0.03), rightElbow: new THREE.Vector3(0.1, -0.23, 0.3),
    leftHand: new THREE.Vector3(-0.003, 0.012, -0.29), leftElbow: new THREE.Vector3(-0.17, -0.22, -0.08),
    rightHandRot: new THREE.Euler(-0.3, 0, 0), leftHandRot: new THREE.Euler(0.1, 0, 0.35),
  };
}

// ------------------------------------------------------------------ pistol

export function buildPistol(M) {
  const root = new THREE.Group();
  const a = new Assembler();
  a.box(0.026, 0.026, 0.172, M.polymer, 0, 0.002, -0.07);
  a.box(0.03, 0.108, 0.049, M.polymer, 0, -0.056, 0.008, -0.2, 0, 0);
  a.box(0.03, 0.012, 0.052, M.polymer, 0, -0.11, 0.02, -0.2, 0, 0);
  a.box(0.005, 0.004, 0.055, M.polymer, 0, -0.022, -0.045);
  a.box(0.005, 0.02, 0.004, M.polymer, 0, -0.012, -0.07);
  a.box(0.004, 0.018, 0.006, M.metalWorn, 0, -0.008, -0.04, 0.2, 0, 0);
  a.box(0.02, 0.008, 0.04, M.polymer, 0, -0.008, -0.115);  // rail
  root.add(a.build());
  const slide = new THREE.Group();
  const sa = new Assembler();
  sa.box(0.027, 0.03, 0.188, M.metal, 0, 0.029, -0.07);
  for (let k = 0; k < 6; k++) { sa.box(0.0285, 0.018, 0.002, M.metalWorn, 0, 0.029, 0.005 - k * 0.006); }
  sa.box(0.002, 0.01, 0.03, M.rubber, 0.0138, 0.034, -0.045);  // ejection port
  sa.box(0.005, 0.007, 0.008, M.metal, -0.0055, 0.0475, 0.012); // rear sight
  sa.box(0.005, 0.007, 0.008, M.metal, 0.0055, 0.0475, 0.012);
  sa.box(0.004, 0.007, 0.006, M.metal, 0, 0.0475, -0.155);     // front sight
  slide.add(sa.build());
  const trit = new THREE.Mesh(new THREE.CircleGeometry(0.0011, 8), M.tritium);
  trit.position.set(0, 0.0495, -0.1519);
  slide.add(trit);
  for (const s of [-1, 1]) {
    const t = new THREE.Mesh(new THREE.CircleGeometry(0.0009, 8), M.tritium);
    t.position.set(s * 0.0055, 0.0495, 0.0161);
    slide.add(t);
  }
  root.add(slide);
  const bar = new THREE.Mesh(propCylinder(0.0062, 0.0062, 0.02, 10), M.metalWorn);
  bar.rotation.x = PI / 2;
  bar.position.set(0, 0.027, -0.158);
  root.add(bar);
  const mag = new THREE.Group();
  mag.position.set(0, -0.02, 0.004);
  mag.rotation.x = -0.2;
  const ma = new Assembler();
  ma.box(0.022, 0.1, 0.034, M.metal, 0, -0.05, 0);
  ma.box(0.031, 0.013, 0.05, M.polymer, 0, -0.1, 0.004);
  mag.add(ma.build());
  root.add(mag);
  return {
    id: 'pistol', group: root, parts: { slide, mag },
    magRest: mag.position.clone(), slideRest: slide.position.clone(),
    muzzle: new THREE.Vector3(0, 0.028, -0.175), eject: new THREE.Vector3(0.016, 0.036, -0.045),
    sight: new THREE.Vector3(0, 0.0512, -0.155), adsDist: 0.5,
    hip: new THREE.Vector3(0.095, -0.115, -0.4),
    rightHand: new THREE.Vector3(0, -0.048, 0.012), rightElbow: new THREE.Vector3(0.1, -0.2, 0.34),
    leftHand: new THREE.Vector3(-0.022, -0.05, 0.002), leftElbow: new THREE.Vector3(-0.16, -0.2, 0.3),
    rightHandRot: new THREE.Euler(-0.2, 0, 0), leftHandRot: new THREE.Euler(-0.15, 0.25, 0.5),
  };
}

// ------------------------------------------------------------------ shotgun

export function buildShotgun(M) {
  const root = new THREE.Group();
  const a = new Assembler();
  a.box(0.042, 0.062, 0.21, M.metal, 0, 0.03, -0.1);
  a.box(0.002, 0.022, 0.06, M.rubber, 0.0212, 0.038, -0.09);
  a.cylZ(0.0115, 0.5, M.metal, 0, 0.052, -0.455, 14);
  a.cylZ(0.0125, 0.36, M.metal, 0, 0.021, -0.4, 12);
  a.cylZ(0.0135, 0.012, M.metalWorn, 0, 0.021, -0.585, 12);
  a.box(0.008, 0.006, 0.02, M.metal, 0, 0.066, -0.695);
  a.add(new THREE.SphereGeometry(0.0032, 8, 6), M.metalWorn, 0, 0.0715, -0.697);
  a.box(0.006, 0.004, 0.06, M.polymer, 0, -0.006, -0.02);
  a.box(0.004, 0.018, 0.005, M.metalWorn, 0, -0.012, -0.03, 0.2, 0, 0);
  // wood stock + grip
  a.box(0.034, 0.1, 0.058, M.wood, 0, -0.045, 0.035, -0.45, 0, 0);
  a.box(0.04, 0.078, 0.24, M.wood, 0, -0.005, 0.2, 0.1, 0, 0);
  a.box(0.042, 0.095, 0.02, M.rubber, 0, -0.018, 0.325, 0.1, 0, 0);
  root.add(a.build());
  const pump = new THREE.Group();
  pump.position.set(0, 0.022, -0.33);
  const pa = new Assembler();
  pa.add(propCylinder(0.026, 0.026, 0.17, 12), M.wood, 0, 0, 0, PI / 2, 0, 0);
  for (let k = 0; k < 7; k++) pa.add(propCylinder(0.0272, 0.0272, 0.006, 12), M.wood, 0, 0, -0.07 + k * 0.023, PI / 2, 0, 0);
  pump.add(pa.build());
  root.add(pump);
  const shell = new THREE.Group();
  const sh = new Assembler();
  sh.cylZ(0.0105, 0.055, M.shellRed, 0, 0, 0, 10);
  sh.cylZ(0.0108, 0.014, M.brass, 0, 0, 0.034, 10);
  shell.add(sh.build());
  shell.visible = false;
  root.add(shell);
  return {
    id: 'shotgun', group: root, parts: { pump, shell },
    pumpRest: pump.position.clone(),
    muzzle: new THREE.Vector3(0, 0.052, -0.71), eject: new THREE.Vector3(0.024, 0.04, -0.09),
    sight: new THREE.Vector3(0, 0.0715, -0.697), adsDist: 0.76,
    hip: new THREE.Vector3(0.14, -0.165, -0.36),
    rightHand: new THREE.Vector3(0, -0.05, 0.04), rightElbow: new THREE.Vector3(0.11, -0.24, 0.3),
    leftHand: new THREE.Vector3(-0.004, -0.005, -0.33), leftElbow: new THREE.Vector3(-0.17, -0.22, -0.1),
    rightHandRot: new THREE.Euler(-0.45, 0, 0), leftHandRot: new THREE.Euler(0.1, 0, 0.4),
  };
}

// ------------------------------------------------------------------ arms

function buildHand(M, left) {
  const g = new THREE.Group();
  const a = new Assembler();
  const s = left ? -1 : 1;
  const palm = new THREE.CapsuleGeometry(0.03, 0.035, 4, 10);
  palm.scale(0.85, 1, 1.25);
  a.add(palm, M.glove, 0, 0, 0.005);
  for (let k = 0; k < 4; k++) {
    const f = new THREE.CapsuleGeometry(0.0105, 0.03, 3, 6);
    a.add(f, M.glove, -s * 0.03, 0.03 - k * 0.019, -0.012, 0, 0, s * 1.3);
  }
  a.add(new THREE.CapsuleGeometry(0.011, 0.035, 3, 6), M.glove, -s * 0.022, 0.045, 0.018, 0.5, 0, -s * 0.4);
  a.box(0.052, 0.018, 0.058, M.watch, s * 0.003, -0.036, 0.03);
  g.add(a.build());
  return g;
}

export function buildArms(M) {
  const mk = (left) => {
    const group = new THREE.Group();
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.043, 0.26, 4, 10), M.sleeve);
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.05, 12), M.sleeve);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.3, 4, 10), M.sleeve);
    const hand = buildHand(M, left);
    [fore, cuff, upper].forEach((m) => { m.frustumCulled = false; group.add(m); });
    group.add(hand);
    return { group, fore, cuff, upper, hand, left };
  };
  return { left: mk(true), right: mk(false) };
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _yUp = new THREE.Vector3(0, 1, 0);

/** Places an arm so the wrist sits at `hand` and the forearm points back to `elbow` (weapon space). */
export function poseArm(arm, hand, elbow, handRot) {
  _d.subVectors(hand, elbow);
  const len = _d.length();
  _d.normalize();
  arm.fore.position.copy(elbow).addScaledVector(_d, len * 0.5 - 0.02);
  arm.fore.quaternion.setFromUnitVectors(_yUp, _d);
  arm.fore.scale.set(1, len / 0.34, 1);
  arm.cuff.position.copy(hand).addScaledVector(_d, -0.075);
  arm.cuff.quaternion.copy(arm.fore.quaternion);
  // upper arm continues behind the elbow (mostly off-screen)
  _a.copy(elbow).add(_b.set(arm.left ? -0.08 : 0.08, -0.12, 0.2));
  _b.subVectors(elbow, _a).normalize();
  arm.upper.position.copy(_a).lerp(elbow, 0.5);
  arm.upper.quaternion.setFromUnitVectors(_yUp, _b);
  arm.hand.position.copy(hand);
  arm.hand.rotation.copy(handRot);
}

// ------------------------------------------------------------------ enemy rifle (single mesh)

export function buildEnemyRifleGeometry() {
  const parts = [];
  const add = (g, x, y, z, rx = 0, col = 0x262728) => {
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, 0)), new THREE.Vector3(1, 1, 1)));
    for (const n of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(n)) g.deleteAttribute(n);
    const c = new THREE.Color(col);
    const cols = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < cols.length; i += 3) { cols[i] = c.r; cols[i + 1] = c.g; cols[i + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    if (!g.index) { const idx = new Uint32Array(g.attributes.position.count); for (let i = 0; i < idx.length; i++) idx[i] = i; g.setIndex(new THREE.BufferAttribute(idx, 1)); }
    parts.push(g);
  };
  add(new THREE.BoxGeometry(0.034, 0.075, 0.22), 0, 0.03, -0.01);
  add(new THREE.BoxGeometry(0.03, 0.1, 0.045), 0, -0.045, 0.02, -0.3);
  add(new THREE.BoxGeometry(0.026, 0.16, 0.06), 0, -0.07, -0.07, 0.2, 0x1c1c1c);
  add(new THREE.CylinderGeometry(0.024, 0.024, 0.28, 8), 0, 0.035, -0.25, Math.PI / 2, 0x3c3a33);
  add(new THREE.CylinderGeometry(0.008, 0.008, 0.2, 6), 0, 0.035, -0.48, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.012, 0.012, 0.05, 6), 0, 0.035, -0.6, Math.PI / 2);
  add(new THREE.BoxGeometry(0.04, 0.07, 0.15), 0, 0.02, 0.165, 0, 0x2e2d2a);
  add(new THREE.BoxGeometry(0.03, 0.035, 0.07), 0, 0.085, -0.02);
  return mergeGeometries(parts, false);
}
