// Exfil helicopter for Mountain Survival: a generic medium transport (no real-world markings) built from
// primitives, with spinning main / tail rotors, rotor-disc blur and a simple flight towards the team.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchAmbient } from './materials.js';

function mat(color, rough, metal, surface = 'metal') {
  const m = patchAmbient(new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
  m.userData.surface = surface;
  m.userData.heat = 'metal';
  return m;
}

function place(g, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz)));
  return g;
}

export function buildHelicopter() {
  const body = mat(0x3f443a, 0.72, 0.35);
  const dark = mat(0x22241f, 0.6, 0.5);
  const glass = new THREE.MeshStandardMaterial({ color: 0x1b2326, roughness: 0.08, metalness: 0.4, envMapIntensity: 1.5 });
  glass.userData.heat = 'metal';
  patchAmbient(glass);
  const root = new THREE.Group();
  // fuselage: long rounded cabin tapering into the tail boom (+z = nose)
  const hull = [];
  hull.push(place(new THREE.CapsuleGeometry(1.25, 5.2, 8, 16), 0, 0, 0.2, Math.PI / 2, 0, 0, 1, 1.05, 1.0));
  hull.push(place(new THREE.SphereGeometry(1.3, 16, 12), 0, -0.05, 3.1, 0, 0, 0, 0.95, 0.9, 1.1));
  hull.push(place(new THREE.CylinderGeometry(0.75, 0.34, 6.5, 12), 0, 0.45, -5.9, -Math.PI / 2 + 0.05, 0, 0));
  hull.push(place(new THREE.BoxGeometry(0.18, 2.0, 1.4), 0, 1.35, -9.0, -0.35, 0, 0));
  hull.push(place(new THREE.BoxGeometry(2.6, 0.12, 0.8), 0, 0.55, -8.2));
  hull.push(place(new THREE.BoxGeometry(1.7, 0.75, 3.2), 0, 1.35, -0.3));
  hull.push(place(new THREE.CapsuleGeometry(0.45, 1.6, 6, 10), 0.75, 1.55, -0.6, Math.PI / 2, 0, 0));
  hull.push(place(new THREE.CapsuleGeometry(0.45, 1.6, 6, 10), -0.75, 1.55, -0.6, Math.PI / 2, 0, 0));
  hull.push(place(new THREE.BoxGeometry(0.9, 0.5, 1.2), 1.2, -0.4, 0.4));
  hull.push(place(new THREE.BoxGeometry(0.9, 0.5, 1.2), -1.2, -0.4, 0.4));
  const hullGeo = mergeGeometries(hull.map((g) => { g.deleteAttribute('uv'); return g; }), false);
  const hullMesh = new THREE.Mesh(hullGeo, body);
  hullMesh.castShadow = true;
  root.add(hullMesh);
  const glassGeo = place(new THREE.SphereGeometry(1.18, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.42), 0, 0.25, 3.25, 0.95, 0, 0, 0.92, 0.85, 1.0);
  root.add(new THREE.Mesh(glassGeo, glass));
  // gear, hub, exhausts
  const bits = [];
  for (const s of [-1, 1]) {
    bits.push(place(new THREE.CylinderGeometry(0.28, 0.28, 0.2, 12), s * 1.25, -1.35, 2.2, 0, 0, Math.PI / 2));
    bits.push(place(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 12), s * 1.35, -1.3, -1.2, 0, 0, Math.PI / 2));
    bits.push(place(new THREE.CylinderGeometry(0.06, 0.06, 1.0, 6), s * 1.2, -0.85, 2.2));
    bits.push(place(new THREE.CylinderGeometry(0.22, 0.26, 0.6, 10), s * 0.85, 1.55, -1.6, Math.PI / 2 + 0.3, 0, 0));
  }
  bits.push(place(new THREE.CylinderGeometry(0.22, 0.3, 0.6, 12), 0, 2.0, -0.3));
  const bitsGeo = mergeGeometries(bits.map((g) => { g.deleteAttribute('uv'); return g; }), false);
  root.add(new THREE.Mesh(bitsGeo, dark));
  // main rotor
  const rotor = new THREE.Group();
  rotor.position.set(0, 2.35, -0.3);
  for (let k = 0; k < 5; k++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.06, 8.6), dark);
    blade.geometry.translate(0, 0, 4.3);
    blade.rotation.y = (k / 5) * Math.PI * 2;
    blade.castShadow = true;
    rotor.add(blade);
  }
  const disc = new THREE.Mesh(new THREE.CircleGeometry(8.7, 40), new THREE.MeshBasicMaterial({ color: 0x1c1d1a, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
  disc.rotation.x = -Math.PI / 2;
  rotor.add(disc);
  root.add(rotor);
  const tail = new THREE.Group();
  tail.position.set(0.18, 1.6, -9.2);
  for (let k = 0; k < 4; k++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.2, 1.5), dark);
    b.geometry.translate(0, 0, 0.75);
    b.rotation.x = (k / 4) * Math.PI * 2;
    tail.add(b);
  }
  root.add(tail);
  root.userData.rotor = rotor;
  root.userData.tail = tail;
  root.visible = false;
  return root;
}

const _d = new THREE.Vector3();

/** Moves the helicopter to `pos`, banking into its motion, and spins the rotors. */
export function updateHelicopter(h, pos, dt) {
  const prev = h.userData.prev || (h.userData.prev = pos.clone());
  _d.subVectors(pos, prev);
  const sp = _d.length() / Math.max(dt, 1e-3);
  if (sp > 0.5) h.userData.yaw = Math.atan2(_d.x, _d.z);
  const yaw = h.userData.yaw || Math.PI;
  const pitch = Math.min(0.28, sp / 220);
  h.position.copy(pos);
  h.rotation.set(pitch, yaw, Math.sin(performance.now() * 0.0007) * 0.03, 'YXZ');
  h.userData.rotor.rotation.y += dt * 27;
  h.userData.tail.rotation.x += dt * 120;
  prev.copy(pos);
}
