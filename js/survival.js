// Mountain Survival mode: ten minutes on the ground until the exfil helicopter arrives. Owns the
// mission clock, the hunt director (the pre-placed groups move on the team's last reported area at
// their scheduled times — nothing ever spawns), squad radio and callouts, bleeding, target marking,
// the helicopter and the end conditions (player death = game over, clock at zero = victory).
import * as THREE from 'three';
import { MODES } from './config.js';
import { rand, clamp, choice } from './util.js';
import { buildHelicopter, updateHelicopter } from './helicopter.js';

const _v = new THREE.Vector3(), _n = new THREE.Vector3();
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

export class Survival {
  constructor(game, world) {
    this.game = game;
    this.world = world;
    this.known = new THREE.Vector3();
    this.markPos = new THREE.Vector3();
    this.heloPos = new THREE.Vector3();
  }

  start() {
    const g = this.game, w = this.world;
    this.timeLeft = MODES.mountain.time;
    this.elapsed = 0;
    this.issued = new Set();
    this.announced = new Set();
    this.radioQueue = [];
    this.calloutT = 0;
    this.refreshT = 25;
    this.leakT = 70;
    this.known.set(w.spawn.x, w.spawn.y, w.spawn.z);
    this.heloStage = 0;
    this.teamKills = 0;
    this.lost = [];
    this.markT = -100;
    this.firstContact = false;
    this.weaponsFree = false;
    this.teamT = 0;
    this.ended = false;
    g.player.bleed = 0;
    if (this.heloLoop) { this.heloLoop.stop(); this.heloLoop = null; }
    if (!this.helo) { this.helo = buildHelicopter(); w.scene.add(this.helo); }
    this.helo.visible = false;
    this.helo.userData.prev = null;
    g.hud.setObjective('Survive until exfil', 'Helicopter inbound · 10:00');
    g.hud.notice('Koh-e Zard highlands', 'Insertion complete · stay alive for ten minutes', 5);
    g.hud.team(w.friendlyList);
    g.audio.play('heloFar', { pos: _v.set(w.spawn.x + 300, w.spawn.y + 120, w.spawn.z + 900), volume: 0.8, ref: 400, rolloff: 0.6, reverb: 0.4 });
    this.say('OVERWATCH', 'Chalk One, Overwatch. Bird is off station. Exfil in one-zero minutes. Stay alive.', 1.2);
    this.say('NOWAK', 'On me. Spread out, watch the ridgelines. Nobody fires unless we have to.', 7.5);
    this.say('MAZUR', 'Marksman up. Mark anything you see and I will take it.', 14);
  }

  // ------------------------------------------------------------------ radio

  say(who, text, delay = 0, prio = false) {
    if (!prio && this.radioQueue.length > 4) return;
    this.radioQueue.push({ who, text, t: delay });
  }

  mateName(exclude) {
    const alive = this.world.friendlyList.filter((m) => m.alive && m !== exclude);
    return alive.length ? choice(alive).def.short : null;
  }

  bearing(from, to) {
    const dx = to.x - from.x, dz = to.z - from.z;
    const deg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
    return { name: COMPASS[Math.round(deg / 45) % 8], deg, dist: Math.hypot(dx, dz) };
  }

  updateRadio(dt) {
    const g = this.game;
    for (let i = 0; i < this.radioQueue.length; i++) {
      const r = this.radioQueue[i];
      r.t -= dt;
      if (r.t <= 0) {
        this.radioQueue.splice(i, 1);
        g.hud.radio(r.who, r.text);
        g.audio.play('radioSquelch', { volume: 0.45, reverb: 0 });
        g.audio.play('chatter', { volume: r.who === 'OVERWATCH' ? 0.2 : 0.28, reverb: 0, rate: r.who === 'OVERWATCH' ? 0.92 : 1.0, delay: 0.08 });
        break;
      }
    }
    this.calloutT -= dt;
  }

  /** Squad callouts from friendly soldiers (rate limited so the net stays readable). */
  callout(s, kind, target) {
    const g = this.game, P = g.player;
    if (!s.alive && kind !== 'down') return;
    if (kind === 'contact') {
      if (this.calloutT > 0 || !target) return;
      this.calloutT = 6;
      const b = this.bearing(P.pos, target.pos || target);
      const rng = Math.round(b.dist / 10) * 10;
      if (!this.weaponsFree) this.say(s.def.short, choice([`Contact ${b.name}, ${rng} metres. Holding fire.`, `Eyes on, ${b.name}, ${rng} metres. Not engaging.`, `Armed man ${b.name}, about ${rng}. Holding.`]), rand(0.3, 0.8));
      else this.say(s.def.short, choice([`Contact ${b.name}, ${rng} metres!`, `Enemy ${b.name}, ${rng} out!`, `Movement ${b.name}, about ${rng} metres!`]), rand(0.3, 0.8));
      if (!this.firstContact) { this.firstContact = true; this.say('NOWAK', 'Get low and find cover. Make every shot count.', 3.5); }
    } else if (kind === 'reload' && this.calloutT <= 0 && Math.random() < 0.35) {
      this.calloutT = 3;
      this.say(s.def.short, choice(['Reloading!', 'Changing mags!', 'Cover me, reloading!']), 0.2);
    } else if (kind === 'kill' && Math.random() < 0.6) {
      this.say(s.def.short, choice(['Tango down.', 'Got him.', 'He is down.', 'Target down.']), rand(0.3, 1));
    } else if (kind === 'hit' && this.calloutT <= 2) {
      this.calloutT = 4;
      this.say(s.def.short, choice(["I'm hit!", 'Hit! I am hit!', 'Taking fire, I am hit!']), 0.1, true);
    } else if (kind === 'down') {
      const other = this.mateName(s) || 'NOWAK';
      this.say(other, choice([`Man down! ${s.def.short} is down!`, `${s.def.short} is hit bad, he is down!`, `We lost ${s.def.short}!`]), 0.4, true);
    }
  }

  // ------------------------------------------------------------------ events

  onContact(src, pos) {
    if (src.team !== 'hostile') return;
    this.known.copy(pos);
    this.compromise('spotted');
  }

  /** The team has been detected or has opened fire: squad weapons free. */
  compromise(reason) {
    if (this.weaponsFree) return;
    this.weaponsFree = true;
    const line = reason === 'spotted' ? 'They have seen us! Weapons free!' : reason === 'hit' ? 'We are taking fire! Weapons free, return fire!' : 'Shots fired. Weapons free.';
    this.say('NOWAK', line, 0.4, true);
  }

  onPlayerShot(def) {
    this.compromise('shot');
    // anything within earshot now knows roughly where the shots came from
    const P = this.game.player;
    const heard = this.world.hostileList.some((h) => h.alive && h.pos.distanceTo(P.pos) < (def.mountainNoise || 400) * 0.8);
    if (heard) this.known.copy(this.jitter(P.pos, 25));
  }

  /** Hostiles that hear the fighting and have a hunt order pending set off early. */
  onGunfireHeard(e, dist) {
    if (!e.def.hunt || this.issued.has(e) || this.elapsed < 40) return;
    const grp = e.def.group;
    const due = Math.max(40, e.def.hunt * 0.55);
    if (this.elapsed < due) return;
    for (const h of this.world.hostileList) {
      if (h.def.group !== grp || this.issued.has(h) || !h.alive) continue;
      this.issued.add(h);
      if (h.state !== 'combat') h.startHunt(this.jitter(this.known, 45));
    }
  }

  onPlayerHit(amount) {
    this.compromise('hit');
    const P = this.game.player;
    if (amount > 10) P.bleed = Math.min(1.6, (P.bleed || 0) + amount * 0.014);
  }

  onNearMiss(dist) {
    const g = this.game;
    g.pipe.fx.flash = Math.max(g.pipe.fx.flash, 0.012);
    if (!this.firstContact) {
      this.firstContact = true;
      this.say(this.mateName() || 'NOWAK', 'Taking fire! Get down!', 0.3, true);
    }
  }

  onKilled(e, headshot, killer) {
    const g = this.game;
    if (e.team === 'hostile') {
      if (killer === 'player') {
        g.stats.kills++;
        if (Math.random() < 0.5) this.callout(this.world.friendlyList.find((m) => m.alive) || e, 'kill');
      } else this.teamKills++;
      const left = this.world.hostileList.filter((h) => h.alive).length;
      if (left === 0) this.say('OVERWATCH', 'No more movement on thermal. Hold what you have until the bird arrives.', 2, true);
    } else {
      this.lost.push(e.def.short);
      this.callout(e, 'down');
      g.hud.team(this.world.friendlyList);
    }
  }

  onPlayerDown() {
    const g = this.game;
    g.player.bleed = 0;
    this.say(this.mateName() || 'NOWAK', 'Man down! Man down!', 0.2, true);
    this.say('OVERWATCH', 'Chalk One, say status… Chalk One, respond.', 2.2, true);
  }

  /** Binocular laser mark: the squad engages a hostile close to the lased point. */
  markTarget(point, range) {
    const g = this.game;
    this.markPos.copy(point);
    this.markT = g.time;
    let best = null, bd = 14;
    for (const h of this.world.hostileList) {
      if (!h.alive) continue;
      const d = h.pos.distanceTo(point);
      if (d < bd) { bd = d; best = h; }
    }
    g.audio.play('click', { volume: 0.4, reverb: 0, rate: 2 });
    const r = Math.round(range);
    const shooter = this.world.friendlyList.find((m) => m.alive && m.def.role === 'marksman') || this.world.friendlyList.find((m) => m.alive);
    if (!shooter) return;
    if (best) {
      this.weaponsFree = true;
      for (const m of this.world.friendlyList) if (m.alive) m.assignTarget(best);
      this.say(shooter.def.short, choice([`Copy mark, ${r} metres. Engaging.`, `Got your mark at ${r}. On it.`, `Tally, ${r} metres. Sending.`]), 0.6);
    } else {
      this.say(shooter.def.short, choice([`Marked ${r} metres, no eyes on anyone.`, `Nothing at your mark, ${r}.`]), 0.6);
    }
  }

  objectiveTarget() {
    if (this.game.time - this.markT < 9) return { x: this.markPos.x, y: this.markPos.y + 0.5, z: this.markPos.z };
    return null;
  }

  jitter(p, r) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
    return _v.set(p.x + Math.cos(a) * d, p.y, p.z + Math.sin(a) * d).clone();
  }

  // ------------------------------------------------------------------ frame

  update(dt) {
    const g = this.game, P = g.player;
    this.elapsed += dt;
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    this.updateRadio(dt);
    // bleeding (no natural regeneration: only a dressing stops it)
    if (P.alive && P.bleed > 0) {
      const died = P.damage(P.bleed * dt, _v.set(0, 0, 0), g.time);
      g.stats.damage += P.bleed * dt;
      g.hudDirty = true;
      if (died) { g.playerDied(); return; }
    }
    this.updateDirector(dt);
    this.updateHelicopter(dt);
    if (this.timeLeft <= 0 && P.alive && !this.ended) {
      this.ended = true;
      this.say('OVERWATCH', 'Chalk One, wheels down. Get on the bird!', 0, true);
      g.survived();
    }
  }

  updatePassive(dt) {
    this.updateRadio(dt);
    this.updateHelicopter(dt);
  }

  updateDirector(dt) {
    const w = this.world, P = this.game.player;
    for (const e of w.hostileList) {
      const h = e.def.hunt;
      if (!h || this.issued.has(e) || !e.alive) continue;
      if (this.elapsed < h) continue;
      this.issued.add(e);
      if (e.state !== 'combat') e.startHunt(this.jitter(this.known, 40));
      const grp = e.def.group;
      if (!this.announced.has(grp)) {
        this.announced.add(grp);
        const b = this.bearing(P.pos, e.pos);
        this.say('OVERWATCH', choice([
          `Chalk One, intercepted ICOM chatter. Fighters moving toward you from the ${b.name}.`,
          `Overwatch: movement ${b.name} of your position, roughly ${Math.round(b.dist / 50) * 50} metres, heading your way.`,
          `Heads up, Chalk One. Group of pax leaving their position ${b.name} of you.`,
        ]), rand(2, 5));
      }
    }
    // the enemy's picture of the team slowly sharpens (spotters, locals, radio)
    this.leakT -= dt;
    if (this.leakT <= 0) {
      this.leakT = rand(45, 70);
      this.known.lerp(P.pos, 0.6);
    }
    this.refreshT -= dt;
    if (this.refreshT <= 0) {
      this.refreshT = rand(18, 26);
      for (const e of w.hostileList) if (e.alive && e.state === 'hunt') e.updateHunt(this.jitter(this.known, 30));
    }
  }

  updateHelicopter(dt = 1 / 60) {
    const g = this.game, t = this.timeLeft, w = this.world;
    if (this.heloStage === 0 && t <= 180) { this.heloStage = 1; this.say('OVERWATCH', 'Chalk One, exfil bird is wheels up. Three minutes.', 0); }
    if (this.heloStage === 1 && t <= 60) { this.heloStage = 2; this.say('OVERWATCH', 'One minute out. Keep your heads down.', 0, true); }
    if (this.heloStage === 2 && t <= 40) {
      this.heloStage = 3;
      this.heloLoop = g.audio.loop('heloLoop', { volume: 0, ref: 60, rolloff: 0.8, reverb: 0.3 });
    }
    if (this.heloStage >= 3 && this.helo) {
      // approach up the valley from the south, descending to a hover beside the team
      const P = g.player.pos;
      const k = clamp(1 - t / 40, 0, 1), e = 1 - (1 - k) * (1 - k);
      const T = w.terrain;
      const ex = P.x + 20, ez = P.z + 32;
      const x = ex + (260 - 20) * (1 - e), z = ez + (3000 - 32) * (1 - e);
      const ground = T.heightAt(x, z);
      const y = Math.max(ground + (k > 0.85 ? 18 : 45), P.y + 22 + 330 * (1 - e));
      this.heloPos.set(x, y, z);
      this.helo.visible = true;
      updateHelicopter(this.helo, this.heloPos, dt || 1 / 60);
      if (this.heloLoop) this.heloLoop.set(this.heloPos, clamp(k * 1.6, 0.15, 1) * 1.1);
      // rotor downwash kicks up dust close to the ground
      if (y - ground < 35 && Math.random() < 0.6) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * 14;
        const gx = x + Math.cos(a) * r, gz = z + Math.sin(a) * r;
        _v.set(gx, T.heightAt(gx, gz) + 0.2, gz);
        g.effects.puff(_v, _n.set(Math.cos(a) * 0.6, 0.5, Math.sin(a) * 0.6), 2, [0.62, 0.56, 0.46], 1.2, 2.4);
      }
    }
  }

  stopAudio() {
    if (this.heloLoop) { this.heloLoop.stop(); this.heloLoop = null; }
    if (this.helo) this.helo.visible = false;
  }

  updateHUD(dt) {
    const g = this.game, W = g.weapons, P = g.player, H = g.hud;
    H.timer(this.timeLeft);
    H.bandage(W.bandages, W.action === 'bandage' ? W.actionT / W.actionDur : -1, P.bleed > 0);
    H.compass(P.yaw);
    this.teamT -= dt;
    if (this.teamT <= 0) { this.teamT = 0.5; H.team(this.world.friendlyList); }
  }

  summary() {
    const f = this.world.friendlyList;
    return {
      survived: Math.round(this.elapsed), teamAlive: f.filter((m) => m.alive).length, teamTotal: f.length,
      teamKills: this.teamKills, lost: this.lost.slice(),
    };
  }
}
