// Mountain Survival world (Koh-e Zard highlands). Builds the terrain, rocks, vegetation, villages and
// posts, lighting, navigation and force positions on top of the shared engine systems (renderer
// pipeline, ambient-patched materials, AABB physics, nav grid, level builder, effects).
import * as THREE from 'three';
import { mergeVertices, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PhysicsWorld, Ramp } from './physics.js';
import { NavGrid } from './nav.js';
import { LevelBuilder } from './builder.js';
import { Terrain } from './terrain.js';
import { NatureTextureFactory } from './natureTextures.js';
import { createTerrainMaterial, createRockMaterial, createGrassMaterial } from './natureMaterials.js';
import { patchAmbient } from './materials.js';
import { createSky, createEnvironment } from './sky.js';
import { MOUNTAIN_LAYOUT, MOUNTAIN_SITES, MOUNTAIN_SUN, MOUNTAIN_TEAM, MOUNTAIN_HOSTILES } from './mountainLayout.js';
import { mulberry32, clamp, smoothstep, lerp } from './util.js';
import { propBox, propCylinder, trs } from './geometry.js';
import { Vegetation } from './vegetation.js';

export const SKY_MOUNTAIN = {
  zenith: [0.075, 0.17, 0.4], horizon: [0.6, 0.64, 0.7], ground: [0.34, 0.31, 0.27],
  cloudCover: 0.36, cloudScale: 1.15, envGround: 0x6a5e4d,
};

export const MOUNTAIN_SUN_DIR = new THREE.Vector3(...MOUNTAIN_SUN).normalize();

// ------------------------------------------------------------------ procedural rock shapes

function hash3(x, y, z, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177) ^ Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise3(x, y, z, s) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const c = (a, b, d) => hash3(xi + a, yi + b, zi + d, s);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), u), x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), u), x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}

/** Faceted, weathered boulder: noisy icosphere cut by random planes, flat base, cavity AO in vertex colour. */
function rockGeometry(seed, detail, { squash = 0.68, cuts = 6, rough = 0.16 } = {}) {
  const rng = mulberry32(seed);
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const pos = g.attributes.position;
  const planes = [];
  for (let i = 0; i < cuts; i++) {
    const th = rng() * Math.PI * 2, ph = Math.acos(rng() * 1.6 - 0.8);
    planes.push({ n: new THREE.Vector3(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)), d: 0.58 + rng() * 0.3 });
  }
  planes.push({ n: new THREE.Vector3(0, -1, 0), d: 0.3 + rng() * 0.15 });
  const sx = 0.85 + rng() * 0.45, sz = 0.8 + rng() * 0.35;
  const col = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n1 = vnoise3(v.x * 1.7 + 11, v.y * 1.7, v.z * 1.7, seed) - 0.5;
    const n2 = vnoise3(v.x * 4.3, v.y * 4.3 + 5, v.z * 4.3, seed + 7) - 0.5;
    const n3 = vnoise3(v.x * 9.1, v.y * 9.1, v.z * 9.1 + 3, seed + 3) - 0.5;
    v.multiplyScalar(1 + n1 * rough * 2.2 + n2 * rough * 0.8 + n3 * rough * 0.25);
    let cut = 0;
    for (const p of planes) {
      const k = v.dot(p.n) - p.d;
      if (k > 0) { v.addScaledVector(p.n, -k * 0.92); cut = Math.max(cut, k); }
    }
    const top = v.y;
    v.x *= sx; v.z *= sz; v.y *= squash;
    pos.setXYZ(i, v.x, v.y, v.z);
    const ao = clamp(0.8 + n1 * 0.5 + n2 * 0.35 - n3 * 0.15 + top * 0.1 - cut * 0.12, 0.55, 1);
    col[i * 3] = ao * 1.02; col[i * 3 + 1] = ao; col[i * 3 + 2] = ao * 0.97;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

/** Three crossed alpha cards for a grass tuft; normals point up so it shades like the ground. */
function tuftGeometry() {
  const parts = [];
  for (let k = 0; k < 3; k++) {
    const g = new THREE.PlaneGeometry(0.75, 0.55, 1, 2);
    g.translate(0, 0.27, 0);
    g.rotateY((k / 3) * Math.PI + 0.2);
    parts.push(g);
  }
  const g = mergeGeometries(parts, false);
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g;
}

// ------------------------------------------------------------------ instanced scatter with tiling

class Scatter {
  constructor(tile) { this.tile = tile; this.groups = new Map(); }
  add(variant, matrix) {
    const key = `${variant}|${Math.floor(matrix.elements[12] / this.tile)}|${Math.floor(matrix.elements[14] / this.tile)}`;
    let g = this.groups.get(key);
    if (!g) { g = { variant, list: [] }; this.groups.set(key, g); }
    g.list.push(matrix);
  }
  build(parent, geos, material, { cast = false, receive = true, cull = 0, tint = null } = {}) {
    const out = [];
    const col = new THREE.Color();
    for (const g of this.groups.values()) {
      const mesh = new THREE.InstancedMesh(geos[g.variant], material, g.list.length);
      g.list.forEach((m, i) => { mesh.setMatrixAt(i, m); if (tint) mesh.setColorAt(i, tint(col, i)); });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      mesh.userData.cullDist = cull;
      parent.add(mesh);
      out.push(mesh);
    }
    return out;
  }
}

// ------------------------------------------------------------------ world

export class MountainWorld {
  constructor(game) {
    this.game = game;
    this.id = 'mountain';
    this.sunDir = MOUNTAIN_SUN_DIR.clone();
    this.zones = [];
    this.indoorBoxes = [];
    this.culled = [];
    this.cullT = 0;
    this.wind = new THREE.Vector2(1.1, 0.35);
    this.windU = { uTime: { value: 0 }, uWind: { value: this.wind } };
    this.cloudOff = new THREE.Vector2(0.13, 0.41);
    this.siteTrees = [];
    this.rubble = [];
    this.boundary = { r: 650, sx: 1.0, sz: 0.95 };
    this.exposure = 1;
  }

  /** 0..1: how much low vegetation / broken ground hides a crouched or prone body here. */
  concealmentAt(x, z) {
    const T = this.terrain;
    if (!this.grassMask) return 0;
    const y = T.heightAt(x, z), slope = T.slopeAt(x, z);
    const g = this.grassMask(x, z, y, slope);
    const rough = smoothstep(0.12, 0.35, slope) * 0.5;
    return clamp(g * 0.9 + rough, 0, 1);
  }

  async build(progress) {
    const g = this.game, q = g.quality;
    this.q = q;
    await progress(0.02, 'Surveying the highlands');
    const terrain = new Terrain(MOUNTAIN_LAYOUT, { size: 800, step: 2, farSize: 12000, farN: 241 });
    await terrain.generate((k) => progress(0.02 + k * 0.14, 'Raising the mountains'));
    this.terrain = terrain;
    this.pads = Object.fromEntries(MOUNTAIN_LAYOUT.pads.map((p) => [p.id, p]));

    await progress(0.17, 'Weathering rock');
    const texSize = q.lightTier >= 2 ? 1024 : q.lightTier >= 1 ? 512 : 256;
    const ntf = new NatureTextureFactory(texSize, Math.min(q.anisotropy, g.pipe.maxAniso));
    this.ntf = ntf;
    const T = {};
    T.rock = ntf.rock();
    await progress(0.22, 'Weathering rock');
    T.dirt = ntf.dirt();
    T.gravel = ntf.gravel();
    await progress(0.27, 'Drying the grass');
    T.grass = ntf.grass();
    T.macro = ntf.macro();
    this.cloudTex = ntf.clouds();
    this.cloudTex.wrapS = this.cloudTex.wrapT = THREE.RepeatWrapping;
    this.cloudTex.needsUpdate = true;
    await progress(0.31, 'Mixing mud plaster');
    const sTf = new NatureTextureFactory(Math.min(texSize, 512), Math.min(q.anisotropy, g.pipe.maxAniso));
    T.adobe = sTf.adobe();
    T.stone = sTf.stoneWall();
    T.blades = ntf.grassBlades();
    this.T = T;

    // --- scene
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0xa9b0b8, 0.00001); // enables the fog chunk; aerial perspective replaces it
    this.scene = scene;
    const physics = new PhysicsWorld();
    physics.setTerrain(terrain);
    physics.enableGrid(-820, -820, 820, 820, 8, 1.2);
    this.physics = physics;

    await progress(0.35, 'Baking mountain light');
    const r = g.pipe.r;
    this.bakeNear = terrain.bakeLighting(r, this.sunDir, q.lightTier >= 1 ? 1024 : 512, 800);
    this.bakeFar = terrain.bakeLighting(r, this.sunDir, 512, 12000);
    const maskTex = terrain.buildMaskTexture(q.lightTier >= 1 ? 2048 : 1024);
    this.terrainMat = createTerrainMaterial(T, maskTex, 800);
    for (const m of terrain.buildMeshes(this.terrainMat, this.terrainMat, 8)) { m.updateMatrix(); scene.add(m); }

    await progress(0.42, 'Building compounds');
    this.buildMaterials();
    this.builder = new LevelBuilder(scene, physics, this.M, q);
    this.buildSites();
    this.structureMeshes = this.builder.finish();
    this.structureColliders = physics.colliders.length;

    await progress(0.52, 'Resolving positions');
    this.resolveForces();

    await progress(0.56, 'Scattering boulders');
    this.buildRocks();
    await progress(0.64, 'Growing vegetation');
    this.buildVegetation();

    await progress(0.72, 'Lighting');
    this.buildLights();
    this.sky = createSky(scene, this.sunDir, SKY_MOUNTAIN);
    this.sky.material.userData.heat = 'sky';
    this.env = createEnvironment(r, this.sunDir, SKY_MOUNTAIN);
    scene.environment = this.env;
    this.buildDust();

    await progress(0.78, 'Mapping routes');
    this.buildNav();
    await progress(0.9, 'Drawing the map');
    this.map = this.buildMapImage();
    await progress(1, 'Ready');
  }

  // ------------------------------------------------------------------ materials

  buildMaterials() {
    const G = this.game.M, T = this.T, aoRamp = G._aoRamp;
    const tiled = (tex, m) => { if (!tex) return null; const t = tex.clone(); t.repeat.set(1 / m, 1 / m); t.needsUpdate = true; return t; };
    const std = (name, set, meters, params, surface, heat, ao = true) => {
      const m = new THREE.MeshStandardMaterial({
        map: tiled(set.map, meters), normalMap: tiled(set.normalMap, meters), roughnessMap: tiled(set.roughMap, meters),
        aoMap: ao ? aoRamp : null, roughness: 1, metalness: 0, ...params,
      });
      m.name = name;
      m.userData.surface = surface;
      m.userData.heat = heat;
      return patchAmbient(m);
    };
    const M = Object.create(G);
    M.adobe = std('adobe', T.adobe, 3.2, { color: 0xeee4d4 }, 'dirt', 'wall');
    M.adobeDark = std('adobeDark', T.adobe, 2.0, { color: 0xc8b9a2 }, 'dirt', 'wall');
    M.mudRoof = std('mudRoof', T.adobe, 3.2, { color: 0xb3a38a }, 'dirt', 'wall', false);
    M.stone = std('stone', T.stone, 1.9, { color: 0xe6e0d6 }, 'rock', 'rock');
    M.stoneDark = std('stoneDark', T.stone, 1.6, { color: 0xa9a196 }, 'rock', 'rock');
    for (const k of ['wood', 'woodDark', 'woodPole', 'plywood']) { M[k] = G[k]; }
    M.timber = std('timber', G._textures.wood, 1.2, { color: 0x8a6f52 }, 'wood', 'wood');
    M.rust = G.drumRust;
    this.M = M;
  }

  // ------------------------------------------------------------------ structures

  buildSites() {
    for (const [id, site] of Object.entries(MOUNTAIN_SITES)) {
      const p = this.pads[id];
      if (!p) continue;
      if (site.kind === 'compound') this.compound(p, site);
      else if (site.kind === 'sangar') this.sangar(p.x, p.y, p.z, site.face, 2.3);
      else if (site.kind === 'outpost') this.outpost(p);
      else if (site.kind === 'checkpoint') this.checkpoint(p);
      else if (site.kind === 'hut') this.shepherdHut(p);
      else if (site.kind === 'tower') this.tower(p);
      else if (site.kind === 'lz') this.landingZone(p);
    }
    this.terraces();
  }

  /** Mud-brick perimeter wall made of slightly uneven segments with an optional gate gap. */
  mudWall(axis, c, from, to, y, h, t, gate) {
    const b = this.builder, M = this.M, rng = b.rng;
    let a = from;
    while (a < to - 0.01) {
      let e = Math.min(to, a + 2.2 + rng() * 1.4);
      if (to - e < 0.8) e = to;
      let s0 = a, s1 = e;
      const pieces = [];
      if (gate && gate.b > s0 && gate.a < s1) {
        if (gate.a > s0) pieces.push([s0, gate.a]);
        if (gate.b < s1) pieces.push([gate.b, s1]);
      } else pieces.push([s0, s1]);
      const hh = h + (rng() - 0.5) * 0.3;
      for (const [p0, p1] of pieces) {
        if (p1 - p0 < 0.05) continue;
        const breach = rng() < 0.06 && p1 - p0 > 1.6;
        const top = breach ? hh - 0.9 - rng() * 0.5 : hh;
        if (axis === 'x') b.solid(p0, y - 0.6, c - t / 2, p1, y + top, c + t / 2, M.adobe, { cover: true, surface: 'dirt' });
        else b.solid(c - t / 2, y - 0.6, p0, c + t / 2, y + top, p1, M.adobe, { cover: true, surface: 'dirt' });
        // rounded, darker cap
        if (axis === 'x') b.vis(p0, y + top, c - t / 2 + 0.05, p1, y + top + 0.06, c + t / 2 - 0.05, M.adobeDark, { ao: false });
        else b.vis(c - t / 2 + 0.05, y + top, p0, c + t / 2 - 0.05, y + top + 0.06, p1, M.adobeDark, { ao: false });
      }
      a = e;
    }
  }

  compound(p, site) {
    const b = this.builder, M = this.M, y = p.y;
    const hw = site.w / 2, hd = site.d / 2, t = 0.6, h = 2.7;
    const G = site.gate;
    const gate = (side) => (G.side === side ? { a: (side === 'n' || side === 's' ? p.x : p.z) + G.at - G.width / 2, b: (side === 'n' || side === 's' ? p.x : p.z) + G.at + G.width / 2 } : null);
    this.mudWall('x', p.z - hd + t / 2, p.x - hw, p.x + hw, y, h, t, gate('n'));
    this.mudWall('x', p.z + hd - t / 2, p.x - hw, p.x + hw, y, h, t, gate('s'));
    this.mudWall('z', p.x - hw + t / 2, p.z - hd + t, p.z + hd - t, y, h, t, gate('w'));
    this.mudWall('z', p.x + hw - t / 2, p.z - hd + t, p.z + hd - t, y, h, t, gate('e'));
    // gate: timber lintel and two heavy leaves swung open inwards
    {
      const g0 = gate(G.side), axis = G.side === 'n' || G.side === 's' ? 'x' : 'z';
      const c = G.side === 'n' ? p.z - hd + t / 2 : G.side === 's' ? p.z + hd - t / 2 : G.side === 'w' ? p.x - hw + t / 2 : p.x + hw - t / 2;
      const inward = G.side === 'n' || G.side === 'w' ? 1 : -1;
      // leaves swung right back against the inner face of the wall, clear of the opening
      const f0 = c + inward * (t / 2 + 0.03), f1 = c + inward * (t / 2 + 0.1), half = G.width / 2;
      if (axis === 'x') {
        b.vis(g0.a - 0.3, y + 2.35, c - 0.35, g0.b + 0.3, y + 2.55, c + 0.35, M.timber, { ao: false });
        b.solid(g0.a - half, y + 0.02, Math.min(f0, f1), g0.a - 0.05, y + 2.3, Math.max(f0, f1), M.woodDark, { ao: false, thin: true, cover: false });
        b.solid(g0.b + 0.05, y + 0.02, Math.min(f0, f1), g0.b + half, y + 2.3, Math.max(f0, f1), M.woodDark, { ao: false, thin: true, cover: false });
      } else {
        b.vis(c - 0.35, y + 2.35, g0.a - 0.3, c + 0.35, y + 2.55, g0.b + 0.3, M.timber, { ao: false });
        b.solid(Math.min(f0, f1), y + 0.02, g0.a - half, Math.max(f0, f1), y + 2.3, g0.a - 0.05, M.woodDark, { ao: false, thin: true, cover: false });
        b.solid(Math.min(f0, f1), y + 0.02, g0.b + 0.05, Math.max(f0, f1), y + 2.3, g0.b + half, M.woodDark, { ao: false, thin: true, cover: false });
      }
    }
    const abs = (side, at) => (side === 'n' || side === 's' ? p.x : p.z) + at;
    site.houses.forEach((hs, i) => this.house(p.x + hs.x0, p.z + hs.z0, p.x + hs.x1, p.z + hs.z1, y, hs.h,
      hs.door && { side: hs.door.side, at: abs(hs.door.side, hs.door.at) },
      (hs.windows || []).map(([side, at]) => [side, abs(side, at)]), i === 1));
    if (site.tree) this.siteTrees.push({ x: p.x + site.tree[0], z: p.z + site.tree[1], kind: 'mulberry' });
    if (site.well) this.well(p.x + site.well[0], y, p.z + site.well[1]);
    // clutter: firewood, water jars, a cart
    this.woodPile(p.x - hw + 2.2, y, p.z + hd - 2.4);
    this.jars(p.x + hw - 2.5, y, p.z - 1.5);
  }

  /** Flat-roofed mud house with timber vigas, parapet, doorway and small shuttered windows. */
  house(x0, z0, x1, z1, y, h, door, windows, stairs) {
    const b = this.builder, M = this.M, t = 0.5;
    const base = y - 0.5;
    const ops = { n: [], s: [], w: [], e: [] };
    if (door) {
      const at = door.at;
      ops[door.side].push({ a: at - 0.55, b: at + 0.55, bottom: y - 0.5, top: y + 1.95, kind: 'door', leaf: door.side === 'n' || door.side === 'w' ? 'pos' : 'neg', leafMat: M.woodDark, frameMat: M.timber });
    }
    for (const [side, at] of windows || []) {
      ops[side].push({ a: at - 0.38, b: at + 0.38, bottom: y + 1.05, top: y + 1.7, kind: 'open', win: true });
    }
    b.wall('x', z0 + t / 2, x0, x1, t, base, y + h, M.adobe, ops.n, { cover: true, surface: 'dirt' });
    b.wall('x', z1 - t / 2, x0, x1, t, base, y + h, M.adobe, ops.s, { cover: true, surface: 'dirt' });
    b.wall('z', x0 + t / 2, z0 + t, z1 - t, t, base, y + h, M.adobe, ops.w, { cover: true, surface: 'dirt' });
    b.wall('z', x1 - t / 2, z0 + t, z1 - t, t, base, y + h, M.adobe, ops.e, { cover: true, surface: 'dirt' });
    // window frames + shutters
    for (const side of ['n', 's', 'w', 'e']) {
      const axis = side === 'n' || side === 's' ? 'x' : 'z';
      const c = side === 'n' ? z0 + t / 2 : side === 's' ? z1 - t / 2 : side === 'w' ? x0 + t / 2 : x1 - t / 2;
      const out = side === 'n' || side === 'w' ? -1 : 1;
      for (const o of ops[side]) {
        if (!o.win) continue;
        const box = (a0, y0, a1, y1, d0, d1, mat) => (axis === 'x' ? b.vis(a0, y0, c + d0, a1, y1, c + d1, mat, { ao: false }) : b.vis(c + d0, y0, a0, c + d1, y1, a1, mat, { ao: false }));
        box(o.a - 0.08, o.top, o.b + 0.08, o.top + 0.1, -t / 2 - 0.02, t / 2 + 0.02, M.timber);
        box(o.a - 0.06, o.bottom - 0.05, o.b + 0.06, o.bottom, -t / 2 - 0.03, t / 2 + 0.03, M.adobeDark);
        // one shutter hanging open against the outer face
        const sw = (o.b - o.a) / 2;
        box(o.a - sw - 0.02, o.bottom + 0.02, o.a - 0.02, o.top - 0.02, out * (t / 2 + 0.01), out * (t / 2 + 0.045), M.woodDark);
        // bars
        for (let k = 1; k < 3; k++) { const a = o.a + (k / 3) * (o.b - o.a); box(a - 0.012, o.bottom, a + 0.012, o.top, -0.012, 0.012, M.woodPole); }
      }
    }
    // roof slab + parapet + vigas
    const rt = y + h;
    b.solid(x0 - 0.12, rt, z0 - 0.12, x1 + 0.12, rt + 0.26, z1 + 0.12, M.mudRoof, { nav: true, surface: 'dirt', ao: false });
    const pt = 0.25, ph = 0.38;
    b.solid(x0 - 0.12, rt + 0.26, z0 - 0.12, x1 + 0.12, rt + 0.26 + ph, z0 - 0.12 + pt, M.adobe, { cover: true, surface: 'dirt', walkTop: false });
    b.solid(x0 - 0.12, rt + 0.26, z1 + 0.12 - pt, x1 + 0.12, rt + 0.26 + ph, z1 + 0.12, M.adobe, { cover: true, surface: 'dirt', walkTop: false });
    if (stairs) {
      // west parapet with an opening where the external stairs arrive
      const gz0 = z1 - 0.3 - (h + 0.3) * 1.35 - 0.4, gz1 = gz0 + 2.0;
      b.solid(x0 - 0.12, rt + 0.26, z0 - 0.12 + pt, x0 - 0.12 + pt, rt + 0.26 + ph, gz0, M.adobe, { cover: true, surface: 'dirt', walkTop: false });
      b.solid(x0 - 0.12, rt + 0.26, gz1, x0 - 0.12 + pt, rt + 0.26 + ph, z1 + 0.12 - pt, M.adobe, { cover: true, surface: 'dirt', walkTop: false });
    } else b.solid(x0 - 0.12, rt + 0.26, z0 - 0.12 + pt, x0 - 0.12 + pt, rt + 0.26 + ph, z1 + 0.12 - pt, M.adobe, { cover: true, surface: 'dirt', walkTop: false });
    b.solid(x1 + 0.12 - pt, rt + 0.26, z0 - 0.12 + pt, x1 + 0.12, rt + 0.26 + ph, z1 + 0.12 - pt, M.adobe, { cover: true, surface: 'dirt', walkTop: false });
    const along = x1 - x0 > z1 - z0 ? 'x' : 'z';
    const L = along === 'x' ? x1 - x0 : z1 - z0;
    for (let a = 0.5; a < L - 0.3; a += 0.75) {
      const beam = propCylinder(0.07, 0.08, (along === 'x' ? z1 - z0 : x1 - x0) + 0.7, 6);
      const m = along === 'x' ? trs(x0 + a, rt - 0.08, (z0 + z1) / 2, Math.PI / 2, 0, 0) : trs((x0 + x1) / 2, rt - 0.08, z0 + a, 0, 0, Math.PI / 2);
      b.mesh(beam, M.timber, m, { ao: false, cast: true });
    }
    // drain spouts
    b.vis(x1 + 0.1, rt + 0.12, (z0 + z1) / 2 - 0.08, x1 + 0.55, rt + 0.24, (z0 + z1) / 2 + 0.08, M.timber, { ao: false });
    if (stairs) {
      // external mud stairs up to the roof along the west wall
      const sx0 = x0 - 1.25, sx1 = x0 - 0.05, sz1 = z1 - 0.3, len = h + 0.3, sz0 = sz1 - len * 1.35;
      const steps = Math.ceil((rt + 0.26 - y) / 0.24);
      for (let k = 0; k < steps; k++) {
        const za = sz1 - (k + 1) * (sz1 - sz0) / steps, zb = sz1 - k * (sz1 - sz0) / steps;
        b.vis(sx0, y - 0.4, za, sx1, y + (k + 1) * (rt + 0.26 - y) / steps, zb, M.adobeDark, { ao: true });
      }
      b.collider(sx0, y - 0.4, sz0, sx1, y + 0.2, sz1, { walkTop: false, surface: 'dirt', cover: false });
      this.physics.addRamp(new Ramp(sx0, sx1, sz0, sz1, 'z', rt + 0.26, y, 'dirt'));
    }
    this.zones.push({ min: [x0 + t, y - 0.2, z0 + t], max: [x1 - t, y + h, z1 - t], value: 0.28, soft: 0.55 });
    this.indoorBoxes.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, minY: y - 0.5, maxY: y + h });
    // interior: a low platform bed and a rug
    b.solid(x0 + t + 0.1, y - 0.1, z0 + t + 0.1, x0 + t + 1.1, y + 0.42, z0 + t + 2.0, M.adobeDark, { surface: 'dirt', cover: false });
    b.vis(x0 + t + 1.4, y + 0.005, z0 + t + 0.6, Math.min(x1 - t - 0.3, x0 + t + 3.4), y + 0.02, z0 + t + 2.2, this.game.M.fabric, { ao: false });
  }

  well(x, y, z) {
    const b = this.builder, M = this.M;
    b.mesh(propCylinder(0.75, 0.8, 0.8, 14, true), M.stone, trs(x, y + 0.35, z), { ao: true, cast: true });
    b.collider(x - 0.75, y - 0.2, z - 0.75, x + 0.75, y + 0.75, z + 0.75, { cover: true, surface: 'rock' });
    b.vis(x - 0.9, y, z - 0.06, x - 0.8, y + 1.8, z + 0.06, M.timber, { ao: false });
    b.vis(x + 0.8, y, z - 0.06, x + 0.9, y + 1.8, z + 0.06, M.timber, { ao: false });
    b.vis(x - 0.9, y + 1.72, z - 0.07, x + 0.9, y + 1.84, z + 0.07, M.timber, { ao: false });
  }

  woodPile(x, y, z) {
    const b = this.builder, M = this.M;
    for (let i = 0; i < 9; i++) {
      const row = Math.floor(i / 4), k = i % 4;
      b.mesh(propCylinder(0.07, 0.07, 1.4, 6), M.timber, trs(x - 0.25 + k * 0.16 + row * 0.08, y + 0.08 + row * 0.13, z, Math.PI / 2, 0.1 * (k - 1.5), 0), { ao: false });
    }
    b.collider(x - 0.4, y - 0.2, z - 0.7, x + 0.4, y + 0.45, z + 0.7, { cover: false, surface: 'wood' });
  }

  jars(x, y, z) {
    const b = this.builder, M = this.M;
    const jar = () => { const g = new THREE.LatheGeometry([[0.001, 0], [0.18, 0.02], [0.26, 0.22], [0.24, 0.45], [0.12, 0.58], [0.1, 0.66], [0.13, 0.7]].map(([a, c]) => new THREE.Vector2(a, c)), 12); return g; };
    [[0, 0], [0.55, 0.2], [0.2, 0.62]].forEach(([dx, dz]) => b.mesh(jar(), M.adobeDark, trs(x + dx, y, z + dz), { ao: false }));
    b.collider(x - 0.3, y - 0.2, z - 0.3, x + 0.85, y + 0.65, z + 0.9, { cover: false, surface: 'dirt' });
  }

  /** Dry-stone fighting position: a ring of wall segments with a gap at the back and a sun tarp. */
  sangar(cx, y, cz, face, R) {
    const b = this.builder, M = this.M;
    const segs = 7;
    for (let k = 0; k < segs; k++) {
      const a = face + ((k - (segs - 1) / 2) / segs) * Math.PI * 1.55;
      const x = cx + Math.sin(a) * R, z = cz - Math.cos(a) * R;
      // axis-aligned block per segment (keeps collision exact)
      const s = 0.62, hgt = 1.05 + (k % 2) * 0.12;
      b.solid(x - s, y - 0.4, z - s, x + s, y + hgt, z + s, M.stone, { cover: true, surface: 'rock' });
      if (k % 2 === 0) b.solid(x - 0.45, y + hgt, z - 0.3, x + 0.45, y + hgt + 0.22, z + 0.3, this.game.M.sandbag, { cover: true, surface: 'dirt', walkTop: false });
    }
    // tarp on four poles
    const tx = cx - Math.sin(face) * 0.6, tz = cz + Math.cos(face) * 0.6;
    for (const [dx, dz] of [[-1.4, -1.2], [1.4, -1.2], [-1.4, 1.2], [1.4, 1.2]]) b.vis(tx + dx - 0.04, y, tz + dz - 0.04, tx + dx + 0.04, y + 1.85 + (dz < 0 ? 0.15 : 0), tz + dz + 0.04, M.woodPole, { ao: false });
    const tarp = new THREE.PlaneGeometry(3.2, 2.8, 4, 4);
    const tp = tarp.attributes.position;
    for (let i = 0; i < tp.count; i++) tp.setZ(i, Math.sin(tp.getX(i) * 1.3) * 0.05 - Math.abs(tp.getY(i)) * 0.03);
    tarp.computeVertexNormals();
    b.mesh(tarp, this.game.M.tarp, trs(tx, y + 1.98, tz, -Math.PI / 2 + 0.06, 0, 0), { ao: false, cast: true });
    this.crate(cx + Math.sin(face + Math.PI) * 0.9, y, cz - Math.cos(face + Math.PI) * 0.9);
  }

  crate(x, y, z, big = false) {
    const b = this.builder, M = this.M, w = big ? 1.2 : 0.62, h = big ? 0.8 : 0.36, d = big ? 0.9 : 0.38;
    b.solid(x - w / 2, y - 0.05, z - d / 2, x + w / 2, y + h, z + d / 2, M.plywood, { cover: big, surface: 'wood', thin: !big });
    b.vis(x - w / 2 - 0.01, y + h * 0.3, z - d / 2 - 0.01, x + w / 2 + 0.01, y + h * 0.36, z + d / 2 + 0.01, M.woodDark, { ao: false });
  }

  outpost(p) {
    const b = this.builder, M = this.M, y = p.y;
    this.sangar(p.x + 4, y, p.z + 7, 1.9, 2.2);
    this.sangar(p.x - 5, y, p.z - 7, 1.5, 2.0);
    // small stone hut
    this.stoneHut(p.x + 3, p.z - 3, 3.4, 3.0, y, 2.2, 's');
    this.crate(p.x - 1, y, p.z + 2, true);
    this.crate(p.x - 0.2, y, p.z + 3.2);
  }

  stoneHut(cx, cz, w, d, y, h, doorSide) {
    const b = this.builder, M = this.M, t = 0.55;
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    const door = (side) => (side === doorSide ? [{ a: (side === 'n' || side === 's' ? cx : cz) - 0.5, b: (side === 'n' || side === 's' ? cx : cz) + 0.5, bottom: y - 0.5, top: y + 1.8, kind: 'door', frameMat: M.timber }] : []);
    b.wall('x', z0 + t / 2, x0, x1, t, y - 0.5, y + h, M.stone, door('n'), { cover: true, surface: 'rock' });
    b.wall('x', z1 - t / 2, x0, x1, t, y - 0.5, y + h, M.stone, door('s'), { cover: true, surface: 'rock' });
    b.wall('z', x0 + t / 2, z0 + t, z1 - t, t, y - 0.5, y + h, M.stone, door('w'), { cover: true, surface: 'rock' });
    b.wall('z', x1 - t / 2, z0 + t, z1 - t, t, y - 0.5, y + h, M.stone, door('e'), { cover: true, surface: 'rock' });
    b.solid(x0 - 0.2, y + h, z0 - 0.2, x1 + 0.2, y + h + 0.22, z1 + 0.2, M.mudRoof, { surface: 'dirt', ao: false });
    for (let a = x0 + 0.3; a < x1; a += 0.6) b.mesh(propCylinder(0.06, 0.07, d + 0.6, 6), M.timber, trs(a, y + h - 0.05, cz, Math.PI / 2, 0, 0), { ao: false });
    this.zones.push({ min: [x0 + t, y - 0.2, z0 + t], max: [x1 - t, y + h, z1 - t], value: 0.26, soft: 0.5 });
    this.indoorBoxes.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, minY: y - 0.5, maxY: y + h });
  }

  checkpoint(p) {
    const b = this.builder, M = this.M, G = this.game.M, y = p.y;
    this.stoneHut(p.x + 8, p.z + 1, 3.2, 3.6, y, 2.3, 'w');
    // sandbag U on the west side of the road
    const sb = (x0, z0, x1, z1, h = 1.1) => b.solid(x0, y - 0.3, z0, x1, y + h, z1, G.sandbag, { cover: true, surface: 'dirt' });
    sb(p.x - 8.2, p.z - 1.5, p.x - 4.4, p.z - 0.8);
    sb(p.x - 8.2, p.z - 0.8, p.x - 7.5, p.z + 2.4);
    sb(p.x - 5.1, p.z - 0.8, p.x - 4.4, p.z + 1.2);
    // barrier pole across the road on two posts
    b.vis(p.x - 3.4, y, p.z - 6.1, p.x - 3.2, y + 1.0, p.z - 5.9, M.woodPole, { ao: false });
    b.vis(p.x + 3.2, y, p.z - 6.1, p.x + 3.4, y + 1.0, p.z - 5.9, M.woodPole, { ao: false });
    b.solid(p.x - 3.3, y + 0.92, p.z - 6.05, p.x + 3.3, y + 1.04, p.z - 5.95, G.steelRed, { ao: false, cover: false, walkTop: false, bullet: false });
    // oil drums and tyres
    const drum = (x, z, mat) => { b.mesh(propCylinder(0.29, 0.29, 0.88, 14), mat, trs(x, y + 0.44, z), { ao: true }); b.collider(x - 0.29, y - 0.1, z - 0.29, x + 0.29, y + 0.88, z + 0.29, { cover: false, surface: 'metal', thin: true }); };
    drum(p.x + 4.2, p.z - 4.5, G.drumRust); drum(p.x + 4.8, p.z - 4.1, G.drumBlue); drum(p.x + 4.4, p.z - 3.5, G.drumRust);
    for (let i = 0; i < 3; i++) b.mesh(new THREE.TorusGeometry(0.36, 0.13, 8, 16), G.rubber, trs(p.x - 3.6, y + 0.13 + i * 0.25, p.z + 5 + (i % 2) * 0.05, Math.PI / 2, 0, 0), { ao: false });
    b.collider(p.x - 4.1, y - 0.1, p.z + 4.5, p.x - 3.1, y + 0.75, p.z + 5.5, { cover: false, surface: 'wood' });
    this.wreck(p.x - 6.5, y, p.z - 12, 0.35);
  }

  /** Burnt-out pickup truck: rusted cab and bed on its rims. */
  wreck(x, y, z, yaw) {
    const b = this.builder, G = this.game.M;
    const R = trs(x, y, z, 0, yaw, 0);
    const put = (geo, mat, lx, ly, lz, rx = 0, ry = 0, rz = 0) => b.mesh(geo, mat, R.clone().multiply(trs(lx, ly, lz, rx, ry, rz)), { ao: false, cast: true });
    put(propBox(1.8, 0.55, 4.9), G.drumRust, 0, 0.72, 0);
    put(propBox(1.72, 0.85, 1.6), G.drumRust, 0, 1.4, -0.6, 0, 0, 0.03);
    put(propBox(1.66, 0.08, 1.3), G.steelDark, 0, 1.86, -0.6);
    put(propBox(1.78, 0.5, 1.4), G.drumRust, 0, 1.2, -1.9, -0.12, 0, 0);
    put(propBox(1.8, 0.45, 0.06), G.drumRust, 0, 1.22, 2.42);
    put(propBox(0.06, 0.45, 2.4), G.drumRust, 0.87, 1.22, 1.2);
    put(propBox(0.06, 0.45, 2.4), G.drumRust, -0.87, 1.22, 1.2, 0, 0, 0.15);
    for (const [wx, wz] of [[-0.85, -1.6], [0.85, -1.6], [-0.85, 1.5], [0.85, 1.5]]) put(propCylinder(0.3, 0.3, 0.22, 10), G.steelDark, wx, 0.28, wz, 0, 0, Math.PI / 2);
    // collider: AABB of the rotated hull
    const c = Math.cos(yaw), s = Math.sin(yaw), hx = Math.abs(c) * 0.95 + Math.abs(s) * 2.45, hz = Math.abs(s) * 0.95 + Math.abs(c) * 2.45;
    b.collider(x - hx * 0.9, y - 0.2, z - hz * 0.9, x + hx * 0.9, y + 1.35, z + hz * 0.9, { cover: true, surface: 'metal' });
  }

  shepherdHut(p) {
    const b = this.builder, M = this.M, y = p.y;
    this.stoneHut(p.x - 2, p.z - 1, 4.2, 3.4, y, 2.2, 's');
    // animal pen of low dry-stone walls
    const pw = (x0, z0, x1, z1) => b.solid(x0, y - 0.4, z0, x1, y + 0.9, z1, M.stoneDark, { cover: true, surface: 'rock' });
    pw(p.x + 1.2, p.z - 5, p.x + 8, p.z - 4.5);
    pw(p.x + 7.5, p.z - 4.5, p.x + 8, p.z + 2);
    pw(p.x + 3.5, p.z + 1.5, p.x + 7.5, p.z + 2);
    this.woodPile(p.x - 5, y, p.z + 2.5);
  }

  tower(p) {
    const b = this.builder, M = this.M, y = p.y, rng = mulberry32(77);
    const x0 = p.x - 2.2, x1 = p.x + 2.2, z0 = p.z - 2.2, z1 = p.z + 2.2, t = 0.7;
    const col = (ax0, az0, ax1, az1, top, door) => {
      // wall broken into columns with a ruined, stepped top
      const alongX = ax1 - ax0 > az1 - az0;
      const L = alongX ? ax1 - ax0 : az1 - az0, n = 4;
      for (let k = 0; k < n; k++) {
        const a0 = (alongX ? ax0 : az0) + (k / n) * L, a1 = (alongX ? ax0 : az0) + ((k + 1) / n) * L;
        const hh = top - rng() * 2.4;
        const mid = (a0 + a1) / 2;
        if (door && Math.abs(mid - door) < 0.6) {
          if (alongX) b.solid(a0, y + 2.0, az0, a1, y + hh, az1, M.stone, { cover: true, surface: 'rock' });
          else b.solid(ax0, y + 2.0, a0, ax1, y + hh, a1, M.stone, { cover: true, surface: 'rock' });
          continue;
        }
        if (alongX) b.solid(a0, y - 0.5, az0, a1, y + hh, az1, M.stone, { cover: true, surface: 'rock' });
        else b.solid(ax0, y - 0.5, a0, ax1, y + hh, a1, M.stone, { cover: true, surface: 'rock' });
      }
    };
    col(x0, z0, x1, z0 + t, 7.4);
    col(x0, z1 - t, x1, z1, 6.2, p.x - 0.55);
    col(x0, z0 + t, x0 + t, z1 - t, 7.0);
    col(x1 - t, z0 + t, x1, z1 - t, 5.6);
    // loopholes are implied by the broken courses; rubble at the base
    this.rubble.push({ x: p.x, z: p.z, r: 6, n: 26 });
  }

  landingZone(p) {
    this.crate(p.x + 3.5, p.y, p.z - 1.5, true);
    this.crate(p.x + 4.4, p.y, p.z - 0.2);
    this.lzPos = new THREE.Vector3(p.x, p.y, p.z);
  }

  /** Small dry-stone terraces beside the wadi near the village. */
  terraces() {
    const b = this.builder, M = this.M, T = this.terrain;
    const rows = [[20, 110, 34, 4], [18, 126, 30, 4.5], [104, 104, 26, 4], [110, 120, 22, 4]];
    for (const [x, z, len, h] of rows) {
      for (let a = 0; a < len; a += 2.5) {
        const gx = x + a, gy = T.heightAt(gx + 1.25, z);
        b.solid(gx, gy - 0.6, z - 0.3, gx + 2.5, gy + 0.55 + ((a * 7) % 3) * 0.07, z + 0.3, M.stoneDark, { cover: false, surface: 'rock' });
      }
    }
  }

  // ------------------------------------------------------------------ forces

  resolveForces() {
    const P = this.physics, T = this.terrain;
    const place = (x, z, roof) => {
      const g = T.heightAt(x, z);
      const y = roof ? P.floorAt(x, z, g + 12).y : P.floorAt(x, z, g + 0.7).y;
      return [x, y, z];
    };
    const at = (d) => {
      if (d.site) { const p = this.pads[d.site]; return [p.x + d.rel[0], p.z + d.rel[1]]; }
      return d.pos;
    };
    this.hostiles = MOUNTAIN_HOSTILES.map((d) => {
      const [x, z] = at(d);
      const route = d.routeRel ? d.routeRel.map(([a, c]) => [this.pads[d.site].x + a, this.pads[d.site].z + c]) : d.route || null;
      return { ...d, team: 'hostile', pos: place(x, z, d.roof), route };
    });
    const s = MOUNTAIN_TEAM.spawn, c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
    this.spawn = { x: s.x, y: T.heightAt(s.x, s.z), z: s.z, yaw: s.yaw };
    this.mates = MOUNTAIN_TEAM.mates.map((m, i) => {
      // offsets are (right, back) relative to the player's facing
      const rx = m.offset[0] * 1.8, bz = m.offset[1] * 1.8;
      const x = s.x + rx * c + bz * sn * 1, z = s.z - rx * sn + bz * c;
      return { ...m, team: 'friendly', profile: m.role === 'marksman' ? 'friendlyMarksman' : 'friendly', pos: place(x, z, false), yaw: s.yaw + Math.PI, slot: i, mode: 'follow' };
    });
    this.keepClear = [...this.hostiles.map((h) => h.pos), ...this.mates.map((m) => m.pos), [s.x, 0, s.z]];
  }

  // ------------------------------------------------------------------ rocks

  blockedForScatter(x, z, clearR) {
    for (const p of MOUNTAIN_LAYOUT.pads) {
      const R = p.r + (p.id === 'lz' ? 2 : 1);
      if (Math.abs(x - p.x) < R + clearR && Math.abs(z - p.z) < R + clearR && Math.hypot(x - p.x, z - p.z) < (R + clearR) * 1.3) return true;
    }
    for (const k of this.keepClear) if (Math.abs(x - k[0]) < 3 + clearR && Math.abs(z - k[2]) < 3 + clearR) return true;
    return false;
  }

  buildRocks() {
    const T = this.terrain, P = this.physics, q = this.q;
    const rng = mulberry32(8812);
    this.rockMat = createRockMaterial(this.T);
    const geos = [rockGeometry(11, 2), rockGeometry(23, 2, { squash: 0.55, cuts: 7 }), rockGeometry(37, 3, { squash: 0.8, cuts: 5, rough: 0.19 }), rockGeometry(51, 3, { squash: 0.62, cuts: 8, rough: 0.13 })];
    const screeGeos = [rockGeometry(71, 1, { squash: 0.6, cuts: 4 }), rockGeometry(83, 1, { squash: 0.5, cuts: 5 })];
    const boulders = new Scatter(400), scree = new Scatter(128);
    const m = new THREE.Matrix4(), qt = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
    const v = new THREE.Vector3();
    let colliders = 0;
    const nrm = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0), qa = new THREE.Quaternion(), qy = new THREE.Quaternion();
    const addRock = (x, z, s, variant, collide) => {
      const g = T.heightAt(x, z), slope = T.slopeAt(x, z);
      const geo = geos[variant], bb = geo.boundingBox;
      const sink = s * (0.22 + slope * 1.2) * -bb.min.y;
      // bed the rock into the slope: tilt it most of the way towards the ground normal
      T.normalAt(x, z, nrm);
      nrm.lerp(yAxis, 0.3).normalize();
      qa.setFromUnitVectors(yAxis, nrm);
      qy.setFromAxisAngle(yAxis, rng() * Math.PI * 2);
      e.set((rng() - 0.5) * 0.2, 0, (rng() - 0.5) * 0.2);
      qt.setFromEuler(e).premultiply(qy).premultiply(qa);
      const sy = s * (0.8 + rng() * 0.45);
      ps.set(x, g - sink - sy * bb.min.y, z);
      sc.set(s, sy, s * (0.85 + rng() * 0.3));
      m.compose(ps, qt, sc);
      boulders.add(variant, m.clone());
      if (!collide) return;
      // collider from the transformed hull (slightly shrunk horizontally: the AABB over-covers a round rock)
      const pos = geo.attributes.position;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < pos.count; i += 3) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        if (v.x < x0) x0 = v.x; if (v.x > x1) x1 = v.x;
        if (v.y < y0) y0 = v.y; if (v.y > y1) y1 = v.y;
        if (v.z < z0) z0 = v.z; if (v.z > z1) z1 = v.z;
      }
      const top = y1 - g;
      if (top < 0.38) return;
      const shx = (x1 - x0) * 0.12, shz = (z1 - z0) * 0.12;
      P.addBox(x0 + shx, Math.max(y0, g - 0.6), z0 + shz, x1 - shx, y1 - top * 0.06, z1 - shz, { surface: 'rock', cover: top >= 0.8 && x1 - x0 > 0.9 && z1 - z0 > 0.9 });
      colliders++;
    };
    // boulders: denser on steep ground and in clusters, big tors on the upper slopes
    const R = 760, step = 6.5;
    for (let z = -R; z < R; z += step) {
      for (let x = -R; x < R; x += step) {
        const jx = x + rng() * step, jz = z + rng() * step;
        const dc = Math.hypot(jx, jz);
        const inPlay = dc < 640;
        const slope = T.slopeAt(jx, jz);
        const cl = T.fbm(T.n2, jx / 90, jz / 90, 2);
        let p = 0.05 + slope * 0.55 + Math.max(0, cl) * 0.35;
        if (!inPlay) p *= 0.45;
        if (rng() > p) continue;
        if (T.maskAt(jx, jz) > 0.05) continue;
        const big = slope > 0.3 && rng() < 0.12;
        let s = big ? 2.2 + rng() * 4.2 : 0.35 + Math.pow(rng(), 2.2) * 1.8;
        if (this.blockedForScatter(jx, jz, s)) continue;
        const variant = big ? 2 + Math.floor(rng() * 2) : Math.floor(rng() * 2);
        addRock(jx, jz, s, variant, inPlay && s > 0.45);
      }
    }
    // wadi boulders and site rubble
    for (let i = 0; i < 900; i++) {
      const k = rng() * (MOUNTAIN_LAYOUT.valley.length - 1), a = Math.floor(k), f = k - a;
      const A = MOUNTAIN_LAYOUT.valley[a], B = MOUNTAIN_LAYOUT.valley[a + 1];
      const x = A[0] + (B[0] - A[0]) * f + (rng() - 0.5) * 18, z = A[1] + (B[1] - A[1]) * f + (rng() - 0.5) * 18;
      if (Math.abs(x) > 780 || Math.abs(z) > 780 || T.maskAt(x, z) > 0.3) continue;
      const s = 0.25 + Math.pow(rng(), 2) * 1.1;
      if (this.blockedForScatter(x, z, s)) continue;
      addRock(x, z, s, Math.floor(rng() * 2), s > 0.45);
    }
    for (const rb of this.rubble) {
      for (let i = 0; i < rb.n; i++) {
        const a = rng() * 6.28, d = 2.6 + rng() * rb.r;
        const x = rb.x + Math.cos(a) * d, z = rb.z + Math.sin(a) * d;
        addRock(x, z, 0.2 + rng() * 0.45, Math.floor(rng() * 2), false);
      }
    }
    // scree: small loose stones on gravel slopes and along the wadi
    const screeCount = q.lightTier >= 2 ? 26000 : q.lightTier >= 1 ? 14000 : 5000;
    let placed = 0;
    for (let i = 0; i < screeCount * 4 && placed < screeCount; i++) {
      const x = (rng() * 2 - 1) * 700, z = (rng() * 2 - 1) * 700;
      const slope = T.slopeAt(x, z);
      const mk = T.maskAt(x, z);
      const w = smoothstep(0.1, 0.3, slope) * 0.8 + 0.12 + (mk > 0.5 ? -0.5 : 0);
      if (rng() > w) continue;
      const s = 0.05 + Math.pow(rng(), 3) * 0.3;
      const g = T.heightAt(x, z);
      e.set(rng() * 3, rng() * 6.28, rng() * 3);
      qt.setFromEuler(e);
      ps.set(x, g - s * 0.15, z);
      sc.set(s, s, s);
      scree.add(Math.floor(rng() * 2), new THREE.Matrix4().compose(ps, qt, sc));
      placed++;
    }
    const trng = mulberry32(31);
    this.boulderMeshes = boulders.build(this.scene, geos, this.rockMat, { cast: q.shadows, receive: true, tint: (c) => c.setRGB(0.95 + trng() * 0.2, 0.93 + trng() * 0.18, 0.9 + trng() * 0.16) });
    this.screeMeshes = scree.build(this.scene, screeGeos, this.rockMat, { cast: false, receive: true, cull: 260, tint: (c) => c.setRGB(0.5 + trng() * 0.18, 0.47 + trng() * 0.16, 0.42 + trng() * 0.14) });
    this.culled.push(...this.screeMeshes);
    this.rockColliders = colliders;
  }

  // ------------------------------------------------------------------ vegetation

  buildVegetation() {
    const T = this.terrain, q = this.q, ntf = this.ntf;
    const rng = mulberry32(5150);
    // CPU mirror of the terrain shader's grass mask so tufts sit on the grass-coloured ground
    const S = ntf.S;
    const field = (arr, u, v) => {
      u -= Math.floor(u); v -= Math.floor(v);
      const x = u * S - 0.5, y = v * S - 0.5, xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
      const i0 = ((xi % S) + S) % S, i1 = (i0 + 1) % S, j0 = ((yi % S) + S) % S, j1 = (j0 + 1) % S;
      return lerp(lerp(arr[j0 * S + i0], arr[j0 * S + i1], fx), lerp(arr[j1 * S + i0], arr[j1 * S + i1], fx), fy);
    };
    const grassMask = (x, z, y, slope) => {
      const macR = field(ntf.L, x / 470, z / 470);
      const mac2G = field(ntf.M, x / 86 + 0.37, z / 86 + 0.61);
      return (1 - smoothstep(0.07, 0.2, slope)) * smoothstep(0.42, 0.62, macR * 0.65 + mac2G * 0.45) * (1 - smoothstep(380, 700, y));
    };
    this.grassMask = grassMask;
    // grass tufts
    const grassMat = createGrassMaterial(this.T.blades, this.windU);
    this.grassMat = grassMat;
    const target = q.lightTier >= 2 ? 90000 : q.lightTier >= 1 ? 45000 : 12000;
    const tufts = new Scatter(64);
    const m = new THREE.Matrix4(), qt = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < target * 5 && n < target; i++) {
      const x = (rng() * 2 - 1) * 560, z = (rng() * 2 - 1) * 640;
      const y = T.heightAt(x, z), slope = T.slopeAt(x, z);
      const gm = grassMask(x, z, y, slope) * (1 - clamp(T.maskAt(x, z) * 2, 0, 1)) + (slope < 0.2 ? 0.035 : 0);
      if (rng() > gm) continue;
      if (this.insideStructure(x, z)) continue;
      const s = 0.7 + rng() * 0.7;
      e.set((rng() - 0.5) * 0.2, rng() * 6.28, (rng() - 0.5) * 0.2);
      qt.setFromEuler(e);
      ps.set(x, y - 0.03, z);
      sc.set(s, s * (0.75 + rng() * 0.55), s);
      tufts.add(0, m.compose(ps, qt, sc).clone());
      n++;
    }
    this.grassMeshes = tufts.build(this.scene, [tuftGeometry()], grassMat, { cast: false, receive: true, cull: 175 });
    this.culled.push(...this.grassMeshes);
    // bushes and forests (see-through leaf-card foliage with near / far LODs)
    this.veg = new Vegetation(this).build();
  }

  /** Keeps vegetation out of houses and from poking through compound walls. */
  insideStructure(x, z) {
    for (const b of this.indoorBoxes) if (x > b.minX - 0.6 && x < b.maxX + 0.6 && z > b.minZ - 0.6 && z < b.maxZ + 0.6) return true;
    for (const id of ['village', 'east']) {
      const p = this.pads[id], st = MOUNTAIN_SITES[id];
      const dx = Math.abs(x - p.x), dz = Math.abs(z - p.z);
      if (dx < st.w / 2 + 0.8 && dz < st.d / 2 + 0.8 && (dx > st.w / 2 - 1.2 || dz > st.d / 2 - 1.2)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ light & atmosphere

  buildLights() {
    const q = this.q;
    const sun = new THREE.DirectionalLight(0xfff1de, 3.5);
    sun.castShadow = q.shadows;
    const size = q.lightTier >= 2 ? 4096 : q.shadowSize;
    sun.shadow.mapSize.set(size, size);
    const sc = sun.shadow.camera;
    this.shadowHalf = q.lightTier >= 2 ? 62 : 48;
    sc.left = -this.shadowHalf; sc.right = this.shadowHalf; sc.top = this.shadowHalf; sc.bottom = -this.shadowHalf;
    sc.near = 1; sc.far = 900;
    sc.updateProjectionMatrix();
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.05;
    this.scene.add(sun, sun.target);
    const hemi = new THREE.HemisphereLight(0xa9c1e2, 0x7a6a55, 1.2);
    this.scene.add(hemi);
    this.lights = { sun, hemi, list: [], points: [], flicker: [] };
    this._snap = new THREE.Vector3();
  }

  /** Wind-blown dust motes and drifting haze sprites around the viewer. */
  buildDust() {
    const N = this.q.lightTier >= 2 ? 900 : this.q.lightTier >= 1 ? 500 : 0;
    if (!N) { this.dust = null; return; }
    const pos = new Float32Array(N * 3), seed = new Float32Array(N);
    const rng = mulberry32(99);
    for (let i = 0; i < N; i++) { pos[i * 3] = rng(); pos[i * 3 + 1] = rng(); pos[i * 3 + 2] = rng(); seed[i] = rng(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uWind: { value: this.wind }, uScale: { value: 800 },
        uSun: { value: this.sunDir }, uCol: { value: new THREE.Color(0.95, 0.86, 0.7) }, uBox: { value: new THREE.Vector3(70, 14, 70) },
      },
      vertexShader: `
        attribute float seed;
        uniform float uTime; uniform vec3 uCam; uniform vec2 uWind; uniform float uScale; uniform vec3 uBox;
        varying float vA; varying float vBig;
        void main() {
          float big = step(0.93, seed);
          vec3 drift = vec3(uWind.x, 0.05 + sin(seed * 40.0 + uTime * 0.7) * 0.12, uWind.y) * uTime * (0.6 + seed * 0.8);
          vec3 p = position * uBox + drift + vec3(sin(uTime * 0.9 + seed * 31.0), 0.0, cos(uTime * 0.7 + seed * 17.0)) * 0.4;
          vec3 rel = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5;
          rel.y = mod(p.y - uCam.y + 3.0, uBox.y) - 3.0;
          vec3 wp = uCam + rel;
          vec4 mv = modelViewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = -mv.z;
          float sz = mix(0.012, 1.8, big);
          gl_PointSize = clamp(sz * uScale / max(d, 0.1), 1.0, 160.0);
          vA = (1.0 - smoothstep(20.0, 34.0, length(rel.xz))) * mix(smoothstep(0.4, 2.0, d), smoothstep(7.0, 16.0, d), big) * mix(0.55, 0.03, big);
          vBig = big;
        }`,
      fragmentShader: `
        uniform vec3 uCol; varying float vA; varying float vBig;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float r = dot(c, c) * 4.0;
          float e = max(0.0, 1.0 - r);
          float a = e * vA * mix(1.0, e, vBig);
          if (a <= 0.003) discard;
          gl_FragColor = vec4(uCol, a);
        }`,
      transparent: true, depthWrite: false,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 3;
    this.scene.add(pts);
    this.dust = pts;
  }

  // ------------------------------------------------------------------ navigation

  buildNav() {
    const T = this.terrain;
    const groundFn = (x, z) => (T.slopeAt(x, z) > 0.4 ? null : T.heightAt(x, z));
    this.nav = new NavGrid(this.physics, { minX: -440, maxX: 440, minZ: -640, maxZ: 600 }, 2.0, 0.32,
      { groundFn, maxStep: 2.3, climbCost: 2.6, hw: 1.8, maxIter: 20000, segCheck: true, nearDy: 3.5 });
    this.nav.build();
    this.nav.buildCover();
  }

  // ------------------------------------------------------------------ map

  /** Top-down shaded relief with contour lines, tracks and structures for the HUD map. */
  buildMapImage() {
    const T = this.terrain, res = 512, half = 660;
    const c = document.createElement('canvas');
    c.width = c.height = res;
    const g = c.getContext('2d');
    const img = g.createImageData(res, res);
    const k = (half * 2) / res;
    const L = new THREE.Vector3(-0.6, 0.7, -0.4).normalize();
    const n = new THREE.Vector3();
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = -half + (i + 0.5) * k, z = -half + (j + 0.5) * k;
        const h = T.heightAt(x, z);
        T.normalAt(x, z, n);
        const shade = clamp(0.45 + n.dot(L) * 0.7, 0.15, 1.15);
        const hc = clamp(h / 700, 0, 1);
        let r = lerp(0.56, 0.72, hc) * shade, gg = lerp(0.52, 0.66, hc) * shade, b = lerp(0.42, 0.6, hc) * shade;
        const hx = T.heightAt(x + k, z), hz = T.heightAt(x, z + k);
        const band = (v) => Math.floor(v / 20);
        if (band(h) !== band(hx) || band(h) !== band(hz)) {
          const major = Math.floor(h / 100) !== Math.floor(hx / 100) || Math.floor(h / 100) !== Math.floor(hz / 100);
          const f = major ? 0.62 : 0.82;
          r *= f; gg *= f; b *= f;
        }
        const o = (j * res + i) * 4;
        img.data[o] = clamp(r, 0, 1) * 255; img.data[o + 1] = clamp(gg, 0, 1) * 255; img.data[o + 2] = clamp(b, 0, 1) * 255; img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    const px = (x) => ((x + half) / (half * 2)) * res;
    g.lineCap = 'round'; g.lineJoin = 'round';
    const line = (pts, w, col, dash) => {
      g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash || []);
      g.beginPath();
      pts.forEach(([x, z], i) => (i ? g.lineTo(px(x), px(z)) : g.moveTo(px(x), px(z))));
      g.stroke();
    };
    line(MOUNTAIN_LAYOUT.valley, 1.2, 'rgba(70,90,110,0.55)', [2, 3]);
    for (const r of MOUNTAIN_LAYOUT.roads) line(r.pts, 2.2, 'rgba(60,45,30,0.75)');
    for (const r of MOUNTAIN_LAYOUT.trails) line(r.pts, 1, 'rgba(60,45,30,0.6)', [3, 3]);
    g.setLineDash([]);
    g.fillStyle = 'rgba(40,32,26,0.9)';
    for (let ci = 0; ci < this.structureColliders; ci++) {
      const col = this.physics.colliders[ci];
      const w = (col.maxX - col.minX) / k, d = (col.maxZ - col.minZ) / k;
      if (w * d < 0.2) continue;
      g.fillRect(px(col.minX), px(col.minZ), Math.max(1, w), Math.max(1, d));
    }
    return { canvas: c, half, res };
  }

  // ------------------------------------------------------------------ runtime

  /** Global lighting state this world needs (called when it becomes the active world). */
  lightingState() {
    const hz = SKY_MOUNTAIN.horizon;
    return {
      terrain: { near: this.bakeNear.texture, far: this.bakeFar.texture, nearHalf: 800, farHalf: 12000 },
      clouds: { tex: this.cloudTex },
      aerial: {
        haze: new THREE.Color(hz[0] * 1.02, hz[1] * 1.03, hz[2] * 1.06), hazeSun: new THREE.Color(1.05, 0.9, 0.72),
        density: 1 / 9500, falloff: 1 / 950, baseHeight: 0, sunPower: 6,
      },
      sunDir: this.sunDir,
    };
  }

  isIndoors(x, y, z) {
    for (const b of this.indoorBoxes) if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ && y > b.minY && y < b.maxY + 0.2) return true;
    return false;
  }

  update(dt, camera, focus) {
    this.windU.uTime.value += dt;
    // gusting wind
    const t = this.windU.uTime.value;
    const gust = 0.75 + 0.35 * Math.sin(t * 0.21) + 0.2 * Math.sin(t * 0.53 + 1.3);
    this.wind.set(1.1 * gust, 0.35 * gust);
    this.cloudOff.x += dt * 2.4 / 1400;
    this.cloudOff.y += dt * 0.8 / 1400;
    this.gustAmt = gust;
    // shadow frustum follows the player, snapped to texels to avoid shimmering
    const sun = this.lights.sun;
    const f = focus || camera.position;
    const texel = (this.shadowHalf * 2) / sun.shadow.mapSize.x;
    const s = this.sunDir;
    // light-space basis
    const up = Math.abs(s.y) > 0.99 ? _X : _Y;
    _r.crossVectors(up, s).normalize();
    _u.crossVectors(s, _r).normalize();
    const a = f.dot(_r), b = f.dot(_u), c = f.dot(s);
    const as = Math.round(a / texel) * texel, bs = Math.round(b / texel) * texel;
    this._snap.copy(_r).multiplyScalar(as).addScaledVector(_u, bs).addScaledVector(s, c);
    sun.target.position.copy(this._snap);
    sun.position.copy(this._snap).addScaledVector(s, 420);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
    // distance culling of small scatter
    this.cullT -= dt;
    if (this.cullT <= 0) {
      this.cullT = 0.2;
      const cp = camera.position;
      for (const m of this.culled) {
        const bs2 = m.boundingSphere;
        if (!bs2) continue;
        const d = bs2.center.distanceTo(cp) - bs2.radius;
        m.visible = d < m.userData.cullDist;
      }
    }
    if (this.veg) this.veg.update(dt, camera.position);
    if (this.dust) {
      const u = this.dust.material.uniforms;
      u.uTime.value = t;
      u.uCam.value.copy(camera.position);
    }
  }
}

const _X = new THREE.Vector3(1, 0, 0), _Y = new THREE.Vector3(0, 1, 0), _r = new THREE.Vector3(), _u = new THREE.Vector3();
