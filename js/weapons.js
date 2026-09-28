// Player weapon handling: firing, spread, recoil, reloads (chamber aware), shotgun pump & shell loading,
// bolt cycling, magnified optics (zoom, zeroing, sway, breath control), binoculars with laser range
// finder and thermal channel, field dressings, ADS / sprint blending and switching.
import * as THREE from 'three';
import { WEAPONS, WEAPON_ORDER, PLAYER, BINOCULARS, MODES } from './config.js';
import { clamp, damp, lerp, gaussian, rand, DEG, smoothstep } from './util.js';
import { RELOAD_TRACKS } from './viewmodel.js';

const _dir = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3();
const _p = new THREE.Vector3(), _q = new THREE.Vector3();

const NO_SPREAD = { hip: 0, ads: 0, move: 0, adsMove: 0, air: 0, crouchMul: 1, bloomPerShot: 0, bloomMax: 0 };
const NO_RECOIL = { up: 0, upGrow: 0, upMax: 0, side: 0, drift: 0, recover: 7, permanent: 0, punch: 0, adsMul: 1, crouchMul: 1 };

/** Non-weapon items that use the same raise / lower / hands pipeline as weapons. */
export const ITEMS = {
  binos: {
    id: 'binos', item: true, slot: 4, name: 'LRF BINOCULARS', short: 'BINO', auto: false, mag: 0, pellets: 0,
    spread: NO_SPREAD, recoil: NO_RECOIL, adsZoom: BINOCULARS.zoom, adsTime: BINOCULARS.raiseTime, moveMul: 0.8, switchTime: 0.5, sprintOutTime: 0.2,
  },
  bandage: {
    id: 'bandage', item: true, slot: 5, name: 'FIELD DRESSING', short: 'DRESS', auto: false, mag: 0, pellets: 0,
    spread: NO_SPREAD, recoil: NO_RECOIL, adsZoom: 1, adsTime: 0.2, moveMul: 0.45, switchTime: 0.34, sprintOutTime: 0.2,
  },
};
const ITEM_STATE = { mag: 0, reserve: 0, mode: 'semi', needsPump: false };
const defOf = (id) => WEAPONS[id] || ITEMS[id];

export class WeaponSystem {
  constructor(game) {
    this.game = game;
    this.sway = { x: 0, y: 0 };
    this.reset();
  }

  reset(loadout = WEAPON_ORDER) {
    const mountain = loadout !== WEAPON_ORDER && loadout.includes('sniper');
    const cfg = mountain ? MODES.mountain : null;
    this.order = [...loadout];
    this.ammo = {};
    for (const id of this.order) {
      const d = WEAPONS[id];
      const reserve = cfg && cfg.reserve && cfg.reserve[id] !== undefined ? cfg.reserve[id] : d.reserve;
      this.ammo[id] = { mag: d.mag, reserve, mode: d.auto ? 'auto' : 'semi', needsPump: false };
    }
    this.hasBinos = mountain;
    this.bandages = cfg ? cfg.bandages : 0;
    this.currentId = this.order[0];
    this.prevId = this.currentId;
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
    // optics
    this.optic = 0;
    this.scopeZoom = {};
    this.zero = {};
    for (const id of this.order) {
      const d = WEAPONS[id];
      if (d.scope) this.scopeZoom[id] = d.scope.zoom;
      if (d.zero) this.zero[id] = d.zero.value;
    }
    this.needsBolt = false;
    this.boltDelay = 0;
    this.sway.x = this.sway.y = 0;
    this.swayPhase = Math.random() * 10;
    this.fatigue = 0;
    this.breathHold = 0;
    this.holding = false;
    this.gaspT = 0;
    this.thermalOn = false;
    this.range = null;
    this.rangeT = 0;
    this.bandageHealed = 0;
    if (this.game.viewmodel) this.game.viewmodel.setWeapon(this.currentId);
  }

  get def() { return defOf(this.currentId); }
  get state() { return this.ammo[this.currentId] || ITEM_STATE; }
  get isItem() { return !!ITEMS[this.currentId]; }

  /** Current magnification (camera field of view divisor). */
  zoom() {
    const d = this.def;
    if (this.currentId === 'binos') {
      const z = this.thermalOn ? BINOCULARS.thermalZoom : BINOCULARS.zoom;
      return lerp(1, z, smoothstep(0.15, 1, this.adsBlend));
    }
    if (d.scope) return lerp(1, this.scopeZoom[this.currentId], smoothstep(0.35, 1, this.adsBlend));
    return lerp(1, d.adsZoom, this.adsBlend);
  }

  // ------------------------------------------------------------------ per-frame

  update(dt, input, time) {
    const g = this.game, P = g.player;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.blockSprintT = Math.max(0, this.blockSprintT - dt);
    this.bloom = damp(this.bloom, 0, time - this.lastShot > 0.12 ? 5 : 0.5, dt);
    if (time - this.lastShot > 0.32) this.burst = 0;
    this.firingRecent = time - this.lastShot < 0.14;

    if (!P.alive) { this.adsBlend = damp(this.adsBlend, 0, 10, dt); this.optic = 0; return; }

    this.handleItemInput(input);
    this.handleSwitchInput(input);
    this.updateAction(dt, input);
    this.updateAds(dt, input);
    if (this.currentId === 'binos') this.updateBinoculars(dt, input);
    else if (!this.isItem) this.updateTrigger(input, time);
    if (input.consumeTap('reload') && !this.isItem) this.startReload();
    if (input.consumeTap('firemode')) this.toggleMode();
    this.updateSlide(dt);
    this.updateWall(dt);
    this.updateOptics(dt, input);
  }

  handleItemInput(input) {
    const g = this.game;
    if (input.consumeTap('binoculars')) {
      if (!this.hasBinos) this.toggleMode();
      else if (this.currentId === 'binos' || this.pendingId === 'binos') this.switchTo(this.prevId);
      else this.switchTo('binos');
    }
    if (input.consumeTap('thermal') && this.hasBinos) {
      this.thermalOn = !this.thermalOn;
      g.audio.play('switchMode', { volume: 0.45, reverb: 0, rate: 1.3 });
      g.hudDirty = true;
    }
    if (input.consumeTap('bandage') && this.bandages > 0) {
      if (this.currentId === 'bandage' || this.pendingId === 'bandage') return;
      if (g.player.health >= PLAYER.maxHealth && !(g.player.bleed > 0)) { g.hud.notice('No wounds to dress', '', 1.4); return; }
      this.switchTo('bandage');
    }
    // zeroing (scoped weapons)
    const d = this.def;
    if (d.zero) {
      const z = d.zero;
      let dz = 0;
      if (input.consumeTap('zeroUp')) dz = 1;
      if (input.consumeTap('zeroDown')) dz = -1;
      if (dz) {
        this.zero[this.currentId] = clamp(this.zero[this.currentId] + dz * z.step, z.min, z.max);
        g.audio.play('click', { volume: 0.4, reverb: 0, rate: 1.6 });
        g.hudDirty = true;
      }
    } else { input.consumeTap('zeroUp'); input.consumeTap('zeroDown'); }
  }

  handleSwitchInput(input) {
    const d = this.def;
    // mouse wheel / zoom buttons adjust a variable scope while aiming
    if (d.scope && d.scope.step > 0 && this.adsBlend > 0.5) {
      let dz = 0;
      if (input.consumeTap('prevWeapon') || input.consumeTap('zoomIn')) dz = 1;
      if (input.consumeTap('nextWeapon') || input.consumeTap('zoomOut')) dz = -1;
      if (dz) {
        const s = d.scope;
        this.scopeZoom[this.currentId] = clamp(this.scopeZoom[this.currentId] + dz * s.step, s.min, s.max);
        this.game.audio.play('click', { volume: 0.3, reverb: 0, rate: 1.2 });
        this.game.hudDirty = true;
      }
    }
    input.consumeTap('zoomIn'); input.consumeTap('zoomOut');
    let target = null;
    if (input.consumeTap('weapon1')) target = this.order[0];
    if (input.consumeTap('weapon2')) target = this.order[1];
    if (input.consumeTap('weapon3')) target = this.order[2];
    const cur = this.order.includes(this.pendingId || this.currentId) ? (this.pendingId || this.currentId) : this.prevId;
    const idx = this.order.indexOf(cur);
    if (input.consumeTap('nextWeapon')) target = this.order[(idx + 1) % this.order.length];
    if (input.consumeTap('prevWeapon')) target = this.order[(idx + this.order.length - 1) % this.order.length];
    if (target) {
      if (this.currentId === 'bandage') this.cancelBandage();
      this.switchTo(target);
    }
  }

  switchTo(id) {
    if (!id) return;
    if (id === this.currentId && this.action !== 'switchOut') return;
    if (this.action === 'switchOut') { this.pendingId = id; return; }
    if (this.action === 'bandage') this.cancelBandage();
    this.cancelReload();
    if (!this.isItem) this.prevId = this.currentId;
    this.pendingId = id;
    this.action = 'switchOut';
    this.actionT = 0;
    this.actionDur = this.def.switchTime * 0.42;
    this.game.audio.play('draw', { volume: 0.35, reverb: 0.05, rate: 1.15 });
    this.game.input.setToggle('ads', false);
  }

  cancelReload() {
    if (this.action === 'reload') { this.action = 'idle'; this.game.viewmodel.resetParts(); }
    if (this.action === 'sgReload') { this.action = 'idle'; this.sg = null; }
    if (this.action === 'bolt') { this.action = 'idle'; this.needsBolt = true; }
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
          g.audio.play(this.currentId === 'binos' ? 'cloth' : 'draw', { volume: 0.45, reverb: 0.05 });
          g.hudDirty = true;
        }
        break;
      case 'switchIn':
        this.lower = 1 - k;
        if (k >= 1) {
          this.action = 'idle';
          this.lower = 0;
          if (this.currentId === 'bandage') this.startBandage();
          else if (this.needsBolt && this.def.bolt && this.state.mag > 0) this.startBolt();
        }
        break;
      case 'reload': this.updateReload(k); break;
      case 'sgReload': this.updateShotgunReload(dt, input); break;
      case 'bolt': this.updateBolt(k); break;
      case 'bandage': this.updateBandage(k, dt, input); break;
      default: break;
    }
    // automatic bolt cycle shortly after a shot
    if (this.boltDelay > 0) {
      this.boltDelay -= dt;
      if (this.boltDelay <= 0 && this.action === 'idle' && this.needsBolt) this.startBolt();
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

  // ------------------------------------------------------------------ bolt action

  startBolt() {
    this.action = 'bolt';
    this.actionT = 0;
    this.actionDur = this.def.boltTime;
    this.soundsFired.clear();
  }

  updateBolt(k) {
    const g = this.game;
    const cues = [[0.08, 'boltUp'], [0.3, 'boltBack'], [0.58, 'boltFwd'], [0.8, 'boltDown']];
    for (const [t, name] of cues) {
      if (k >= t && !this.soundsFired.has(name)) {
        this.soundsFired.add(name);
        g.audio.play(name, { volume: 0.7, reverb: 0.1 });
        if (name === 'boltBack' && this.spentCase) { this.ejectShell(this.def.shell); this.spentCase = false; }
      }
    }
    if (k >= 1) { this.action = 'idle'; this.needsBolt = false; }
  }

  // ------------------------------------------------------------------ field dressing

  startBandage() {
    const cfg = MODES.mountain;
    this.action = 'bandage';
    this.actionT = 0;
    this.actionDur = cfg.bandageTime;
    this.bandageHealed = 0;
    this.soundsFired.clear();
    this.game.emitNoise(this.game.player.pos, 4, 'reload', 'friendly');
  }

  updateBandage(k, dt, input) {
    const g = this.game, P = g.player, cfg = MODES.mountain;
    const cues = [[0.04, 'bandageRip'], [0.3, 'bandageWrap'], [0.56, 'bandageWrap'], [0.8, 'bandageWrap']];
    for (const [t, name] of cues) {
      if (k >= t && !this.soundsFired.has(name + t)) { this.soundsFired.add(name + t); g.audio.play(name, { volume: 0.55, reverb: 0.05, rateVar: 0.1 }); }
    }
    // healing comes in as the dressing is tightened
    const want = cfg.bandageHeal * smoothstep(0.35, 0.95, k);
    const add = want - this.bandageHealed;
    if (add > 0) { P.heal(add); this.bandageHealed = want; g.hudDirty = true; }
    if (k > 0.5 && P.bleed > 0) P.bleed = 0;
    if (input.isDown('fire') && k < 0.92) { this.cancelBandage(); this.switchTo(this.prevId); return; }
    if (k >= 1) {
      this.bandages--;
      g.stats.bandages = (g.stats.bandages || 0) + 1;
      P.bleed = 0;
      this.action = 'idle';
      g.hud.notice('Wound dressed', `${this.bandages} dressing${this.bandages === 1 ? '' : 's'} left`, 1.8);
      g.hudDirty = true;
      this.switchTo(this.prevId);
    }
  }

  cancelBandage() {
    if (this.action !== 'bandage') return;
    const k = clamp(this.actionT / this.actionDur, 0, 1);
    if (k >= 0.5) { this.bandages--; this.game.player.bleed = 0; }
    this.action = 'idle';
    this.game.hudDirty = true;
  }

  // ------------------------------------------------------------------ binoculars

  updateBinoculars(dt, input) {
    const g = this.game;
    this.rangeT -= dt;
    if (this.rangeT <= 0 && this.adsBlend > 0.9) {
      this.rangeT = 0.15;
      g.camera.getWorldDirection(_f);
      const e = g.camera.position;
      const hit = g.physics.raycast(e.x, e.y, e.z, _f.x, _f.y, _f.z, 2500, 'sight');
      this.range = hit ? hit.t : null;
      this.rangePoint = hit ? _p.copy(_f).multiplyScalar(hit.t).add(e).clone() : null;
    }
    const held = input.isDown('fire');
    const fresh = held && !this.triggerPrev;
    this.triggerPrev = held;
    if (fresh && this.adsBlend > 0.9 && this.rangePoint && g.mode === 'mountain') g.world.survival.markTarget(this.rangePoint, this.range);
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
    const d = this.def, s = this.state, T = RELOAD_TRACKS[d.id] || RELOAD_TRACKS.rifle;
    const list = this.reloadEmpty ? [...T.sounds, ...T.emptySounds] : T.sounds;
    for (const [t, name] of list) {
      if (k >= t && !this.soundsFired.has(name)) {
        this.soundsFired.add(name);
        this.game.audio.play(name, { volume: 0.75, reverb: 0.12 });
        if (name === 'magIn') this.game.emitNoise(this.game.player.pos, 7, 'reload', 'friendly');
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
      if (d.bolt && this.reloadEmpty) { this.needsBolt = true; this.spentCase = false; this.startBolt(); }
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
    const busy = this.action === 'reload' || this.action === 'sgReload' || this.action === 'switchOut' || this.action === 'switchIn' || this.action === 'bandage';
    let want = input.isDown('ads') && !busy && !P.sprinting;
    if (this.currentId === 'binos') want = !busy && !P.sprinting;
    if (this.currentId === 'bandage') want = false;
    if (want && !this.adsWas && !this.isItem) this.game.audio.play('adsIn', { volume: 0.25, reverb: 0 });
    this.adsWas = want;
    this.adsBlend = clamp(this.adsBlend + (want ? 1 : -1) * dt / d.adsTime, 0, 1);
    const sprintTarget = P.sprinting ? 1 : 0;
    this.sprintBlend = clamp(this.sprintBlend + (sprintTarget ? 1 : -1) * dt / d.sprintOutTime, 0, 1);
    if (P.sprinting && input.touchToggles.ads) input.setToggle('ads', false);
  }

  /** Scope / binocular overlay blend, weapon sway, breathing and breath holding. */
  updateOptics(dt, input) {
    const g = this.game, P = g.player, d = this.def;
    const magnified = !!d.scope || this.currentId === 'binos';
    const target = magnified ? smoothstep(0.72, 0.97, this.adsBlend) : 0;
    this.optic = target;
    // fatigue from exertion
    if (P.sprinting) this.fatigue = Math.min(1, this.fatigue + dt * 0.12);
    else this.fatigue = Math.max(0, this.fatigue - dt * (P.speed < 0.3 ? 0.07 : 0.03));
    const aiming = magnified ? this.adsBlend : this.adsBlend * 0.25;
    // breath control (sprint key while aiming through glass)
    const wantHold = magnified && this.adsBlend > 0.85 && input.isDown('sprint') && this.gaspT <= 0;
    if (wantHold && !this.holding) { this.holding = true; g.audio.play('breathIn', { volume: 0.35, reverb: 0 }); }
    if (this.holding && (!wantHold || this.breathHold > 6)) {
      this.holding = false;
      g.audio.play('breathOut', { volume: this.breathHold > 5.9 ? 0.55 : 0.3, reverb: 0 });
      if (this.breathHold > 5.9) { this.gaspT = 2.8; this.fatigue = Math.min(1, this.fatigue + 0.25); }
    }
    if (this.holding) this.breathHold += dt;
    else this.breathHold = Math.max(0, this.breathHold - dt * 1.6);
    this.gaspT = Math.max(0, this.gaspT - dt);
    // sway amplitude
    const stance = P.proneT > 0.5 ? 0.2 : P.crouching ? 0.58 : 1;
    const moveK = clamp(P.speed / PLAYER.walkSpeed, 0, 1.5) * 1.4;
    const hurt = P.health < 40 ? 1.35 : 1;
    const hold = this.holding ? 0.1 + smoothstep(4.5, 6, this.breathHold) * 0.6 : this.gaspT > 0 ? 1.9 : 1;
    const amp = 0.17 * (d.sway || (this.currentId === 'binos' ? BINOCULARS.sway : 0.5)) * stance * (1 + this.fatigue * 1.7 + moveK) * hurt * hold;
    const rate = 0.24 + this.fatigue * 0.3 + (this.gaspT > 0 ? 0.35 : 0);
    this.swayPhase += dt * rate * Math.PI * 2;
    const t = g.time, ph = this.swayPhase;
    const tx = (Math.sin(ph * 0.5 + 1.3) * 0.55 + Math.sin(t * 0.83 + 2.1) * 0.35 + Math.sin(t * 2.3) * 0.1) * amp;
    const ty = (Math.sin(ph) * 0.8 + Math.sin(t * 0.61 + 0.7) * 0.3 + Math.sin(t * 2.9 + 1.1) * 0.08) * amp;
    this.sway.x = damp(this.sway.x, tx * DEG * aiming, 12, dt);
    this.sway.y = damp(this.sway.y, ty * DEG * aiming, 12, dt);
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
    if (d.bolt && this.needsBolt) { if (fresh && s.mag > 0) this.startBolt(); else if (fresh) this.dryFire(s); return; }
    const auto = d.auto && s.mode === 'auto';
    if (!auto && !fresh) return;
    if (s.mag <= 0) { this.dryFire(s); return; }
    if (d.id === 'shotgun' && s.needsPump) return;
    this.fire(time);
  }

  dryFire(s) {
    if (this.dryClicked) return;
    this.dryClicked = true;
    this.game.audio.play('dry', { volume: 0.6, reverb: 0 });
    if (s.reserve > 0) setTimeout(() => { if (this.state.mag === 0) this.startReload(); }, 280);
  }

  fire(time) {
    const g = this.game, P = g.player, d = this.def, s = this.state, vm = g.viewmodel;
    s.mag--;
    this.cooldown = 60 / d.rpm;
    this.burst = time - this.lastShot < 0.32 ? this.burst + 1 : 0;
    this.lastShot = time;
    g.stats.shots++;
    // aim + spread (the camera already carries the sway)
    const eye = g.camera.position;
    g.camera.getWorldDirection(_f);
    _r.crossVectors(_f, g.camera.up).normalize();
    _u.crossVectors(_r, _f).normalize();
    // scope zero: tilt the bore up so the trajectory crosses the line of sight at the set range
    let elev = 0;
    if (d.zero && g.world.ballistics) elev = g.ballistics.zeroAngle(d, this.zero[this.currentId]);
    const spreadDeg = this.currentSpread();
    g.shotHit = false;
    for (let i = 0; i < d.pellets; i++) {
      const ang = Math.min(Math.abs(gaussian()) * 0.55, 2) * spreadDeg * DEG * (d.pellets > 1 ? 0.7 + Math.random() * 0.5 : 1);
      const az = Math.random() * Math.PI * 2;
      _dir.copy(_f).addScaledVector(_r, Math.cos(az) * Math.tan(ang)).addScaledVector(_u, Math.sin(az) * Math.tan(ang) + Math.tan(elev)).normalize();
      g.fireBullet(eye, _dir, d, 'player', i === 0);
    }
    if (g.shotHit) g.stats.hits++;
    this.bloom = Math.min(this.bloom + d.spread.bloomPerShot, d.spread.bloomMax);
    this.applyRecoil();
    vm.kick(d.kick, this.adsBlend);
    // audio (non-positional for your own gun) + AI noise
    g.audio.play(d.sound, { volume: 1.0, reverb: 0.95, rateVar: 0.03, indoor: g.indoorAmt });
    const noise = g.world.teamCombat && d.mountainNoise ? d.mountainNoise : d.noise;
    g.emitNoise(P.pos, noise, 'gunshot', 'friendly');
    // world effects
    vm.muzzleWorld(eye, _p);
    g.effects.flashLight('player', _p, d.id === 'shotgun' ? 26 : d.id === 'pistol' ? 12 : 18, 0.05);
    g.effects.muzzleSmoke(_p, _f, d.id === 'shotgun' ? 3 : d.bolt ? 3 : 1);
    if (d.id === 'shotgun') {
      s.needsPump = true;
      this.ejectHull = true;
      this.pumpDelay = 0.14;
    } else if (d.bolt) {
      this.needsBolt = true;
      this.spentCase = true;
      this.boltDelay = 0.32;
    } else {
      this.ejectShell(d.shell);
      if (d.id === 'pistol') this.slideBack = 1;
    }
    if (g.mode === 'mountain') g.world.survival.onPlayerShot(d);
    g.hudDirty = true;
  }

  ejectShell(kind) {
    const g = this.game, vm = g.viewmodel;
    vm.axes(_r, _u, _f);
    const hip = 1 - this.adsBlend;
    _p.copy(g.camera.position).addScaledVector(_r, 0.16 + 0.08 * hip).addScaledVector(_f, 0.32).addScaledVector(_u, -0.1 - 0.06 * hip);
    _q.copy(_r).multiplyScalar(rand(1.6, 2.6)).addScaledVector(_u, rand(1.0, 2.0)).addScaledVector(_f, rand(-0.4, 0.3));
    _q.x += g.player.vel.x; _q.z += g.player.vel.z;
    g.effects.shell(kind === 'brass762' ? 'brass' : kind, _p, _q);
  }

  currentSpread() {
    const P = this.game.player, sp = this.def.spread;
    const mv = clamp(P.speed / PLAYER.walkSpeed, 0, 1.6);
    let s = lerp(sp.hip + sp.move * mv, sp.ads + sp.adsMove * mv, this.adsBlend);
    if (!P.grounded) s += sp.air;
    if (P.crouching) s *= sp.crouchMul;
    if (P.proneT > 0.5) s *= 0.6;
    return s + this.bloom;
  }

  applyRecoil() {
    const d = this.def, r = d.recoil, P = this.game.player;
    const n = this.burst;
    const up = Math.min(r.up + r.upGrow * n, r.upMax);
    const drift = r.drift * (n > 3 ? Math.sin(n * 0.55) * 2.2 + 0.6 : 0.3);
    const side = (Math.random() * 2 - 1) * r.side + drift;
    const mul = lerp(1, r.adsMul, this.adsBlend) * (P.crouching ? r.crouchMul : 1) * (P.proneT > 0.5 ? 0.6 : 1);
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
    const target = hit && this.optic < 0.5 ? clamp((0.85 - hit.t) / 0.5, 0, 1) : 0;
    this.wall = damp(this.wall, target, 10, dt);
  }

  addAmmo(id, n) {
    if (!this.ammo[id]) return 0;
    this.ammo[id].reserve += n;
    this.game.hudDirty = true;
    return n;
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
    st.bolt = this.action === 'bolt' ? clamp(this.actionT / this.actionDur, 0, 1) : -1;
    st.bandage = this.action === 'bandage' ? clamp(this.actionT / this.actionDur, 0, 1) : -1;
    st.optic = this.optic;
    return st;
  }

  get busy() { return this.action !== 'idle'; }
}
