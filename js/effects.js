// Visual effects: pooled particles (1 draw call), spark/tracer streaks (1 draw call),
// instanced decals (1 draw call), instanced shell casings, muzzle flashes and flash lights.
import * as THREE from 'three';
import { rand, clamp, choice } from './util.js';
import { ambientAt, patchAmbient } from './materials.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _up = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------------ particles

class ParticlePool {
  constructor(scene, max, texture, additive) {
    this.max = max;
    this.n = 0;
    this.p = [];
    for (let i = 0; i < max; i++) this.p.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, size: 0.1, grow: 0, r: 1, g: 1, b: 1, a: 1, grav: 0, drag: 0, fade: 1 });
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: texture }, uScale: { value: 600 } },
      vertexShader: `
        attribute vec4 pcolor; attribute float psize; uniform float uScale; varying vec4 vC;
        void main() {
          vC = pcolor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = min(psize * uScale / max(-mv.z, 0.05), 256.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uTex; varying vec4 vC;
        void main() {
          vec4 t = texture2D(uTex, gl_PointCoord);
          ${additive ? 'gl_FragColor = vec4(vC.rgb * t.a * vC.a, 1.0);' : 'gl_FragColor = vec4(vC.rgb, t.a * vC.a);'}
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    scene.add(this.points);
    this.cursor = 0;
  }

  spawn(o) {
    let p = null;
    for (let k = 0; k < this.max; k++) {
      const c = (this.cursor + k) % this.max;
      if (!this.p[c].alive) { p = this.p[c]; this.cursor = (c + 1) % this.max; break; }
    }
    if (!p) { p = this.p[this.cursor]; this.cursor = (this.cursor + 1) % this.max; }
    Object.assign(p, o);
    p.alive = true;
    p.life = 0;
    return p;
  }

  update(dt) {
    let n = 0;
    const pos = this.pos, col = this.col, size = this.size;
    for (let i = 0; i < this.max; i++) {
      const p = this.p[i];
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.maxLife) { p.alive = false; continue; }
      const dk = Math.exp(-p.drag * dt);
      p.vx *= dk; p.vy = p.vy * dk - p.grav * dt; p.vz *= dk;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.floor !== undefined && p.y < p.floor) { p.y = p.floor; p.vy *= -0.25; p.vx *= 0.5; p.vz *= 0.5; }
      const k = p.life / p.maxLife;
      pos[n * 3] = p.x; pos[n * 3 + 1] = p.y; pos[n * 3 + 2] = p.z;
      col[n * 4] = p.r; col[n * 4 + 1] = p.g; col[n * 4 + 2] = p.b;
      col[n * 4 + 3] = p.a * (p.fade ? (1 - k) * Math.min(1, k * 12 + 0.2) : 1 - k * k);
      size[n] = p.size + p.grow * p.life;
      n++;
    }
    this.n = n;
    const g = this.points.geometry;
    g.setDrawRange(0, n);
    if (n) {
      g.attributes.position.needsUpdate = true;
      g.attributes.pcolor.needsUpdate = true;
      g.attributes.psize.needsUpdate = true;
    }
  }

  clear() { for (const p of this.p) p.alive = false; }
}

class StreakPool {
  constructor(scene, max) {
    this.max = max;
    this.s = [];
    for (let i = 0; i < max; i++) this.s.push({ alive: false });
    this.pos = new Float32Array(max * 6);
    this.col = new Float32Array(max * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.lines = new THREE.LineSegments(g, mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 7;
    scene.add(this.lines);
    this.cursor = 0;
  }
  spawn(o) {
    const s = this.s[this.cursor];
    this.cursor = (this.cursor + 1) % this.max;
    Object.assign(s, { grav: 0, len: 0.03, bounce: false, floor: -100 }, o);
    s.alive = true;
    s.life = 0;
    return s;
  }
  update(dt) {
    let n = 0;
    for (const s of this.s) {
      if (!s.alive) continue;
      s.life += dt;
      if (s.life >= s.maxLife) { s.alive = false; continue; }
      s.vy -= s.grav * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      if (s.y < s.floor) {
        if (s.bounce) { s.y = s.floor; s.vy = -s.vy * 0.35; s.vx *= 0.6; s.vz *= 0.6; } else { s.alive = false; continue; }
      }
      const sp = Math.hypot(s.vx, s.vy, s.vz) || 1;
      const L = s.len;
      const k = 1 - s.life / s.maxLife;
      const j = n * 6;
      this.pos[j] = s.x; this.pos[j + 1] = s.y; this.pos[j + 2] = s.z;
      this.pos[j + 3] = s.x - (s.vx / sp) * L; this.pos[j + 4] = s.y - (s.vy / sp) * L; this.pos[j + 5] = s.z - (s.vz / sp) * L;
      const b = k * s.bright;
      this.col[j] = s.r * b; this.col[j + 1] = s.g * b; this.col[j + 2] = s.b * b;
      this.col[j + 3] = s.r * b * 0.2; this.col[j + 4] = s.g * b * 0.2; this.col[j + 5] = s.b * b * 0.2;
      n++;
    }
    const g = this.lines.geometry;
    g.setDrawRange(0, n * 2);
    if (n) { g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; }
  }
  clear() { for (const s of this.s) s.alive = false; }
}

// ------------------------------------------------------------------ decals

const DECAL_CELLS = { concrete: [0, 1], asphalt: [0, 1], metal: [2], wood: [3], blood: [4, 5], pool: [6], glass: [7] };

class DecalPool {
  constructor(scene, max, atlas) {
    this.max = max;
    this.cursor = 0;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.cell = new Float32Array(max * 2);
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(this.cell, 2));
    const mat = new THREE.MeshStandardMaterial({
      map: atlas.map, normalMap: atlas.normalMap, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, roughness: 0.85, metalness: 0,
    });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aCell;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>
          #ifdef USE_MAP
            vMapUv = vMapUv * vec2(0.25, 0.5) + aCell;
          #endif
          #ifdef USE_NORMALMAP
            vNormalMapUv = vNormalMapUv * vec2(0.25, 0.5) + aCell;
          #endif`);
    };
    mat.customProgramCacheKey = () => 'decal';
    patchAmbient(mat);
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.receiveShadow = true;
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < max; i++) this.mesh.setMatrixAt(i, _m);
    scene.add(this.mesh);
  }
  add(point, normal, type, size) {
    const cells = DECAL_CELLS[type];
    if (!cells) return;
    const c = choice(cells);
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.cell[i * 2] = (c % 4) * 0.25;
    this.cell[i * 2 + 1] = Math.floor(c / 4) * 0.5;
    _q.setFromUnitVectors(_z, normal);
    const spin = new THREE.Quaternion().setFromAxisAngle(_z, Math.random() * Math.PI * 2);
    _q.multiply(spin);
    _v.copy(point).addScaledVector(normal, 0.003 + Math.random() * 0.002);
    _s.set(size, size, size);
    _m.compose(_v, _q, _s);
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.geometry.attributes.aCell.needsUpdate = true;
  }
  clear() {
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ shell casings

class ShellPool {
  constructor(scene, physics, max) {
    this.physics = physics;
    this.max = max;
    const brassMat = patchAmbient(new THREE.MeshStandardMaterial({ color: 0xc9a25a, metalness: 1, roughness: 0.32 }));
    const shellMat = patchAmbient(new THREE.MeshStandardMaterial({ color: 0x7a2419, metalness: 0.1, roughness: 0.55 }));
    const brassGeo = new THREE.CylinderGeometry(0.0048, 0.0048, 0.045, 8);
    brassGeo.rotateX(Math.PI / 2);
    const shellGeo = new THREE.CylinderGeometry(0.0105, 0.0105, 0.068, 10);
    shellGeo.rotateX(Math.PI / 2);
    this.meshes = {
      brass: new THREE.InstancedMesh(brassGeo, brassMat, max),
      shell: new THREE.InstancedMesh(shellGeo, shellMat, Math.floor(max / 2)),
    };
    this.items = { brass: [], shell: [] };
    for (const [k, mesh] of Object.entries(this.meshes)) {
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      _m.makeScale(0, 0, 0);
      for (let i = 0; i < mesh.count; i++) { mesh.setMatrixAt(i, _m); this.items[k].push({ alive: false, q: new THREE.Quaternion(), p: new THREE.Vector3(), v: new THREE.Vector3(), w: new THREE.Vector3() }); }
      scene.add(mesh);
    }
    this.cursor = { brass: 0, shell: 0 };
    this.floorOut = { y: 0, surface: 'concrete' };
  }
  spawn(kind, pos, vel, sound) {
    const key = kind === 'shell12' ? 'shell' : 'brass';
    const list = this.items[key];
    const it = list[this.cursor[key]];
    this.cursor[key] = (this.cursor[key] + 1) % list.length;
    it.alive = true;
    it.resting = false;
    it.bounced = false;
    it.scale = kind === 'brass9' ? 0.62 : 1;
    it.kind = kind;
    it.sound = sound;
    it.p.copy(pos);
    it.v.copy(vel);
    it.w.set(rand(-25, 25), rand(-25, 25), rand(-25, 25));
    it.q.setFromEuler(new THREE.Euler(rand(0, 6), rand(0, 6), rand(0, 6)));
    it.age = 0;
  }
  update(dt, onBounce) {
    for (const key of ['brass', 'shell']) {
      const mesh = this.meshes[key];
      let dirty = false;
      this.items[key].forEach((it, i) => {
        if (!it.alive || it.resting) return;
        it.age += dt;
        it.v.y -= 9.81 * dt;
        it.p.addScaledVector(it.v, dt);
        const f = this.physics.floorAt(it.p.x, it.p.z, it.p.y + 0.3, this.floorOut);
        if (it.p.y < f.y + 0.005) {
          it.p.y = f.y + 0.005;
          if (!it.bounced || Math.abs(it.v.y) > 0.6) {
            if (onBounce) onBounce(it, f.surface, Math.abs(it.v.y));
            it.bounced = true;
          }
          it.v.y = Math.abs(it.v.y) * 0.3;
          it.v.x *= 0.45; it.v.z *= 0.45;
          it.w.multiplyScalar(0.4);
          if (Math.abs(it.v.y) < 0.25 && Math.hypot(it.v.x, it.v.z) < 0.15) {
            it.resting = true;
            // lie flat on the floor
            const yaw = Math.random() * Math.PI * 2;
            it.q.setFromEuler(new THREE.Euler(0, yaw, 0));
            it.p.y = f.y + (key === 'shell' ? 0.0105 : 0.0048 * it.scale);
          }
        }
        const wl = it.w.length();
        if (wl > 0.001 && !it.resting) {
          _q.setFromAxisAngle(_v.copy(it.w).divideScalar(wl), wl * dt);
          it.q.premultiply(_q);
        }
        _s.set(it.scale, it.scale, it.scale);
        _m.compose(it.p, it.q, _s);
        mesh.setMatrixAt(i, _m);
        dirty = true;
      });
      if (dirty) mesh.instanceMatrix.needsUpdate = true;
    }
  }
  clear() {
    for (const key of ['brass', 'shell']) {
      _m.makeScale(0, 0, 0);
      this.items[key].forEach((it, i) => { it.alive = false; this.meshes[key].setMatrixAt(i, _m); });
      this.meshes[key].instanceMatrix.needsUpdate = true;
    }
  }
}

// ------------------------------------------------------------------ public facade

export class Effects {
  constructor(scene, physics, audio, tf, quality) {
    this.scene = scene;
    this.physics = physics;
    this.audio = audio;
    this.quality = quality;
    const low = quality.lightTier === 0;
    this.puffTex = tf.puff();
    this.dust = new ParticlePool(scene, low ? 220 : 480, this.puffTex, false);
    this.glow = new ParticlePool(scene, 80, this.puffTex, true);
    this.streaks = new StreakPool(scene, low ? 120 : 220);
    this.decals = new DecalPool(scene, low ? 70 : 140, tf.decalAtlas());
    this.shells = new ShellPool(scene, physics, 48);
    this.flashTex = tf.muzzleFlash();
    this.flashes = [];
    for (let i = 0; i < 6; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: 0xffd9a0 }));
      sp.visible = false;
      sp.renderOrder = 8;
      scene.add(sp);
      this.flashes.push({ sprite: sp, t: 0 });
    }
    this.lights = {
      player: this.makeFlashLight(scene, 0xffc98a),
      enemy: this.makeFlashLight(scene, 0xffc98a),
      impact: quality.lightTier >= 2 ? this.makeFlashLight(scene, 0xffb070) : null,
    };
    this.floorOut = { y: 0, surface: 'concrete' };
    this._tmp = new THREE.Vector3();
  }

  makeFlashLight(scene, color) {
    const l = new THREE.PointLight(color, 0, 10, 2);
    l.castShadow = false;
    scene.add(l);
    return { light: l, t: 0, peak: 0 };
  }

  setScale(pxScale) {
    this.dust.mat.uniforms.uScale.value = pxScale;
    this.glow.mat.uniforms.uScale.value = pxScale;
  }

  flashLight(which, pos, intensity, dur = 0.05) {
    const f = this.lights[which];
    if (!f) return;
    f.light.position.copy(pos);
    f.peak = intensity;
    f.t = dur;
    f.dur = dur;
    f.light.intensity = intensity;
  }

  worldMuzzleFlash(pos, dir, scale = 1) {
    const f = this.flashes.find((x) => x.t <= 0) || this.flashes[0];
    f.sprite.position.copy(pos).addScaledVector(dir, 0.08);
    f.sprite.scale.setScalar(0.45 * scale * rand(0.8, 1.2));
    f.sprite.material.rotation = Math.random() * Math.PI * 2;
    f.sprite.visible = true;
    f.t = 0.045;
  }

  lightAt(x, y, z) {
    _v.set(x, y, z);
    return 0.25 + ambientAt(_v) * 0.75;
  }

  // ------------------------------------------------------------------ recipes

  impact(point, normal, surface, dir, opts = {}) {
    const L = this.lightAt(point.x, point.y, point.z);
    const big = opts.big ? 1.6 : 1;
    if (surface === 'metal') {
      this.decals.add(point, normal, 'metal', rand(0.05, 0.07));
      const n = Math.floor(rand(7, 13) * big);
      for (let i = 0; i < n; i++) this.spark(point, normal, dir, 1);
      this.puff(point, normal, 1, [0.32 * L, 0.3 * L, 0.28 * L], 0.12, 0.8);
      if (!opts.quiet) this.flashLight('impact', _v.copy(point).addScaledVector(normal, 0.1), 3, 0.04);
    } else if (surface === 'wood') {
      this.decals.add(point, normal, 'wood', rand(0.05, 0.075));
      for (let i = 0; i < 7 * big; i++) this.debris(point, normal, [0.36 * L, 0.26 * L, 0.16 * L], 0.018);
      this.puff(point, normal, 2, [0.5 * L, 0.42 * L, 0.32 * L], 0.14, 0.9);
    } else if (surface === 'dirt' || surface === 'fabric') {
      for (let i = 0; i < 10 * big; i++) this.debris(point, normal, [0.42 * L, 0.36 * L, 0.26 * L], 0.02, 3);
      this.puff(point, normal, 4, [0.5 * L, 0.45 * L, 0.36 * L], 0.25, 1.3);
    } else if (surface === 'glass') {
      this.decals.add(point, normal, 'glass', rand(0.12, 0.2));
      this.glassShards(point, normal, 6);
    } else {
      const asph = surface === 'asphalt';
      this.decals.add(point, normal, 'concrete', rand(0.06, 0.09) * (asph ? 0.8 : 1));
      const c = asph ? [0.3 * L, 0.29 * L, 0.27 * L] : [0.55 * L, 0.52 * L, 0.48 * L];
      this.puff(point, normal, Math.floor(4 * big), c, 0.2, 1.4);
      for (let i = 0; i < 9 * big; i++) this.debris(point, normal, [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6], 0.016);
      if (Math.random() < 0.3) this.spark(point, normal, dir, 0.5);
    }
    if (!opts.quiet) {
      const name = surface === 'asphalt' ? 'impact_concrete' : surface === 'fabric' ? 'impact_dirt' : 'impact_' + surface;
      this.audio.play(name, { pos: point, volume: opts.volume ?? 0.75, ref: 2.5, reverb: 0.3, rateVar: 0.1, priority: 'low', occluded: opts.occluded });
    }
  }

  puff(p, n, count, color, size, life) {
    for (let i = 0; i < count; i++) {
      const s = rand(0.6, 1.6);
      this.dust.spawn({
        x: p.x + n.x * 0.03, y: p.y + n.y * 0.03, z: p.z + n.z * 0.03,
        vx: n.x * s + rand(-0.4, 0.4), vy: n.y * s + rand(-0.2, 0.5), vz: n.z * s + rand(-0.4, 0.4),
        maxLife: life * rand(0.6, 1.2), size: size * rand(0.6, 1.2), grow: size * 1.2,
        r: color[0], g: color[1], b: color[2], a: 0.55, grav: -0.15, drag: 3.2, fade: 1, floor: undefined,
      });
    }
  }

  debris(p, n, color, size, speed = 2.5) {
    const f = this.physics.floorAt(p.x, p.z, p.y + 0.05, this.floorOut).y;
    this.dust.spawn({
      x: p.x + n.x * 0.02, y: p.y + n.y * 0.02, z: p.z + n.z * 0.02,
      vx: n.x * rand(0.5, speed) + rand(-1, 1), vy: n.y * rand(0.5, speed) + rand(0.2, 1.8), vz: n.z * rand(0.5, speed) + rand(-1, 1),
      maxLife: rand(0.5, 1.1), size: size * rand(0.6, 1.4), grow: 0, r: color[0], g: color[1], b: color[2], a: 1,
      grav: 9.8, drag: 0.4, fade: 0, floor: f,
    });
  }

  spark(p, n, dir, bright = 1) {
    // reflect-ish direction
    const d = dir ? dir : n;
    const dot = d.x * n.x + d.y * n.y + d.z * n.z;
    const rx = d.x - 2 * dot * n.x, ry = d.y - 2 * dot * n.y, rz = d.z - 2 * dot * n.z;
    const sp = rand(3, 9);
    const f = this.physics.floorAt(p.x, p.z, p.y + 0.05, this.floorOut).y;
    this.streaks.spawn({
      x: p.x, y: p.y, z: p.z,
      vx: (rx * 0.6 + n.x * 0.5 + rand(-0.6, 0.6)) * sp, vy: (ry * 0.6 + n.y * 0.5 + rand(-0.3, 0.9)) * sp, vz: (rz * 0.6 + n.z * 0.5 + rand(-0.6, 0.6)) * sp,
      maxLife: rand(0.12, 0.45), r: 1.0, g: 0.62, b: 0.25, bright: 4 * bright, len: rand(0.03, 0.08), grav: 9.8, bounce: true, floor: f,
    });
  }

  tracer(from, to, faint = false) {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 3) return;
    const speed = 420;
    this.streaks.spawn({
      x: from.x + (dx / d) * 1.5, y: from.y + (dy / d) * 1.5, z: from.z + (dz / d) * 1.5,
      vx: (dx / d) * speed, vy: (dy / d) * speed, vz: (dz / d) * speed,
      maxLife: Math.max(0.02, (d - 1.5) / speed), r: 1.0, g: 0.78, b: 0.5, bright: faint ? 1.2 : 2.5, len: 2.2, grav: 0,
    });
  }

  blood(point, dir, heavy = false) {
    const L = this.lightAt(point.x, point.y, point.z);
    const n = heavy ? 10 : 6;
    for (let i = 0; i < n; i++) {
      const s = rand(0.3, 1.8);
      this.dust.spawn({
        x: point.x, y: point.y, z: point.z,
        vx: dir.x * s + rand(-0.6, 0.6), vy: dir.y * s + rand(-0.3, 0.7), vz: dir.z * s + rand(-0.6, 0.6),
        maxLife: rand(0.25, 0.6), size: rand(0.06, 0.16), grow: 0.35, r: 0.32 * L, g: 0.02 * L, b: 0.02 * L, a: 0.75,
        grav: 2.5, drag: 3.5, fade: 1,
      });
    }
    for (let i = 0; i < 5; i++) this.debris(point, dir, [0.25 * L, 0.01, 0.01], 0.012, 2);
    // spatter on a surface behind the target
    const hit = this.physics.raycast(point.x, point.y, point.z, dir.x, dir.y, dir.z, 2.6, 'bullet');
    if (hit) {
      _v.set(point.x + dir.x * hit.t, point.y + dir.y * hit.t, point.z + dir.z * hit.t);
      this._tmp.set(hit.nx, hit.ny, hit.nz);
      this.decals.add(_v, this._tmp, 'blood', rand(0.3, 0.55) * (1 - hit.t / 3.2));
    }
  }

  bloodPool(pos) {
    const f = this.physics.floorAt(pos.x, pos.z, pos.y + 0.5, this.floorOut);
    _v.set(pos.x, f.y, pos.z);
    this.decals.add(_v, _up, 'pool', rand(0.9, 1.3));
  }

  glassShards(p, n, count) {
    const f = this.physics.floorAt(p.x, p.z, p.y, this.floorOut).y;
    for (let i = 0; i < count; i++) {
      this.dust.spawn({
        x: p.x + rand(-0.2, 0.2), y: p.y + rand(-0.2, 0.2), z: p.z + rand(-0.2, 0.2),
        vx: n.x * rand(0.2, 2) + rand(-0.6, 0.6), vy: rand(-0.5, 1.2), vz: n.z * rand(0.2, 2) + rand(-0.6, 0.6),
        maxLife: rand(0.7, 1.4), size: rand(0.015, 0.035), grow: 0, r: 0.75, g: 0.8, b: 0.82, a: 0.9,
        grav: 9.8, drag: 0.3, fade: 0, floor: f,
      });
    }
  }

  muzzleSmoke(pos, dir, amount = 1) {
    const L = this.lightAt(pos.x, pos.y, pos.z);
    for (let i = 0; i < 2 * amount; i++) {
      this.dust.spawn({
        x: pos.x, y: pos.y, z: pos.z,
        vx: dir.x * rand(0.4, 1.4) + rand(-0.15, 0.15), vy: dir.y * 0.8 + rand(0.05, 0.3), vz: dir.z * rand(0.4, 1.4) + rand(-0.15, 0.15),
        maxLife: rand(0.5, 1.1), size: rand(0.05, 0.1), grow: 0.35, r: 0.6 * L, g: 0.6 * L, b: 0.62 * L, a: 0.22,
        grav: -0.25, drag: 2.5, fade: 1,
      });
    }
  }

  /** Brief spark cloud at the muzzle (world space). */
  muzzleSparks(pos, dir, count = 3) {
    for (let i = 0; i < count; i++) {
      const sp = rand(6, 14);
      this.streaks.spawn({
        x: pos.x, y: pos.y, z: pos.z,
        vx: (dir.x + rand(-0.25, 0.25)) * sp, vy: (dir.y + rand(-0.25, 0.25)) * sp, vz: (dir.z + rand(-0.25, 0.25)) * sp,
        maxLife: rand(0.03, 0.08), r: 1, g: 0.7, b: 0.35, bright: 3, len: 0.05, grav: 0,
      });
    }
  }

  shell(kind, pos, vel) { this.shells.spawn(kind, pos, vel, true); }

  update(dt, camera) {
    this.dust.update(dt);
    this.glow.update(dt);
    this.streaks.update(dt);
    this.shells.update(dt, (it, surface, speed) => {
      if (!it.sound) return;
      const name = it.kind === 'shell12' ? 'casing_shell' : it.kind === 'brass9' ? 'casing_brass9' : 'casing_brass';
      this.audio.play(name, { pos: it.p, volume: clamp(speed / 2.5, 0.15, 0.55), ref: 1.2, reverb: 0.2, rateVar: 0.08, priority: 'low' });
      it.sound = false;
    });
    for (const f of this.flashes) {
      if (f.t > 0) { f.t -= dt; if (f.t <= 0) f.sprite.visible = false; }
    }
    for (const f of Object.values(this.lights)) {
      if (f && f.t > 0) {
        f.t -= dt;
        f.light.intensity = f.t > 0 ? f.peak * (f.t / f.dur) : 0;
      }
    }
  }

  clear() {
    this.dust.clear(); this.glow.clear(); this.streaks.clear(); this.decals.clear(); this.shells.clear();
    for (const f of this.flashes) { f.t = 0; f.sprite.visible = false; }
    for (const f of Object.values(this.lights)) if (f) { f.t = 0; f.light.intensity = 0; }
  }
}
