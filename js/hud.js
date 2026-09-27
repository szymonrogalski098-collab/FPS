// Minimal realistic HUD. DOM writes only happen when values change.
import * as THREE from 'three';
import { clamp } from './util.js';

const $ = (id) => document.getElementById(id);
const _p = new THREE.Vector3();

export class HUD {
  constructor() {
    this.el = {
      root: $('hud'), hp: $('hp-value'), hpFill: $('hp-fill'), hpTrail: $('hp-trail'), health: $('hud-health'),
      wpn: $('hud-weapon'), wpnName: $('wpn-name'), mag: $('ammo-mag'), res: $('ammo-res'), mode: $('wpn-mode'), slots: $('wpn-slots'),
      objText: $('obj-text'), objSub: $('obj-sub'), marker: $('obj-marker'), markerDist: document.querySelector('#obj-marker .dist'),
      interact: $('interact'), interactTxt: document.querySelector('#interact .txt'), interactFill: $('interact-fill'),
      notice: $('notice'), crosshair: $('crosshair'), hitmarker: $('hitmarker'), dmgOverlay: $('dmg-overlay'), dmgDirs: $('dmg-dirs'),
      fps: $('fps'), minimap: $('minimap'), useBtn: document.querySelector('.t-interact'),
    };
    this.cache = {};
    this.pings = [];
    this.noticeT = 0;
    this.hitT = 0;
    this.mm = this.el.minimap.getContext('2d');
    this.mapImg = null;
  }

  show(v) { this.el.root.classList.toggle('hidden', !v); }

  set(key, el, value, prop = 'textContent') {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    el[prop] = value;
  }

  setHealth(h) {
    const v = Math.ceil(h);
    if (this.cache.hp === v) return;
    this.cache.hp = v;
    this.el.hp.textContent = v;
    this.el.hpFill.style.width = `${clamp(h, 0, 100)}%`;
    this.el.hpTrail.style.width = `${clamp(h, 0, 100)}%`;
    this.el.health.classList.toggle('low', h <= 30);
  }

  setWeapon(def, st) {
    this.set('wname', this.el.wpnName, def.name);
    this.set('mag', this.el.mag, String(st.mag));
    this.set('res', this.el.res, String(st.reserve));
    this.set('mode', this.el.mode, def.auto ? (st.mode === 'auto' ? 'AUTO' : 'SEMI') : def.id === 'shotgun' ? 'PUMP' : 'SEMI');
    const low = st.mag <= Math.ceil(def.mag * 0.25);
    const key = `${st.mag === 0}|${low}`;
    if (this.cache.ammoState !== key) {
      this.cache.ammoState = key;
      this.el.wpn.classList.toggle('empty', st.mag === 0);
      this.el.wpn.classList.toggle('low', low && st.mag > 0);
    }
    if (this.cache.slot !== def.slot) {
      this.cache.slot = def.slot;
      this.el.slots.querySelectorAll('span').forEach((s) => s.classList.toggle('on', Number(s.dataset.slot) === def.slot));
    }
  }

  setObjective(text, sub, flash = false) {
    this.set('obj', this.el.objText, text);
    this.set('objSub', this.el.objSub, sub);
    if (flash) {
      this.el.objText.classList.remove('flash');
      void this.el.objText.offsetWidth;
      this.el.objText.classList.add('flash');
    }
  }

  notice(text, sub = '', dur = 3) {
    this.el.notice.innerHTML = sub ? `${text}<small>${sub}</small>` : text;
    this.el.notice.classList.add('show');
    this.noticeT = dur;
  }

  interact(show, text = '', progress = 0) {
    const key = show ? text : '';
    if (this.cache.interact !== key) {
      this.cache.interact = key;
      this.el.interact.classList.toggle('show', show);
      if (this.el.useBtn) this.el.useBtn.classList.toggle('show', show);
      if (show) this.el.interactTxt.textContent = text;
    }
    const w = `${Math.round(progress * 100)}%`;
    this.set('iprog', this.el.interactFill.style, w, 'width');
  }

  crosshair(opacity, gap) {
    const o = opacity.toFixed(2);
    this.set('chO', this.el.crosshair.style, o, 'opacity');
    const g = `${gap.toFixed(1)}px`;
    if (this.cache.chG !== g) { this.cache.chG = g; this.el.crosshair.style.setProperty('--gap', g); }
  }

  hitmarker(kill) {
    const h = this.el.hitmarker;
    h.classList.toggle('kill', !!kill);
    h.style.transition = 'none';
    h.style.opacity = '1';
    this.hitT = 0.12;
  }

  damageFlash(amount) {
    this.dmgLevel = Math.min(1, (this.dmgLevel || 0) + amount / 45);
  }

  damageDir(angle) {
    const d = document.createElement('div');
    d.className = 'dmg-dir';
    d.style.transform = `rotate(${angle}rad)`;
    this.el.dmgDirs.appendChild(d);
    requestAnimationFrame(() => { d.style.opacity = '0'; });
    setTimeout(() => d.remove(), 1000);
  }

  ping(pos) {
    this.pings.push({ x: pos.x, z: pos.z, t: 2.2 });
    if (this.pings.length > 20) this.pings.shift();
  }

  /** Renders a static top-down plan of the level once. */
  buildMap(physics, bounds) {
    const S = 5;
    const W = Math.ceil((bounds.maxX - bounds.minX) * S), H = Math.ceil((bounds.maxZ - bounds.minZ) * S);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(40,42,40,0.55)';
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(70,72,68,0.6)';
    g.fillRect((-18 - bounds.minX) * S, (-16 - bounds.minZ) * S, 36 * S, 24 * S);
    const sorted = [...physics.colliders].filter((col) => col.maxY > 0.6 && col.minY < 2.2 && col.surface !== 'glass').sort((a, b) => a.maxY - b.maxY);
    for (const col of sorted) {
      const tall = col.maxY - Math.max(0, col.minY) > 2.2;
      g.fillStyle = tall ? 'rgba(214,210,198,0.85)' : col.bullet ? 'rgba(150,148,138,0.7)' : 'rgba(150,148,138,0.3)';
      g.fillRect((col.minX - bounds.minX) * S, (col.minZ - bounds.minZ) * S, Math.max(1, (col.maxX - col.minX) * S), Math.max(1, (col.maxZ - col.minZ) * S));
    }
    this.mapImg = c;
    this.mapScale = S;
    this.mapBounds = bounds;
  }

  updateMinimap(player, objective, dt) {
    const ctx = this.mm, cv = this.el.minimap, R = cv.width / 2;
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!this.mapImg) return;
    const S = this.mapScale * 0.85, b = this.mapBounds;
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(R, R);
    ctx.rotate(player.yaw);
    ctx.scale(0.85, 0.85);
    ctx.drawImage(this.mapImg, -(player.pos.x - b.minX) * this.mapScale, -(player.pos.z - b.minZ) * this.mapScale);
    ctx.scale(1 / 0.85, 1 / 0.85);
    // gunfire pings
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i];
      p.t -= dt;
      if (p.t <= 0) { this.pings.splice(i, 1); continue; }
      ctx.fillStyle = `rgba(210,80,60,${Math.min(1, p.t).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc((p.x - player.pos.x) * S, (p.z - player.pos.z) * S, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // objective (clamped to rim)
    if (objective) {
      ctx.save();
      ctx.translate(R, R);
      ctx.rotate(player.yaw);
      let ox = (objective.x - player.pos.x) * S, oz = (objective.z - player.pos.z) * S;
      const d = Math.hypot(ox, oz), lim = R - 8;
      if (d > lim) { ox *= lim / d; oz *= lim / d; }
      ctx.translate(ox, oz);
      ctx.rotate(-player.yaw + Math.PI / 4);
      ctx.strokeStyle = '#c7a766';
      ctx.lineWidth = 2;
      ctx.strokeRect(-4, -4, 8, 8);
      ctx.restore();
    }
    // player
    ctx.fillStyle = '#ece8dc';
    ctx.beginPath();
    ctx.moveTo(R, R - 7); ctx.lineTo(R + 5, R + 5); ctx.lineTo(R, R + 2); ctx.lineTo(R - 5, R + 5); ctx.closePath();
    ctx.fill();
    // view cone
    ctx.fillStyle = 'rgba(236,232,220,0.07)';
    ctx.beginPath(); ctx.moveTo(R, R); ctx.arc(R, R, R, -Math.PI / 2 - 0.6, -Math.PI / 2 + 0.6); ctx.closePath(); ctx.fill();
  }

  updateMarker(target, camera, show) {
    const m = this.el.marker;
    if (!target || !show) { this.set('mk', m.style, '0', 'opacity'); return; }
    _p.set(target.x, target.y, target.z).project(camera);
    const behind = _p.z > 1;
    let x = _p.x, y = _p.y;
    if (behind) { x = -x; y = -y; }
    const edge = 0.92;
    const outside = behind || Math.abs(x) > edge || Math.abs(y) > edge;
    if (outside) {
      const k = edge / Math.max(Math.abs(x), Math.abs(y), 1e-3);
      x *= k; y *= k;
      if (behind) y = -edge;
    }
    const sx = (x * 0.5 + 0.5) * window.innerWidth, sy = (-y * 0.5 + 0.5) * window.innerHeight;
    m.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -50%)`;
    this.set('mk', m.style, outside ? '0.55' : '0.9', 'opacity');
    const d = Math.round(camera.position.distanceTo(_p.set(target.x, target.y, target.z)));
    this.set('mkd', this.el.markerDist, `${d} m`);
  }

  update(dt, fps) {
    if (this.noticeT > 0) {
      this.noticeT -= dt;
      if (this.noticeT <= 0) this.el.notice.classList.remove('show');
    }
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT <= 0) { this.el.hitmarker.style.transition = 'opacity 0.2s'; this.el.hitmarker.style.opacity = '0'; }
    }
    this.dmgLevel = Math.max(0, (this.dmgLevel || 0) - dt * 0.9);
    this.set('dmg', this.el.dmgOverlay.style, this.dmgLevel.toFixed(2), 'opacity');
    if (fps !== null) this.set('fps', this.el.fps, fps);
  }

  reset() {
    this.cache = {};
    this.pings.length = 0;
    this.dmgLevel = 0;
    this.el.notice.classList.remove('show');
    this.el.dmgDirs.innerHTML = '';
    this.interact(false);
  }
}
