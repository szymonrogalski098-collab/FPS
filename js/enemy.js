// Enemy soldier: perception (sight + hearing), tactical state machine (patrol → investigate → combat
// with cover / peek / reposition / advance → search), burst fire with human-like aim error,
// procedural locomotion, IK arms, hit reactions and a physically-plausible collapse on death.
import * as THREE from 'three';
import { ENEMY_PROFILES, DIFFICULTY, PLAYER } from './config.js';
import { createSoldier, solveArm } from './enemyModel.js';
import { ambientAt } from './materials.js';
import { isIndoors } from './level.js';
import { clamp, damp, lerp, rand, randInt, angleDiff, gaussian, DEG, Spring, easeInQuad, choice } from './util.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion();
const POLE_R = new THREE.Vector3(-0.6, -1, -0.3), POLE_L = new THREE.Vector3(0.7, -1, -0.2);
const GRIP = new THREE.Vector3(0, -0.035, 0.02), HANDGUARD = new THREE.Vector3(0, 0.0, -0.22), MUZZLE = new THREE.Vector3(0, 0.035, -0.63);
const HIT_SPHERES = [
  ['head', 'head', 0.07, 0.125], ['chest', 'torso', 0.1, 0.2], ['spine', 'torso', 0.06, 0.18], ['hips', 'torso', 0, 0.17],
  ['thighL', 'limb', -0.2, 0.095], ['thighR', 'limb', -0.2, 0.095], ['shinL', 'limb', -0.2, 0.075], ['shinR', 'limb', -0.2, 0.075],
  ['upperArmL', 'limb', -0.14, 0.065], ['upperArmR', 'limb', -0.14, 0.065], ['forearmL', 'limb', -0.13, 0.058], ['forearmR', 'limb', -0.13, 0.058],
];

let uid = 0;

export class Enemy {
  constructor(game, def) {
    this.game = game;
    this.def = def;
    this.id = uid++;
    this.profile = ENEMY_PROFILES[def.profile];
    const model = createSoldier(game.M._textures, this.profile);
    this.model = model;
    this.B = model.bones;
    this.object = new THREE.Group();
    this.body = new THREE.Group();
    this.body.add(model.mesh);
    this.object.add(this.body);
    game.scene.add(this.object);
    this.pos = this.object.position;
    this.vel = new THREE.Vector3();
    this.lastKnown = new THREE.Vector3();
    this.noisePos = new THREE.Vector3();
    this.flinchX = new Spring(90, 9);
    this.flinchZ = new Spring(90, 9);
    this.recoilZ = new Spring(250, 20);
    this.tmpHit = { t: 0, zone: '', point: new THREE.Vector3() };
    this.floorOut = { y: 0, surface: 'concrete' };
    this.reset(def);
  }

  reset(def = this.def) {
    this.def = def;
    this.active = !def.reinforcement;
    this.object.visible = this.active;
    this.pos.set(def.pos[0], def.pos[1], def.pos[2]);
    this.vel.set(0, 0, 0);
    this.yaw = def.yaw ?? 0;
    this.aimYaw = this.yaw;
    this.aimPitch = 0;
    this.headYaw = 0;
    this.health = this.profile.hp;
    this.alive = true;
    this.state = def.mode === 'patrol' ? 'patrol' : 'idle';
    this.sub = null;
    this.subT = 0;
    this.awareness = 0;
    this.canSee = false;
    this.lastSeen = -100;
    this.hasContact = false;
    this.path = null;
    this.pathIdx = 0;
    this.pathGoal = null;
    this.repathT = 0;
    this.moveSpeed = 0;
    this.speed = 0;
    this.routeIdx = 0;
    this.waitT = rand(1, 3);
    this.crouch = 0;
    this.wantCrouch = false;
    this.ready = 0;
    this.gait = Math.random() * 6;
    this.thinkT = Math.random() * 0.12;
    this.visT = 0;
    this.mag = 30;
    this.reloadT = 0;
    this.burstLeft = 0;
    this.burstGap = 0;
    this.fireCD = 0;
    this.reaction = 0;
    this.settle = 1;
    this.cover = null;
    this.peekPos = null;
    this.suppressedT = 0;
    this.lastHurt = -100;
    this.voiceCD = 0;
    this.stuckT = 0;
    this.lastProgress = new THREE.Vector3().copy(this.pos);
    this.shots = 0;
    this.deathT = 0;
    this.fall = null;
    this.token = false;
    this.lookAroundT = rand(0, 10);
    this.body.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
    this.model.mesh.skeleton.bones.forEach((b, i) => { b.position.copy(this.model.rest[i]); b.quaternion.identity(); });
    if (this.droppedRifle) { this.game.scene.remove(this.droppedRifle.mesh); this.droppedRifle = null; }
    if (this.model.rifle.parent !== this.model.holder) { this.model.holder.add(this.model.rifle); }
    this.model.rifle.position.set(0, 0, 0);
    this.model.rifle.rotation.set(0, Math.PI, 0);
    this.model.rifle.scale.set(1, 1, 1);
    this.model.rifle.updateMatrix();
    this.object.rotation.set(0, this.yaw, 0);
    this.hideT = 1;
    this.peekShots = 0;
    this.investigatePhase = 'turn';
    this.lookTarget = null;
    this.snapToFloor();
    this.animate(0);
  }

  get diff() { return DIFFICULTY[this.game.settings.difficulty] || DIFFICULTY.regular; }
  get eyeHeight() { return lerp(1.62, 1.02, this.crouch); }

  eye(out) { return out.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z); }

  /** Called when the drive is taken: reinforcements enter hunting the player. */
  activate(knownPos) {
    this.active = true;
    this.object.visible = true;
    this.awareness = 0.95;
    this.lastKnown.copy(knownPos);
    this.lastSeen = this.game.time - 3;
    this.enterCombat(false);
    this.sub = 'advance';
    this.subT = 0;
  }

  // ------------------------------------------------------------------ main update

  update(dt) {
    if (!this.active) return;
    if (!this.alive) { this.updateDeath(dt); return; }
    const g = this.game;
    this.voiceCD -= dt;
    this.suppressedT = Math.max(0, this.suppressedT - dt);
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      const step = 0.12;
      this.thinkT += step;
      this.perceive(step);
      this.think(step);
    }
    this.updateMovement(dt);
    this.updateAim(dt);
    this.updateWeapon(dt);
    this.animate(dt);
  }

  // ------------------------------------------------------------------ perception

  perceive(dt) {
    const g = this.game, P = g.player;
    this.canSee = false;
    if (!g.aiEnabled) return;
    if (!P.alive) { this.awareness = Math.max(0, this.awareness - dt * 0.2); return; }
    const eye = this.eye(_a);
    const pe = P.eyePosition(_b);
    const dx = pe.x - eye.x, dz = pe.z - eye.z, dy = pe.y - eye.y;
    const dist = Math.hypot(dx, dy, dz);
    const combat = this.state === 'combat';
    if (dist > 60) { this.decayAwareness(dt); return; }
    const facing = this.state === 'combat' ? this.aimYaw : this.yaw + this.headYaw;
    const ang = Math.abs(angleDiff(facing, Math.atan2(dx, dz)));
    const fovHalf = (combat ? 170 : this.profile.fov) * 0.5 * DEG;
    const close = dist < 2.2;
    if (ang > fovHalf && !close) { this.decayAwareness(dt); return; }
    let los = g.physics.clearLine(eye.x, eye.y, eye.z, pe.x, pe.y - 0.05, pe.z, 'sight');
    if (!los) los = g.physics.clearLine(eye.x, eye.y, eye.z, P.pos.x, P.pos.y + P.height * 0.55, P.pos.z, 'sight');
    if (!los) { this.decayAwareness(dt); return; }
    this.canSee = true;
    let rate = this.profile.detectRate * this.diff.detect;
    rate *= clamp(2.0 - dist / 18, 0.18, 2.0);
    if (P.crouching) rate *= 0.55;
    rate *= P.speed > 3.8 ? 1.6 : P.speed > 0.5 ? 1.0 : 0.6;
    if (g.time - g.weapons.lastShot < 0.6) rate *= 3;
    rate *= 0.4 + 0.6 * clamp(ambientAt(P.pos) * 1.4, 0, 1);
    if (ang > 50 * DEG) rate *= 0.45;
    if (combat) rate *= 4;
    if (close) rate = 10;
    this.awareness = Math.min(1.3, this.awareness + rate * dt * 1.1);
    if (this.awareness >= 1) {
      this.lastKnown.copy(P.pos);
      this.lastSeen = g.time;
      if (!combat) this.enterCombat(true);
    } else if (this.awareness > 0.3 && (this.state === 'idle' || this.state === 'patrol')) {
      this.state = 'suspicious';
      this.subT = 0;
      this.noisePos.copy(P.pos);
      this.stopMoving();
    }
    if (this.state === 'suspicious') this.noisePos.copy(P.pos);
  }

  decayAwareness(dt) {
    if (this.state !== 'combat') this.awareness = Math.max(0, this.awareness - dt * 0.06);
  }

  hearNoise(pos, radius, type, fromPlayer) {
    if (!this.alive || !this.active || !this.game.aiEnabled) return;
    const d = this.pos.distanceTo(pos);
    if (d > radius) return;
    const g = this.game;
    const occluded = !g.physics.clearLine(this.pos.x, this.pos.y + 1.6, this.pos.z, pos.x, pos.y + 1, pos.z, 'sight');
    if (occluded && d > radius * 0.6) return;
    const err = Math.min(4, d * 0.12);
    const est = _w.set(pos.x + rand(-err, err), pos.y, pos.z + rand(-err, err));
    if (type === 'gunshot' || type === 'impact') {
      this.awareness = Math.max(this.awareness, d < radius * 0.55 || type === 'impact' ? 1.0 : 0.75);
      if (this.state === 'combat') {
        if (!this.canSee) { this.lastKnown.copy(est); this.lastSeen = Math.max(this.lastSeen, g.time - 2); }
      } else if (this.awareness >= 1) {
        this.lastKnown.copy(est);
        this.lastSeen = g.time - 1.5;
        this.enterCombat(false);
      } else {
        this.startInvestigate(est, true);
      }
    } else {
      const add = type === 'land' ? 0.45 : type === 'reload' ? 0.35 : 0.28;
      this.awareness = Math.min(0.95, this.awareness + add * (1 - d / radius));
      if (this.state === 'combat') {
        if (!this.canSee && d < radius * 0.7) { this.lastKnown.copy(est); }
      } else if (this.state !== 'investigate' && this.awareness > 0.25) {
        this.startInvestigate(est, false);
      }
    }
  }

  /** A player round passed close by or hit something near us. */
  onNearMiss(shooterPos) {
    if (!this.alive || !this.active) return;
    this.suppressedT = 1.2;
    this.flinchX.impulse(rand(-2, 2));
    this.awareness = 1.1;
    if (this.state !== 'combat') {
      this.lastKnown.copy(shooterPos);
      this.lastSeen = this.game.time - 0.5;
      this.enterCombat(false);
    } else if (!this.canSee) {
      this.lastKnown.lerp(shooterPos, 0.6);
    }
    if ((this.sub === 'peek' || this.sub === 'engage') && Math.random() < 0.55) this.seekCover(true);
  }

  // ------------------------------------------------------------------ decision making

  enterCombat(spotted) {
    const g = this.game;
    const wasCombat = this.state === 'combat';
    this.state = 'combat';
    this.awareness = Math.max(this.awareness, 1);
    this.reaction = rand(...this.profile.reaction) * this.diff.reaction;
    this.settle = 1;
    if (!wasCombat) {
      if (spotted) g.alertAllies(this, this.lastKnown);
      this.say('chatter', 0.8);
      if (this.def.stationary) this.sub = 'engage';
      else if (!this.seekCover(false)) this.sub = 'engage';
      this.subT = 0;
    }
  }

  startInvestigate(pos, urgent) {
    this.state = 'investigate';
    this.noisePos.copy(pos);
    this.subT = 0;
    this.investigateUrgent = urgent;
    this.investigatePhase = 'turn';
    this.stopMoving();
  }

  think(dt) {
    this.subT += dt;
    switch (this.state) {
      case 'idle': this.thinkIdle(dt); break;
      case 'patrol': this.thinkPatrol(dt); break;
      case 'suspicious': this.thinkSuspicious(dt); break;
      case 'investigate': this.thinkInvestigate(dt); break;
      case 'combat': this.thinkCombat(dt); break;
      case 'search': this.thinkSearch(dt); break;
    }
  }

  thinkIdle(dt) {
    this.wantCrouch = false;
    this.moveSpeed = 0;
  }

  thinkPatrol(dt) {
    this.wantCrouch = false;
    const route = this.def.route;
    if (!route) { this.state = 'idle'; return; }
    if (!this.path) {
      this.waitT -= dt;
      if (this.waitT > 0) return;
      this.routeIdx = (this.routeIdx + 1) % route.length;
      const [x, z] = route[this.routeIdx];
      this.goTo(_v.set(x, this.pos.y, z), 1.35);
      this.waitT = rand(1.5, 4.5);
    }
  }

  thinkSuspicious(dt) {
    this.stopMoving();
    this.lookAt(this.noisePos, 2.5);
    if (this.awareness < 0.15) { this.returnToDuty(); return; }
    if (this.subT > 2.5 && this.awareness > 0.35) this.startInvestigate(this.noisePos, false);
  }

  thinkInvestigate(dt) {
    this.ready = 1;
    if (this.investigatePhase === 'turn') {
      this.lookAt(this.noisePos, 3);
      if (this.subT > (this.investigateUrgent ? 0.4 : 1.2)) {
        this.investigatePhase = 'move';
        if (this.def.stationary) { this.investigatePhase = 'look'; this.subT = 0; return; }
        this.goTo(this.noisePos, this.investigateUrgent ? 2.4 : 1.7);
      }
    } else if (this.investigatePhase === 'move') {
      if (!this.path || this.pos.distanceTo(this.noisePos) < 1.5) { this.stopMoving(); this.investigatePhase = 'look'; this.subT = 0; }
    } else {
      this.lookAround();
      if (this.subT > 6) { this.awareness = Math.min(this.awareness, 0.2); this.returnToDuty(); }
    }
  }

  thinkSearch(dt) {
    this.ready = 1;
    if (this.game.time - this.lastSeen > 40) { this.returnToDuty(); return; }
    if (!this.path) {
      this.waitT -= dt;
      this.lookAround();
      if (this.waitT <= 0) {
        const p = this.game.nav.randomNear(this.lastKnown.x, this.lastKnown.y, this.lastKnown.z, 8);
        if (p && !this.def.stationary) this.goTo(_v.set(p.x, p.y, p.z), 1.8);
        this.waitT = rand(2, 4);
      }
    }
  }

  returnToDuty() {
    this.state = this.def.route ? 'patrol' : 'idle';
    this.sub = null;
    this.releaseCover();
    this.releaseToken();
    if (!this.def.route && !this.def.stationary) this.goTo(_v.set(this.def.pos[0], this.def.pos[1], this.def.pos[2]), 1.4);
  }

  thinkCombat(dt) {
    const g = this.game, P = g.player;
    const since = g.time - this.lastSeen;
    if (!P.alive) { this.state = 'search'; this.stopMoving(); return; }
    if (since > 14 && !this.canSee) {
      this.state = 'search';
      this.sub = null;
      this.releaseCover();
      this.releaseToken();
      this.waitT = 0;
      return;
    }
    const distP = this.pos.distanceTo(P.pos);
    // too close: back off while firing
    if (this.canSee && distP < 3.2 && !this.def.stationary && this.sub !== 'toCover' && Math.random() < 0.3) {
      this.seekCover(true, 6);
    }
    switch (this.sub) {
      case 'engage': {
        this.wantCrouch = this.def.stationary ? this.cover !== null || this.subT % 6 > 3 : this.crouchPreference();
        this.stopMoving();
        if (this.canSee) this.lookAt(P.pos, 6);
        else this.lookAt(this.lastKnown, 4);
        const exposedFor = this.subT;
        if (!this.canSee && since > 1.6) { this.reposition(); break; }
        if (!this.def.stationary && (exposedFor > rand(2.5, 4.5) || g.time - this.lastHurt < 0.3)) {
          if (!this.seekCover(true)) this.subT = 0;
        }
        break;
      }
      case 'toCover': {
        this.wantCrouch = false;
        if (!this.path) {
          this.sub = 'cover';
          this.subT = 0;
          this.hideT = rand(0.9, 2.1) * (this.reloadT > 0 ? 1.4 : 1);
        } else if (this.cover && this.subT > 1 && this.coverCompromised()) {
          this.seekCover(true);
        }
        break;
      }
      case 'cover': {
        this.stopMoving();
        this.wantCrouch = this.cover ? this.cover.low : false;
        this.lookAt(this.lastKnown, 4);
        if (this.cover && this.coverCompromised()) { if (!this.seekCover(true)) { this.sub = 'engage'; this.subT = 0; } break; }
        if (this.reloadT > 0) break;
        if (this.subT > this.hideT) this.startPeek();
        break;
      }
      case 'peek': {
        if (this.cover && this.cover.low) this.wantCrouch = false;
        this.lookAt(this.canSee ? P.pos : this.lastKnown, 6);
        if (this.canSee) this.peekSawT = g.time;
        const burstDone = this.peekShots > 0 && this.burstLeft <= 0 && this.burstGap > 0.1;
        if (burstDone || this.subT > 3.2 || this.reloadT > 0) this.backToCover();
        else if (!this.canSee && this.subT > 1.3) {
          if (since > 4.5) this.reposition(); else this.backToCover();
        }
        break;
      }
      case 'advance': {
        this.wantCrouch = false;
        if (this.canSee) { this.releaseToken(); this.sub = 'engage'; this.subT = 0; this.stopMoving(); break; }
        if (!this.path) {
          if (this.pos.distanceTo(this.lastKnown) < 2.5 || this.subT > 10) {
            this.releaseToken();
            this.state = 'search';
            this.waitT = 1;
          } else this.goTo(this.lastKnown, 2.8);
        }
        break;
      }
      default:
        this.sub = 'engage';
        this.subT = 0;
    }
  }

  crouchPreference() {
    return this.profile.aggression < 0.6 ? this.subT % 5 > 2 : false;
  }

  coverCompromised() {
    const c = this.cover, g = this.game;
    if (!c) return false;
    const P = g.player;
    const tx = P.pos.x - c.x, tz = P.pos.z - c.z, tl = Math.hypot(tx, tz) || 1;
    if ((c.nx * tx + c.nz * tz) / tl < 0.1) return true;
    const pe = P.eyePosition(_b);
    const hy = c.y + (c.low ? 0.95 : 1.5);
    return this.canSee && this.sub === 'cover' && g.physics.clearLine(pe.x, pe.y, pe.z, c.x, hy, c.z, 'sight');
  }

  startPeek() {
    this.sub = 'peek';
    this.subT = 0;
    this.peekShots = 0;
    this.burstLeft = 0;
    this.burstGap = 0;
    if (this.cover && !this.cover.low && this.peekPos) this.goTo(this.peekPos, 2.2);
  }

  backToCover() {
    this.sub = 'cover';
    this.subT = 0;
    this.hideT = rand(1.1, 2.4);
    if (this.cover && !this.cover.low) this.goTo(_v.set(this.cover.x, this.cover.y, this.cover.z), 2.2);
  }

  reposition() {
    if (this.def.stationary) { this.sub = 'engage'; this.subT = 0; return; }
    const g = this.game;
    if (this.seekCover(false, 16, true)) return;
    if (g.requestToken(this)) {
      this.releaseCover();
      this.sub = 'advance';
      this.subT = 0;
      this.goTo(this.flankPoint(), 2.8);
    } else {
      this.sub = 'cover';
      this.subT = 0;
      this.hideT = rand(2, 4);
    }
  }

  flankPoint() {
    // approach the last known position from an angle rather than head-on
    const dx = this.lastKnown.x - this.pos.x, dz = this.lastKnown.z - this.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const side = (this.id % 2 ? 1 : -1) * Math.min(4, d * 0.35);
    _w.set(this.lastKnown.x - (dx / d) * 2 + (-dz / d) * side, this.lastKnown.y, this.lastKnown.z - (dz / d) * 2 + (dx / d) * side);
    const n = this.game.nav.nearestNode(_w.x, _w.y, _w.z, 5);
    if (n >= 0) return _w.set(this.game.nav.x[n], this.game.nav.y[n], this.game.nav.z[n]);
    return this.lastKnown;
  }

  /** Picks the best reachable cover spot relative to the threat. */
  seekCover(urgent, maxDist = 15, wantLos = false) {
    if (this.def.stationary) {
      // stationary marksmen only use cover at their post
      return false;
    }
    const g = this.game, nav = g.nav, P = g.player;
    const threat = this.state === 'combat' && this.canSee ? P.pos : this.lastKnown;
    const te = _a.set(threat.x, threat.y + 1.55, threat.z);
    const cands = [];
    for (const c of nav.cover) {
      if (c.owner && c.owner !== this) continue;
      if (Math.abs(c.y - this.pos.y) > 3.5) continue;
      const d = Math.hypot(c.x - this.pos.x, c.z - this.pos.z);
      if (d > maxDist) continue;
      const tx = threat.x - c.x, tz = threat.z - c.z, tl = Math.hypot(tx, tz);
      if (tl < 4.5) continue;
      if ((c.nx * tx + c.nz * tz) / tl < 0.3) continue;
      // don't run toward the threat to reach cover
      const vx = c.x - this.pos.x, vz = c.z - this.pos.z;
      const toward = (vx * (threat.x - this.pos.x) + vz * (threat.z - this.pos.z)) / ((Math.hypot(vx, vz) || 1) * (Math.hypot(threat.x - this.pos.x, threat.z - this.pos.z) || 1));
      if (urgent && toward > 0.7 && d > 3) continue;
      cands.push({ c, d, tl });
    }
    cands.sort((p, q) => p.d - q.d);
    let best = null, bestScore = -Infinity;
    for (const { c, d, tl } of cands.slice(0, 26)) {
      const hy = c.y + (c.low ? 0.95 : 1.5);
      if (g.physics.clearLine(te.x, te.y, te.z, c.x, hy, c.z, 'sight')) continue;
      let peek = null;
      if (c.low) {
        if (g.physics.clearLine(c.x, c.y + 1.6, c.z, te.x, te.y - 0.4, te.z, 'sight')) peek = true;
      } else {
        for (const s of [1, -1]) {
          const px = c.x + -c.nz * s * 0.85, pz = c.z + c.nx * s * 0.85;
          const n = nav.nearestNode(px, c.y, pz, 1);
          if (n < 0 || Math.hypot(nav.x[n] - px, nav.z[n] - pz) > 0.4) continue;
          if (g.physics.clearLine(px, c.y + 1.6, pz, te.x, te.y - 0.4, te.z, 'sight')) { peek = { x: nav.x[n], y: nav.y[n], z: nav.z[n] }; break; }
        }
      }
      if (wantLos && !peek) continue;
      let score = -d * (urgent ? 1.3 : 0.8) - Math.abs(tl - 11) * 0.3 + (peek ? 3.5 : -1) + (c.low ? 0.4 : 0) + Math.random() * 0.8;
      for (const e of g.enemies) if (e !== this && e.alive && Math.hypot(e.pos.x - c.x, e.pos.z - c.z) < 2.2) score -= 2.5;
      if (score > bestScore) { bestScore = score; best = { c, peek }; }
    }
    if (!best) return false;
    const ok = this.goTo(_v.set(best.c.x, best.c.y, best.c.z), urgent ? 3.9 : 3.0);
    if (!ok) return false;
    this.releaseCover();
    this.releaseToken();
    this.cover = best.c;
    best.c.owner = this;
    this.peekPos = best.peek && best.peek !== true ? best.peek : null;
    this.sub = 'toCover';
    this.subT = 0;
    return true;
  }

  releaseCover() {
    if (this.cover && this.cover.owner === this) this.cover.owner = null;
    this.cover = null;
    this.peekPos = null;
  }

  releaseToken() { if (this.token) this.game.releaseToken(this); }

  lookAt(p, rate) {
    this.lookTarget = p;
    this.lookRate = rate;
  }

  lookAround() {
    this.lookTarget = null;
    this.lookAroundT += 0.12;
    this.headYaw = Math.sin(this.lookAroundT * 0.9) * 0.9;
  }

  say(name, vol = 1) {
    if (this.voiceCD > 0) return;
    this.voiceCD = rand(3, 6);
    this.game.audio.play(name, { pos: this.headPos(_w), volume: 0.55 * vol, ref: 2.5, reverb: 0.4, indoor: isIndoors(this.pos.x, this.pos.y, this.pos.z) ? 1 : 0, occluded: !this.visibleToListener() });
  }

  headPos(out) { return out.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z); }

  visibleToListener() {
    const c = this.game.camera.position;
    return this.game.physics.clearLine(c.x, c.y, c.z, this.pos.x, this.pos.y + 1.4, this.pos.z, 'sight');
  }

  // ------------------------------------------------------------------ movement

  goTo(target, speed) {
    const g = this.game;
    const path = g.nav.findPath(this.pos, target);
    if (!path || !path.length) return false;
    this.path = path;
    this.pathIdx = path.length > 1 ? 1 : 0;
    this.moveSpeed = speed;
    this.stuckT = 0;
    this.lastProgress.copy(this.pos);
    return true;
  }

  stopMoving() {
    this.path = null;
    this.moveSpeed = 0;
  }

  snapToFloor() {
    const f = this.game.physics.floorAt(this.pos.x, this.pos.z, this.pos.y + 0.5, this.floorOut);
    this.pos.y = f.y;
    this.surface = f.surface;
  }

  updateMovement(dt) {
    const g = this.game;
    let tvx = 0, tvz = 0;
    if (this.path) {
      const p = this.path[this.pathIdx];
      const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.35) {
        this.pathIdx++;
        if (this.pathIdx >= this.path.length) { this.path = null; }
      } else {
        const sp = this.moveSpeed * (this.crouch > 0.5 ? 0.5 : 1) * (this.suppressedT > 0 ? 0.85 : 1);
        tvx = (dx / d) * sp; tvz = (dz / d) * sp;
      }
      // stuck detection
      this.stuckT += dt;
      if (this.stuckT > 1.2) {
        if (this.pos.distanceTo(this.lastProgress) < 0.25 && this.path) {
          const goal = this.path[this.path.length - 1];
          if (!this.goTo(_v.set(goal.x, goal.y, goal.z), this.moveSpeed)) this.stopMoving();
          this.pathIdx = Math.min(this.pathIdx + 1, (this.path ? this.path.length - 1 : 0));
        }
        this.stuckT = 0;
        this.lastProgress.copy(this.pos);
      }
    }
    this.vel.x = damp(this.vel.x, tvx, 7, dt);
    this.vel.z = damp(this.vel.z, tvz, 7, dt);
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    // separation from other soldiers and the player
    for (const e of g.enemies) {
      if (e === this || !e.alive || !e.active) continue;
      const dx = this.pos.x - e.pos.x, dz = this.pos.z - e.pos.z, d = Math.hypot(dx, dz);
      if (d < 0.65 && d > 1e-4 && Math.abs(this.pos.y - e.pos.y) < 1.5) { const k = (0.65 - d) * 0.5; this.pos.x += (dx / d) * k; this.pos.z += (dz / d) * k; }
    }
    const P = g.player;
    const pdx = this.pos.x - P.pos.x, pdz = this.pos.z - P.pos.z, pd = Math.hypot(pdx, pdz);
    if (pd < 0.62 && pd > 1e-4 && Math.abs(this.pos.y - P.pos.y) < 1.5) { const k = 0.62 - pd; this.pos.x += (pdx / pd) * k; this.pos.z += (pdz / pd) * k; }
    g.physics.resolveCircle(this.pos, 0.3, 1.7, 0.45);
    const f = g.physics.floorAt(this.pos.x, this.pos.z, this.pos.y + 0.5, this.floorOut);
    this.pos.y = damp(this.pos.y, f.y, 18, dt);
    this.surface = f.surface;
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    // body facing: towards travel direction unless engaged
    let targetYaw = this.yaw;
    if (this.speed > 0.3) targetYaw = Math.atan2(this.vel.x, this.vel.z);
    const engaged = this.state === 'combat' || this.state === 'suspicious' || (this.state === 'investigate' && this.investigatePhase !== 'move');
    if (engaged && this.lookTarget && this.speed < 0.3) targetYaw = Math.atan2(this.lookTarget.x - this.pos.x, this.lookTarget.z - this.pos.z);
    this.yaw += clamp(angleDiff(this.yaw, targetYaw), -dt * 4.5, dt * 4.5);
    this.object.rotation.y = this.yaw;
    // footsteps
    if (this.speed > 0.5) {
      const before = Math.floor(this.gait / Math.PI);
      this.gait += (this.speed * dt / 1.25) * Math.PI;
      if (Math.floor(this.gait / Math.PI) !== before) this.footstep();
    }
  }

  footstep() {
    const g = this.game;
    const loud = this.speed > 3 ? 1 : 0.55;
    const d = this.pos.distanceTo(g.player.pos);
    if (d > 32) return;
    const s = this.surface === 'asphalt' ? 'step_asphalt' : this.surface === 'metal' ? 'step_metal' : this.surface === 'wood' ? 'step_wood' : 'step_concrete';
    g.audio.play(s, { pos: this.pos, volume: 0.55 * loud, ref: 3, rolloff: 1.3, reverb: 0.25, priority: 'low', indoor: isIndoors(this.pos.x, this.pos.y, this.pos.z) ? 1 : 0, occluded: d > 6 && !this.visibleToListener() });
  }

  // ------------------------------------------------------------------ aiming & shooting

  updateAim(dt) {
    const g = this.game, P = g.player;
    let tYaw = this.yaw + this.headYaw * 0.6, tPitch = 0;
    if (this.state !== 'idle' && this.state !== 'patrol') this.headYaw = damp(this.headYaw, 0, 3, dt);
    else if (this.state === 'idle') { this.lookAroundT += dt; this.headYaw = Math.sin(this.lookAroundT * 0.35) * 0.55 + Math.sin(this.lookAroundT * 0.13) * 0.3; }
    else this.headYaw = damp(this.headYaw, 0, 2, dt);
    const tgt = this.state === 'combat' && this.canSee ? P.pos : this.lookTarget;
    if (tgt) {
      const eye = this.eye(_a);
      const ty = tgt === P.pos ? P.pos.y + P.height * 0.7 : tgt.y + 1.2;
      const dx = tgt.x - eye.x, dz = tgt.z - eye.z;
      tYaw = Math.atan2(dx, dz);
      tPitch = Math.atan2(ty - eye.y, Math.hypot(dx, dz));
    }
    const rate = this.state === 'combat' ? 5.5 : 2.5;
    this.aimYaw += clamp(angleDiff(this.aimYaw, tYaw), -dt * rate, dt * rate);
    this.aimPitch = damp(this.aimPitch, clamp(tPitch, -0.8, 0.8), 6, dt);
    // aim settles while tracking a visible target
    if (this.canSee && this.state === 'combat') this.settle = Math.max(0, this.settle - dt / 1.8);
    else this.settle = Math.min(1, this.settle + dt * 0.35);
    const wantReady = this.state === 'combat' || this.state === 'investigate' || this.state === 'search' || this.state === 'suspicious';
    this.ready = damp(this.ready, wantReady ? 1 : 0, 5, dt);
    // keep the torso twist sane when the body faces away
    const twist = angleDiff(this.yaw, this.aimYaw);
    if (Math.abs(twist) > 1.2 && this.speed < 0.3) this.yaw += clamp(twist, -dt * 5, dt * 5);
  }

  updateWeapon(dt) {
    const g = this.game;
    this.fireCD -= dt;
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) { this.mag = 30; g.audio.play('magIn', { pos: this.pos, volume: 0.45, ref: 2, reverb: 0.2, priority: 'low' }); }
      return;
    }
    const shooting = this.state === 'combat' && this.canSee && (this.sub === 'engage' || this.sub === 'peek' || (this.sub === 'toCover' && this.profile.aggression > 0.65) || this.sub === 'advance');
    if (!shooting) { this.reaction = Math.max(this.reaction, 0.15); return; }
    const aimErr = Math.abs(angleDiff(this.aimYaw, Math.atan2(g.player.pos.x - this.pos.x, g.player.pos.z - this.pos.z)));
    if (aimErr > 0.25) return;
    if (this.reaction > 0) { this.reaction -= dt; return; }
    if (this.burstLeft <= 0) {
      this.burstGap -= dt;
      if (this.burstGap > 0) return;
      this.burstLeft = randInt(...this.profile.burst);
    }
    if (this.fireCD > 0) return;
    if (this.mag <= 0) { this.startReload(); return; }
    this.shoot();
    this.burstLeft--;
    this.fireCD = (60 / this.profile.rpm) * rand(1.0, 1.3);
    if (this.burstLeft <= 0) this.burstGap = rand(...this.profile.burstGap);
  }

  startReload() {
    this.reloadT = rand(2.2, 2.8);
    this.game.audio.play('magOut', { pos: this.pos, volume: 0.45, ref: 2, reverb: 0.2, priority: 'low' });
    if (Math.random() < 0.5) this.say('chatter', 0.7);
    if (this.sub === 'engage' || this.sub === 'peek') { if (!this.seekCover(true)) this.backToCover(); }
  }

  muzzleWorld(out) {
    this.model.rifle.updateWorldMatrix(true, false);
    return out.copy(MUZZLE).applyMatrix4(this.model.rifle.matrixWorld);
  }

  shoot() {
    const g = this.game, P = g.player;
    this.mag--;
    this.shots++;
    if (this.sub === 'peek') this.peekShots++;
    const muzzle = this.muzzleWorld(new THREE.Vector3());
    // aim point: centre mass, occasionally the head
    const aimHead = Math.random() < 0.06;
    const tp = _b.set(P.pos.x + P.leanOffset * Math.cos(P.yaw), P.pos.y + (aimHead ? P.eyeHeight : P.height * 0.62), P.pos.z - P.leanOffset * Math.sin(P.yaw));
    const dir = _a.subVectors(tp, muzzle).normalize();
    let spread = this.profile.spread * this.diff.spread;
    spread *= 1 + this.settle * 3;
    if (P.speed > 2.5) spread *= 1.35;
    if (P.speed > 4.5) spread *= 1.3;
    if (this.speed > 0.5) spread *= 2.0;
    if (this.suppressedT > 0) spread *= 1.8;
    if (g.time - this.lastHurt < 0.8) spread *= 1.6;
    if (P.crouching) spread *= 1.1;
    spread *= 0.85 + Math.min(1, this.shots * 0.02);
    const e1 = gaussian() * spread * 0.75 * DEG, e2 = gaussian() * spread * 0.75 * DEG;
    const right = _w.set(dir.z, 0, -dir.x).normalize();
    dir.addScaledVector(right, Math.tan(e1));
    dir.y += Math.tan(e2);
    dir.normalize();
    const wdef = { damage: this.profile.damage * this.diff.damage, headMult: 1.6, limbMult: 0.8, range: 250 };
    g.fireBullet(muzzle, dir, wdef, this, true);
    // presentation
    g.effects.worldMuzzleFlash(muzzle, dir, 1);
    g.effects.flashLight('enemy', muzzle, 14, 0.05);
    if (this.shots % 3 === 0) g.effects.muzzleSparks(muzzle, dir, 2);
    this.recoilZ.impulse(-1.2);
    const indoor = isIndoors(this.pos.x, this.pos.y, this.pos.z) ? 1 : 0;
    g.audio.play('enemyShot', { pos: muzzle, volume: 1.0, ref: 6, rolloff: 0.9, reverb: 0.8, indoor, soundDelay: true, occluded: !this.visibleToListener() });
    g.hud.ping(this.pos);
    g.emitNoise(this.pos, 30, 'enemyShot', false, this);
    // brass
    this.model.rifle.updateWorldMatrix(true, false);
    const ej = _w.set(0.03, 0.04, -0.05).applyMatrix4(this.model.rifle.matrixWorld);
    const side = _v.set(-Math.cos(this.aimYaw), 0.8, Math.sin(this.aimYaw)).multiplyScalar(rand(1.2, 2));
    if (this.pos.distanceTo(P.pos) < 20) g.effects.shells.spawn('brass', ej, side, this.pos.distanceTo(P.pos) < 10);
  }

  // ------------------------------------------------------------------ damage

  /** Ray vs hit spheres attached to bones. Returns shared hit or null. */
  raycast(o, d, maxT) {
    if (!this.alive || !this.active) return null;
    const cx = this.pos.x, cy = this.pos.y + 0.95, cz = this.pos.z;
    // bounding sphere reject
    const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
    const bb = ox * d.x + oy * d.y + oz * d.z, cc = ox * ox + oy * oy + oz * oz - 1.15 * 1.15;
    if (bb > 0 && cc > 0) return null;
    if (bb * bb - cc < 0) return null;
    this.object.updateMatrixWorld(true);
    let best = null, bt = maxT;
    for (const [bone, zone, off, r] of HIT_SPHERES) {
      const b = this.B[bone];
      _v.set(0, off, 0).applyMatrix4(b.matrixWorld);
      const px = o.x - _v.x, py = o.y - _v.y, pz = o.z - _v.z;
      const B2 = px * d.x + py * d.y + pz * d.z, C = px * px + py * py + pz * pz - r * r;
      const disc = B2 * B2 - C;
      if (disc < 0) continue;
      const t = -B2 - Math.sqrt(disc);
      if (t > 0 && t < bt) { bt = t; best = zone; }
    }
    if (!best) return null;
    this.tmpHit.t = bt;
    this.tmpHit.zone = best;
    this.tmpHit.point.set(o.x + d.x * bt, o.y + d.y * bt, o.z + d.z * bt);
    return this.tmpHit;
  }

  takeDamage(amount, zone, dir, shooterPos) {
    if (!this.alive) return false;
    const g = this.game;
    this.health -= amount;
    this.lastHurt = g.time;
    this.flinchX.impulse(zone === 'head' ? -4 : rand(1.5, 3.5));
    this.flinchZ.impulse(rand(-3, 3));
    this.pos.x += dir.x * 0.04; this.pos.z += dir.z * 0.04;
    this.settle = Math.min(1, this.settle + 0.45);
    this.reaction = Math.max(this.reaction, 0.25);
    if (this.health <= 0) { this.die(dir, zone === 'head'); return true; }
    if (Math.random() < 0.65) { this.voiceCD = 0; this.say('grunt', 1); }
    this.awareness = 1.2;
    this.lastKnown.copy(shooterPos);
    this.lastSeen = g.time;
    if (this.state !== 'combat') this.enterCombat(true);
    else if ((this.sub === 'engage' || this.sub === 'peek') && Math.random() < 0.6) this.seekCover(true);
    return false;
  }

  die(dir, headshot) {
    const g = this.game;
    this.alive = false;
    this.state = 'dead';
    this.stopMoving();
    this.releaseCover();
    this.releaseToken();
    this.deathT = 0;
    this.headshot = headshot;
    // pick a fall direction with room to fall (prefer along the bullet)
    const opts = [Math.atan2(dir.x, dir.z), Math.atan2(dir.x, dir.z) + 0.6, Math.atan2(dir.x, dir.z) - 0.6, Math.atan2(-dir.x, -dir.z), Math.atan2(dir.z, -dir.x), Math.atan2(-dir.z, dir.x)];
    let fallYaw = null;
    for (const a of opts) {
      const fx = Math.sin(a), fz = Math.cos(a);
      if (!g.physics.raycast(this.pos.x, this.pos.y + 0.5, this.pos.z, fx, 0, fz, 1.8, 'move') && !g.physics.raycast(this.pos.x, this.pos.y + 1.1, this.pos.z, fx, 0, fz, 1.8, 'move')) { fallYaw = a; break; }
    }
    const slump = fallYaw === null;
    if (slump) fallYaw = Math.atan2(dir.x, dir.z);
    // convert to model space: tip about an axis perpendicular to the fall direction
    const local = fallYaw - this.yaw;
    this.fall = { local, slump, twist: rand(-0.5, 0.5), limbs: [rand(-1, 1), rand(-1, 1), rand(-1, 1), rand(-1, 1)], soundDone: false };
    if (!headshot) this.game.audio.play('death', { pos: this.headPos(_w), volume: 0.6, ref: 2.5, reverb: 0.4, indoor: isIndoors(this.pos.x, this.pos.y, this.pos.z) ? 1 : 0 });
    this.dropRifle(dir);
    g.onEnemyKilled(this, headshot);
  }

  dropRifle(dir) {
    const r = this.model.rifle, g = this.game;
    r.updateWorldMatrix(true, false);
    r.matrixWorld.decompose(_v, _q, _w);
    g.scene.add(r);
    r.position.copy(_v);
    r.quaternion.copy(_q);
    const f = g.physics.floorAt(_v.x, _v.z, _v.y, this.floorOut);
    this.droppedRifle = { mesh: r, vy: 0.8, vx: dir.x * 0.6 + rand(-0.5, 0.5), vz: dir.z * 0.6 + rand(-0.5, 0.5), floor: f.y + 0.03, done: false, t: 0, spinY: rand(-3, 3) };
    const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rand(0, 6.28), Math.PI / 2));
    this.droppedRifle.target = flat;
  }

  updateDeath(dt) {
    this.deathT += dt;
    const t = this.deathT, f = this.fall, B = this.B;
    const hs = this.headshot ? 1.35 : 1;
    // knees buckle first, then the body tips over
    const buckle = clamp(t * 4 * hs, 0, 1);
    const tipK = clamp((t * hs - 0.12) / 0.62, 0, 1);
    const tip = easeInQuad(tipK) * (f.slump ? 1.0 : 1.52);
    const settle = tipK >= 1 ? Math.max(0, Math.sin(Math.min(1, (t * hs - 0.74) / 0.25) * Math.PI) * 0.06) : 0;
    const dirSign = Math.cos(f.local) >= 0 ? 1 : -1;
    // rotate the body about the feet: forward (+x rot) or backward (-x rot) with some roll for sideways falls
    const fx = Math.cos(f.local), fz = Math.sin(f.local);
    this.body.rotation.set((tip - settle) * fx, f.twist * tipK, -(tip - settle) * fz, 'YXZ');
    this.body.position.y = lerp(0, f.slump ? 0.05 : 0.14, tipK);
    // legs fold, arms go loose
    B.hips.position.y = lerp(0.98, 0.72, buckle * 0.6);
    for (const [s, k] of [['L', 0], ['R', 1]]) {
      const relax = 1 - tipK * 0.85;
      B['thigh' + s].quaternion.setFromEuler(new THREE.Euler(-0.7 * buckle * relax + f.limbs[k] * 0.15 * tipK, 0, (k ? -1 : 1) * 0.15 * tipK));
      B['shin' + s].rotation.set(1.1 * buckle * relax + 0.15 * tipK, 0, 0);
      B['upperArm' + s].rotation.set(-0.5 * tipK * dirSign + f.limbs[k + 2] * 0.4, 0, (k ? -1 : 1) * (0.4 + 0.8 * tipK));
      B['forearm' + s].rotation.set(-0.4 * tipK, 0, 0);
    }
    B.spine.rotation.set(0.25 * buckle * dirSign, 0, 0);
    B.chest.rotation.set(0.15 * buckle * dirSign, 0, 0);
    B.neck.rotation.set(0.3 * tipK * dirSign, 0, f.twist * 0.6);
    if (!f.soundDone && tipK >= 0.95) {
      f.soundDone = true;
      this.game.audio.play('bodyfall', { pos: this.pos, volume: 0.7, ref: 2, reverb: 0.35, indoor: isIndoors(this.pos.x, this.pos.y, this.pos.z) ? 1 : 0 });
      this.game.effects.puff(_v.set(this.pos.x, this.pos.y + 0.05, this.pos.z), _w.set(0, 1, 0), 3, [0.35, 0.33, 0.3], 0.3, 1.2);
    }
    if (t > 1.6 && !f.pool) { f.pool = true; this.game.effects.bloodPool(this.chestWorld(_v)); }
    // dropped rifle
    const d = this.droppedRifle;
    if (d && !d.done) {
      d.t += dt;
      d.vy -= 9.8 * dt;
      const m = d.mesh;
      m.position.x += d.vx * dt; m.position.z += d.vz * dt; m.position.y += d.vy * dt;
      m.quaternion.slerp(d.target, Math.min(1, dt * 6));
      if (m.position.y <= d.floor) {
        m.position.y = d.floor;
        if (Math.abs(d.vy) > 1.5) {
          this.game.audio.play('gunDrop', { pos: m.position, volume: 0.5, ref: 2, reverb: 0.3, priority: 'low' });
          d.vy = -d.vy * 0.25; d.vx *= 0.4; d.vz *= 0.4;
        } else { d.done = true; m.quaternion.copy(d.target); }
      }
    }
  }

  chestWorld(out) {
    this.object.updateMatrixWorld(true);
    return out.set(0, 0.1, 0).applyMatrix4(this.B.chest.matrixWorld);
  }

  // ------------------------------------------------------------------ animation

  animate(dt) {
    const B = this.B, R = this.model.rest;
    const crouchTarget = this.wantCrouch ? 1 : 0;
    this.crouch = damp(this.crouch, crouchTarget, 6, dt || 1);
    const moving = clamp(this.speed / 1.4, 0, 1);
    const run = clamp((this.speed - 2.2) / 1.6, 0, 1);
    const kneel = this.crouch * (1 - moving);
    const crouchWalk = this.crouch * moving;
    const ph = this.gait;
    const amp = moving * (0.42 + run * 0.28);
    // movement direction relative to the body for strafing legs
    const rel = this.speed > 0.2 ? Math.atan2(this.vel.x, this.vel.z) - this.yaw : 0;
    const mx = Math.sin(rel), mz = Math.cos(rel);
    const axis = _a.set(mz, 0, -mx).normalize();
    const hipsBob = Math.abs(Math.sin(ph)) * 0.035 * moving - 0.02 * moving - run * 0.03;
    B.hips.position.set(0, R[1].y + hipsBob - kneel * 0.44 - crouchWalk * 0.24, 0);
    // legs
    const swingL = -Math.sin(ph) * amp, swingR = Math.sin(ph) * amp;
    const kneeL = Math.max(0, Math.cos(ph)) * amp * 1.6 + moving * 0.1, kneeR = Math.max(0, -Math.cos(ph)) * amp * 1.6 + moving * 0.1;
    B.thighL.quaternion.setFromAxisAngle(axis, swingL);
    B.thighR.quaternion.setFromAxisAngle(axis, swingR);
    const splay = 0.07 * (1 - moving);
    _q.setFromAxisAngle(_b.set(0, 0, 1), splay); B.thighL.quaternion.premultiply(_q);
    _q.setFromAxisAngle(_b.set(0, 0, 1), -splay); B.thighR.quaternion.premultiply(_q);
    B.shinL.rotation.set(kneeL + crouchWalk * 0.9, 0, 0);
    B.shinR.rotation.set(kneeR + crouchWalk * 0.9, 0, 0);
    if (crouchWalk > 0) {
      _q.setFromAxisAngle(_b.set(1, 0, 0), -crouchWalk * 0.7);
      B.thighL.quaternion.premultiply(_q); B.thighR.quaternion.premultiply(_q);
    }
    if (kneel > 0.01) {
      // one knee down, weapon-side leg forward
      _q.setFromEuler(new THREE.Euler(-0.05 * kneel, 0, 0.05 * kneel));
      B.thighL.quaternion.slerp(_q, kneel);
      B.shinL.rotation.x = lerp(B.shinL.rotation.x, 1.55, kneel);
      _q.setFromEuler(new THREE.Euler(-1.4 * kneel, 0, -0.12 * kneel));
      B.thighR.quaternion.slerp(_q, kneel);
      B.shinR.rotation.x = lerp(B.shinR.rotation.x, 1.42, kneel);
    }
    B.footL.rotation.set(-B.shinL.rotation.x * 0.3, 0, 0);
    B.footR.rotation.set(-B.shinR.rotation.x * 0.3, 0, 0);
    // torso: aim pitch + twist towards aim yaw
    const twist = clamp(angleDiff(this.yaw, this.aimYaw), -1.2, 1.2);
    const pitch = this.aimPitch * this.ready;
    const fl = this.flinchX.update(dt || 0), flz = this.flinchZ.update(dt || 0), rk = this.recoilZ.update(dt || 0);
    const lean = run * 0.18 + kneel * 0.1 + crouchWalk * 0.2;
    B.spine.rotation.set(-pitch * 0.35 + lean + fl * 0.05, twist * 0.45, flz * 0.04, 'YXZ');
    B.chest.rotation.set(-pitch * 0.55 + fl * 0.04, twist * 0.45, flz * 0.03, 'YXZ');
    B.neck.rotation.set(-pitch * 0.1, this.state === 'idle' ? this.headYaw * 0.5 : twist * 0.1, 0);
    B.head.rotation.set(0, this.state === 'idle' || this.state === 'patrol' ? this.headYaw * 0.5 : 0, 0);
    // rifle: low ready ↔ shouldered
    const h = this.model.holder;
    h.rotation.set(lerp(0.75, 0, this.ready), lerp(0.35, 0, this.ready), 0);
    h.position.set(-0.1, 0.06, 0.3 + rk * 0.02);
    // arms via IK in chest space
    const reloading = this.reloadT > 0;
    h.updateMatrix();
    _v.copy(GRIP).applyMatrix4(this.model.rifle.matrix).applyMatrix4(h.matrix);
    solveArm(B.upperArmR, B.forearmR, _v, POLE_R);
    if (reloading) {
      const k = Math.sin(clamp(1 - this.reloadT / 2.4, 0, 1) * Math.PI);
      _w.set(0.08, -0.25 - k * 0.1, 0.12);
      _v.copy(HANDGUARD).applyMatrix4(this.model.rifle.matrix).applyMatrix4(h.matrix).lerp(_w, k);
    } else _v.copy(HANDGUARD).applyMatrix4(this.model.rifle.matrix).applyMatrix4(h.matrix);
    solveArm(B.upperArmL, B.forearmL, _v, POLE_L);
  }
}
