// Player weapon handling: firing, spread, recoil, reloads (chamber aware), shotgun pump & shell loading,
// ADS / sprint blending, weapon switching and the data the view model animates from.
import * as THREE from 'three';
import { WEAPONS, WEAPON_ORDER, PLAYER } from './config.js';
import { clamp, damp, lerp, gaussian, rand, DEG } from './util.js';
import { RELOAD_TRACKS } from './viewmodel.js';

const _dir = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3();
const _p = new THREE.Vector3(), _q = new THREE.Vector3();

export class WeaponSystem {
  constructor(game) {
    this.game = game;
    this.reset();
  }

  reset() {
    this.ammo = {};
    for (const id of WEAPON_ORDER) {
      const d = WEAPONS[id];
      this.ammo[id] = { mag: d.mag, reserve: d.reserve, mode: d.auto ? 'auto' : 'semi', needsPump: false };
    }
    this.currentId = 'rifle';
    this.pendingId = null;
    this.action = 'idle';
    this.actionT = 0;
    this.actionDur = 0;
    this.reloadEmpty = false;
    this.soundsFired = new Set();
    this.cooldown = 0;
    this.adsBlend = 0;
    this.sprintBlend = 0;
    this.lower = 0;
    this.bloom = 0;
    this.burst = 0;
    this.lastShot = -10;
    this.triggerPrev = false;
    this.dryClicked = false;
    this.slideBack = 0;
    this.pumpT = -1;
    this.pumpDelay = 0;
    this.sg = null;
    this.wall = 0;
    this.blockSprintT = 0;
    this.firingRecent = false;
    this.adsWas = false;
    if (this.game.viewmodel) this.game.viewmodel.setWeapon('rifle');
  }

  get def() { return WEAPONS[this.currentId]; }
  get state() { return this.ammo[this.currentId]; }

  // ------------------------------------------------------------------ per-frame

  update(dt, input, time) {
    const g = this.game, P = g.player;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.blockSprintT = Math.max(0, this.blockSprintT - dt);
    this.bloom = damp(this.bloom, 0, time - this.lastShot > 0.12 ? 5 : 0.5, dt);
    if (time - this.lastShot > 0.32) this.burst = 0;
    this.firingRecent = time - this.lastShot < 0.14;

    if (!P.alive) { this.adsBlend = damp(this.adsBlend, 0, 10, dt); return; }

    this.handleSwitchInput(input);
    this.updateAction(dt, input);
    this.updateAds(dt, input);
    this.updateTrigger(input, time);
    if (input.consumeTap('reload')) this.startReload();
    if (input.consumeTap('firemode')) this.toggleMode();
    this.updateSlide(dt);
    this.updateWall(dt);
  }

  handleSwitchInput(input) {
    let target = null;
    if (input.consumeTap('weapon1')) target = 'rifle';
    if (input.consumeTap('weapon2')) target = 'pistol';
    if (input.consumeTap('weapon3')) target = 'shotgun';
    const idx = WEAPON_ORDER.indexOf(this.pendingId || this.currentId);
    if (input.consumeTap('nextWeapon')) target = WEAPON_ORDER[(idx + 1) % WEAPON_ORDER.length];
    if (input.consumeTap('prevWeapon')) target = WEAPON_ORDER[(idx + WEAPON_ORDER.length - 1) % WEAPON_ORDER.length];
    if (target) this.switchTo(target);
  }

  switchTo(id) {
    if (id === this.currentId && this.action !== 'switchOut') return;
    if (this.action === 'switchOut') { this.pendingId = id; return; }
    this.cancelReload();
    this.pendingId = id;
    this.action = 'switchOut';
    this.actionT = 0;
    this.actionDur = this.def.switchTime * 0.42;
    this.game.audio.play('draw', { volume: 0.35, reverb: 0.05, rate: 1.15 });
  }

  cancelReload() {
    if (this.action === 'reload') { this.action = 'idle'; this.game.viewmodel.resetParts(); }
    if (this.action === 'sgReload') { this.action = 'idle'; this.sg = null; }
  }

  updateAction(dt, input) {
    const g = this.game;
    if (this.action === 'idle') { this.lower = damp(this.lower, 0, 14, dt); }
    this.actionT += dt;
    const k = this.actionDur > 0 ? clamp(this.actionT / this.actionDur, 0, 1) : 1;
    switch (this.action) {
      case 'switchOut':
        this.lower = k;
        if (k >= 1) {
          this.currentId = this.pendingId;
          this.pendingId = null;
          g.viewmodel.setWeapon(this.currentId);
          this.action = 'switchIn';
          this.actionT = 0;
          this.actionDur = this.def.switchTime * 0.58;
          this.slideBack = this.currentId === 'pistol' && this.state.mag === 0 ? 1 : 0;
          g.audio.play('draw', { volume: 0.45, reverb: 0.05 });
          g.hudDirty = true;
        }
        break;
      case 'switchIn':
        this.lower = 1 - k;
        if (k >= 1) { this.action = 'idle'; this.lower = 0; }
        break;
      case 'reload': this.updateReload(k); break;
      case 'sgReload': this.updateShotgunReload(dt, input); break;
      default: break;
    }
    // pump cycle (shotgun)
    if (this.pumpDelay > 0) {
      this.pumpDelay -= dt;
      if (this.pumpDelay <= 0) { this.pumpT = 0; this.soundsFired.clear(); }
    }
    if (this.pumpT >= 0) {
      this.pumpT += dt / WEAPONS.shotgun.pumpTime;
      const t = this.pumpT;
      if (t > 0.18 && !this.soundsFired.has('pb')) { this.soundsFired.add('pb'); g.audio.play('pumpBack', { volume: 0.7, reverb: 0.1 }); }
      if (t > 0.36 && !this.soundsFired.has('ej')) { this.soundsFired.add('ej'); if (this.ejectHull) this.ejectShell('shell12'); this.ejectHull = false; }
      if (t > 0.58 && !this.soundsFired.has('pf')) { this.soundsFired.add('pf'); g.audio.play('pumpFwd', { volume: 0.7, reverb: 0.1 }); }
      if (t >= 1) { this.pumpT = -1; this.ammo.shotgun.needsPump = false; }
    }
  }

  // ------------------------------------------------------------------ reloads

  startReload() {
    const d = this.def, s = this.state;
    if (this.action !== 'idle' || s.reserve <= 0 || this.pumpT >= 0 || this.pumpDelay > 0) return;
    const cap = d.mag + (d.chamber && s.mag > 0 ? 1 : 0);
    if (s.mag >= cap) return;
    if (d.id === 'shotgun') {
      if (s.mag >= d.mag) return;
      this.action = 'sgReload';
      this.sg = { stage: 'start', t: 0, tilt: 0, shellT: -1, emptyStart: s.mag === 0 || s.needsPump, stopRequested: false };
      this.game.audio.play('adsIn', { volume: 0.4, reverb: 0 });
      return;
    }
    this.action = 'reload';
    this.actionT = 0;
    this.reloadEmpty = s.mag === 0;
    this.actionDur = this.reloadEmpty ? d.reloadEmptyTime : d.reloadTime;
    this.soundsFired.clear();
    this.game.input.setToggle('ads', false);
  }

  updateReload(k) {
    const d = this.def, s = this.state, T = RELOAD_TRACKS[d.id];
    const list = this.reloadEmpty ? [...T.sounds, ...T.emptySounds] : T.sounds;
    for (const [t, name] of list) {
      if (k >= t && !this.soundsFired.has(name)) {
        this.soundsFired.add(name);
        this.game.audio.play(name, { volume: 0.75, reverb: 0.12 });
        if (name === 'magIn') this.game.emitNoise(this.game.player.pos, 7, 'reload');
      }
    }
    if (this.reloadEmpty && d.id === 'pistol' && k > 0.8) this.slideBack = 0;
    if (k >= 1) {
      const cap = d.mag + (d.chamber && !this.reloadEmpty ? 1 : 0);
      const take = Math.min(cap - s.mag, s.reserve);
      s.mag += take;
      s.reserve -= take;
      this.action = 'idle';
      this.game.hudDirty = true;
    }
  }

  updateShotgunReload(dt, input) {
    const sg = this.sg, d = WEAPONS.shotgun, s = this.ammo.shotgun, g = this.game;
    sg.t += dt;
    if (input.isDown('fire') && s.mag > 0) sg.stopRequested = true;
    if (sg.stage === 'start') {
      sg.tilt = clamp(sg.t / d.reloadStart, 0, 1);
      if (sg.t >= d.reloadStart) { sg.stage = 'shell'; sg.t = 0; sg.inserted = false; }
    } else if (sg.stage === 'shell') {
      sg.tilt = 1;
      sg.shellT = clamp(sg.t / d.reloadShell, 0, 1);
      if (!sg.inserted && sg.shellT > 0.6) {
        sg.inserted = true;
        s.mag++; s.reserve--;
        g.audio.play('shellIn', { volume: 0.8, reverb: 0.12 });
        g.hudDirty = true;
      }
      if (sg.t >= d.reloadShell) {
        sg.t = 0; sg.inserted = false;
        if (s.mag >= d.mag || s.reserve <= 0 || sg.stopRequested) { sg.stage = 'end'; sg.shellT = -1; }
      }
    } else if (sg.stage === 'end') {
      sg.tilt = 1 - clamp(sg.t / d.reloadEnd, 0, 1);
      if (sg.t >= d.reloadEnd) {
        this.action = 'idle';
        this.sg = null;
        if (sg.emptyStart) { this.pumpT = 0; this.soundsFired.clear(); this.ejectHull = false; }
      }
    }
  }

  // ------------------------------------------------------------------ ADS / sprint / fire

  updateAds(dt, input) {
    const P = this.game.player, d = this.def;
    const busy = this.action === 'reload' || this.action === 'sgReload' || this.action === 'switchOut' || this.action === 'switchIn';
    const want = input.isDown('ads') && !busy && !P.sprinting;
    if (want && !this.adsWas) this.game.audio.play('adsIn', { volume: 0.25, reverb: 0 });
    this.adsWas = want;
    this.adsBlend = clamp(this.adsBlend + (want ? 1 : -1) * dt / d.adsTime, 0, 1);
    const sprintTarget = P.sprinting ? 1 : 0;
    this.sprintBlend = clamp(this.sprintBlend + (sprintTarget ? 1 : -1) * dt / d.sprintOutTime, 0, 1);
    if (P.sprinting && input.touchToggles.ads) input.setToggle('ads', false);
  }

  updateTrigger(input, time) {
    const held = input.isDown('fire');
    const fresh = held && !this.triggerPrev;
    this.triggerPrev = held;
    if (!held) { this.dryClicked = false; return; }
    const g = this.game, P = g.player, d = this.def, s = this.state;
    if (P.sprinting || this.sprintBlend > 0.05) { this.blockSprintT = 0.45; return; }
    this.blockSprintT = 0.25;
    if (this.action === 'sgReload') return;
    if (this.action !== 'idle' || this.cooldown > 0 || this.pumpT >= 0 || this.pumpDelay > 0) return;
    const auto = d.auto && s.mode === 'auto';
    if (!auto && !fresh) return;
    if (s.mag <= 0) {
      if (!this.dryClicked) {
        this.dryClicked = true;
        g.audio.play('dry', { volume: 0.6, reverb: 0 });
        if (s.reserve > 0) setTimeout(() => { if (this.state.mag === 0) this.startReload(); }, 280);
      }
      return;
    }
    if (d.id === 'shotgun' && s.needsPump) return;
    this.fire(time);
  }

  fire(time) {
    const g = this.game, P = g.player, d = this.def, s = this.state, vm = g.viewmodel;
    s.mag--;
    this.cooldown = 60 / d.rpm;
    this.burst = time - this.lastShot < 0.32 ? this.burst + 1 : 0;
    this.lastShot = time;
    g.stats.shots++;
    // aim + spread
    const eye = g.camera.position;
    g.camera.getWorldDirection(_f);
    _r.crossVectors(_f, g.camera.up).normalize();
    _u.crossVectors(_r, _f).normalize();
    const spreadDeg = this.currentSpread();
    g.shotHit = false;
    for (let i = 0; i < d.pellets; i++) {
      const ang = Math.min(Math.abs(gaussian()) * 0.55, 2) * spreadDeg * DEG * (d.pellets > 1 ? 0.7 + Math.random() * 0.5 : 1);
      const az = Math.random() * Math.PI * 2;
      _dir.copy(_f).addScaledVector(_r, Math.cos(az) * Math.tan(ang)).addScaledVector(_u, Math.sin(az) * Math.tan(ang)).normalize();
      g.fireBullet(eye, _dir, d, 'player', i === 0);
    }
    if (g.shotHit) g.stats.hits++;
    this.bloom = Math.min(this.bloom + d.spread.bloomPerShot, d.spread.bloomMax);
    this.applyRecoil();
    vm.kick(d.kick, this.adsBlend);
    // audio (non-positional for your own gun) + AI noise
    g.audio.play(d.sound, { volume: 1.0, reverb: 0.95, rateVar: 0.03, indoor: g.indoorAmt });
    g.emitNoise(P.pos, d.noise, 'gunshot', true);
    // world effects
    vm.muzzleWorld(eye, _p);
    g.effects.flashLight('player', _p, d.id === 'shotgun' ? 26 : d.id === 'pistol' ? 12 : 18, 0.05);
    g.effects.muzzleSmoke(_p, _f, d.id === 'shotgun' ? 3 : 1);
    if (d.id === 'shotgun') {
      s.needsPump = true;
      this.ejectHull = true;
      this.pumpDelay = 0.14;
    } else {
      this.ejectShell(d.shell);
      if (d.id === 'pistol') this.slideBack = 1;
    }
    g.hudDirty = true;
  }

  ejectShell(kind) {
    const g = this.game, vm = g.viewmodel;
    vm.axes(_r, _u, _f);
    // world-scale ejection point to the right of the weapon (the view model itself is drawn closer than life size)
    const hip = 1 - this.adsBlend;
    _p.copy(g.camera.position).addScaledVector(_r, 0.16 + 0.08 * hip).addScaledVector(_f, 0.32).addScaledVector(_u, -0.1 - 0.06 * hip);
    _q.copy(_r).multiplyScalar(rand(1.6, 2.6)).addScaledVector(_u, rand(1.0, 2.0)).addScaledVector(_f, rand(-0.4, 0.3));
    _q.x += g.player.vel.x; _q.z += g.player.vel.z;
    g.effects.shell(kind, _p, _q);
  }

  currentSpread() {
    const P = this.game.player, sp = this.def.spread;
    const mv = clamp(P.speed / PLAYER.walkSpeed, 0, 1.6);
    let s = lerp(sp.hip + sp.move * mv, sp.ads + sp.adsMove * mv, this.adsBlend);
    if (!P.grounded) s += sp.air;
    if (P.crouching) s *= sp.crouchMul;
    return s + this.bloom;
  }

  applyRecoil() {
    const d = this.def, r = d.recoil, P = this.game.player;
    const n = this.burst;
    const up = Math.min(r.up + r.upGrow * n, r.upMax);
    const drift = r.drift * (n > 3 ? Math.sin(n * 0.55) * 2.2 + 0.6 : 0.3);
    const side = (Math.random() * 2 - 1) * r.side + drift;
    const mul = lerp(1, r.adsMul, this.adsBlend) * (P.crouching ? r.crouchMul : 1);
    P.addRecoil(up * DEG * mul, side * DEG * mul, r.permanent);
    P.punchPitch.impulse(up * r.punch * 6 * mul * (1 - this.adsBlend * 0.4));
    P.punchYaw.impulse(side * r.punch * 4 * mul);
    P.punchRoll.impulse(rand(-1, 1) * r.punch * 3);
  }

  toggleMode() {
    const s = this.state;
    if (!this.def.auto) return;
    s.mode = s.mode === 'auto' ? 'semi' : 'auto';
    this.game.audio.play('switchMode', { volume: 0.6, reverb: 0 });
    this.game.hudDirty = true;
  }

  updateSlide(dt) {
    if (this.currentId !== 'pistol') return;
    const locked = this.state.mag === 0 && !(this.action === 'reload' && this.actionT / this.actionDur > 0.8);
    if (locked && this.action !== 'switchIn') { this.slideBack = 1; return; }
    this.slideBack = Math.max(0, this.slideBack - dt * 14);
  }

  updateWall(dt) {
    const g = this.game;
    g.camera.getWorldDirection(_f);
    const e = g.camera.position;
    const hit = g.physics.raycast(e.x, e.y, e.z, _f.x, _f.y, _f.z, 1.0, 'move');
    const target = hit ? clamp((0.85 - hit.t) / 0.5, 0, 1) : 0;
    this.wall = damp(this.wall, target, 10, dt);
  }

  addAmmo(id, n) {
    this.ammo[id].reserve += n;
    this.game.hudDirty = true;
  }

  /** Data consumed by the view model each frame. */
  viewState(st) {
    st.ads = this.adsBlend;
    st.sprint = this.sprintBlend;
    st.lower = this.lower;
    st.reload = this.action === 'reload' ? clamp(this.actionT / this.actionDur, 0, 1) : -1;
    st.reloadEmpty = this.reloadEmpty;
    st.pump = this.currentId === 'shotgun' ? this.pumpT : -1;
    st.slideBack = this.slideBack;
    st.shotgunReload = this.currentId === 'shotgun' && this.sg ? this.sg : null;
    st.wall = this.wall;
    return st;
  }

  get busy() { return this.action !== 'idle'; }
}
