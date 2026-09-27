// First-person player: look, stance, acceleration-based movement, stairs, lean, head bob, damage.
import * as THREE from 'three';
import { PLAYER } from './config.js';
import { clamp, damp, lerp, Spring, DEG, easeInOutSine } from './util.js';

const _v = new THREE.Vector3();

export class Player {
  constructor(physics) {
    this.physics = physics;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.eye = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.punchPitch = new Spring(160, 16);
    this.punchYaw = new Spring(160, 16);
    this.punchRoll = new Spring(120, 12);
    this.landSpring = new Spring(140, 13);
    this.floorInfo = { y: 0, surface: 'concrete' };
    this.reset({ x: 0, y: 0, z: 0, yaw: 0 });
  }

  reset(spawn) {
    this.pos.set(spawn.x, spawn.y || 0, spawn.z);
    this.vel.set(0, 0, 0);
    this.yaw = spawn.yaw || 0;
    this.pitch = 0;
    this.recoilPitch = this.recoilYaw = 0;
    this.punchPitch.reset(); this.punchYaw.reset(); this.punchRoll.reset(); this.landSpring.reset();
    this.crouching = false;
    this.crouchToggle = false;
    this.crouchT = 0;
    this.height = PLAYER.standHeight;
    this.eyeHeight = PLAYER.standEye;
    this.stepSmooth = 0;
    this.grounded = true;
    this.surface = 'concrete';
    this.lean = 0;
    this.leanOffset = 0;
    this.health = PLAYER.maxHealth;
    this.alive = true;
    this.deathT = 0;
    this.sprinting = false;
    this.speed = 0;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.stepDist = 0;
    this.airTime = 0;
    this.lastHitTime = -10;
    this.lookDX = 0;
    this.lookDY = 0;
  }

  // ------------------------------------------------------------------ per-frame

  update(dt, input, ctx) {
    if (!this.alive) { this.updateDeath(dt); return; }
    this.updateLook(input, ctx);
    this.updateStance(dt, input);
    this.updateMovement(dt, input, ctx);
    this.updateLean(dt, input);
    this.updateBob(dt, ctx);
    this.updateRecoilRecovery(dt, ctx);
  }

  updateLook(input, ctx) {
    const l = input.consumeLook();
    const s = ctx.settings;
    let k = l.source === 'touch' ? 0.0052 * s.touchSens : 0.0021 * s.mouseSens;
    k *= lerp(1, s.adsSensMul / ctx.adsZoom, ctx.adsBlend);
    k *= ctx.aimFriction || 1;
    const dx = l.x * k, dy = l.y * k * (s.invertY ? -1 : 1);
    this.yaw -= dx;
    this.pitch = clamp(this.pitch - dy, -1.5, 1.5);
    this.lookDX = dx;
    this.lookDY = dy;
  }

  updateStance(dt, input) {
    if (input.consumeTap('crouchToggle')) this.crouchToggle = !this.crouchToggle;
    let want = input.isDown('crouch') || this.crouchToggle || (input.touchToggles && input.touchToggles.crouch);
    if (!want && this.crouchT > 0.05) {
      // cannot stand up under something
      if (this.physics.overlaps(this.pos.x, this.pos.y + 0.1, this.pos.z, PLAYER.radius * 0.9, PLAYER.standHeight - 0.1)) want = true;
    }
    this.crouching = want;
    this.crouchT = damp(this.crouchT, want ? 1 : 0, 10, dt);
    const e = easeInOutSine(this.crouchT);
    this.height = lerp(PLAYER.standHeight, PLAYER.crouchHeight, e);
    this.eyeHeight = lerp(PLAYER.standEye, PLAYER.crouchEye, e);
  }

  updateMovement(dt, input, ctx) {
    const mv = input.getMove();
    const mag = Math.min(1, Math.hypot(mv.x, mv.y));
    const wantSprint = input.isDown('sprint') && mv.y > 0.35 && !this.crouching && this.grounded && !ctx.blockSprint;
    this.sprinting = wantSprint && mag > 0.2;
    if (this.sprinting && this.crouchToggle) this.crouchToggle = false;
    let maxSpeed = this.crouching ? PLAYER.crouchSpeed : this.sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
    maxSpeed *= lerp(1, PLAYER.adsSpeedMul, ctx.adsBlend) * ctx.weaponMoveMul;
    if (ctx.lowHealth) maxSpeed *= 0.9;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wx = -sin * mv.y + cos * mv.x, wz = -cos * mv.y - sin * mv.x;
    const wl = Math.hypot(wx, wz) || 1;
    const tx = (wx / wl) * maxSpeed * mag, tz = (wz / wl) * maxSpeed * mag;
    const accel = this.grounded ? (mag > 0.05 ? PLAYER.accel : PLAYER.accel * 1.25) : PLAYER.airAccel;
    this.vel.x = damp(this.vel.x, tx, accel, dt);
    this.vel.z = damp(this.vel.z, tz, accel, dt);

    if (this.grounded && input.consumeTap('jump') && !this.crouching) {
      this.vel.y = PLAYER.jumpVel;
      this.grounded = false;
      if (ctx.onJump) ctx.onJump();
    } else {
      input.consumeTap('jump');
    }
    this.vel.y -= PLAYER.gravity * dt;

    // horizontal integration in sub-steps so fast movement never tunnels through thin colliders
    const steps = Math.max(1, Math.ceil((Math.hypot(this.vel.x, this.vel.z) * dt) / 0.15));
    const prevY = this.pos.y;
    for (let i = 0; i < steps; i++) {
      this.pos.x += (this.vel.x * dt) / steps;
      this.pos.z += (this.vel.z * dt) / steps;
      this.physics.resolveCircle(this.pos, PLAYER.radius, this.height, PLAYER.stepUp);
      ctx.pushFromEnemies && ctx.pushFromEnemies(this.pos, PLAYER.radius);
    }
    this.pos.y += this.vel.y * dt;
    const floor = this.physics.floorAt(this.pos.x, this.pos.z, Math.max(this.pos.y, prevY) + PLAYER.stepUp, this.floorInfo);
    const wasGrounded = this.grounded;
    if (this.pos.y <= floor.y) {
      if (!wasGrounded) this.onLand(-this.vel.y, ctx);
      const stepUp = floor.y - this.pos.y;
      if (wasGrounded && stepUp > 0.02) this.stepSmooth -= stepUp;
      this.pos.y = floor.y;
      this.vel.y = 0;
      this.grounded = true;
    } else if (wasGrounded && this.vel.y <= 0 && this.pos.y - floor.y < 0.45) {
      this.stepSmooth += this.pos.y - floor.y;
      this.pos.y = floor.y;
      this.vel.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
    this.surface = floor.surface;
    this.airTime = this.grounded ? 0 : this.airTime + dt;
    this.stepSmooth = damp(this.stepSmooth, 0, 14, dt);
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    if (this.pos.y < -5) this.pos.set(this.pos.x, 0.1, this.pos.z);
  }

  onLand(impactSpeed, ctx) {
    if (impactSpeed > 2.5) {
      this.landSpring.impulse(-Math.min(impactSpeed, 8) * 0.12);
      if (ctx.onLand) ctx.onLand(impactSpeed, this.surface);
    }
  }

  updateLean(dt, input) {
    let target = 0;
    if (!this.sprinting) {
      if (input.isDown('leanL')) target -= 1;
      if (input.isDown('leanR')) target += 1;
    }
    this.lean = damp(this.lean, target, 9, dt);
    // limit the lean offset so the camera never pokes through walls
    const want = this.lean * PLAYER.leanDist;
    if (Math.abs(want) > 0.01) {
      const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
      const sgn = Math.sign(want);
      const ey = this.pos.y + this.eyeHeight;
      const hit = this.physics.raycast(this.pos.x, ey, this.pos.z, rx * sgn, 0, rz * sgn, Math.abs(want) + 0.25, 'move');
      const maxD = hit ? Math.max(0, hit.t - 0.25) : Math.abs(want);
      this.leanOffset = sgn * Math.min(Math.abs(want), maxD);
    } else this.leanOffset = want;
  }

  updateBob(dt, ctx) {
    const moving = this.grounded && this.speed > 0.4;
    if (moving) {
      const stride = this.sprinting ? 1.05 : this.crouching ? 0.6 : 0.78;
      this.bobPhase += (this.speed * dt / stride) * Math.PI;
      this.stepDist += this.speed * dt;
      if (this.stepDist >= stride) {
        this.stepDist -= stride;
        if (ctx.onFootstep) ctx.onFootstep(this.surface, this.sprinting ? 1 : this.crouching ? 0.25 : 0.6);
      }
    } else {
      this.stepDist = Math.min(this.stepDist, 0.5);
    }
    const target = moving ? clamp(this.speed / PLAYER.walkSpeed, 0, 1.7) : 0;
    this.bobAmount = damp(this.bobAmount, target, 7, dt);
    this.landSpring.update(dt);
  }

  updateRecoilRecovery(dt, ctx) {
    const rate = ctx.recoilRecover || 7;
    if (!ctx.firing) {
      this.recoilPitch = damp(this.recoilPitch, 0, rate, dt);
      this.recoilYaw = damp(this.recoilYaw, 0, rate, dt);
    }
    this.punchPitch.update(dt);
    this.punchYaw.update(dt);
    this.punchRoll.update(dt);
  }

  addRecoil(pitch, yaw, permanentFrac) {
    this.pitch = clamp(this.pitch + pitch * permanentFrac, -1.5, 1.5);
    this.yaw += yaw * permanentFrac;
    this.recoilPitch += pitch * (1 - permanentFrac);
    this.recoilYaw += yaw * (1 - permanentFrac);
  }

  // ------------------------------------------------------------------ damage & death

  damage(amount, fromDir, time) {
    if (!this.alive) return false;
    this.health = Math.max(0, this.health - amount);
    this.lastHitTime = time;
    const s = Math.min(1, amount / 25);
    this.punchPitch.impulse((Math.random() * 0.5 + 0.5) * 0.9 * s);
    this.punchYaw.impulse((Math.random() - 0.5) * 1.2 * s);
    this.punchRoll.impulse((Math.random() - 0.5) * 1.5 * s);
    if (this.health <= 0) {
      this.alive = false;
      this.deathT = 0;
      this.deathRollDir = Math.random() < 0.5 ? -1 : 1;
      return true;
    }
    return false;
  }

  heal(amount) { this.health = Math.min(PLAYER.maxHealth, this.health + amount); }

  updateDeath(dt) {
    this.deathT += dt;
    this.vel.set(0, 0, 0);
  }

  // ------------------------------------------------------------------ camera

  eyePosition(out = this.eye) {
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    out.set(this.pos.x + rx * this.leanOffset, this.pos.y + this.eyeHeight + this.stepSmooth, this.pos.z + rz * this.leanOffset);
    return out;
  }

  applyCamera(camera, adsBlend) {
    this.eyePosition(_v);
    const bobK = this.bobAmount * (1 - adsBlend * 0.75);
    const s1 = Math.sin(this.bobPhase), s2 = Math.sin(this.bobPhase * 2);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    let y = _v.y + s2 * 0.022 * bobK + this.landSpring.x;
    let x = _v.x + rx * s1 * 0.014 * bobK, z = _v.z + rz * s1 * 0.014 * bobK;
    let roll = -this.lean * PLAYER.leanRoll * DEG + s1 * 0.3 * DEG * bobK + this.punchRoll.x * DEG;
    let pitch = this.pitch + this.recoilPitch + this.punchPitch.x * DEG + s2 * 0.25 * DEG * bobK;
    let yaw = this.yaw + this.recoilYaw + this.punchYaw.x * DEG;
    if (!this.alive) {
      const t = Math.min(1, this.deathT / 1.1), e = t * t * (3 - 2 * t);
      y = lerp(y, this.pos.y + 0.28, e);
      roll = lerp(roll, this.deathRollDir * 1.35, e);
      pitch = lerp(pitch, -0.25, e);
    }
    camera.position.set(x, y, z);
    camera.rotation.set(pitch, yaw, roll, 'YXZ');
  }

  forward(out) {
    const cp = Math.cos(this.pitch + this.recoilPitch);
    const yaw = this.yaw + this.recoilYaw;
    return out.set(-Math.sin(yaw) * cp, Math.sin(this.pitch + this.recoilPitch), -Math.cos(yaw) * cp);
  }
}
