// Game orchestrator: loads the world, runs the mission and ties every system together.
import * as THREE from 'three';
import { QUALITY, WEAPONS } from './config.js';
import { TextureFactory } from './textures.js';
import { createMaterials, ambientAt, patchAmbient, setSunMask } from './materials.js';
import { PhysicsWorld } from './physics.js';
import { buildLevel, buildLights, buildLightShafts, buildDust, SUN_DIR, BOUNDS, BUILDING, LEVEL_INFO, isIndoors } from './level.js';
import { createSky, createEnvironment } from './sky.js';
import { NavGrid } from './nav.js';
import { Effects } from './effects.js';
import { ViewModel } from './viewmodel.js';
import { Player } from './player.js';
import { WeaponSystem } from './weapons.js';
import { Enemy } from './enemy.js';
import { propBox } from './geometry.js';
import { clamp, damp, lerp, rand, DEG } from './util.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _f = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);

export class Game {
  constructor(pipe, audio, input, hud, settings) {
    this.pipe = pipe;
    this.audio = audio;
    this.input = input;
    this.hud = hud;
    this.settings = settings;
    this.state = 'loading';
    this.time = 0;
    this.aiEnabled = false;
    this.delayed = [];
    this.tokens = 0;
    this.onEnd = null;
    this.hudDirty = true;
    this.indoorAmt = 0;
    this.exposure = 1;
    this.sunVis = 1;
    this.sunCheckT = 0;
    this.whizzT = 0;
    this.heartT = 0;
    this.glassHits = [];
    this.viewState = {};
    this.pctx = {};
  }

  // ------------------------------------------------------------------ loading

  async load(progress) {
    const q = QUALITY[this.settings.quality];
    this.quality = q;
    this.pipe.applyQuality(q);
    setSunMask(!q.shadows);
    await progress(0.03, 'Generating surfaces');
    const tf = new TextureFactory(q.texSize, Math.min(q.anisotropy, this.pipe.maxAniso));
    this.tf = tf;
    await progress(0.18, 'Preparing materials');
    this.M = createMaterials(tf, q);
    await progress(0.3, 'Building Kestrel Freight Depot');
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0xa9a398, 0.0062);
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.03, 700);
    this.physics = new PhysicsWorld();
    this.level = buildLevel(scene, this.physics, this.M, tf, q);
    this.lights = buildLights(scene, q);
    createSky(scene, SUN_DIR);
    await progress(0.42, 'Lighting');
    this.env = createEnvironment(this.pipe.r, SUN_DIR);
    scene.environment = this.env;
    this.shafts = buildLightShafts(scene);
    this.dust = q.dust ? buildDust(scene, q.lightTier >= 2 ? 520 : 300) : null;
    await progress(0.5, 'Computing navigation');
    this.nav = new NavGrid(this.physics, BOUNDS, 0.5, 0.32);
    this.nav.build();
    this.nav.buildCover();
    await progress(0.58, 'Arming');
    this.effects = new Effects(scene, this.physics, this.audio, tf, q);
    this.viewmodel = new ViewModel(tf, this.M._textures, this.env);
    this.player = new Player(this.physics);
    this.weapons = new WeaponSystem(this);
    await progress(0.64, 'Deploying hostiles');
    this.enemies = [];
    for (const d of LEVEL_INFO.enemies) this.enemies.push(new Enemy(this, d));
    for (const d of LEVEL_INFO.reinforcements) this.enemies.push(new Enemy(this, { ...d, reinforcement: true, mode: 'guard' }));
    this.buildPickups();
    this.hud.buildMap(this.physics, BOUNDS);
    await progress(0.7, 'Recording audio');
    await this.audio.generate(async (k) => progress(0.7 + k * 0.24, 'Recording audio'));
    await progress(0.95, 'Compiling shaders');
    this.onResize();
    this.compileAll();
    await progress(1, 'Ready');
    this.state = 'menu';
    this.menuT = 0;
    this.resetWorld();
    this.audio.startAmbience({ generator: new THREE.Vector3(13.5, 1.0, -2.4), buzz: new THREE.Vector3(12.2, 3.4, -5.25) });
  }

  compileAll() {
    const hidden = [];
    this.scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    this.viewmodel.scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    try {
      this.pipe.r.compile(this.scene, this.camera);
      this.pipe.r.compile(this.viewmodel.scene, this.viewmodel.camera);
      this.pipe.render(this.scene, this.camera, this.viewmodel.scene, this.viewmodel.camera, 0);
    } catch (e) { console.warn(e); }
    for (const o of hidden) o.visible = false;
  }

  buildPickups() {
    const M = this.M;
    const ammoMat = patchAmbient(new THREE.MeshStandardMaterial({ color: 0x4a4a3a, roughness: 0.85 }));
    const magMat = patchAmbient(new THREE.MeshStandardMaterial({ color: 0x1f2021, roughness: 0.6 }));
    const kitMat = patchAmbient(new THREE.MeshStandardMaterial({ color: 0xcfcac0, roughness: 0.6 }));
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#d6d1c6'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#9c2a22'; g.fillRect(24, 10, 16, 44); g.fillRect(10, 24, 44, 16);
    const crossTex = new THREE.CanvasTexture(c);
    crossTex.colorSpace = THREE.SRGBColorSpace;
    const crossMat = patchAmbient(new THREE.MeshStandardMaterial({ map: crossTex, roughness: 0.6 }));
    this.pickups = [];
    for (let i = 0; i < 14; i++) {
      const grp = new THREE.Group();
      const pouch = new THREE.Mesh(propBox(0.2, 0.07, 0.13), ammoMat);
      pouch.position.y = 0.035;
      const mag = new THREE.Mesh(propBox(0.026, 0.12, 0.065), magMat);
      mag.position.set(0.04, 0.07, 0);
      mag.rotation.z = 0.9;
      grp.add(pouch, mag);
      grp.visible = false;
      this.scene.add(grp);
      this.pickups.push({ kind: 'ammo', mesh: grp, active: false, pos: grp.position });
    }
    this.medkits = LEVEL_INFO.medkits.map((m) => {
      const grp = new THREE.Group();
      const box = new THREE.Mesh(propBox(0.32, 0.12, 0.22), kitMat);
      box.position.y = 0.06;
      const top = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.14), crossMat);
      top.rotation.x = -Math.PI / 2;
      top.position.y = 0.1205;
      grp.add(box, top);
      grp.position.set(m.x, m.y, m.z);
      grp.rotation.y = rand(0, 3);
      box.castShadow = true;
      this.scene.add(grp);
      return { mesh: grp, active: true, pos: grp.position };
    });
  }

  // ------------------------------------------------------------------ mission

  resetWorld() {
    this.effects.clear();
    this.delayed.length = 0;
    this.tokens = 0;
    for (const e of this.enemies) e.reset();
    for (const c of this.nav.cover) c.owner = null;
    for (const p of this.pickups) { p.active = false; p.mesh.visible = false; }
    for (const m of this.medkits) { m.active = true; m.mesh.visible = true; }
    // glass
    const gm = this.level.glassMesh;
    if (gm) {
      for (const pane of this.physics.glass) {
        pane.broken = false;
        pane.collider.move = true;
        gm.setMatrixAt(pane.index, pane.matrix);
      }
      gm.instanceMatrix.needsUpdate = true;
    }
    const dyn = this.level.dynamic;
    dyn.drive.visible = true;
  }

  startMission() {
    this.resetWorld();
    const s = LEVEL_INFO.spawn;
    this.player.reset(s);
    this.weapons.reset();
    this.viewmodel.setWeapon('rifle');
    this.hud.reset();
    this.stats = { shots: 0, hits: 0, kills: 0, headshots: 0, damage: 0, time: 0 };
    this.objective = 'intel';
    this.interactProgress = 0;
    this.enteredBuilding = false;
    this.endT = 0;
    this.time = 0;
    this.aiEnabled = true;
    this.state = 'playing';
    this.hudDirty = true;
    this.hud.setObjective('Secure the drive', 'Upper office · main hall mezzanine');
    this.hud.notice('Kestrel Freight Depot', 'Breach · recover the drive · exfil', 4.5);
    this.exposure = 1;
    this.indoorAmt = 0;
    this.input.clearAll();
  }

  objectiveTarget() {
    if (this.objective === 'intel') return { x: LEVEL_INFO.intel.x, y: LEVEL_INFO.intel.y + 0.2, z: LEVEL_INFO.intel.z };
    if (this.objective === 'exfil') return { x: LEVEL_INFO.exfil.x, y: 1.0, z: LEVEL_INFO.exfil.z };
    return null;
  }

  secureIntel() {
    this.objective = 'exfil';
    this.level.dynamic.drive.visible = false;
    this.audio.playUI('objective');
    this.hud.setObjective('Exfil', 'Return to the breach point · south-east yard', true);
    this.hud.notice('Drive secured', 'Move to exfil', 3.5);
    const known = this.player.pos.clone();
    this.later(5.5, () => {
      if (this.state !== 'playing') return;
      this.audio.play('chatter', { volume: 0.4, reverb: 0.2, ui: false });
      this.hud.notice('Hostile reinforcements', 'Entering from the north side', 3.5);
      for (const e of this.enemies) if (e.def.reinforcement) e.activate(known);
    });
  }

  completeMission() {
    this.state = 'complete';
    this.aiEnabled = false;
    this.audio.playUI('objective');
    this.hud.notice('Exfil reached', '', 2);
    this.later(1.4, () => this.onEnd && this.onEnd('complete', this.summary()));
  }

  playerDied() {
    this.state = 'dead';
    this.later(2.8, () => this.onEnd && this.onEnd('kia', this.summary()));
  }

  summary() {
    const s = this.stats;
    const alive = this.enemies.filter((e) => e.active && e.alive).length;
    return { ...s, accuracy: s.shots ? Math.round((s.hits / s.shots) * 100) : 0, remaining: alive, total: this.enemies.filter((e) => e.active || !e.def.reinforcement).length };
  }

  later(t, fn) { this.delayed.push({ t, fn }); }

  // ------------------------------------------------------------------ combat services

  /** Resolves one bullet / pellet. shooter: 'player' or an Enemy. */
  fireBullet(o, d, w, shooter, primary) {
    const P = this.physics;
    const maxR = w.range || 250;
    const hit = P.raycast(o.x, o.y, o.z, d.x, d.y, d.z, maxR, 'bullet');
    let tWorld = maxR, hn = null, surf = 'concrete';
    if (hit) { tWorld = hit.t; hn = _w.set(hit.nx, hit.ny, hit.nz).clone(); surf = hit.surface; }
    // shatter glass panes along the path
    P.glassAlong(o.x, o.y, o.z, d.x, d.y, d.z, tWorld, this.glassHits);
    for (const gh of this.glassHits) this.shatterPane(gh.pane, _v.copy(d).multiplyScalar(gh.t).add(o), d);
    if (shooter === 'player') {
      let best = null, bt = tWorld, zone = null;
      const pt = new THREE.Vector3();
      for (const e of this.enemies) {
        const h = e.raycast(o, d, bt);
        if (h) { best = e; bt = h.t; zone = h.zone; pt.copy(h.point); }
      }
      if (best) {
        const fall = this.falloff(w, bt);
        const mult = zone === 'head' ? w.headMult : zone === 'limb' ? w.limbMult : 1;
        const killed = best.takeDamage(w.damage * fall * mult, zone, d, this.player.pos);
        this.shotHit = true;
        this.effects.blood(pt, d, zone === 'head');
        this.audio.play('impact_flesh', { pos: pt, volume: 0.85, ref: 3, reverb: 0.2 });
        if (zone === 'head' && best.profile.helmet && !killed) this.audio.play('impact_metal', { pos: pt, volume: 0.5, ref: 3, reverb: 0.2 });
        if (this.settings.hitMarkers) this.hud.hitmarker(killed);
        if (killed && zone === 'head') this.stats.headshots++;
        return;
      }
      // suppression of enemies the round passes close to
      if (primary) {
        for (const e of this.enemies) {
          if (!e.alive || !e.active) continue;
          _v.set(e.pos.x - o.x, e.pos.y + 1.2 - o.y, e.pos.z - o.z);
          const t = _v.dot(d);
          if (t < 0 || t > tWorld + 1.5) continue;
          const dist2 = _v.lengthSq() - t * t;
          if (dist2 < 2.2 * 2.2) e.onNearMiss(this.player.pos);
        }
      }
    } else {
      const ph = this.rayPlayer(o, d, tWorld);
      if (ph) {
        this.damagePlayer(w.damage * (ph.head ? w.headMult : 1), shooter, ph.point, d);
        return;
      }
      this.checkWhizz(o, d, tWorld);
    }
    if (hit) {
      const point = _v.copy(d).multiplyScalar(tWorld).add(o).clone();
      const occluded = shooter !== 'player' && point.distanceTo(this.camera.position) > 8 && !this.physics.clearLine(this.camera.position.x, this.camera.position.y, this.camera.position.z, point.x + hn.x * 0.1, point.y + hn.y * 0.1, point.z + hn.z * 0.1, 'sight');
      this.effects.impact(point, hn, surf, d, { volume: shooter === 'player' ? 0.7 : 0.9, occluded, quiet: !primary && shooter === 'player' && Math.random() < 0.6 });
      if (shooter === 'player' && primary) this.emitNoise(point, 6, 'impact', true);
    }
  }

  falloff(w, t) {
    if (!w.falloffStart || t <= w.falloffStart) return 1;
    const k = clamp((t - w.falloffStart) / (w.falloffEnd - w.falloffStart), 0, 1);
    return lerp(1, w.minDamageMul, k);
  }

  shatterPane(pane, point, dir) {
    pane.broken = true;
    pane.collider.move = false;
    const gm = this.level.glassMesh;
    gm.setMatrixAt(pane.index, ZERO_M);
    gm.instanceMatrix.needsUpdate = true;
    const n = pane.axis === 'x' ? _f.set(0, 0, Math.sign(dir.z) || 1) : _f.set(Math.sign(dir.x) || 1, 0, 0);
    this.effects.glassShards(point, n, 16);
    this.audio.play('impact_glass', { pos: point, volume: 0.9, ref: 3, reverb: 0.4 });
    this.emitNoise(point, 14, 'impact', true);
  }

  /** Ray vs the player's body (stack of spheres following stance + lean). */
  rayPlayer(o, d, maxT) {
    const p = this.player;
    if (!p.alive) return null;
    const lx = Math.cos(p.yaw) * p.leanOffset, lz = -Math.sin(p.yaw) * p.leanOffset;
    const h = p.height;
    const spheres = [[0.2, 0.22, 0], [0.45, 0.24, 0.3], [0.68, 0.26, 0.6], [0.86, 0.22, 0.9]];
    let best = null, bt = maxT;
    for (const [fy, r, lean] of spheres) {
      const cx = p.pos.x + lx * lean, cy = p.pos.y + h * fy, cz = p.pos.z + lz * lean;
      const t = raySphere(o, d, cx, cy, cz, r);
      if (t !== null && t < bt) { bt = t; best = { head: false }; }
    }
    const e = p.eyePosition(_v);
    const th = raySphere(o, d, e.x, e.y - 0.02, e.z, 0.13);
    if (th !== null && th < bt) { bt = th; best = { head: true }; }
    if (!best) return null;
    best.point = new THREE.Vector3().copy(d).multiplyScalar(bt).add(o);
    return best;
  }

  damagePlayer(amount, shooter, point, dir) {
    const P = this.player;
    this.stats.damage += amount;
    const died = P.damage(amount, dir, this.time);
    this.hud.damageFlash(amount);
    this.pipe.fx.flash = 0.03;
    this.audio.play('impact_flesh', { volume: 0.9, reverb: 0.1, rate: 0.9 });
    if (Math.random() < 0.5) this.audio.play('grunt', { volume: 0.35, rate: 0.85, reverb: 0.1 });
    // direction indicator relative to view
    const src = shooter && shooter.pos ? shooter.pos : point;
    const ang = Math.atan2(src.x - P.pos.x, src.z - P.pos.z);
    const rel = -(ang - (P.yaw + Math.PI));
    this.hud.damageDir(rel);
    this.hudDirty = true;
    if (died) this.playerDied();
  }

  checkWhizz(o, d, tEnd) {
    if (this.whizzT > 0) return;
    const e = this.camera.position;
    _v.subVectors(e, o);
    const t = _v.dot(d);
    if (t < 1 || t > tEnd) return;
    const dist = Math.sqrt(Math.max(0, _v.lengthSq() - t * t));
    if (dist > 2.2) return;
    const cp = _w.copy(d).multiplyScalar(t).add(o);
    this.audio.play('whizz', { pos: cp, volume: 0.9 * (1 - dist / 2.4), ref: 1, reverb: 0.15, rateVar: 0.12 });
    this.whizzT = 0.07;
    this.player.punchRoll.impulse(rand(-0.3, 0.3));
  }

  emitNoise(pos, radius, type, fromPlayer, source = null) {
    if (!this.aiEnabled) return;
    for (const e of this.enemies) if (e !== source) e.hearNoise(pos, radius, type, fromPlayer);
  }

  alertAllies(src, pos) {
    for (const e of this.enemies) {
      if (e === src || !e.alive || !e.active || e.state === 'combat') continue;
      const d = e.pos.distanceTo(src.pos);
      if (d < 22 || (d < 40 && this.physics.clearLine(src.pos.x, src.pos.y + 1.5, src.pos.z, e.pos.x, e.pos.y + 1.5, e.pos.z, 'sight'))) {
        const known = pos.clone().add(new THREE.Vector3(rand(-2, 2), 0, rand(-2, 2)));
        this.later(rand(0.4, 1.4), () => {
          if (!e.alive || e.state === 'combat') return;
          e.lastKnown.copy(known);
          e.lastSeen = this.time - 2;
          e.awareness = 1;
          e.enterCombat(false);
          if (Math.random() < 0.5) e.say('radio', 0.7);
        });
      }
    }
  }

  requestToken(e) {
    if (e.token) return true;
    if (this.tokens >= 2) return false;
    this.tokens++;
    e.token = true;
    return true;
  }

  releaseToken(e) {
    if (!e.token) return;
    e.token = false;
    this.tokens = Math.max(0, this.tokens - 1);
  }

  onEnemyKilled(e, headshot) {
    this.stats.kills++;
    const p = this.pickups.find((q) => !q.active) || this.pickups[0];
    const f = this.physics.floorAt(e.pos.x, e.pos.z, e.pos.y + 0.5);
    p.active = true;
    p.mesh.visible = true;
    p.mesh.position.set(e.pos.x + rand(-0.3, 0.3), f.y, e.pos.z + rand(-0.3, 0.3));
    p.mesh.rotation.y = rand(0, 6.28);
    p.spawnT = this.time;
    const alive = this.enemies.filter((q) => q.active && q.alive).length;
    const sub = this.objective === 'intel' ? 'Upper office · main hall mezzanine' : 'Return to the breach point · south-east yard';
    this.hud.setObjective(this.objective === 'intel' ? 'Secure the drive' : 'Exfil', `${sub} · ${this.stats.kills} down`);
    if (alive === 0 && this.objective === 'exfil') this.hud.notice('Area quiet', 'No further contact', 2.5);
  }

  // ------------------------------------------------------------------ frame

  update(dt) {
    this.whizzT = Math.max(0, this.whizzT - dt);
    for (let i = this.delayed.length - 1; i >= 0; i--) {
      const ev = this.delayed[i];
      ev.t -= dt;
      if (ev.t <= 0) { this.delayed.splice(i, 1); ev.fn(); }
    }
    if (this.state === 'menu' || this.state === 'paused-menu') this.updateMenu(dt);
    else if (this.state === 'playing' || this.state === 'dead' || this.state === 'complete') this.updatePlaying(dt);
  }

  updateMenu(dt) {
    this.menuT += dt;
    const t = this.menuT;
    this.camera.position.set(6.5 + Math.sin(t * 0.04) * 3.5, 4.6 + Math.sin(t * 0.07) * 0.35, 25 - Math.sin(t * 0.03) * 1.2);
    this.camera.lookAt(-7 + Math.sin(t * 0.05) * 4, 1.6, 4);
    this.camera.fov = 55;
    this.camera.updateProjectionMatrix();
    this.aiEnabled = false;
    for (const e of this.enemies) e.update(dt);
    this.updateEnvironment(dt, false);
    this.effects.update(dt, this.camera);
    this.audio.setListener(this.camera.position, this.camera.getWorldDirection(_f), _up);
    this.pipe.render(this.scene, this.camera, null, null, dt);
  }

  updatePlaying(dt) {
    const P = this.player, W = this.weapons, I = this.input;
    this.time += dt;
    if (this.state === 'playing') this.stats.time += dt;
    // --- player
    const c = this.pctx;
    c.settings = this.settings;
    c.adsBlend = W.adsBlend;
    c.adsZoom = W.def.adsZoom;
    c.aimFriction = this.aimFriction();
    c.blockSprint = W.blockSprintT > 0 || I.isDown('ads') || W.action === 'reload';
    c.weaponMoveMul = W.def.moveMul;
    c.lowHealth = P.health < 30;
    c.firing = W.firingRecent;
    c.recoilRecover = W.def.recoil.recover;
    c.onFootstep = this._onFootstep || (this._onFootstep = (s, loud) => this.playerFootstep(s, loud));
    c.onLand = this._onLand || (this._onLand = (v, s) => this.playerLand(v, s));
    c.onJump = this._onJump || (this._onJump = () => this.audio.play('adsIn', { volume: 0.35, reverb: 0 }));
    c.pushFromEnemies = this._push || (this._push = (pos, r) => this.pushFromEnemies(pos, r));
    if (this.state !== 'playing') { I.consumeLook(); I.clearAll(); }
    P.update(dt, I, c);
    if (this.state === 'playing') W.update(dt, I, this.time);
    // --- world
    for (const e of this.enemies) e.update(dt);
    if (this.state === 'playing') {
      this.updatePickups();
      this.updateInteraction(dt);
      this.updateObjective();
    }
    // --- camera
    const vFov = this.baseVFov();
    const zoom = lerp(1, W.def.adsZoom, W.adsBlend);
    this.camera.fov = 2 * Math.atan(Math.tan((vFov * DEG) / 2) / zoom) / DEG;
    this.camera.updateProjectionMatrix();
    P.applyCamera(this.camera, W.adsBlend);
    this.camera.updateMatrixWorld();
    // --- presentation
    this.updateEnvironment(dt, true);
    const vs = W.viewState(this.viewState);
    vs.crouch = P.crouchT; vs.lookDX = P.lookDX; vs.lookDY = P.lookDY;
    vs.bobPhase = P.bobPhase; vs.bobAmount = P.bobAmount; vs.time = this.time;
    vs.fovV = lerp(56, 44, W.adsBlend);
    this.viewmodel.root.visible = P.alive;
    this.viewmodel.update(dt, this.camera, vs);
    this.effects.update(dt, this.camera);
    this.audio.setListener(this.camera.position, this.camera.getWorldDirection(_f), _up);
    this.updateHUD(dt);
    I.endFrame();
    this.pipe.render(this.scene, this.camera, P.alive ? this.viewmodel.scene : null, this.viewmodel.camera, dt);
  }

  baseVFov() {
    const h = this.settings.fov * DEG;
    return 2 * Math.atan(Math.tan(h / 2) * (9 / 16)) / DEG;
  }

  aimFriction() {
    if (this.input.lookSource !== 'touch') return 1;
    const cam = this.camera;
    cam.getWorldDirection(_f);
    for (const e of this.enemies) {
      if (!e.alive || !e.active || !e.canSee) continue;
      _v.set(e.pos.x, e.pos.y + 1.2, e.pos.z).sub(cam.position);
      const d = _v.length();
      if (d > 45) continue;
      const cosA = _v.dot(_f) / d;
      if (cosA > Math.cos(Math.max(2.5, 30 / d) * DEG)) return 0.55;
    }
    return 1;
  }

  pushFromEnemies(pos, r) {
    for (const e of this.enemies) {
      if (!e.alive || !e.active) continue;
      const dx = pos.x - e.pos.x, dz = pos.z - e.pos.z, d = Math.hypot(dx, dz), min = r + 0.3;
      if (d < min && d > 1e-4 && Math.abs(pos.y - e.pos.y) < 1.5) { pos.x += (dx / d) * (min - d); pos.z += (dz / d) * (min - d); }
    }
  }

  playerFootstep(surface, loud) {
    const name = surface === 'metal' ? 'step_metal' : surface === 'asphalt' || surface === 'dirt' ? 'step_asphalt' : surface === 'wood' ? 'step_wood' : 'step_concrete';
    this.audio.play(name, { volume: 0.12 + loud * 0.3, reverb: 0.15, rateVar: 0.08, priority: 'low', indoor: this.indoorAmt });
    const r = loud >= 1 ? 13 : loud > 0.5 ? 6.5 : 1.8;
    this.emitNoise(this.player.pos, surface === 'metal' ? r * 1.4 : r, 'footstep', true);
  }

  playerLand(v, surface) {
    const name = surface === 'metal' ? 'step_metal' : surface === 'asphalt' ? 'step_asphalt' : 'step_concrete';
    this.audio.play(name, { volume: Math.min(0.9, v * 0.15), rate: 0.8, reverb: 0.2 });
    this.viewmodel.land(Math.min(v, 7));
    if (v > 4) this.emitNoise(this.player.pos, 10, 'land', true);
  }

  updatePickups() {
    const P = this.player;
    for (const p of this.pickups) {
      if (!p.active || this.time - p.spawnT < 0.6) continue;
      if (Math.hypot(p.pos.x - P.pos.x, p.pos.z - P.pos.z) > 1.3 || Math.abs(p.pos.y - P.pos.y) > 1.2) continue;
      const A = this.weapons.ammo;
      const gains = [];
      const add = (id, n, cap, label) => {
        const room = cap - A[id].reserve;
        const k = Math.max(0, Math.min(n, room));
        if (k > 0) { A[id].reserve += k; gains.push(`+${k} ${label}`); }
      };
      add('rifle', 30, 240, WEAPONS.rifle.caliber);
      add('pistol', 10, 90, WEAPONS.pistol.caliber);
      add('shotgun', 4, 40, WEAPONS.shotgun.caliber);
      if (!gains.length) continue;
      p.active = false;
      p.mesh.visible = false;
      this.audio.play('pickup', { volume: 0.7, reverb: 0.1 });
      this.hud.notice('Ammunition', gains.join('  ·  '), 1.8);
      this.hudDirty = true;
    }
  }

  updateInteraction(dt) {
    const P = this.player, I = this.input, eye = P.eyePosition(_v);
    let target = null, text = '', hold = 1.6;
    this.camera.getWorldDirection(_f);
    const check = (pos, r) => {
      const dx = pos.x - eye.x, dy = pos.y - eye.y, dz = pos.z - eye.z, d = Math.hypot(dx, dy, dz);
      if (d > r || Math.abs(pos.y - P.pos.y) > 1.6) return false;
      return (dx * _f.x + dy * _f.y + dz * _f.z) / d > 0.35 || d < 0.9;
    };
    const touch = this.input.isTouch;
    if (this.objective === 'intel') {
      const it = LEVEL_INFO.intel;
      if (check(_w.set(it.x, it.y, it.z), it.r)) { target = 'intel'; text = touch ? 'Hold USE — secure drive' : 'Hold to secure drive'; hold = 2.0; }
    }
    if (!target && P.health < 100) {
      for (const m of this.medkits) {
        if (m.active && check(m.pos, 1.7)) { target = m; text = touch ? 'Hold USE — use medkit' : 'Hold to use medkit'; hold = 1.3; break; }
      }
    }
    const holding = I.isDown('interact');
    if (target && holding) {
      this.interactProgress += dt / hold;
      if (this.interactProgress >= 1) {
        this.interactProgress = 0;
        if (target === 'intel') this.secureIntel();
        else {
          target.active = false;
          target.mesh.visible = false;
          P.heal(50);
          this.audio.play('medkit', { volume: 0.8, reverb: 0.1 });
          this.hud.notice('Treated wounds', '+50 health', 1.8);
          this.hudDirty = true;
        }
      }
    } else this.interactProgress = Math.max(0, this.interactProgress - dt * 3);
    this.hud.interact(!!target, text, this.interactProgress);
  }

  updateObjective() {
    const P = this.player;
    if (!this.enteredBuilding && isIndoors(P.pos.x, P.pos.y, P.pos.z)) {
      this.enteredBuilding = true;
      this.audio.play('pigeons', { pos: { x: P.pos.x - 6, y: 6.5, z: P.pos.z - 8 }, volume: 0.6, ref: 6, reverb: 0.8 });
    }
    if (this.objective === 'exfil') {
      const E = LEVEL_INFO.exfil;
      if (Math.hypot(P.pos.x - E.x, P.pos.z - E.z) < E.r && P.alive) this.completeMission();
    }
  }

  updateEnvironment(dt, playing) {
    const cam = this.camera.position;
    const indoor = isIndoors(cam.x, cam.y, cam.z) ? 1 : 0;
    this.indoorAmt = damp(this.indoorAmt, indoor, 2.2, dt);
    this.audio.setIndoor(this.indoorAmt);
    const amb = ambientAt(cam);
    // sun visibility test for the view model
    this.sunCheckT -= dt;
    if (this.sunCheckT <= 0) {
      this.sunCheckT = 0.1;
      this.sunVis = this.computeSunVis(cam) ? 1 : 0;
    }
    this.sunVisS = damp(this.sunVisS ?? 1, this.sunVis, 8, dt);
    const target = clamp(1.02 / (0.28 + 0.72 * amb), 1, 2.4) * (0.94 + this.sunVisS * 0.06);
    this.exposure = damp(this.exposure, target, target > this.exposure ? 0.9 : 2.2, dt);
    this.pipe.exposure = this.exposure;
    // flickering corridor tube
    let buzz = 0;
    for (const L of this.lights.list) {
      if (!L.flicker) continue;
      L.ft = (L.ft ?? 0) - dt;
      if (L.ft <= 0) { L.on = Math.random() < (L.on ? 0.15 : 0.7) ? !L.on : L.on; L.ft = L.on ? rand(0.3, 3) : rand(0.03, 0.15); }
      const k = L.on ? 1 : 0.05;
      L.light.intensity = L.base * k * (0.92 + Math.random() * 0.08);
      buzz = k;
    }
    this.audio.updateAmbience(dt, this.time + (this.menuT || 0), buzz);
    const u = this.shafts.material.uniforms;
    u.uTime.value += dt;
    if (this.dust) {
      this.dust.material.uniforms.uTime.value += dt;
      this.dust.material.uniforms.uScale.value = this.pipe.height || 800;
    }
    const pxScale = (this.pipe.height || 800) / (2 * Math.tan((this.camera.fov * DEG) / 2));
    this.effects.setScale(pxScale);
    if (!playing) return;
    // view model lighting follows the environment
    let bestL = null, bestS = 0;
    for (const L of this.lights.list) {
      const l = L.light;
      if (!l.visible) continue;
      const d2 = l.position.distanceToSquared(cam);
      if (d2 > 225) continue;
      const s = l.intensity / Math.max(1, d2);
      if (s > bestS) { bestS = s; bestL = l; }
    }
    this.viewmodel.syncLighting(amb, this.sunVisS, SUN_DIR, this.lights.sun.intensity, this.lights.hemi, bestL, cam);
    // low health presentation
    const P = this.player;
    const low = clamp((45 - P.health) / 45, 0, 1);
    this.pipe.fx.desat = low * 0.85;
    this.pipe.fx.damage = Math.min(1, (this.hud.dmgLevel || 0) * 0.55 + low * 0.25);
    this.pipe.fx.flash = Math.max(0, this.pipe.fx.flash - dt * 0.3);
    this.audio.setMuffle(P.alive ? low * 0.55 : 0.8);
    if (P.alive && P.health < 30) {
      this.heartT -= dt;
      if (this.heartT <= 0) { this.heartT = 0.95; this.audio.play('heart', { volume: 0.5 * (1 - P.health / 40), reverb: 0 }); }
    }
  }

  computeSunVis(p) {
    const S = SUN_DIR, P = this.physics;
    if (isIndoors(p.x, p.y, p.z)) {
      const tRoof = (7.45 - p.y) / S.y;
      if (P.raycast(p.x, p.y, p.z, S.x, S.y, S.z, tRoof, 'sight')) return false;
      const x = p.x + S.x * tRoof, z = p.z + S.z * tRoof;
      return !(x > BUILDING.minX && x < BUILDING.maxX && z > BUILDING.minZ && z < BUILDING.maxZ);
    }
    return !P.raycast(p.x, p.y, p.z, S.x, S.y, S.z, 60, 'sight');
  }

  updateHUD(dt) {
    const P = this.player, W = this.weapons, H = this.hud;
    H.setHealth(P.health);
    if (this.hudDirty) { H.setWeapon(W.def, W.state); this.hudDirty = false; }
    const vis = (1 - W.adsBlend) * (1 - W.sprintBlend * 0.9) * (1 - W.lower) * (P.alive ? 1 : 0) * (W.action === 'reload' || W.action === 'sgReload' ? 0.35 : 1);
    H.crosshair(vis, 4 + Math.min(10, W.currentSpread() * 1.6));
    const obj = this.objectiveTarget();
    this.mmT = (this.mmT || 0) - dt;
    if (this.mmT <= 0) { this.mmT = 1 / 30; H.updateMinimap(P, obj, 1 / 30); }
    const near = obj && Math.hypot(obj.x - P.pos.x, obj.z - P.pos.z) < 3;
    H.updateMarker(obj, this.camera, this.state === 'playing' && !near);
  }

  onResize() {
    if (!this.camera) return;
    this.camera.aspect = (this.pipe.forceW || window.innerWidth) / (this.pipe.forceH || window.innerHeight);
    this.camera.updateProjectionMatrix();
    this.pipe.resize();
  }
}

function raySphere(o, d, cx, cy, cz, r) {
  const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : null;
}
