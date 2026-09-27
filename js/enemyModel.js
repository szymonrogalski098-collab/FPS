// Enemy soldier: one SkinnedMesh (single draw call) built from primitives, rigidly skinned to a
// small skeleton. Arms are posed with two-bone IK so hands always sit on the rifle.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildEnemyRifleGeometry } from './weaponModels.js';
import { patchAmbient } from './materials.js';

const BONES = [
  ['root', -1, [0, 0, 0]],
  ['hips', 0, [0, 0.98, 0]],
  ['spine', 1, [0, 0.12, 0]],
  ['chest', 2, [0, 0.2, 0]],
  ['neck', 3, [0, 0.22, 0]],
  ['head', 4, [0, 0.1, 0]],
  ['upperArmL', 3, [0.19, 0.16, 0]],
  ['forearmL', 6, [0, -0.3, 0]],
  ['handL', 7, [0, -0.27, 0]],
  ['upperArmR', 3, [-0.19, 0.16, 0]],
  ['forearmR', 9, [0, -0.3, 0]],
  ['handR', 10, [0, -0.27, 0]],
  ['thighL', 1, [0.1, -0.06, 0]],
  ['shinL', 12, [0, -0.43, 0]],
  ['footL', 13, [0, -0.44, 0]],
  ['thighR', 1, [-0.1, -0.06, 0]],
  ['shinR', 15, [0, -0.43, 0]],
  ['footR', 16, [0, -0.44, 0]],
];
const IDX = Object.fromEntries(BONES.map((b, i) => [b[0], i]));

const PALETTES = {
  rookie: { jacket: 0x4b4e44, pants: 0x57523f, vest: 0x3b3c35, glove: 0x2a2826, boot: 0x2c2721, face: 0x2e2e2c, helmet: 0x333532, pouch: 0x34352f },
  regular: { jacket: 0x6d6450, pants: 0x605846, vest: 0x5a4f39, glove: 0x3a332a, boot: 0x3a3128, face: 0x3a3833, helmet: 0x555945, pouch: 0x4d4431 },
  veteran: { jacket: 0x2f3133, pants: 0x2c2e30, vest: 0x1f2123, glove: 0x1c1c1c, boot: 0x1e1c1a, face: 0x222222, helmet: 0x2b2c2d, pouch: 0x252729 },
};

let sharedMat = null, sharedRifleMat = null, rifleGeo = null;

function getMaterials(T) {
  if (!sharedMat) {
    const map = T.fabric.map.clone(); map.repeat.set(5, 5); map.needsUpdate = true;
    const nrm = T.fabric.normalMap.clone(); nrm.repeat.set(5, 5); nrm.needsUpdate = true;
    sharedMat = patchAmbient(new THREE.MeshStandardMaterial({ vertexColors: true, map, normalMap: nrm, roughness: 0.92, metalness: 0 }));
    sharedMat.userData.surface = 'flesh';
    sharedRifleMat = patchAmbient(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.55 }));
    rifleGeo = buildEnemyRifleGeometry();
  }
  return { mat: sharedMat, rifleMat: sharedRifleMat, rifleGeo };
}

function part(geo, bone, color, x, y, z, rx = 0, ry = 0, rz = 0) {
  geo.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1)));
  for (const n of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(n)) geo.deleteAttribute(n);
  if (!geo.index) { const idx = new Uint32Array(geo.attributes.position.count); for (let i = 0; i < idx.length; i++) idx[i] = i; geo.setIndex(new THREE.BufferAttribute(idx, 1)); }
  const n = geo.attributes.position.count;
  const c = new THREE.Color(color);
  const col = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    si[i * 4] = IDX[bone]; sw[i * 4] = 1;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  return geo;
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cap = (r, l) => new THREE.CapsuleGeometry(r, l, 3, 8);
const jitter = (hex, k = 0.06) => {
  const c = new THREE.Color(hex);
  const f = 1 + (Math.random() * 2 - 1) * k;
  return c.multiplyScalar(f).getHex();
};

export function createSoldier(T, profile) {
  const { mat, rifleMat, rifleGeo: rg } = getMaterials(T);
  const P = PALETTES[profile.palette] || PALETTES.regular;
  const c = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, jitter(v)]));
  const parts = [];
  const add = (...a) => parts.push(part(...a));
  // lower body
  const pelvis = new THREE.CapsuleGeometry(0.105, 0.13, 4, 10); pelvis.rotateZ(Math.PI / 2); pelvis.scale(1, 1, 1.05);
  add(pelvis, 'hips', c.pants, 0, 0.95, 0);
  add(box(0.36, 0.055, 0.25), 'hips', c.pouch, 0, 1.04, 0);
  for (const s of [1, -1]) {
    add(cap(0.092, 0.26), s > 0 ? 'thighL' : 'thighR', c.pants, s * 0.1, 0.71, 0);
    add(box(0.1, 0.11, 0.05), s > 0 ? 'shinL' : 'shinR', c.pouch, s * 0.1, 0.5, 0.075);
    add(cap(0.074, 0.27), s > 0 ? 'shinL' : 'shinR', c.pants, s * 0.1, 0.27, 0);
    add(box(0.115, 0.12, 0.28), s > 0 ? 'footL' : 'footR', c.boot, s * 0.1, 0.06, 0.04);
    add(cap(0.078, 0.06), s > 0 ? 'shinL' : 'shinR', c.boot, s * 0.1, 0.14, 0);
  }
  add(box(0.06, 0.16, 0.12), 'thighR', c.pouch, -0.19, 0.78, 0.0);
  // torso
  const belly = new THREE.CapsuleGeometry(0.12, 0.08, 4, 12); belly.scale(1.32, 1, 0.9);
  add(belly, 'spine', c.jacket, 0, 1.15, 0);
  const chest = new THREE.CapsuleGeometry(0.135, 0.12, 4, 12); chest.scale(1.38, 1, 0.88);
  add(chest, 'chest', c.jacket, 0, 1.36, 0);
  add(box(0.34, 0.3, 0.27), 'chest', c.vest, 0, 1.3, 0.005);
  add(box(0.09, 0.05, 0.25), 'chest', c.vest, 0.12, 1.47, 0.0);
  add(box(0.09, 0.05, 0.25), 'chest', c.vest, -0.12, 1.47, 0.0);
  for (const x of [-0.11, 0, 0.11]) add(box(0.08, 0.12, 0.055), 'chest', c.pouch, x, 1.21, 0.168);
  add(box(0.3, 0.26, 0.08), 'chest', c.pouch, 0, 1.32, -0.18);
  add(box(0.06, 0.1, 0.06), 'chest', c.pouch, 0.2, 1.24, 0.02);
  for (const s of [1, -1]) add(new THREE.SphereGeometry(0.082, 8, 6), 'chest', c.jacket, s * 0.2, 1.44, 0);
  // head
  add(new THREE.CylinderGeometry(0.056, 0.06, 0.11, 8), 'neck', c.face, 0, 1.56, 0);
  const head = new THREE.SphereGeometry(0.1, 14, 12); head.scale(0.9, 1.1, 1.0);
  add(head, 'head', c.face, 0, 1.665, 0.01);
  const gog = new THREE.CapsuleGeometry(0.022, 0.1, 3, 8); gog.rotateZ(Math.PI / 2);
  add(gog, 'head', 0x111111, 0, 1.678, 0.083);
  if (profile.helmet) {
    const h = new THREE.SphereGeometry(0.123, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.56); h.scale(1, 0.95, 1.1);
    add(h, 'head', c.helmet, 0, 1.685, -0.008);
    add(box(0.045, 0.035, 0.025), 'head', 0x1c1c1c, 0, 1.765, 0.118);
    add(box(0.018, 0.05, 0.1), 'head', c.helmet, 0.118, 1.69, -0.01);
    add(box(0.018, 0.05, 0.1), 'head', c.helmet, -0.118, 1.69, -0.01);
  } else {
    const b = new THREE.SphereGeometry(0.108, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5); b.scale(1, 1.05, 1.05);
    add(b, 'head', c.helmet, 0, 1.69, 0.005);
  }
  // arms
  for (const s of [1, -1]) {
    const L = s > 0 ? 'L' : 'R';
    add(cap(0.064, 0.18), 'upperArm' + L, c.jacket, s * 0.19, 1.31, 0);
    add(cap(0.056, 0.18), 'forearm' + L, c.jacket, s * 0.19, 1.025, 0);
    const hand = new THREE.CapsuleGeometry(0.033, 0.05, 3, 8); hand.scale(1, 1, 0.8);
    add(hand, 'hand' + L, c.glove, s * 0.19, 0.845, 0.01);
  }
  const geo = mergeGeometries(parts, false);
  geo.computeBoundingSphere();

  const bones = BONES.map(([name, , p]) => { const b = new THREE.Bone(); b.name = name; b.position.set(...p); return b; });
  BONES.forEach(([, parent], i) => { if (parent >= 0) bones[parent].add(bones[i]); });
  const mesh = new THREE.SkinnedMesh(geo, mat);
  mesh.add(bones[0]);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const B = Object.fromEntries(bones.map((b) => [b.name, b]));
  // rifle held at the right shoulder, parented to the chest
  const holder = new THREE.Group();
  holder.position.set(-0.1, 0.06, 0.3);
  B.chest.add(holder);
  const rifle = new THREE.Mesh(rg, rifleMat);
  rifle.rotation.y = Math.PI;
  rifle.castShadow = true;
  holder.add(rifle);
  return { mesh, bones: B, holder, rifle, rest: bones.map((b) => b.position.clone()) };
}

// ------------------------------------------------------------------ IK

const DOWN = new THREE.Vector3(0, -1, 0);
const _d = new THREE.Vector3(), _e = new THREE.Vector3(), _pn = new THREE.Vector3(), _t = new THREE.Vector3(), _iq = new THREE.Quaternion();

/** Two-bone IK in the chest's local space. */
export function solveArm(upper, fore, target, pole, l1 = 0.3, l2 = 0.27) {
  const s = upper.position;
  _d.subVectors(target, s);
  let dist = _d.length();
  dist = Math.min(Math.max(dist, 0.08), (l1 + l2) * 0.998);
  _d.normalize();
  const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
  const A = Math.acos(Math.min(1, Math.max(-1, cosA)));
  _pn.copy(pole).addScaledVector(_d, -pole.dot(_d)).normalize();
  _e.copy(s).addScaledVector(_d, Math.cos(A) * l1).addScaledVector(_pn, Math.sin(A) * l1);
  _t.subVectors(_e, s).normalize();
  upper.quaternion.setFromUnitVectors(DOWN, _t);
  _t.copy(s).addScaledVector(_d, dist).sub(_e).normalize();
  _iq.copy(upper.quaternion).invert();
  _t.applyQuaternion(_iq);
  fore.quaternion.setFromUnitVectors(DOWN, _t);
}
