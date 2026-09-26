// Kestrel Freight Depot: the single hand-authored map.
// Layout (metres, +z = south / yard, -z = north):
//   yard z 8..26 | main hall x -18..6 with mezzanine + office (NW) | east wing x 6..18 (workshop, corridor, break room, storage)
import * as THREE from 'three';
import { LevelBuilder } from './builder.js';
import * as P from './props.js';
import { propBox, propCylinder, trs, finishGeometry } from './geometry.js';
import { setAmbientZones, patchAmbient } from './materials.js';
import { Ramp } from './physics.js';

export const SUN_DIR = new THREE.Vector3(-0.55, 0.42, 0.72).normalize();
export const BOUNDS = { minX: -26, maxX: 26, minZ: -20, maxZ: 26 };
export const BUILDING = { minX: -18, maxX: 18, minZ: -16, maxZ: 8 };

const AMBIENT_ZONES = [
  { min: [-17.85, -1, -15.85], max: [5.9, 7.45, 7.85], value: 0.34, soft: 1.4 },   // main hall
  { min: [6.1, -1, -15.85], max: [17.85, 3.6, 7.85], value: 0.2, soft: 0.8 },      // east wing
  { min: [-17.85, -1, -15.85], max: [-11.2, 2.9, -2.2], value: 0.2, soft: 1.2 },   // under mezzanine
  { min: [-17.85, 3.2, -15.85], max: [-13.6, 5.8, -9.1], value: 0.24, soft: 0.6 }, // office
  { min: [-12.5, -1, 3.5], max: [-7, 4.4, 8.4], value: 0.55, soft: 2.2 },          // light spill from the dock door
  { min: [-26, -1, -20], max: [26, 6, -16.2], value: 0.72, soft: 1.5 },            // shaded back lot
];

export const LEVEL_INFO = {
  spawn: { x: 22.3, y: 0, z: 23.8, yaw: Math.atan2(0.62, 0.78) },
  exfil: { x: 22.0, z: 23.4, r: 2.6 },
  intel: { x: -17.02, y: 3.99, z: -13.28, r: 1.9 },
  enemies: [
    { id: 'yard', profile: 'regular', pos: [-10, 0, 15.5], mode: 'patrol', route: [[-10, 15.5], [-1.5, 16.2], [5.0, 21.8], [-1, 23.5], [-12, 21.8], [-11.5, 16]] },
    { id: 'dock', profile: 'regular', pos: [-10.3, 0, 4.4], yaw: 0, mode: 'guard' },
    { id: 'hall', profile: 'rookie', pos: [-7, 0, -6.6], mode: 'patrol', route: [[-7, -6.6], [-4.5, -12.2], [3, -12], [3.5, -3], [-3, 2.8], [-8.5, -2.6]] },
    { id: 'mezz', profile: 'veteran', pos: [-12.6, 3.2, -6.0], yaw: Math.PI / 2, mode: 'guard', stationary: true },
    { id: 'office', profile: 'regular', pos: [-15.5, 3.2, -11.3], yaw: 0, mode: 'guard' },
    { id: 'ws1', profile: 'rookie', pos: [9.2, 0, -14.1], yaw: Math.PI, mode: 'guard' },
    { id: 'ws2', profile: 'regular', pos: [15, 0, -9], mode: 'patrol', route: [[15, -9], [13.6, -5.3], [7.5, -5.3], [8, -9.5], [12, -8.8]] },
    { id: 'break', profile: 'rookie', pos: [9.8, 0, 2.6], yaw: -Math.PI / 2, mode: 'guard' },
    { id: 'storage', profile: 'veteran', pos: [15.2, 0, 4.6], yaw: 0, mode: 'guard' },
  ],
  reinforcements: [
    { id: 'r1', profile: 'regular', pos: [-3.0, 0, -18.3] },
    { id: 'r2', profile: 'veteran', pos: [-1.6, 0, -18.9] },
    { id: 'r3', profile: 'regular', pos: [-4.4, 0, -18.9] },
  ],
  medkits: [
    { x: -7.3, y: 0.76, z: -4.8 },
    { x: 10.6, y: 0.92, z: -15.35 },
    { x: 12.4, y: 0, z: 7.3 },
  ],
  shaftSources: [],
};

export function groundSurface(x, z) {
  if (x > BUILDING.minX && x < BUILDING.maxX && z > BUILDING.minZ && z < BUILDING.maxZ) return 'concrete';
  return 'asphalt';
}

export function isIndoors(x, y, z) {
  return x > BUILDING.minX && x < BUILDING.maxX && z > BUILDING.minZ && z < BUILDING.maxZ && y < 7.4;
}

export function buildLevel(scene, physics, M, tf, quality) {
  const b = new LevelBuilder(scene, physics, M, quality);
  physics.groundSurfaceFn = groundSurface;
  LEVEL_INFO.shaftSources.length = 0;

  build_ground(b);
  build_perimeter(b);
  build_building_shell(b);
  build_roof(b);
  build_main_hall(b);
  build_mezzanine(b);
  build_stairs(b);
  build_office(b);
  build_east_wing(b);
  build_yard(b);
  build_back_lot(b);
  build_details(b, tf);
  build_surroundings(b);

  const meshes = b.finish();
  const aoTex = bakeGroundAO(physics);
  M.floor.aoMap = aoTex;
  M.asphalt.aoMap = aoTex;
  M.floor.needsUpdate = true;
  M.asphalt.needsUpdate = true;
  setAmbientZones(AMBIENT_ZONES);

  const dynamic = build_dynamic_props(scene, M, tf);
  return { builder: b, meshes, glassMesh: b.glassMesh, info: LEVEL_INFO, dynamic };
}

// ------------------------------------------------------------------ ground

/** Horizontal plane with metre UVs and uv1 mapped into the baked ground-AO texture. */
function groundPlane(x0, z0, x1, z1, y = 0) {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, 1, 1);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  const pos = g.attributes.position, uv = g.attributes.uv;
  const uv1 = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    uv.setXY(i, x, -z);
    uv1[i * 2] = (x - BOUNDS.minX) / (BOUNDS.maxX - BOUNDS.minX);
    uv1[i * 2 + 1] = 1 - (z - BOUNDS.minZ) / (BOUNDS.maxZ - BOUNDS.minZ);
  }
  g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  return g;
}

function build_ground(b) {
  const M = b.M;
  b.batch.add(groundPlane(-18, -16, 18, 8), M.floor, { cast: false });
  b.batch.add(groundPlane(-26, 8, 26, 26), M.asphalt, { cast: false });
  b.batch.add(groundPlane(-26, -20, 26, -16), M.asphalt, { cast: false });
  b.batch.add(groundPlane(-26, -16, -18, 8), M.asphalt, { cast: false });
  b.batch.add(groundPlane(18, -16, 26, 8), M.asphalt, { cast: false });
  const outer = new THREE.PlaneGeometry(900, 900, 1, 1);
  outer.rotateX(-Math.PI / 2);
  outer.translate(0, -0.03, 0);
  const uv = outer.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 900, uv.getY(i) * 900);
  b.mesh(outer, M.ground, null, { cast: false });
  // road beyond the south gate
  const road = new THREE.PlaneGeometry(500, 11, 1, 1);
  road.rotateX(-Math.PI / 2);
  road.translate(0, -0.01, 33);
  const ruv = road.attributes.uv;
  for (let i = 0; i < ruv.count; i++) ruv.setXY(i, ruv.getX(i) * 500, ruv.getY(i) * 11);
  b.mesh(road, M.road, null, { cast: false });
}

function bakeGroundAO(physics) {
  const PPM = 14;
  const W = Math.round((BOUNDS.maxX - BOUNDS.minX) * PPM), H = Math.round((BOUNDS.maxZ - BOUNDS.minZ) * PPM);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  const px = (x) => (x - BOUNDS.minX) * PPM, pz = (z) => (z - BOUNDS.minZ) * PPM;
  const rect = (x0, z0, x1, z1, strength, spread) => {
    const steps = 7;
    for (let k = steps; k >= 0; k--) {
      const e = 0.04 + (k / steps) * spread;
      g.fillStyle = `rgba(0,0,0,${(strength * 0.11).toFixed(3)})`;
      g.fillRect(px(x0 - e), pz(z0 - e), (x1 - x0 + 2 * e) * PPM, (z1 - z0 + 2 * e) * PPM);
    }
  };
  for (const col of physics.colliders) {
    if (col.surface === 'glass' || col.minY > 1.2 || col.maxY < 0.15) continue;
    const h = col.maxY - Math.max(0, col.minY);
    const strength = Math.min(1, 0.35 + h * 0.25) * (col.bullet ? 1 : 0.35) * (1 - Math.min(0.8, col.minY));
    rect(col.minX, col.minZ, col.maxX, col.maxZ, strength, Math.min(0.9, 0.25 + h * 0.18));
  }
  // covered areas
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(px(-17.85), pz(-15.85), 6.85 * PPM, 13.85 * PPM);
  const tex = new THREE.CanvasTexture(c);
  tex.channel = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// ------------------------------------------------------------------ structure

function build_perimeter(b) {
  const M = b.M, h = 2.8, t = 0.25;
  b.wall('x', 26, -26.125, 26.125, t, 0, h, M.concreteDark, [{ a: -4, b: 4, bottom: 0, top: h, kind: 'open' }]);
  b.wall('x', -20, -26.125, 26.125, t, 0, h, M.concreteDark, []);
  b.wall('z', -26, -19.875, 25.875, t, 0, h, M.concreteDark, []);
  b.wall('z', 26, -19.875, 25.875, t, 0, h, M.concreteDark, []);
  // panel posts
  for (let x = -24; x <= 24; x += 4) {
    if (Math.abs(x) > 4.5) b.vis(x - 0.15, 0, 25.8, x + 0.15, h + 0.12, 26.2, M.concrete);
    b.vis(x - 0.15, 0, -20.2, x + 0.15, h + 0.12, -19.8, M.concrete);
  }
  for (let z = -16; z <= 24; z += 4) {
    b.vis(-26.2, 0, z - 0.15, -25.8, h + 0.12, z + 0.15, M.concrete);
    b.vis(25.8, 0, z - 0.15, 26.2, h + 0.12, z + 0.15, M.concrete);
  }
  fence(b, 'x', 26, -4, 4, 2.4);
  fence(b, 'x', 8.05, -25.875, -18.15, 2.5);
  fence(b, 'x', 8.05, 18.15, 25.875, 2.5);
}

function fence(b, axis, c, a0, a1, h) {
  const M = b.M, len = a1 - a0, mid = (a0 + a1) / 2;
  const g = new THREE.PlaneGeometry(len, h - 0.05);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len, uv.getY(i) * h);
  const m = axis === 'x' ? trs(mid, h / 2 + 0.05, c) : trs(c, h / 2 + 0.05, mid, 0, Math.PI / 2, 0);
  b.mesh(g, M.chainlink, m, { cast: true });
  const posts = Math.max(1, Math.round(len / 2.5));
  for (let i = 0; i <= posts; i++) {
    const a = a0 + (i / posts) * len;
    const p = axis === 'x' ? trs(a, h / 2 + 0.2, c) : trs(c, h / 2 + 0.2, a);
    b.mesh(propCylinder(0.035, 0.035, h + 0.4, 8), M.galv, p);
  }
  const rail = axis === 'x' ? trs(mid, h, c, 0, 0, Math.PI / 2) : trs(c, h, mid, Math.PI / 2, 0, 0);
  b.mesh(propCylinder(0.025, 0.025, len, 8), M.galv, rail);
  for (const [dy, off] of [[0.2, 0.08], [0.32, 0.16], [0.44, 0.24]]) {
    const w = axis === 'x' ? trs(mid, h + dy, c - off, 0, 0, Math.PI / 2) : trs(c - off, h + dy, mid, Math.PI / 2, 0, 0);
    b.mesh(propCylinder(0.006, 0.006, len, 4), M.steelDark, w, { cast: false });
  }
  if (axis === 'x') b.collider(a0, 0, c - 0.05, a1, h + 0.4, c + 0.05, { bullet: false, sight: false, walkTop: false });
  else b.collider(c - 0.05, 0, a0, c + 0.05, h + 0.4, a1, { bullet: false, sight: false, walkTop: false });
}

function build_building_shell(b) {
  const M = b.M, H = 7.5, T = 0.3;
  const south = [
    { a: -16.5, b: -13.5, bottom: 4.6, top: 6.6, kind: 'window', glass: 'broken' },
    { a: -12, b: -7.5, bottom: 0, top: 4.2, kind: 'open' },
    { a: -5, b: -2, bottom: 4.6, top: 6.6, kind: 'window', glass: 'broken' },
    { a: 0, b: 3, bottom: 4.6, top: 6.6, kind: 'window', glass: 'broken' },
    { a: 7.4, b: 9.8, bottom: 1.1, top: 2.4, kind: 'window', glass: 'intact' },
    { a: 14, b: 15.1, bottom: 0, top: 2.2, kind: 'door', leaf: 'neg', hinge: 'a' },
    { a: 16.2, b: 17.4, bottom: 1.1, top: 2.4, kind: 'window', glass: 'broken' },
  ];
  b.wall('x', 8, -18.15, 18.15, T, 0, H, M.concrete, south);
  b.wall('x', -16, -18.15, 18.15, T, 0, H, M.concrete, [
    { a: -16.8, b: -14.6, bottom: 4.3, top: 5.5, kind: 'window', glass: 'intact' },
    { a: -9, b: -6, bottom: 4.6, top: 6.6, kind: 'window', glass: 'broken' },
    { a: -3.6, b: -2.5, bottom: 0, top: 2.2, kind: 'door', leaf: 'pos', hinge: 'a' },
    { a: -1, b: 2, bottom: 4.6, top: 6.6, kind: 'window', glass: 'broken' },
    { a: 8, b: 10.4, bottom: 1.1, top: 2.4, kind: 'window', glass: 'intact' },
    { a: 13, b: 15.4, bottom: 1.1, top: 2.4, kind: 'window', glass: 'broken' },
  ]);
  const west = [
    { a: -14.8, b: -12.6, bottom: 4.3, top: 5.5, kind: 'window', glass: 'intact' },
    { a: -7.5, b: -4, bottom: 4.4, top: 6.2, kind: 'window', glass: 'broken' },
    { a: 0.5, b: 3.5, bottom: 4.6, top: 6.6, kind: 'window', glass: 'broken' },
  ];
  b.wall('z', -18, -15.85, 7.85, T, 0, H, M.concrete, west);
  b.wall('z', 18, -15.85, 7.85, T, 0, H, M.concrete, [
    { a: -13, b: -10.6, bottom: 1.1, top: 2.4, kind: 'window', glass: 'intact' },
    { a: -5.9, b: -4.6, bottom: 1.1, top: 2.4, kind: 'window', glass: 'broken' },
    { a: 2, b: 4.4, bottom: 1.1, top: 2.4, kind: 'window', glass: 'broken' },
  ]);
  // sun-facing openings feed the volumetric light shafts
  for (const o of south) {
    if (o.kind === 'door' || o.a > 6) continue;
    LEVEL_INFO.shaftSources.push({ axis: 'x', c: 7.85, a: o.a, b: o.b, bottom: Math.max(o.bottom, 0.02), top: o.top, floorY: 0 });
  }
  for (const o of west) {
    const floorY = o.a < -2 ? 3.2 : 0;
    LEVEL_INFO.shaftSources.push({ axis: 'z', c: -17.85, a: o.a, b: o.b, bottom: o.bottom, top: o.top, floorY });
  }
  // coping + plinth band
  b.vis(-18.3, 7.5, 7.95, 18.3, 7.62, 8.3, M.steelDark, { ao: false });
  b.vis(-18.3, 7.5, -16.3, 18.3, 7.62, -15.95, M.steelDark, { ao: false });
  b.vis(-18.3, 7.5, -16.3, -17.95, 7.62, 8.3, M.steelDark, { ao: false });
  b.vis(17.95, 7.5, -16.3, 18.3, 7.62, 8.3, M.steelDark, { ao: false });
  // interior partition between hall and east wing (full height)
  b.wall('z', 6, -15.85, 7.85, 0.25, 0, H, M.blockGrey, [
    { a: -12, b: -10.6, bottom: 0, top: 2.2, kind: 'door', leaf: 'pos', hinge: 'a' },
    { a: -5.9, b: -4.6, bottom: 0, top: 2.2, kind: 'door' },
    { a: 3.2, b: 4.4, bottom: 0, top: 2.2, kind: 'door', leaf: 'pos', hinge: 'b' },
  ], { cover: true });
  // loading door: half-lowered roller shutter + drum housing
  b.solid(-12.05, 2.85, 7.72, -7.45, 4.2, 7.8, M.shutter, { uvSwap: true, ao: false, walkTop: false });
  b.vis(-12.25, 4.2, 7.3, -7.25, 4.75, 7.85, M.steelGrey, { ao: false });
  b.vis(-12.2, 0, 7.6, -12.05, 4.2, 7.85, M.steelDark);
  b.vis(-7.45, 0, 7.6, -7.3, 4.2, 7.85, M.steelDark);
  b.vis(-12.4, -0.01, 7.85, -7.1, 0.02, 9.2, M.concreteDark, { ao: false, cast: false });
}

function build_roof(b) {
  const M = b.M, y0 = 7.5, y1 = 7.7;
  const xa = -18.15, xb = 6, sx0 = -15, sx1 = 3;
  const strips = [[-12, -10.8], [-4.2, -3], [3, 4.2]];
  let z = -16.15;
  for (const [s0, s1] of strips) {
    b.vis(xa, y0, z, xb, y1, s0, M.roofMetal, { ao: false });
    b.vis(xa, y0, s0, sx0, y1, s1, M.roofMetal, { ao: false });
    b.vis(sx1, y0, s0, xb, y1, s1, M.roofMetal, { ao: false });
    b.vis(sx0, y1 - 0.02, s0, sx1, y1, s1, M.glass, { ao: false, cast: false });
    z = s1;
  }
  b.vis(xa, y0, z, xb, y1, 8.15, M.roofMetal, { ao: false });
  b.vis(6, y0, -16.15, 18.15, y1, 8.15, M.roofMetal, { ao: false });
  // girders & purlins
  for (const gz of [-14.5, -8.8, -1.5, 4.5]) {
    b.vis(-17.85, 6.85, gz - 0.12, 5.875, 7.5, gz + 0.12, M.steelBlue, { ao: false });
  }
  for (let x = -15; x <= 4; x += 3) b.vis(x - 0.06, 7.32, -15.85, x + 0.06, 7.5, 7.85, M.steelBlue, { ao: false });
}

// ------------------------------------------------------------------ main hall

function build_main_hall(b) {
  const M = b.M;
  for (const x of [-4.5, 2.5]) {
    for (const z of [-8.8, -1.5, 4.5]) {
      b.solid(x - 0.15, 0, z - 0.15, x + 0.15, 7.5, z + 0.15, M.steelBlue, { cover: true });
      b.vis(x - 0.25, 0, z - 0.25, x + 0.25, 0.03, z + 0.25, M.steelDark);
    }
  }
  P.rack(b, -10, -15.8, -1.2, -14.6, 4.6, [1.5, 3.0, 4.5], 11);
  P.rack(b, -10, -9.4, -5.6, -8.2, 4.6, [1.5, 3.0, 4.5], 23);
  P.rack(b, -3.0, -9.4, 1.2, -8.2, 4.6, [1.5, 3.0, 4.5], 37);
  P.forklift(b, -1.0, -4.6);

  // hostile camp
  P.table(b, -8.4, -5.2, -6.6, -4.4);
  P.chair(b, -7.9, -3.9, Math.PI);
  P.chair(b, -6.9, -5.8, 0.2);
  b.vis(-8.2, 0.76, -5.05, -7.85, 0.95, -4.8, M.plasticDark, { ao: false }); // radio
  b.vis(-7.7, 0.76, -5.1, -7.4, 0.94, -4.95, M.steelGreen, { ao: false });  // ammo can
  b.vis(-8.1, 0, -6.6, -6.5, 0.03, -5.8, M.tarp, { ao: false });            // sleeping mat
  P.floodlight(b, -9.8, -3.2, 2.36);
  P.crate(b, -8.1, -1.7, -6.9, -0.5, 0, 1.2);
  P.crate(b, -7.9, -1.5, -7.1, -0.7, 1.2, 0.8);
  P.crate(b, -6.6, 3.4, -5.4, 4.6, 0, 1.2);
  P.crate(b, -6.4, 3.6, -5.6, 4.4, 1.2, 0.7);
  P.sandbags(b, -12.2, 5.1, -9.2, 5.7, 0.9);
  P.palletStack(b, -3.0, 6.1, 7);
  P.drumCluster(b, 3.8, 6.0, [M.drumBlue, M.drumRust, M.drumBlue, M.drumRust]);
  P.crate(b, -1.4, 1.0, 0.0, 2.0, 0, 1.0);
  P.crate(b, -15.6, 5.2, -13.2, 7.6, 0, 2.2);
  P.crate(b, 3.8, -15.6, 5.0, -14.4, 0, 1.2);
  P.crate(b, 4.6, -14.2, 5.8, -13.0, 0, 1.2);
  P.crate(b, 3.2, -6.4, 4.4, -5.2, 0, 1.2);
  P.crate(b, -3.2, -2.6, -2.0, -1.4, 0, 1.2);
  P.loadedPallet(b, 0.3, 3.2, 0, 1.2, true);
  P.pallet(b, 1.5, -11.9, 0, true);
  b.solid(0.9, 0.125, -12.4, 2.1, 1.15, -11.4, M.tarp, { cover: true });
  b.collider(0.9, 0, -12.4, 2.1, 0.125, -11.4, { cover: true, surface: 'wood' });
  // under the mezzanine
  P.shelving(b, -17.8, -14.5, -17.2, -10.5, 2.2, 4, 7);
  P.workbench(b, -17.8, -8.2, -15.8, -7.4);
  P.loadedPallet(b, -13.2, -13.5, 0, 1.2, true);
  P.drumCluster(b, -13.0, -5.2, [M.drumRust, M.drumBlue, M.drumRust, M.drumRust]);
  P.gasCylinder(b, -17.4, -6.7, M.steelGreen);
  P.gasCylinder(b, -17.1, -6.5, M.steelGrey);
  // cable spool
  b.mesh(propCylinder(0.75, 0.75, 0.08, 20), M.plywood, trs(-13.8, 0.75, 1.2, Math.PI / 2, 0, 0), { ao: false });
  b.mesh(propCylinder(0.75, 0.75, 0.08, 20), M.plywood, trs(-13.8, 0.75, 2.2, Math.PI / 2, 0, 0), { ao: false });
  b.mesh(propCylinder(0.45, 0.45, 0.95, 16), M.rubber, trs(-13.8, 0.75, 1.7, Math.PI / 2, 0, 0), { ao: false });
  b.collider(-14.55, 0, 1.1, -13.05, 1.5, 2.3, { cover: true, surface: 'wood' });
  // floor markings
  for (const [x0, z0, x1, z1] of [[-10, -13.95, 1.2, -13.85], [-10, -10.25, 1.2, -10.15], [-10, -7.45, 1.2, -7.35], [-10.6, -13.9, -10.5, -7.4]]) {
    b.vis(x0, 0, z0, x1, 0.004, z1, M.paintLine, { ao: false, cast: false });
  }
}

function build_mezzanine(b) {
  const M = b.M, y = 3.2;
  b.vis(-17.85, 2.95, -15.85, -11, 3.18, -2, M.steelGrey, { ao: false });
  b.collider(-17.85, 2.95, -15.85, -13.5, y, -9, { nav: true, surface: 'concrete' });
  b.collider(-13.5, 2.95, -15.85, -11, y, -9, { nav: true, surface: 'metal' });
  b.collider(-17.85, 2.95, -9, -11, y, -2, { nav: true, surface: 'metal' });
  b.vis(-13.5, 3.18, -15.85, -11, y, -9, M.checker, { ao: false });
  b.vis(-17.85, 3.18, -9, -11, y, -2, M.checker, { ao: false });
  b.vis(-17.85, 3.18, -15.85, -13.5, y, -9, M.lino, { ao: false });
  b.vis(-11.12, 2.72, -15.85, -10.96, y, -2, M.steelBlue, { ao: false });
  b.vis(-16.5, 2.72, -2.12, -10.96, y, -1.96, M.steelBlue, { ao: false });
  for (let x = -16.6; x < -11.2; x += 1.4) b.vis(x - 0.05, 2.78, -15.85, x + 0.05, 2.95, -2, M.steelBlue, { ao: false });
  for (const z of [-15.5, -9, -2.3]) {
    b.solid(-11.35, 0, z - 0.1, -11.15, 2.95, z + 0.1, M.steelBlue, { cover: false });
  }
  railing(b, 'z', -11.03, -15.85, -2, y);
  railing(b, 'x', -2.04, -16.5, -11, y);
  b.baseY = y;
  P.sandbags(b, -12.1, -7.3, -11.3, -4.7, 0.75);
  P.table(b, -16.9, -4.6, -15.6, -3.4);
  b.baseY = 0;
  P.crate(b, -16.8, -7.5, -15.6, -6.3, y, 1.2);
  P.crate(b, -14.2, -4.0, -13.0, -2.8, y, 1.0);
  b.vis(-16.7, y + 0.76, -4.3, -16.3, y + 0.94, -4.0, M.plasticDark, { ao: false });
}

function railing(b, axis, c, a0, a1, y) {
  const M = b.M, len = a1 - a0, n = Math.max(1, Math.round(len / 1.4));
  for (let i = 0; i <= n; i++) {
    const a = a0 + (i / n) * len;
    if (axis === 'z') b.vis(c - 0.03, y, a - 0.03, c + 0.03, y + 1.05, a + 0.03, M.steelYellow, { ao: false });
    else b.vis(a - 0.03, y, c - 0.03, a + 0.03, y + 1.05, c + 0.03, M.steelYellow, { ao: false });
  }
  for (const [ry, rh] of [[1.0, 0.05], [0.55, 0.035], [0.0, 0.12]]) {
    if (axis === 'z') b.vis(c - 0.03, y + ry, a0, c + 0.03, y + ry + rh, a1, M.steelYellow, { ao: false });
    else b.vis(a0, y + ry, c - 0.03, a1, y + ry + rh, c + 0.03, M.steelYellow, { ao: false });
  }
  if (axis === 'z') b.collider(c - 0.06, y, a0, c + 0.06, y + 1.05, a1, { bullet: false, sight: false, walkTop: false });
  else b.collider(a0, y, c - 0.06, a1, y + 1.05, c + 0.06, { bullet: false, sight: false, walkTop: false });
}

function build_stairs(b) {
  const M = b.M, x0 = -17.85, x1 = -16.55, zTop = -2, zBot = 3.6, H = 3.2, n = 16;
  b.physics.addRamp(new Ramp(x0, x1, zTop, zBot, 'z', H, 0, 'metal'));
  const run = (zBot - zTop) / n;
  for (let k = 0; k < n; k++) {
    const za = zTop + k * run, t = (k + 0.5) / n, y = H * (1 - t);
    b.vis(x0 + 0.05, y - 0.035, za, x1 - 0.05, y + 0.005, za + run + 0.02, M.checker, { ao: false });
  }
  const L = Math.hypot(zBot - zTop, H), ang = Math.atan2(H, zBot - zTop);
  for (const x of [x0 + 0.04, x1 - 0.04]) {
    b.mesh(propBox(0.06, 0.28, L), M.steelYellow, trs(x, H / 2 - 0.1, (zTop + zBot) / 2, ang, 0, 0));
  }
  // handrail (open side)
  b.mesh(propCylinder(0.022, 0.022, L, 8), M.steelYellow, trs(x1 + 0.02, H / 2 + 0.95, (zTop + zBot) / 2, Math.PI / 2 + ang, 0, 0));
  for (let i = 0; i <= 4; i++) {
    const z = zTop + (i / 4) * (zBot - zTop), yb = H * (1 - (z - zTop) / (zBot - zTop));
    b.vis(x1 - 0.005, yb, z - 0.025, x1 + 0.045, yb + 0.95, z + 0.025, M.steelYellow, { ao: false });
  }
  // wall-side handrail
  b.mesh(propCylinder(0.02, 0.02, L, 8), M.steelGrey, trs(x0 + 0.08, H / 2 + 0.9, (zTop + zBot) / 2, Math.PI / 2 + ang, 0, 0));
  // mesh panel under the stair (keeps the underside visibly closed)
  const tri = new THREE.BufferGeometry();
  const verts = new Float32Array([x1, 0, zTop, x1, H - 0.2, zTop, x1, 0, zBot - 0.3]);
  tri.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  tri.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([zTop, 0, zTop, H - 0.2, zBot - 0.3, 0]), 2));
  tri.computeVertexNormals();
  b.mesh(tri, M.chainlink, null, { cast: true });
  const segs = 6;
  for (let i = 0; i < segs; i++) {
    const za = zTop + (i * (zBot - zTop)) / segs, zb = za + (zBot - zTop) / segs;
    const top = H * (1 - (za - zTop) / (zBot - zTop)) + 1.0;
    b.collider(x1, 0, za, x1 + 0.08, top, zb, { bullet: false, sight: false, walkTop: false });
  }
}

function build_office(b) {
  const M = b.M, y0 = 3.2, y1 = 5.8;
  b.wall('z', -13.5, -15.85, -8.925, 0.15, y0, y1, M.blockCream, [
    { a: -14.8, b: -10.2, bottom: 4.1, top: 5.25, kind: 'window', glass: 'intact' },
  ], { cover: true });
  b.wall('x', -9, -17.85, -13.575, 0.15, y0, y1, M.blockCream, [
    { a: -15.3, b: -14.3, bottom: y0, top: y0 + 2.1, kind: 'door', leaf: 'neg', hinge: 'b', leafMat: M.woodDark },
  ], { cover: true });
  b.solid(-17.85, y1, -15.85, -13.425, y1 + 0.15, -8.925, M.ceiling, { ao: false, walkTop: false });
  // desk with the intel laptop
  b.vis(-17.75, y0 + 0.72, -14.3, -16.3, y0 + 0.76, -12.5, M.woodDark, { ao: false });
  b.vis(-17.75, y0, -14.3, -17.7, y0 + 0.72, -12.5, M.steelGrey);
  b.vis(-16.35, y0, -14.3, -16.3, y0 + 0.72, -12.5, M.steelGrey);
  b.vis(-17.7, y0 + 0.3, -14.28, -16.35, y0 + 0.72, -14.25, M.steelGrey);
  b.collider(-17.75, y0, -14.3, -16.3, y0 + 0.76, -12.5, { cover: true, surface: 'wood', thin: true });
  b.baseY = y0;
  P.chair(b, -16.0, -13.3, -Math.PI / 2);
  b.baseY = 0;
  b.solid(-14.3, y0, -15.8, -13.65, y0 + 1.32, -15.2, M.steelGrey, { cover: true });
  b.solid(-17.8, y0, -10.6, -17.3, y0 + 1.9, -9.2, M.steelGrey, { cover: true });
  P.lightFixture(b, -15.7, 5.72, -12.4, 'tube', 'z');
  // papers & binders
  b.vis(-17.6, y0 + 0.76, -12.9, -17.3, y0 + 0.765, -12.6, M.steelWhite, { ao: false, cast: false });
  b.vis(-14.2, y0 + 1.32, -15.7, -13.8, y0 + 1.55, -15.5, M.plasticBlue, { ao: false });
}

// ------------------------------------------------------------------ east wing

function paintBand(b, axis, face, dir, from, to, openings = []) {
  const M = b.M, y1 = 1.15, t = 0.012 * dir;
  const cuts = openings.filter((o) => o.bottom < y1).sort((p, q) => p.a - q.a);
  let cur = from;
  const seg = (a0, a1) => {
    if (a1 - a0 < 0.02) return;
    if (axis === 'x') b.vis(a0, 0, Math.min(face, face + t), a1, y1, Math.max(face, face + t), M.blockGreen, { ao: true, cast: false });
    else b.vis(Math.min(face, face + t), 0, a0, Math.max(face, face + t), y1, a1, M.blockGreen, { ao: true, cast: false });
  };
  for (const o of cuts) { seg(cur, o.a - 0.06); cur = o.b + 0.06; }
  seg(cur, to);
}

function build_east_wing(b) {
  const M = b.M, ceil = 3.6;
  b.solid(6.125, ceil, -15.85, 17.85, ceil + 0.15, 7.85, M.ceiling, { ao: false, walkTop: false });
  const wWork = [{ a: 13, b: 14.2, bottom: 0, top: 2.2, kind: 'door' }];
  const wCorr = [
    { a: 8.8, b: 9.9, bottom: 0, top: 2.2, kind: 'door', leaf: 'pos', hinge: 'a' },
    { a: 15, b: 16.1, bottom: 0, top: 2.2, kind: 'door', leaf: 'pos', hinge: 'b' },
  ];
  const wSplit = [{ a: 1, b: 2.1, bottom: 0, top: 2.2, kind: 'door' }];
  b.wall('x', -6.5, 6.125, 17.85, 0.2, 0, ceil, M.blockCream, wWork, { cover: true });
  b.wall('x', -4.0, 6.125, 17.85, 0.2, 0, ceil, M.blockCream, wCorr, { cover: true });
  b.wall('z', 11.5, -3.9, 7.85, 0.2, 0, ceil, M.blockCream, wSplit, { cover: true });
  // painted dado bands
  const hallDoors = [{ a: -12, b: -10.6, bottom: 0 }, { a: -5.9, b: -4.6, bottom: 0 }, { a: 3.2, b: 4.4, bottom: 0 }];
  paintBand(b, 'z', 6.125, 1, -15.85, 7.85, hallDoors);
  paintBand(b, 'x', -6.6, -1, 6.125, 17.85, wWork);
  paintBand(b, 'x', -6.4, 1, 6.125, 17.85, wWork);
  paintBand(b, 'x', -4.1, -1, 6.125, 17.85, wCorr);
  paintBand(b, 'x', -3.9, 1, 6.125, 17.85, wCorr);
  paintBand(b, 'z', 11.4, -1, -3.9, 7.85, wSplit);
  paintBand(b, 'z', 11.6, 1, -3.9, 7.85, wSplit);
  paintBand(b, 'x', -15.85, 1, 6.125, 17.85, []);
  paintBand(b, 'z', 17.85, -1, -15.85, 7.85, []);
  paintBand(b, 'x', 7.85, -1, 6.125, 17.85, [{ a: 14, b: 15.1, bottom: 0 }]);

  // workshop
  P.workbench(b, 7.0, -15.8, 11.5, -15.0);
  b.vis(7.2, 1.2, -15.84, 11.3, 2.2, -15.8, M.plywood, { ao: false });     // pegboard
  b.vis(8.0, 0.92, -15.5, 8.3, 1.08, -15.2, M.steelBlue, { ao: false });   // vise
  b.vis(10.1, 0.92, -15.6, 10.5, 1.02, -15.2, M.steelRed, { ao: false });  // toolbox
  b.solid(13.2, 0, -12.6, 16.2, 0.3, -11.6, M.steelDark, { cover: true });
  b.solid(13.3, 0.3, -12.5, 16.1, 1.25, -11.7, M.steelGreen, { cover: true, ao: false });
  b.vis(15.6, 1.25, -12.4, 16.0, 1.55, -11.8, M.steelGreen, { ao: false });
  b.solid(9.0, 0, -10.8, 9.6, 0.1, -10.2, M.steelDark, { cover: false });
  b.mesh(propCylinder(0.05, 0.05, 1.6, 8), M.steelGreen, trs(9.3, 0.9, -10.6));
  b.mesh(propBox(0.35, 0.3, 0.45), M.steelGreen, trs(9.3, 1.55, -10.45));
  b.collider(9.05, 0.1, -10.8, 9.55, 1.7, -10.2, { cover: false, surface: 'metal' });
  P.shelving(b, 17.2, -15.5, 17.8, -13.5, 2.2, 4, 13);
  P.lockers(b, 17.35, -9.6, 17.85, -7.4, 1.9, M.steelGrey, '-x');
  P.drumCluster(b, 12.6, -7.6, [M.drumBlue, M.drumRust, M.drumRust, M.drumBlue]);
  P.gasCylinder(b, 7.0, -12.8, M.steelGreen);
  P.gasCylinder(b, 7.3, -13.0, M.steelRed);
  P.lightFixture(b, 9.5, 3.52, -11, 'tube', 'x');
  P.lightFixture(b, 14.5, 3.52, -11, 'tube', 'x', false);
  P.lightFixture(b, 9.5, 3.52, -14, 'tube', 'x', false);
  P.lightFixture(b, 14.5, 3.52, -14, 'tube', 'x', false);

  // corridor
  P.lightFixture(b, 9.2, 3.52, -5.25, 'tube', 'x', false);
  P.lightFixture(b, 12.2, 3.52, -5.25, 'tube', 'x');
  P.lightFixture(b, 15.4, 3.52, -5.25, 'tube', 'x', false);
  P.pipeRun(b, 'x', 6.2, 17.8, 3.35, -6.25, 0.05);
  P.pipeRun(b, 'x', 6.2, 17.8, 3.35, -6.05, 0.035, M.steelRed);
  P.fireExtinguisher(b, 17.6, 0.6, -4.5);
  b.solid(17.2, 0, -6.35, 17.8, 0.9, -5.75, M.plasticDark, { cover: true });

  // break room
  P.table(b, 7.6, 0.4, 9.4, 1.6);
  P.chair(b, 7.9, 0.1, 0);
  P.chair(b, 9.0, 1.95, Math.PI);
  P.chair(b, 7.2, 1.2, Math.PI / 2 + 0.3);
  P.vending(b, 10.4, -3.85, 11.35, -2.95, 1);
  b.solid(6.2, 0, -3.85, 6.9, 1.8, -3.15, M.steelWhite, { cover: true });
  P.couch(b, 6.2, 4.8, 7.1, 7.2);
  P.lockers(b, 10.9, 3.8, 11.4, 6.2, 1.9, M.steelBlue, '-x');
  P.lightFixture(b, 8.7, 3.52, 2, 'tube', 'z');
  b.vis(8.1, 0.76, 0.8, 8.4, 0.9, 1.0, M.steelWhite, { ao: false });

  // storage / generator room
  P.generator(b, 12.2, -3.3, 14.8, -1.6);
  P.shelving(b, 17.2, -3.5, 17.8, 1.5, 2.4, 5, 29);
  P.crate(b, 12.0, 3.6, 13.4, 5.0, 0, 1.2);
  P.crate(b, 12.2, 3.8, 13.2, 4.8, 1.2, 0.8);
  P.loadedPallet(b, 16.6, 6.4, 0, 1.0, false);
  P.drumCluster(b, 16.6, -0.2 + 3.0, [M.drumRust, M.drumRust, M.drumBlue, M.drumRust]);
  P.lightFixture(b, 14.5, 3.52, 2, 'tube', 'x');
}

// ------------------------------------------------------------------ outside

function build_yard(b) {
  const M = b.M;
  P.container(b, -22.1, 12, -16.0, 14.44, 0, M.containerRed, '+x');
  P.container(b, -22.1, 12, -16.0, 14.44, 2.59, M.containerGreen, '+x');
  P.container(b, -9.5, 18.6, -3.44, 21.04, 0, M.containerBlue, '-x');
  P.container(b, 2.5, 11.8, 4.94, 17.86, 0, M.containerGreen, '+z');
  P.boxTruck(b, 11, 12.4, 13.5, 20.4);
  P.car(b, 17.2, 18.8, 19.0, 23.3, M.steelGrey);
  P.jersey(b, -3, 11.2, -1, 11.8);
  P.jersey(b, -15, 17.6, -13, 18.2);
  P.jersey(b, 7.4, 20, 8.0, 22);
  P.jersey(b, 16.5, 15.2, 18.5, 15.8);
  P.jersey(b, -7.5, 10.2, -5.5, 10.8);
  P.jersey(b, 20.5, 12.5, 22.5, 13.1);
  P.palletStack(b, -13.2, 10.6, 7);
  P.loadedPallet(b, -11.8, 10.6, 0, 1.2, true);
  P.palletStack(b, 19.6, 10.4, 5, false);
  P.drumCluster(b, -19.9, 18.6, [M.drumRust, M.drumBlue, M.drumRust, M.drumRust]);
  P.drumCluster(b, 8.6, 13.6, [M.drumBlue, M.drumBlue, M.drumRust, M.drumBlue]);
  P.dumpster(b, 15.6, 8.35, 17.6, 9.65);
  // guard booth
  b.solid(5.5, 0, 23, 7.9, 2.6, 25.2, M.blockGrey, { cover: true });
  b.vis(5.3, 2.6, 22.8, 8.1, 2.75, 25.4, M.steelDark, { ao: false });
  b.vis(5.8, 1.1, 22.98, 7.6, 2.1, 23.0, M.glassDark, { ao: false });
  b.vis(5.48, 1.1, 23.3, 5.5, 2.1, 24.9, M.glassDark, { ao: false });
  b.vis(7.9, 1.1, 23.3, 7.92, 2.1, 24.9, M.glassDark, { ao: false });
  P.lightPole(b, -5, 15.5, 7);
  P.lightPole(b, 14, 24.6, 6.5);
  // tyre stack & debris
  for (let i = 0; i < 4; i++) {
    b.mesh(new THREE.TorusGeometry(0.3, 0.12, 8, 16), M.rubber, trs(-23.5, 0.12 + i * 0.24, 22.5, Math.PI / 2, 0, 0), { ao: false });
  }
  b.collider(-23.95, 0, 22.05, -23.05, 0.96, 22.95, { cover: true, surface: 'wood' });
  // painted parking lines
  for (let x = -24; x <= -14; x += 2.6) b.vis(x, 0, 19.5, x + 0.1, 0.004, 24.5, M.paintLine, { ao: false, cast: false });
}

function build_back_lot(b) {
  const M = b.M;
  P.dumpster(b, -8, -19.7, -6, -18.4);
  b.solid(8, 0, -17.35, 9.4, 1.25, -16.2, M.steelGrey, { cover: true });
  b.solid(10.2, 0, -17.35, 11.6, 1.25, -16.2, M.steelGrey, { cover: true });
  P.palletStack(b, 12.5, -18.5, 4);
  P.drumCluster(b, -14, -18.4, [M.drumRust, M.drumRust, M.drumBlue, M.drumRust]);
  P.crate(b, 3.2, -19.6, 4.4, -18.4, 0, 1.2);
  P.jersey(b, -22, -18.2, -20, -17.6);
}

function build_details(b, tf) {
  const M = b.M;
  // pipes & trays in the hall
  P.pipeRun(b, 'x', -17.8, 5.8, 5.9, -15.65, 0.09);
  P.pipeRun(b, 'x', -17.8, 5.8, 6.25, -15.65, 0.06, M.steelRed);
  P.pipeRun(b, 'z', -15.8, 7.8, 6.1, 5.7, 0.07);
  P.cableTray(b, 'z', -15.8, 7.8, 6.45, -6);
  P.cableTray(b, 'x', -17.8, 5.8, 6.45, 0.8);
  // dead high-bay lights hanging from girders
  for (const x of [-12, -6, 0]) for (const z of [-11.5, -5, 1.5]) P.lightFixture(b, x, 5.4, z, 'bay', 'x', false);
  P.electricBox(b, 5.55, 1.1, -3.4, 5.875, 2.1, -2.4);
  P.electricBox(b, 5.6, 1.3, -2.2, 5.875, 1.7, -1.8);
  P.fireExtinguisher(b, 5.72, 0.8, 2.8);
  P.fireExtinguisher(b, -17.7, 0.8, 4.6);
  // signage
  const dock = tf.sign(['DOCK 2'], { bg: '#c9b87a', fg: '#1d1d1b', font: 'bold 150px Arial', w: 512, h: 256 });
  P.signQuad(b, dock, -9.75, 5.05, 8.17, 1.6, 0.8, 0);
  const name = tf.sign(['KESTREL FREIGHT'], { bg: '#5a6770', fg: '#e3e0d6', font: 'bold 120px Arial', w: 1024, h: 192 });
  P.signQuad(b, name, 11.5, 4.6, 8.17, 7.2, 1.35, 0);
  const auth = tf.sign(['AUTHORISED', 'PERSONNEL ONLY'], { bg: '#e2ddd0', fg: '#8a2419', font: 'bold 64px Arial', border: '#8a2419' });
  P.signQuad(b, auth, -3.05, 2.6, -15.84, 0.9, 0.45, 0);
  const smoke = tf.sign(['NO SMOKING', 'NO NAKED FLAMES'], { bg: '#e2ddd0', fg: '#8a2419', font: 'bold 60px Arial', border: '#8a2419' });
  P.signQuad(b, smoke, 5.86, 2.3, -8.0, 0.8, 0.4, -Math.PI / 2);
  const hazard = tf.sign([''], { bg: '#c9a640', stripe: '#1d1d1b', w: 512, h: 64 });
  P.signQuad(b, hazard, -9.75, 4.3, 7.73, 4.4, 0.25, Math.PI);
  const exitTex = tf.sign(['EXIT'], { bg: '#1f5a3a', fg: '#e8efe9', font: 'bold 150px Arial', w: 512, h: 200 });
  P.signQuad(b, exitTex, 14.55, 2.45, 7.8, 0.5, 0.2, Math.PI, true);
  P.signQuad(b, exitTex, -3.05, 2.45, -15.8, 0.5, 0.2, 0, true);
  const wb = tf.whiteboard();
  P.signQuad(b, wb, -17.83, 4.55, -11.2, 1.6, 0.8, Math.PI / 2);
  const bay = tf.sign(['BAY A'], { bg: '#c9b87a', fg: '#1d1d1b', font: 'bold 150px Arial', w: 512, h: 256 });
  P.signQuad(b, bay, -5.6, 3.5, -15.84, 1.0, 0.5, 0);
  // floor debris: concrete chunks & papers
  const rnd = b.rng;
  for (let i = 0; i < 70; i++) {
    const x = -17 + rnd() * 22, z = -15 + rnd() * 22, s = 0.03 + rnd() * 0.09;
    if (b.physics.overlaps(x, 0, z, 0.1, 0.5)) continue;
    b.mesh(propBox(s, s * 0.6, s * 1.3), M.concrete, trs(x, s * 0.3, z, 0, rnd() * 3, 0), { cast: false });
  }
  for (let i = 0; i < 28; i++) {
    const x = -16 + rnd() * 30, z = -15 + rnd() * 22;
    if (b.physics.overlaps(x, 0, z, 0.2, 0.5)) continue;
    b.mesh(propBox(0.21, 0.002, 0.297), M.steelWhite, trs(x, 0.002 + rnd() * 0.002, z, 0, rnd() * 3, 0), { cast: false });
  }
}

function build_surroundings(b) {
  const M = b.M;
  const blocks = [
    [-70, -60, 30, 18, 20, M.concreteDark], [62, -78, 40, 24, 25, M.cladding], [-92, 36, 25, 12, 40, M.concreteDark],
    [84, 46, 22, 30, 20, M.cladding], [0, -115, 60, 14, 20, M.concreteDark], [-44, 95, 30, 10, 16, M.cladding],
    [46, 98, 26, 16, 26, M.concreteDark], [-130, -20, 30, 22, 30, M.cladding], [120, -10, 24, 15, 40, M.concreteDark],
  ];
  for (const [x, z, w, h, d, mat] of blocks) {
    b.vis(x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2, mat, { collide: false, cast: false, ao: false });
    b.vis(x - w / 2 - 0.3, h, z - d / 2 - 0.3, x + w / 2 + 0.3, h + 0.5, z + d / 2 + 0.3, M.steelDark, { cast: false, ao: false });
  }
  // water tower
  const wt = [48, -48];
  for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
    b.mesh(propCylinder(0.15, 0.2, 14, 6), M.steelGrey, trs(wt[0] + dx, 7, wt[1] + dz), { cast: false });
  }
  b.mesh(propCylinder(3.2, 3.2, 5, 20), M.steelGrey, trs(wt[0], 16.5, wt[1]), { cast: false });
  b.mesh(propCylinder(0.2, 3.4, 1.8, 20), M.steelDark, trs(wt[0], 19.9, wt[1]), { cast: false });
  // utility poles along the road
  for (let x = -150; x <= 150; x += 30) {
    b.mesh(propCylinder(0.13, 0.17, 10, 6), M.woodPole, trs(x, 5, 38.5), { cast: false });
    b.mesh(propBox(2.4, 0.12, 0.12), M.woodPole, trs(x, 9.3, 38.5), { cast: false });
  }
  // tree lines
  const rng = b.rng;
  const trunkGeo = () => propCylinder(0.12, 0.18, 2.4, 5);
  for (let i = 0; i < 90; i++) {
    const ang = rng() * Math.PI * 2, r = 42 + rng() * 70;
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    if (z > 28 && z < 40) continue;
    if (Math.abs(x) < 30 && z > -24 && z < 30) continue;
    const s = 0.8 + rng() * 0.9;
    b.mesh(trunkGeo(), M.woodPole, trs(x, 1.2 * s, z, 0, 0, 0, s, s, s), { cast: false });
    b.mesh(new THREE.ConeGeometry(2.2, 5.5, 7), M.foliage, trs(x, (2.2 + 2.75) * s, z, 0, rng() * 3, 0, s, s, s), { cast: false });
    b.mesh(new THREE.ConeGeometry(1.6, 4.0, 7), M.foliage, trs(x, (4.8 + 2.0) * s, z, 0, rng() * 3, 0, s, s, s), { cast: false });
  }
}

// ------------------------------------------------------------------ dynamic (non-batched) props

function build_dynamic_props(scene, M, tf) {
  const out = {};
  const I = LEVEL_INFO.intel;
  // laptop
  const lap = new THREE.Group();
  const base = new THREE.Mesh(propBox(0.34, 0.02, 0.24), M.plasticDark);
  base.position.set(0, 0.01, 0);
  lap.add(base);
  const lid = new THREE.Mesh(propBox(0.34, 0.22, 0.012), M.plasticDark);
  lid.position.set(0, 0.11, -0.12);
  lid.rotation.x = -0.25;
  lap.add(lid);
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.31, 0.19), new THREE.MeshBasicMaterial({ map: tf.laptopScreen(), color: 0x9aa7a2 }));
  scr.position.set(0, 0.11, -0.113);
  scr.rotation.x = -0.25;
  lap.add(scr);
  lap.position.set(I.x + 0.2, 3.96, I.z);
  lap.rotation.y = Math.PI / 2 + 0.15;
  scene.add(lap);
  // the drive (objective item)
  const drive = new THREE.Group();
  const dbody = new THREE.Mesh(propBox(0.14, 0.035, 0.09), patchAmbient(new THREE.MeshStandardMaterial({ color: 0x2b2f31, roughness: 0.5, metalness: 0.4 })));
  drive.add(dbody);
  const led = new THREE.Mesh(propBox(0.01, 0.006, 0.01), new THREE.MeshBasicMaterial({ color: 0x7cff9a }));
  led.position.set(0.05, 0.02, 0.04);
  drive.add(led);
  drive.position.set(I.x - 0.1, 3.978, I.z + 0.3);
  drive.rotation.y = 0.4;
  scene.add(drive);
  out.laptop = lap;
  out.drive = drive;
  out.driveLed = led;
  return out;
}

// ------------------------------------------------------------------ lights

export function buildLights(scene, quality) {
  const tier = quality.lightTier;
  const L = { sun: null, hemi: null, points: [], flicker: [], spot: null, list: [] };
  const sun = new THREE.DirectionalLight(0xffd7a8, 3.1);
  sun.position.copy(SUN_DIR).multiplyScalar(80).add(new THREE.Vector3(0, 0, 3));
  sun.target.position.set(0, 0, 3);
  sun.castShadow = quality.shadows;
  sun.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
  const sc = sun.shadow.camera;
  sc.left = -38; sc.right = 38; sc.top = 34; sc.bottom = -34; sc.near = 20; sc.far = 150;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  scene.add(sun, sun.target);
  L.sun = sun;
  const hemi = new THREE.HemisphereLight(0xb2c3d8, 0x5b5045, 1.15);
  scene.add(hemi);
  L.hemi = hemi;

  const add = (minTier, color, intensity, dist, x, y, z, opts = {}) => {
    if (tier < minTier) return null;
    const l = new THREE.PointLight(color, intensity, dist, 2);
    l.position.set(x, y, z);
    scene.add(l);
    L.points.push(l);
    L.list.push({ light: l, base: intensity, flicker: !!opts.flicker, buzz: !!opts.flicker });
    if (opts.flicker) L.flicker.push(l);
    return l;
  };
  const spot = new THREE.SpotLight(0xffe0b0, 140, 32, 0.62, 0.55, 2);
  spot.position.set(-9.75, 2.3, -3.25);
  spot.target.position.set(-4.5, 0.3, -9.5);
  spot.castShadow = tier >= 2 && quality.shadows;
  if (spot.castShadow) {
    spot.shadow.mapSize.set(512, 512);
    spot.shadow.bias = -0.0008;
    spot.shadow.camera.near = 0.3;
    spot.shadow.camera.far = 30;
  }
  scene.add(spot, spot.target);
  L.spot = spot;
  L.list.push({ light: spot, base: 140 });
  add(0, 0xffb466, 95, 24, -5, 6.6, 16.65);
  add(0, 0xffb466, 70, 20, 14, 6.1, 25.75);
  add(1, 0xdde6ff, 9, 7, -15.7, 5.45, -12.4);
  add(1, 0xfff2dc, 16, 11, 9.5, 3.3, -11);
  add(1, 0xe0ebff, 11, 8, 12.2, 3.3, -5.25, { flicker: true });
  add(2, 0xffe9cc, 8, 8, 8.7, 3.3, 2);
  add(2, 0xffdcab, 7, 8, 14.5, 3.3, 2);
  add(2, 0xffe0b0, 7, 7, -16.4, 2.5, -7.6);
  return L;
}

// ------------------------------------------------------------------ atmosphere

/** Fake volumetric sun shafts extruded from each sunlit window along the light direction. */
export function buildLightShafts(scene) {
  const L = SUN_DIR.clone().negate();
  const positions = [], uvs = [];
  const quad = (a, bb, c, d) => {
    positions.push(...a, ...bb, ...c, ...a, ...c, ...d);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  };
  for (const s of LEVEL_INFO.shaftSources) {
    const corners = s.axis === 'x'
      ? [[s.a, s.bottom, s.c], [s.b, s.bottom, s.c], [s.b, s.top, s.c], [s.a, s.top, s.c]]
      : [[s.c, s.bottom, s.a], [s.c, s.bottom, s.b], [s.c, s.top, s.b], [s.c, s.top, s.a]];
    const far = corners.map(([x, y, z]) => {
      const t = Math.max(0.5, (y - s.floorY) / -L.y);
      return [x + L.x * t, y + L.y * t, z + L.z * t];
    });
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      quad(corners[i], corners[j], far[j], far[i]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uStrength: { value: 0.085 }, uColor: { value: new THREE.Color(1.0, 0.82, 0.6) } },
    vertexShader: `
      varying vec2 vUv; varying vec3 vN; varying vec3 vView; varying vec3 vW;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform float uTime; uniform float uStrength; uniform vec3 uColor;
      varying vec2 vUv; varying vec3 vN; varying vec3 vView; varying vec3 vW;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      void main() {
        float along = vUv.y;
        float fade = pow(1.0 - along, 1.4) * smoothstep(0.0, 0.08, along);
        float edge = pow(sin(3.14159 * vUv.x), 0.9);
        float facing = smoothstep(0.05, 0.6, abs(dot(normalize(vN), vView)));
        float dist = length(cameraPosition - vW);
        float near = smoothstep(0.4, 2.5, dist);
        float flick = 0.85 + 0.15 * sin(uTime * 0.7 + vW.x * 0.8 + vW.z * 0.5);
        float a = uStrength * fade * edge * facing * near * flick;
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}

/** Slowly drifting dust motes animated entirely in the vertex shader. */
export function buildDust(scene, count) {
  const pos = new Float32Array(count * 3), seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const hall = Math.random() < 0.78;
    pos[i * 3] = hall ? -17 + Math.random() * 22.5 : 6.5 + Math.random() * 11;
    pos[i * 3 + 1] = 0.2 + Math.random() * (hall ? 6.8 : 3.2);
    pos[i * 3 + 2] = -15.5 + Math.random() * 23;
    seed[i] = Math.random() * 100;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uScale: { value: 400 } },
    vertexShader: `
      attribute float seed; uniform float uTime; uniform float uScale; varying float vA;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.11 + seed) * 0.35;
        p.y += sin(uTime * 0.07 + seed * 1.7) * 0.25;
        p.z += cos(uTime * 0.09 + seed * 0.6) * 0.35;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float d = -mv.z;
        gl_PointSize = clamp(uScale * 0.012 / max(d, 0.1), 1.0, 5.0);
        vA = smoothstep(14.0, 2.0, d) * (0.5 + 0.5 * sin(uTime * 0.5 + seed * 3.0));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vA;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.0, length(c)) * vA * 0.35;
        gl_FragColor = vec4(vec3(1.0, 0.93, 0.8) * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  return pts;
}
