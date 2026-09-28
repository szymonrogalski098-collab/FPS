// Soldier AI (hostile or friendly): perception (sight + hearing) over any number of opposing actors,
// tactical state machine (patrol → investigate → combat with cover / peek / reposition / advance →
// search; hostiles also hunt, friendlies follow the player in formation), burst fire with human-like
// aim error and ballistic hold-over, procedural locomotion, IK arms, hit reactions and a collapse on death.
import * as THREE from 'three';
import { ENEMY_PROFILES, DIFFICULTY, PLAYER } from './config.js';
import { createSoldier, solveArm } from './enemyModel.js';
import { ambientAt } from './materials.js';
import { clamp, damp, lerp, rand, randInt, angleDiff, gaussian, DEG, Spring, easeInQuad } from './util.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const POLE_R = new THREE.Vector3(-0.6, -1, -0.3), POLE_L = new THREE.Vector3(0.7, -1, -0.2);
const GRIP = new THREE.Vector3(0, -0.035, 0.02), HANDGUARD = new THREE.Vector3(0, 0.0, -0.22);
const HIT_SPHERES = [
  ['head', 'head', 0.07, 0.125], ['chest', 'torso', 0.1, 0.2], ['spine', 'torso', 0.06, 0.18], ['hips', 'torso', 0, 0.17],
  ['thighL', 'limb', -0.2, 0.095], ['thighR', 'limb', -0.2, 0.095], ['shinL', 'limb', -0.2, 0.075], ['shinR', 'limb', -0.2, 0.075],
  ['upperArmL', 'limb', -0.14, 0.065], ['upperArmR', 'limb', -0.14, 0.065], ['forearmL', 'limb', -0.13, 0.058], ['forearmR', 'limb', -0.13, 0.058],
];
const SHOT_SOUND = { ak: 'akShot', svd: 'svdShot', m4: 'm4Shot', dmr: 'dmrShot' };

let uid = 0;

export class Enemy {
  constructor(game, def) {
    this.game = game;
    this.def = def;
    this.id = uid++;
    this.team = def.team || 'hostile';
    this.profile = ENEMY_PROFILES[def.profile];
    const model = createSoldier(game.M._textures, this.profile);
    this.model = model;
    this.B = model.bones;
    this.muzzleLocal = model.muzzle;
    this.object = new THREE.Group();
    this.body = new THREE.Group();
    this.body.add(model.mesh);
    this.object.add(this.body);
    this.scene = def.scene || game.scene;
    this.scene.add(this.object);
    this.pos = this.object.position;
    this.vel = new THREE.Vector3();
    this.lastKnown = new THREE.Vector3();
    this.noisePos = new THREE.Vector3();
    this.huntGoal = new THREE.Vector3();
    this.slot = new THREE.Vector3();
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
    this.state = def.mode === 'patrol' ? 'patrol' : def.mode === 'follow' ? 'follow' : 'idle';
    this.sub = null;
    this.subT = 0;
    this.awareness = 0;
    this.canSee = false;
    this.target = null;
    this.lastSeen = -100;
    this.lastShotT = -100;
    this.markT = -100;
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
    this.scan = Math.floor(Math.random() * 8);
    this.mag = this.profile.mag || 30;
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
    this.killer = null;
    this.fallDone = false;
    this.haltT = 0;
    this.nextPause = rand(12, 22);
    this.lookAroundT = rand(0, 10);
    this.body.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
    this.model.mesh.skeleton.bones.forEach((b, i) => { b.position.copy(this.model.rest[i]); b.quaternion.identity(); });
    if (this.droppedRifle) { this.droppedRifle.mesh.parent && this.droppedRifle.mesh.parent.remove(this.droppedRifle.mesh); this.droppedRifle = null; }
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
  get height() { return lerp(1.78, 1.15, this.crouch); }
  get crouching() { return this.crouch > 0.5; }
  get open() { return !!this.game.world.teamCombat; }
  get friendly() { return this.team === 'friendly'; }

  eye(out) { return out.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z); }
  eyePosition(out) { return this.eye(out); }

  /** Called when the drive is taken: reinforcements enter hunting the player. */
  activate(knownPos) {
    this.active = true;
    this.object.visible = true;
    this.awareness = 0.95;
    this.lastKnown.copy(knownPos);
    this.lastSeen = this.game.time - 3;
    this.target = this.game.player;
    this.enterCombat(false);
    this.sub = 'advance';
    this.subT = 0;
  }

  // ------------------------------------------------------------------ main update

  update(dt) {
    if (!this.active) return;
    if (!this.alive) { this.updateDeath(dt); return; }
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
    const g = this.game;
    this.canSee = false;
    if (!g.aiEnabled) return;
    const cands = g.targetsFor(this);
    if (!cands.length) { this.decayAwareness(dt); return; }
    const eye = this.eye(_a);
    const combat = this.state === 'combat';
    const range = this.profile.sightRange || 60;
    const facing = combat ? this.aimYaw : this.yaw + this.headYaw;
    const fovHalf = (combat ? 170 : this.profile.fov) * 0.5 * DEG;
    // line-of-sight tests are the expensive part: the current target plus a rotating subset of the rest
    const budget = this.open ? (combat ? 3 : 2) : cands.length;
    let checks = 0, best = null, bestRate = 0;
    const n = cands.length;
    this.scan = (this.scan + 1) % Math.max(1, n);
    for (let k = -1; k < n; k++) {
      const T = k < 0 ? this.target : cands[(k + this.scan) % n];
      if (!T || !T.alive || T.active === false) continue;
      if (k >= 0 && T === this.target) continue;
      const pe = T.eyePosition(_b);
      const dx = pe.x - eye.x, dz = pe.z - eye.z, dy = pe.y - eye.y;
      const dist = Math.hypot(dx, dy, dz);
      const marked = g.time - this.markT < 12 && T === this.target;
      if (dist > range * (marked ? 1.4 : 1)) continue;
      const ang = Math.abs(angleDiff(facing, Math.atan2(dx, dz)));
      const close = dist < 2.2;
      // far away only what you are actually looking at can be picked out
      const fovEff = this.open && !combat ? fovHalf * clamp(110 / dist, 0.28, 1) : fovHalf;
      if (ang > fovEff && !close && !marked) continue;
      if (checks >= budget) break;
      checks++;
      let los = g.physics.clearLine(eye.x, eye.y, eye.z, pe.x, pe.y - 0.05, pe.z, 'sight');
      if (!los) los = g.physics.clearLine(eye.x, eye.y, eye.z, T.pos.x, T.pos.y + T.height * 0.55, T.pos.z, 'sight');
      if (!los) continue;
      let rate = this.detectRate(T, dist, ang, close, combat);
      if (marked) rate *= 5;
      if (T === this.target) rate *= 1.5;
      if (rate > bestRate) { bestRate = rate; best = T; }
    }
    if (!best) { this.decayAwareness(dt); return; }
    const P = best;
    this.canSee = true;
    if (this.target !== P && (combat || this.awareness < 0.3)) this.target = P;
    this.awareness = Math.min(1.3, this.awareness + bestRate * dt * 1.1);
    if (this.awareness >= 1) {
      this.target = P;
      this.lastKnown.copy(P.pos);
      this.lastSeen = g.time;
      if (!combat) this.enterCombat(true);
    } else if (this.awareness > 0.3 && (this.state === 'idle' || this.state === 'patrol' || this.state === 'hunt' || this.state === 'follow')) {
      this.state = 'suspicious';
      this.subT = 0;
      this.noisePos.copy(P.pos);
      this.stopMoving();
    }
    if (this.state === 'suspicious') this.noisePos.copy(P.pos);
  }

  /** How fast an actor in view is recognised as a threat. */
  detectRate(T, dist, ang, close, combat) {
    const g = this.game, pr = this.profile;
    let rate = pr.detectRate * this.diff.detect;
    if (pr.detectRange) rate *= clamp(Math.pow(pr.detectRange / Math.max(dist, 1), 1.4), pr.minDetect || 0.1, 2);
    else rate *= clamp(2.0 - dist / 18, 0.18, 2.0);
    const prone = T.proneT > 0.5;
    if (prone) rate *= 0.3;
    else if (T.crouching) rate *= 0.55;
    rate *= T.speed > 3.8 ? 1.6 : T.speed > 0.5 ? 1.0 : 0.6;
    const shotT = T === g.player ? g.weapons.lastShot : T.lastShotT;
    if (g.time - shotT < (this.open ? 1.4 : 0.6)) rate *= this.open ? 5 : 3;
    rate *= 0.4 + 0.6 * clamp(ambientAt(T.pos) * 1.4, 0, 1);
    if (this.open && g.world.concealmentAt && (prone || T.crouching)) rate *= 1 - g.world.concealmentAt(T.pos.x, T.pos.z) * (prone ? 0.6 : 0.35);
    if (ang > 50 * DEG) rate *= 0.45;
    if (combat) rate *= 4;
    if (close) rate = 10;
    return rate;
  }

  decayAwareness(dt) {
    if (this.state !== 'combat') this.awareness = Math.max(0, this.awareness - dt * 0.06);
  }

  hearNoise(pos, radius, type, team, source) {
    if (!this.alive || !this.active || !this.game.aiEnabled) return;
    const d = this.pos.distanceTo(pos);
    if (d > radius) return;
    const g = this.game;
    if (d < 150) {
      const occluded = !g.physics.clearLine(this.pos.x, this.pos.y + 1.6, this.pos.z, pos.x, pos.y + 1, pos.z, 'sight');
      if (occluded && d > radius * 0.6) return;
    }
    const errMax = this.open ? 40 : 4, errK = this.open ? 0.09 : 0.12;
    const err = Math.min(errMax, d * errK);
    const est = _w.set(pos.x + rand(-err, err), pos.y, pos.z + rand(-err, err));
    if (team === this.team) {
      // a team-mate is fighting or moving: go and look (in the open only when it is close by)
      if (type !== 'enemyShot' && type !== 'impact') return;
      if (this.open && d > 150) {
        if (this.state === 'idle' || this.state === 'patrol') { this.state = 'suspicious'; this.subT = 0; this.noisePos.copy(est); this.stopMoving(); this.awareness = Math.max(this.awareness, 0.5); }
        if (g.mode === 'mountain' && !this.friendly) g.world.survival.onGunfireHeard(this, d);
        return;
      }
      this.awareness = Math.min(0.95, this.awareness + 0.28 * (1 - d / radius));
      if (this.state === 'follow' || this.state === 'combat') return;
      if (this.state !== 'investigate' && this.awareness > 0.25) this.startInvestigate(est, false);
      return;
    }
    if (this.open && d > 150 && (type === 'gunshot' || type === 'enemyShot')) {
      // distant gunfire: alert and look, but hold the position (the hunt director moves groups)
      this.awareness = Math.max(this.awareness, 0.55);
      if (this.state === 'idle' || this.state === 'patrol') {
        this.state = 'suspicious';
        this.subT = 0;
        this.noisePos.copy(est);
        this.stopMoving();
      }
      if (g.mode === 'mountain' && !this.friendly) g.world.survival.onGunfireHeard(this, d);
      return;
    }
    if (type === 'gunshot' || type === 'impact' || (this.open && type === 'enemyShot')) {
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
      } else if (this.state !== 'investigate' && this.state !== 'follow' && this.awareness > 0.25) {
        this.startInvestigate(est, false);
      }
    }
  }

  /** A round passed close by or hit something near us. */
  onNearMiss(shooterPos, shooter) {
    if (!this.alive || !this.active) return;
    this.suppressedT = 1.2;
    this.flinchX.impulse(rand(-2, 2));
    this.awareness = 1.1;
    const src = shooter === 'player' ? this.game.player : shooter;
    if (this.state !== 'combat') {
      this.lastKnown.copy(this.open ? _v.set(shooterPos.x + rand(-15, 15), shooterPos.y, shooterPos.z + rand(-15, 15)) : shooterPos);
      this.lastSeen = this.game.time - 0.5;
      if (src && src.alive !== false) this.target = src;
      this.enterCombat(false);
    } else if (!this.canSee) {
      this.lastKnown.lerp(shooterPos, this.open ? 0.3 : 0.6);
    }
    if ((this.sub === 'peek' || this.sub === 'engage') && Math.random() < 0.55) this.seekCover(true);
  }

  /** Squad leader / binocular mark: prioritise this hostile. */
  assignTarget(h) {
    if (!this.alive || !h.alive) return;
    this.target = h;
    this.markT = this.game.time;
    this.lastKnown.copy(h.pos);
    this.lastSeen = this.game.time - 1;
    this.awareness = Math.max(this.awareness, 0.95);
    if (this.state !== 'combat') { this.state = 'combat'; this.sub = 'engage'; this.subT = 0; this.reaction = rand(...this.profile.reaction); }
    this.lookAt(h.pos, 5);
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
      if (this.friendly) { if (spotted && g.mode === 'mountain') g.world.survival.callout(this, 'contact', this.target || this.lastKnown); }
      else this.say('chatter', 0.8);
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

  /** Hunt director order: move on the team's last reported area. */
  startHunt(pos) {
    if (!this.alive || this.state === 'combat' || this.def.stationary || this.friendly) return;
    this.state = 'hunt';
    this.huntGoal.copy(pos);
    this.subT = 0;
    this.waitT = 0;
    this.nextPause = rand(10, 20);
    this.stopMoving();
  }

  updateHunt(pos) {
    this.huntGoal.copy(pos);
    this.waitT = Math.min(this.waitT, 0.5);
    if (this.path) this.stopMoving();
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
      case 'hunt': this.thinkHunt(dt); break;
      case 'follow': this.thinkFollow(dt); break;
    }
  }

  thinkIdle(dt) {
    this.wantCrouch = !!this.def.stationary && this.open && this.subT % 14 > 9;
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
    if (this.open) {
      this.wantCrouch = true;
      this.awareness = Math.max(0, this.awareness - dt * 0.02);
      if (this.subT > 25 && this.awareness < 0.6) { this.awareness = 0.2; this.returnToDuty(); return; }
    }
    if (this.awareness < 0.15) { this.returnToDuty(); return; }
    if (this.subT > 2.5 && this.awareness > 0.35) {
      if (this.friendly) { this.subT = 0; this.awareness = Math.min(this.awareness, 0.5); return; }
      this.startInvestigate(this.noisePos, false);
    }
  }

  thinkInvestigate(dt) {
    this.ready = 1;
    if (this.investigatePhase === 'turn') {
      this.lookAt(this.noisePos, 3);
      if (this.subT > (this.investigateUrgent ? 0.4 : 1.2)) {
        this.investigatePhase = 'move';
        if (this.def.stationary || this.friendly) { this.investigatePhase = 'look'; this.subT = 0; return; }
        const goal = this.open && this.pos.distanceTo(this.noisePos) > 60 ? this.stepToward(this.noisePos, 45) : this.noisePos;
        this.goTo(goal, this.investigateUrgent ? 2.4 : 1.7);
      }
    } else if (this.investigatePhase === 'move') {
      if (!this.path || this.pos.distanceTo(this.noisePos) < 1.5) { this.stopMoving(); this.investigatePhase = 'look'; this.subT = 0; }
    } else {
      this.lookAround();
      this.wantCrouch = this.open;
      if (this.subT > (this.open ? 10 : 6)) { this.awareness = Math.min(this.awareness, 0.2); this.returnToDuty(); }
    }
  }

  thinkSearch(dt) {
    this.ready = 1;
    if (this.game.time - this.lastSeen > (this.open ? 60 : 40)) { this.returnToDuty(); return; }
    if (this.friendly) { this.returnToDuty(); return; }
    if (!this.path) {
      this.waitT -= dt;
      this.lookAround();
      if (this.waitT <= 0) {
        const p = this.game.nav.randomNear(this.lastKnown.x, this.lastKnown.y, this.lastKnown.z, this.open ? 22 : 8);
        if (p && !this.def.stationary) this.goTo(_v.set(p.x, p.y, p.z), 1.8);
        this.waitT = rand(2, 4);
      }
    }
  }

  thinkHunt(dt) {
    this.ready = 1;
    const d = this.pos.distanceTo(this.huntGoal);
    if (d < 14) {
      this.state = 'search';
      this.lastKnown.copy(this.huntGoal);
      this.lastSeen = this.game.time - 5;
      this.waitT = 0;
      return;
    }
    if (this.path) {
      // bounding movement: stop now and then to kneel and scan
      if (this.subT > this.nextPause) {
        this.stopMoving();
        this.wantCrouch = true;
        this.waitT = rand(2.5, 5);
        this.nextPause = this.subT + this.waitT + rand(10, 22);
      }
      return;
    }
    this.lookAround();
    this.waitT -= dt;
    if (this.waitT > 0) return;
    this.wantCrouch = false;
    const goal = d > 90 ? this.stepToward(this.huntGoal, 80) : this.huntGoal;
    if (!this.goTo(goal, rand(2.3, 3.1))) {
      const p = this.game.nav.randomNear(goal.x, goal.y, goal.z, 25);
      if (!p || !this.goTo(_v.set(p.x, p.y, p.z), 2.6)) this.waitT = rand(1, 3);
    }
  }

  /** Friendly squad member: keep a formation slot around the player, take a knee when halted. */
  thinkFollow(dt) {
    const g = this.game, P = g.player;
    this.ready = damp(this.ready, 0.6, 2, dt);
    if (!P.alive) { this.stopMoving(); this.wantCrouch = true; return; }
    const off = this.def.offset || [0, 6];
    const spread = this.open ? 1.8 : 1;
    const c = Math.cos(P.yaw), s = Math.sin(P.yaw);
    const rx = off[0] * spread, bz = off[1] * spread;
    const sx = P.pos.x + rx * c + bz * s, sz = P.pos.z - rx * s + bz * c;
    this.slot.set(sx, g.physics.floorAt(sx, sz, P.pos.y + 30).y, sz);
    const dSlot = Math.hypot(this.slot.x - this.pos.x, this.slot.z - this.pos.z);
    const dP = this.pos.distanceTo(P.pos);
    const halted = P.speed < 0.4;
    this.haltT = halted ? this.haltT + dt : 0;
    this.repathT -= dt;
    if ((dSlot > 5 || dP > 22) && this.repathT <= 0) {
      this.repathT = 1.2;
      const quiet = g.mode === 'mountain' && !g.world.survival.weaponsFree;
      const sp = dP > 30 ? 4 : P.sprinting ? 4.2 : P.speed > 2 ? (quiet ? 2.6 : 3.2) : quiet ? 1.8 : 2.2;
      if (!this.goTo(this.slot, sp)) this.goTo(P.pos, sp);
    } else if (dSlot < 2 && this.path) this.stopMoving();
    this.wantCrouch = (P.crouching || P.proneT > 0.5) || (this.haltT > 2.5 && !this.path);
    if (!this.path && this.haltT > 2) {
      // watch an outward sector
      const sector = P.yaw + Math.PI + (off[0] > 0 ? -0.9 : off[0] < 0 ? 0.9 : Math.PI) + Math.sin(g.time * 0.1 + this.id) * 0.5;
      _v.set(this.pos.x + Math.sin(sector) * 20, this.pos.y, this.pos.z + Math.cos(sector) * 20);
      this.lookAt(_v.clone(), 1.5);
    } else this.lookTarget = null;
  }

  stepToward(goal, dist) {
    const dx = goal.x - this.pos.x, dz = goal.z - this.pos.z, d = Math.hypot(dx, dz) || 1;
    const x = this.pos.x + (dx / d) * dist, z = this.pos.z + (dz / d) * dist;
    return _c.set(x, this.game.physics.groundAt(x, z), z);
  }

  returnToDuty() {
    this.sub = null;
    this.releaseCover();
    this.releaseToken();
    if (this.friendly) { this.state = 'follow'; this.target = null; this.stopMoving(); return; }
    this.state = this.def.route ? 'patrol' : 'idle';
    this.target = null;
    if (!this.def.route && !this.def.stationary) this.goTo(_v.set(this.def.pos[0], this.def.pos[1], this.def.pos[2]), 1.4);
  }

  thinkCombat(dt) {
    const g = this.game;
    let T = this.target;
    if (!T || !T.alive || T.active === false) {
      this.target = null;
      if (this.friendly) { this.returnToDuty(); return; }
      const next = g.targetsFor(this).find((q) => q.alive && q.pos.distanceTo(this.pos) < 60);
      if (next) { this.target = T = next; this.lastKnown.copy(next.pos); this.lastSeen = g.time - 4; }
      else { this.state = 'search'; this.stopMoving(); return; }
    }
    const since = g.time - this.lastSeen;
    if (since > (this.open ? 20 : 14) && !this.canSee) {
      if (this.friendly) { this.returnToDuty(); return; }
      this.state = 'search';
      this.sub = null;
      this.releaseCover();
      this.releaseToken();
      this.waitT = 0;
      return;
    }
    const distP = this.pos.distanceTo(T.pos);
    // recon team under "weapons hold": keep tracking a distant contact while staying with the player
    if (this.friendly && g.mode === 'mountain' && !g.world.survival.weaponsFree && distP > 80 && g.time - this.lastHurt > 8 && g.time - this.markT > 12) {
      this.thinkFollow(dt);
      if (!this.path) { this.lookAt(this.canSee ? T.pos : this.lastKnown, 2); this.wantCrouch = true; }
      if (!this.canSee && since > 12) this.returnToDuty();
      return;
    }
    if (this.canSee && distP < 3.2 && !this.def.stationary && this.sub !== 'toCover' && Math.random() < 0.3) this.seekCover(true, 6);
    // friendlies do not wander away from the player
    if (this.friendly && this.pos.distanceTo(g.player.pos) > 40 && this.sub !== 'toCover') {
      this.goTo(g.player.pos, 3.8);
      this.sub = 'toCover';
      this.subT = 0;
      return;
    }
    switch (this.sub) {
      case 'engage': {
        this.wantCrouch = this.def.stationary ? this.cover !== null || this.subT % 6 > 3 : this.crouchPreference();
        this.stopMoving();
        if (this.canSee) this.lookAt(T.pos, 6);
        else this.lookAt(this.lastKnown, 4);
        const exposedFor = this.subT;
        if (!this.canSee && since > (this.friendly ? 3 : 1.6)) { this.reposition(); break; }
        if (!this.def.stationary && (exposedFor > rand(2.5, 4.5) * (this.open ? 2 : 1) || g.time - this.lastHurt < 0.3)) {
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
        this.wantCrouch = this.cover ? this.cover.low : true;
        this.lookAt(this.lastKnown, 4);
        if (this.cover && this.coverCompromised()) { if (!this.seekCover(true)) { this.sub = 'engage'; this.subT = 0; } break; }
        if (this.reloadT > 0) break;
        if (this.subT > this.hideT) this.startPeek();
        break;
      }
      case 'peek': {
        if (this.cover && this.cover.low) this.wantCrouch = false;
        this.lookAt(this.canSee ? T.pos : this.lastKnown, 6);
        if (this.canSee) this.peekSawT = g.time;
        const burstDone = this.peekShots > 0 && this.burstLeft <= 0 && this.burstGap > 0.1;
        if (burstDone || this.subT > (this.open ? 5 : 3.2) || this.reloadT > 0) this.backToCover();
        else if (!this.canSee && this.subT > 1.3) {
          if (since > 4.5 || (this.friendly && this.open && since > 2.5)) this.reposition(); else this.backToCover();
        }
        break;
      }
      case 'toFire': {
        this.wantCrouch = false;
        if (!this.path || this.subT > 12) { this.stopMoving(); this.sub = 'engage'; this.subT = 0; this.wantCrouch = true; }
        break;
      }
      case 'advance': {
        this.wantCrouch = false;
        if (this.canSee) { this.releaseToken(); this.sub = 'engage'; this.subT = 0; this.stopMoving(); break; }
        if (!this.path) {
          if (this.pos.distanceTo(this.lastKnown) < 2.5 || this.subT > (this.open ? 25 : 10)) {
            this.releaseToken();
            this.state = 'search';
            this.waitT = 1;
          } else this.goTo(this.open && this.pos.distanceTo(this.lastKnown) > 70 ? this.stepToward(this.lastKnown, 60) : this.lastKnown, 2.8);
        }
        break;
      }
      default:
        this.sub = 'engage';
        this.subT = 0;
    }
  }

  crouchPreference() {
    if (this.open) return this.subT % 7 > 2.5;
    return this.profile.aggression < 0.6 ? this.subT % 5 > 2 : false;
  }

  threatPos() {
    return this.state === 'combat' && this.canSee && this.target ? this.target.pos : this.lastKnown;
  }

  coverCompromised() {
    const c = this.cover, g = this.game;
    if (!c) return false;
    const T = this.target;
    const tp = T ? T.pos : this.lastKnown;
    const tx = tp.x - c.x, tz = tp.z - c.z, tl = Math.hypot(tx, tz) || 1;
    if ((c.nx * tx + c.nz * tz) / tl < 0.1) return true;
    if (!T) return false;
    const pe = T.eyePosition(_b);
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
    this.hideT = rand(1.1, 2.4) * (this.open ? 1.5 : 1);
    if (this.cover && !this.cover.low) this.goTo(_v.set(this.cover.x, this.cover.y, this.cover.z), 2.2);
  }

  reposition() {
    if (this.def.stationary) { this.sub = 'engage'; this.subT = 0; return; }
    const g = this.game;
    if (this.seekCover(false, this.open ? 26 : 16, true)) return;
    if (this.friendly && this.open && this.seekFiringPosition()) return;
    if (!this.friendly && g.requestToken(this)) {
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

  /** Friendly: move to a spot near the player with a clear line to the threat (kneeling height). */
  seekFiringPosition() {
    const g = this.game, P = g.player, T = g.physics.terrain;
    const th = this.threatPos();
    if (!T || !th) return false;
    let best = null, bestS = -Infinity;
    for (let k = 0; k < 14; k++) {
      const a = Math.random() * Math.PI * 2, r = 5 + Math.random() * 20;
      const x = P.pos.x + Math.cos(a) * r, z = P.pos.z + Math.sin(a) * r;
      if (T.slopeAt(x, z) > 0.35) continue;
      const y = g.physics.floorAt(x, z, T.heightAt(x, z) + 1).y;
      if (!g.physics.clearLine(x, y + 1.05, z, th.x, th.y + 1.2, th.z, 'sight')) continue;
      const toward = Math.hypot(th.x - x, th.z - z);
      const s = -Math.hypot(x - this.pos.x, z - this.pos.z) * 0.6 - Math.abs(toward - this.pos.distanceTo(th)) * 0.1 + Math.random() * 3;
      if (s > bestS) { bestS = s; best = _c.set(x, y, z); }
    }
    if (!best || !this.goTo(best, 3.4)) return false;
    this.releaseCover();
    this.sub = 'toFire';
    this.subT = 0;
    return true;
  }

  flankPoint() {
    const dx = this.lastKnown.x - this.pos.x, dz = this.lastKnown.z - this.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const side = (this.id % 2 ? 1 : -1) * Math.min(this.open ? 25 : 4, d * 0.35);
    const back = this.open ? Math.min(40, d * 0.4) : 2;
    _w.set(this.lastKnown.x - (dx / d) * back + (-dz / d) * side, this.lastKnown.y, this.lastKnown.z - (dz / d) * back + (dx / d) * side);
    const n = this.game.nav.nearestNode(_w.x, _w.y, _w.z, 5);
    if (n >= 0) return _w.set(this.game.nav.x[n], this.game.nav.y[n], this.game.nav.z[n]);
    return this.lastKnown;
  }

  /** Picks the best reachable cover spot relative to the threat. */
  seekCover(urgent, maxDist = this.open ? 22 : 15, wantLos = false) {
    if (this.def.stationary) return false;
    const g = this.game, nav = g.nav, P = g.player;
    const threat = this.threatPos();
    const te = _a.set(threat.x, threat.y + 1.55, threat.z);
    const cands = [];
    const anchor = this.friendly ? P.pos : null;
    for (const c of nav.cover) {
      if (c.owner && c.owner !== this) continue;
      if (Math.abs(c.x - this.pos.x) > maxDist || Math.abs(c.z - this.pos.z) > maxDist) continue;
      if (Math.abs(c.y - this.pos.y) > (this.open ? 6 : 3.5)) continue;
      const d = Math.hypot(c.x - this.pos.x, c.z - this.pos.z);
      if (d > maxDist) continue;
      if (anchor && Math.hypot(c.x - anchor.x, c.z - anchor.z) > 28) continue;
      const tx = threat.x - c.x, tz = threat.z - c.z, tl = Math.hypot(tx, tz);
      if (tl < 4.5) continue;
      if ((c.nx * tx + c.nz * tz) / tl < 0.3) continue;
      const vx = c.x - this.pos.x, vz = c.z - this.pos.z;
      const toward = (vx * (threat.x - this.pos.x) + vz * (threat.z - this.pos.z)) / ((Math.hypot(vx, vz) || 1) * (Math.hypot(threat.x - this.pos.x, threat.z - this.pos.z) || 1));
      if (urgent && toward > 0.7 && d > 3) continue;
      cands.push({ c, d, tl });
    }
    cands.sort((p, q) => p.d - q.d);
    let best = null, bestScore = -Infinity;
    const ideal = this.open ? Math.min(250, this.pos.distanceTo(threat)) : 11;
    for (const { c, d, tl } of cands.slice(0, this.open ? 14 : 26)) {
      const hy = c.y + (c.low ? 0.95 : 1.5);
      if (g.physics.clearLine(te.x, te.y, te.z, c.x, hy, c.z, 'sight')) continue;
      let peek = null;
      if (c.low) {
        if (g.physics.clearLine(c.x, c.y + 1.6, c.z, te.x, te.y - 0.4, te.z, 'sight')) peek = true;
      } else {
        for (const s of [1, -1]) {
          const px = c.x + -c.nz * s * 0.85, pz = c.z + c.nx * s * 0.85;
          const n = nav.nearestNode(px, c.y, pz, 1);
          if (n < 0 || Math.hypot(nav.x[n] - px, nav.z[n] - pz) > (this.open ? 1.5 : 0.4)) continue;
          if (g.physics.clearLine(px, c.y + 1.6, pz, te.x, te.y - 0.4, te.z, 'sight')) { peek = { x: this.open ? px : nav.x[n], y: this.open ? c.y : nav.y[n], z: this.open ? pz : nav.z[n] }; break; }
        }
      }
      if (wantLos && !peek) continue;
      let score = -d * (urgent ? 1.3 : 0.8) - Math.abs(tl - ideal) * (this.open ? 0.02 : 0.3) + (peek ? 3.5 : -1) + (c.low ? 0.4 : 0) + Math.random() * 0.8;
      for (const e of g.soldiers) if (e !== this && e.alive && Math.abs(e.pos.x - c.x) < 2.2 && Math.hypot(e.pos.x - c.x, e.pos.z - c.z) < 2.2) score -= 2.5;
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
    const g = this.game;
    if (this.open && this.pos.distanceTo(g.camera.position) > 120) return;
    this.voiceCD = rand(3, 6);
    g.audio.play(name, { pos: this.headPos(_w), volume: 0.55 * vol, ref: 2.5, reverb: 0.4, indoor: g.isIndoors(this.pos.x, this.pos.y, this.pos.z) ? 1 : 0, occluded: !this.visibleToListener() });
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
    const f = this.game.world ? this.game.physics.floorAt(this.pos.x, this.pos.z, this.pos.y + 0.5, this.floorOut) : { y: this.pos.y, surface: 'concrete' };
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
      if (d < (this.open ? 0.6 : 0.35)) {
        this.pathIdx++;
        if (this.pathIdx >= this.path.length) { this.path = null; }
      } else {
        let sp = this.moveSpeed * (this.crouch > 0.5 ? 0.5 : 1) * (this.suppressedT > 0 ? 0.85 : 1);
        if (this.open) {
          // uphill is slow going
          const climb = (p.y - this.pos.y) / Math.max(d, 0.5);
          if (climb > 0.15) sp *= clamp(1 - (climb - 0.15) * 1.1, 0.45, 1);
        }
        tvx = (dx / d) * sp; tvz = (dz / d) * sp;
      }
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
    for (const e of g.soldiers) {
      if (e === this || !e.alive || !e.active) continue;
      const dx = this.pos.x - e.pos.x;
      if (dx > 0.65 || dx < -0.65) continue;
      const dz = this.pos.z - e.pos.z, d = Math.hypot(dx, dz);
      if (d < 0.65 && d > 1e-4 && Math.abs(this.pos.y - e.pos.y) < 1.5) { const k = (0.65 - d) * 0.5; this.pos.x += (dx / d) * k; this.pos.z += (dz / d) * k; }
    }
    const P = g.player;
    const pdx = this.pos.x - P.pos.x, pdz = this.pos.z - P.pos.z, pd = Math.hypot(pdx, pdz);
    if (pd < 0.62 && pd > 1e-4 && Math.abs(this.pos.y - P.pos.y) < 1.5) { const k = 0.62 - pd; this.pos.x += (pdx / pd) * k; this.pos.z += (pdz / pd) * k; }
    g.physics.resolveCircle(this.pos, 0.3, 1.7, 0.45);
    const f = g.physics.floorAt(this.pos.x, this.pos.z, this.pos.y + (this.open ? 1.2 : 0.5), this.floorOut);
    this.pos.y = damp(this.pos.y, f.y, 18, dt);
    this.surface = f.surface;
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    let targetYaw = this.yaw;
    if (this.speed > 0.3) targetYaw = Math.atan2(this.vel.x, this.vel.z);
    const engaged = this.state === 'combat' || this.state === 'suspicious' || (this.state === 'investigate' && this.investigatePhase !== 'move') || (this.state === 'follow' && this.lookTarget);
    if (engaged && this.lookTarget && this.speed < 0.3) targetYaw = Math.atan2(this.lookTarget.x - this.pos.x, this.lookTarget.z - this.pos.z);
    this.yaw += clamp(angleDiff(this.yaw, targetYaw), -dt * 4.5, dt * 4.5);
    this.object.rotation.y = this.yaw;
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
    const sf = this.surface;
    const s = sf === 'asphalt' ? 'step_asphalt' : sf === 'metal' ? 'step_metal' : sf === 'wood' ? 'step_wood' : sf === 'grass' ? 'step_grass' : sf === 'gravel' || sf === 'rock' ? 'step_gravel' : sf === 'dirt' ? 'step_dirt' : 'step_concrete';
    g.audio.play(s, { pos: this.pos, volume: 0.55 * loud * (this.friendly ? 0.6 : 1), ref: 3, rolloff: 1.3, reverb: 0.25, priority: 'low', indoor: g.isIndoors(this.pos.x, this.pos.y, this.pos.z) ? 1 : 0, occluded: d > 6 && !this.visibleToListener() });
  }

  // ------------------------------------------------------------------ aiming & shooting

  updateAim(dt) {
    const g = this.game, T = this.target;
    let tYaw = this.yaw + this.headYaw * 0.6, tPitch = 0;
    if (this.state !== 'idle' && this.state !== 'patrol') this.headYaw = damp(this.headYaw, 0, 3, dt);
    else if (this.state === 'idle') { this.lookAroundT += dt; this.headYaw = Math.sin(this.lookAroundT * 0.35) * 0.55 + Math.sin(this.lookAroundT * 0.13) * 0.3; }
    else this.headYaw = damp(this.headYaw, 0, 2, dt);
    const tgt = this.state === 'combat' && this.canSee && T ? T.pos : this.lookTarget;
    if (tgt) {
      const eye = this.eye(_a);
      const ty = T && tgt === T.pos ? T.pos.y + T.height * 0.7 : tgt.y + 1.2;
      const dx = tgt.x - eye.x, dz = tgt.z - eye.z;
      tYaw = Math.atan2(dx, dz);
      tPitch = Math.atan2(ty - eye.y, Math.hypot(dx, dz));
    }
    const rate = this.state === 'combat' ? 5.5 : 2.5;
    this.aimYaw += clamp(angleDiff(this.aimYaw, tYaw), -dt * rate, dt * rate);
    this.aimPitch = damp(this.aimPitch, clamp(tPitch, -0.8, 0.8), 6, dt);
    if (this.canSee && this.state === 'combat') this.settle = Math.max(0, this.settle - dt / 1.8);
    else this.settle = Math.min(1, this.settle + dt * 0.35);
    const wantReady = this.state === 'combat' || this.state === 'investigate' || this.state === 'search' || this.state === 'suspicious' || this.state === 'hunt';
    this.ready = damp(this.ready, wantReady ? 1 : this.state === 'follow' ? 0.45 : 0, 5, dt);
    const twist = angleDiff(this.yaw, this.aimYaw);
    if (Math.abs(twist) > 1.2 && this.speed < 0.3) this.yaw += clamp(twist, -dt * 5, dt * 5);
  }

  updateWeapon(dt) {
    const g = this.game, T = this.target;
    this.fireCD -= dt;
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) { this.mag = this.profile.mag || 30; g.audio.play('magIn', { pos: this.pos, volume: 0.45, ref: 2, reverb: 0.2, priority: 'low' }); }
      return;
    }
    let shooting = this.state === 'combat' && this.canSee && T && (this.sub === 'engage' || this.sub === 'peek' || (this.sub === 'toCover' && this.profile.aggression > 0.65) || this.sub === 'advance');
    // recon rules of engagement: hold fire until compromised, a mark, self-defence or close contact
    if (shooting && this.friendly && g.mode === 'mountain' && !g.world.survival.weaponsFree) {
      const self = g.time - this.lastHurt < 5 || g.time - this.markT < 12 || T.pos.distanceTo(this.pos) < 60;
      if (!self) shooting = false;
    }
    if (!shooting) { this.reaction = Math.max(this.reaction, 0.15); return; }
    const aimErr = Math.abs(angleDiff(this.aimYaw, Math.atan2(T.pos.x - this.pos.x, T.pos.z - this.pos.z)));
    if (aimErr > 0.25) return;
    if (this.reaction > 0) { this.reaction -= dt; return; }
    if (this.burstLeft <= 0) {
      this.burstGap -= dt;
      if (this.burstGap > 0) return;
      this.burstLeft = randInt(...this.profile.burst);
    }
    if (this.fireCD > 0) return;
    if (this.mag <= 0) { this.startReload(); return; }
    if (!this.shoot()) { this.fireCD = 0.4; return; }
    this.burstLeft--;
    this.fireCD = (60 / this.profile.rpm) * rand(1.0, 1.3);
    if (this.burstLeft <= 0) this.burstGap = rand(...this.profile.burstGap);
  }

  startReload() {
    this.reloadT = rand(2.2, 2.8);
    this.game.audio.play('magOut', { pos: this.pos, volume: 0.45, ref: 2, reverb: 0.2, priority: 'low' });
    if (this.friendly && this.game.mode === 'mountain') this.game.world.survival.callout(this, 'reload');
    else if (Math.random() < 0.5) this.say('chatter', 0.7);
    if (this.sub === 'engage' || this.sub === 'peek') { if (!this.seekCover(true)) this.backToCover(); }
  }

  muzzleWorld(out) {
    this.model.rifle.updateWorldMatrix(true, false);
    return out.copy(this.muzzleLocal).applyMatrix4(this.model.rifle.matrixWorld);
  }

  /** Team-mates within a metre of the line of fire block the shot. */
  lineBlocked(from, to) {
    const g = this.game;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, L = Math.hypot(dx, dy, dz) || 1;
    const check = (p) => {
      const px = p.x - from.x, py = p.y + 1.1 - from.y, pz = p.z - from.z;
      const t = (px * dx + py * dy + pz * dz) / L;
      if (t < 0.5 || t > L - 0.5) return false;
      const d2 = px * px + py * py + pz * pz - t * t;
      return d2 < 1.1 * 1.1;
    };
    for (const e of g.soldiers) if (e !== this && e.alive && e.team === this.team && check(e.pos)) return true;
    if (this.friendly && g.player.alive && check(g.player.pos)) return true;
    return false;
  }

  shoot() {
    const g = this.game, T = this.target, P = g.player;
    const muzzle = this.muzzleWorld(new THREE.Vector3());
    const isPlayer = T === P;
    const aimHead = Math.random() < (this.profile.weapon === 'svd' || this.profile.weapon === 'dmr' ? 0.18 : 0.06);
    const lean = isPlayer ? P.leanOffset : 0;
    const tp = _b.set(T.pos.x + lean * Math.cos(T.yaw), T.pos.y + (aimHead ? T.eyeHeight : T.height * (T.proneT > 0.5 ? 0.35 : 0.62)), T.pos.z - lean * Math.sin(T.yaw));
    if (this.lineBlocked(muzzle, tp)) return false;
    const pr = this.profile;
    if (g.world.ballistics && pr.velocity) {
      // hold-over and lead from an estimated range (the estimate is where marksmen differ)
      const dist = muzzle.distanceTo(tp);
      const est = dist * (1 + gaussian() * (pr.rangeErr || 0.1) * clamp(dist / 300, 0.2, 1.5));
      const fl = g.ballistics.predict(pr.velocity, pr.drag, Math.max(5, est));
      tp.y += fl.drop;
      const lk = (pr.lead || 0.6) * (0.8 + Math.random() * 0.4);
      tp.x += T.vel.x * fl.t * lk;
      tp.z += T.vel.z * fl.t * lk;
    }
    const dir = _a.subVectors(tp, muzzle).normalize();
    this.mag--;
    this.shots++;
    this.lastShotT = g.time;
    if (this.sub === 'peek') this.peekShots++;
    let spread = pr.spread * this.diff.spread;
    spread *= 1 + this.settle * 3;
    if (T.speed > 2.5) spread *= 1.35;
    if (T.speed > 4.5) spread *= 1.3;
    if (this.speed > 0.5) spread *= 2.0;
    if (this.suppressedT > 0) spread *= 1.8;
    if (g.time - this.lastHurt < 0.8) spread *= 1.6;
    if (T.crouching) spread *= 1.1;
    if (this.crouch > 0.5 && this.open) spread *= 0.8;
    if (this.open) {
      // long shots at people who move or hug the ground are hard
      spread *= 1 + muzzle.distanceTo(tp) / 650;
      if (T.proneT > 0.5) spread *= 1.35;
      spread *= 1 + Math.min(1.5, T.speed * 0.25);
    }
    spread *= 0.85 + Math.min(1, this.shots * 0.02);
    const e1 = gaussian() * spread * 0.75 * DEG, e2 = gaussian() * spread * 0.75 * DEG;
    const right = _w.set(dir.z, 0, -dir.x).normalize();
    dir.addScaledVector(right, Math.tan(e1));
    dir.y += Math.tan(e2);
    dir.normalize();
    const wdef = this.wdef || (this.wdef = {
      id: 'ai-' + (pr.weapon || 'm4'), damage: pr.damage, headMult: 1.6, limbMult: 0.8, range: pr.range || 250,
      velocity: pr.velocity, drag: pr.drag,
    });
    wdef.damage = pr.damage * (this.friendly ? 1 : this.diff.damage);
    wdef.headMult = isPlayer ? 1.6 : 3.2;
    g.fireBullet(muzzle, dir, wdef, this, true);
    // presentation
    const camD = muzzle.distanceTo(g.camera.position);
    if (camD < 900) {
      g.effects.worldMuzzleFlash(muzzle, dir, 1);
      if (camD < 120) g.effects.flashLight('enemy', muzzle, 14, 0.05);
      if (this.shots % 3 === 0 && camD < 60) g.effects.muzzleSparks(muzzle, dir, 2);
      if (this.open && camD < 400) g.effects.muzzleSmoke(muzzle, dir, 1);
    }
    this.recoilZ.impulse(-1.2);
    const indoor = g.isIndoors(this.pos.x, this.pos.y, this.pos.z) ? 1 : 0;
    const sound = this.open ? SHOT_SOUND[pr.weapon] || 'enemyShot' : 'enemyShot';
    g.audio.play(sound, { pos: muzzle, volume: 1.0, ref: 6, rolloff: 0.9, reverb: 0.8, indoor, soundDelay: true, occluded: camD < 200 && !this.visibleToListener(), distant: this.open });
    if (!this.friendly && (!this.open || camD < 350)) g.hud.ping(this.pos);
    g.emitNoise(this.pos, pr.noise || 30, 'enemyShot', this.team, this);
    if (camD < 20) {
      this.model.rifle.updateWorldMatrix(true, false);
      const ej = _w.set(0.03, 0.04, -0.05).applyMatrix4(this.model.rifle.matrixWorld);
      const side = _v.set(-Math.cos(this.aimYaw), 0.8, Math.sin(this.aimYaw)).multiplyScalar(rand(1.2, 2));
      g.effects.shells.spawn('brass', ej, side, camD < 10);
    }
    return true;
  }

  // ------------------------------------------------------------------ damage

  /** Ray vs hit spheres attached to bones. Returns shared hit or null. */
  raycast(o, d, maxT) {
    if (!this.alive || !this.active) return null;
    const cx = this.pos.x, cy = this.pos.y + 0.95, cz = this.pos.z;
    const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
    const bb = ox * d.x + oy * d.y + oz * d.z, cc = ox * ox + oy * oy + oz * oz - 1.15 * 1.15;
    if (bb > 0 && cc > 0) return null;
    if (bb * bb - cc < 0) return null;
    if (-bb - 1.2 > maxT) return null;
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

  takeDamage(amount, zone, dir, shooterPos, shooter) {
    if (!this.alive) return false;
    const g = this.game;
    this.health -= amount;
    this.lastHurt = g.time;
    this.killer = shooter;
    this.flinchX.impulse(zone === 'head' ? -4 : rand(1.5, 3.5));
    this.flinchZ.impulse(rand(-3, 3));
    this.pos.x += dir.x * 0.04; this.pos.z += dir.z * 0.04;
    this.settle = Math.min(1, this.settle + 0.45);
    this.reaction = Math.max(this.reaction, 0.25);
    if (this.health <= 0) { this.die(dir, zone === 'head'); return true; }
    if (Math.random() < 0.65) { this.voiceCD = 0; this.say('grunt', 1); }
    const src = shooter === 'player' ? g.player : shooter;
    if (src && g.teamOf(src) === this.team) return false; // friendly fire: flinch, no retaliation
    if (this.friendly && g.mode === 'mountain') g.world.survival.callout(this, 'hit');
    this.awareness = 1.2;
    this.lastKnown.copy(shooterPos);
    this.lastSeen = g.time;
    if (src && src.alive !== false) this.target = src;
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
    const opts = [Math.atan2(dir.x, dir.z), Math.atan2(dir.x, dir.z) + 0.6, Math.atan2(dir.x, dir.z) - 0.6, Math.atan2(-dir.x, -dir.z), Math.atan2(dir.z, -dir.x), Math.atan2(-dir.z, dir.x)];
    let fallYaw = null;
    for (const a of opts) {
      const fx = Math.sin(a), fz = Math.cos(a);
      if (!g.physics.raycast(this.pos.x, this.pos.y + 0.5, this.pos.z, fx, 0, fz, 1.8, 'move') && !g.physics.raycast(this.pos.x, this.pos.y + 1.1, this.pos.z, fx, 0, fz, 1.8, 'move')) { fallYaw = a; break; }
    }
    const slump = fallYaw === null;
    if (slump) fallYaw = Math.atan2(dir.x, dir.z);
    const local = fallYaw - this.yaw;
    this.fall = { local, slump, twist: rand(-0.5, 0.5), limbs: [rand(-1, 1), rand(-1, 1), rand(-1, 1), rand(-1, 1)], soundDone: false };
    if (!headshot) g.audio.play('death', { pos: this.headPos(_w), volume: 0.6, ref: 2.5, reverb: 0.4, indoor: g.isIndoors(this.pos.x, this.pos.y, this.pos.z) ? 1 : 0 });
    this.dropRifle(dir);
    g.onSoldierKilled(this, headshot, this.killer);
  }

  dropRifle(dir) {
    const r = this.model.rifle, g = this.game;
    r.updateWorldMatrix(true, false);
    r.matrixWorld.decompose(_v, _q, _w);
    this.scene.add(r);
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
    if (t > 6 && this.fallDone) return;
    const hs = this.headshot ? 1.35 : 1;
    const buckle = clamp(t * 4 * hs, 0, 1);
    const tipK = clamp((t * hs - 0.12) / 0.62, 0, 1);
    const tip = easeInQuad(tipK) * (f.slump ? 1.0 : 1.52);
    const settle = tipK >= 1 ? Math.max(0, Math.sin(Math.min(1, (t * hs - 0.74) / 0.25) * Math.PI) * 0.06) : 0;
    const dirSign = Math.cos(f.local) >= 0 ? 1 : -1;
    const fx = Math.cos(f.local), fz = Math.sin(f.local);
    this.body.rotation.set((tip - settle) * fx, f.twist * tipK, -(tip - settle) * fz, 'YXZ');
    this.body.position.y = lerp(0, f.slump ? 0.05 : 0.14, tipK);
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
      this.game.audio.play('bodyfall', { pos: this.pos, volume: 0.7, ref: 2, reverb: 0.35, indoor: this.game.isIndoors(this.pos.x, this.pos.y, this.pos.z) ? 1 : 0 });
      this.game.effects.puff(_v.set(this.pos.x, this.pos.y + 0.05, this.pos.z), _w.set(0, 1, 0), 3, [0.35, 0.33, 0.3], 0.3, 1.2);
    }
    if (t > 1.6 && !f.pool) { f.pool = true; this.game.effects.bloodPool(this.chestWorld(_v)); }
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
    if (t > 6 && (!d || d.done)) this.fallDone = true;
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
    const rel = this.speed > 0.2 ? Math.atan2(this.vel.x, this.vel.z) - this.yaw : 0;
    const mx = Math.sin(rel), mz = Math.cos(rel);
    const axis = _a.set(mz, 0, -mx).normalize();
    const hipsBob = Math.abs(Math.sin(ph)) * 0.035 * moving - 0.02 * moving - run * 0.03;
    B.hips.position.set(0, R[1].y + hipsBob - kneel * 0.44 - crouchWalk * 0.24, 0);
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
      _q.setFromEuler(new THREE.Euler(-0.05 * kneel, 0, 0.05 * kneel));
      B.thighL.quaternion.slerp(_q, kneel);
      B.shinL.rotation.x = lerp(B.shinL.rotation.x, 1.55, kneel);
      _q.setFromEuler(new THREE.Euler(-1.4 * kneel, 0, -0.12 * kneel));
      B.thighR.quaternion.slerp(_q, kneel);
      B.shinR.rotation.x = lerp(B.shinR.rotation.x, 1.42, kneel);
    }
    B.footL.rotation.set(-B.shinL.rotation.x * 0.3, 0, 0);
    B.footR.rotation.set(-B.shinR.rotation.x * 0.3, 0, 0);
    const twist = clamp(angleDiff(this.yaw, this.aimYaw), -1.2, 1.2);
    const pitch = this.aimPitch * this.ready;
    const fl = this.flinchX.update(dt || 0), flz = this.flinchZ.update(dt || 0), rk = this.recoilZ.update(dt || 0);
    const lean = run * 0.18 + kneel * 0.1 + crouchWalk * 0.2;
    B.spine.rotation.set(-pitch * 0.35 + lean + fl * 0.05, twist * 0.45, flz * 0.04, 'YXZ');
    B.chest.rotation.set(-pitch * 0.55 + fl * 0.04, twist * 0.45, flz * 0.03, 'YXZ');
    B.neck.rotation.set(-pitch * 0.1, this.state === 'idle' ? this.headYaw * 0.5 : twist * 0.1, 0);
    B.head.rotation.set(0, this.state === 'idle' || this.state === 'patrol' || this.state === 'hunt' ? this.headYaw * 0.5 : 0, 0);
    const h = this.model.holder;
    h.rotation.set(lerp(0.75, 0, this.ready), lerp(0.35, 0, this.ready), 0);
    h.position.set(-0.1, 0.06, 0.3 + rk * 0.02);
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
