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
    this.m = {
      timer: $('timer-val'), timerBox: $('hud-timer'), team: $('hud-team'), med: $('med-val'), medBox: $('hud-med'), medFill: $('med-fill'),
      bleed: $('med-bleed'), compass: $('compass-strip'), heading: $('compass-deg'), radio: $('radio-log'),
      optic: $('optic'), opticSvg: $('optic-svg'), maskPath: $('optic-mask'), ring: $('optic-ring'), reticles: $('optic-reticles'),
      ret: { mil: $('ret-mil'), chevron: $('ret-chevron'), binos: $('ret-binos') },
      opticInfo: $('optic-info'), oZoom: $('o-zoom'), oZero: $('o-zero'), oRange: $('o-range'), oHead: $('o-head'),
    };
    this.radioLines = [];
    this.buildCompass();
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

  setWeapon(def, st, W) {
    this.set('wname', this.el.wpnName, def.name);
    const item = !!def.item;
    this.el.wpn.classList.toggle('item', item);
    this.set('mag', this.el.mag, item ? '' : String(st.mag));
    this.set('res', this.el.res, item ? '' : String(st.reserve));
    let mode = def.auto ? (st.mode === 'auto' ? 'AUTO' : 'SEMI') : def.id === 'shotgun' ? 'PUMP' : def.bolt ? 'BOLT' : 'SEMI';
    if (def.scope && W) mode += ` · ${W.scopeZoom[def.id]}× · ${W.zero[def.id]} m`;
    if (def.id === 'binos' && W) mode = W.thermalOn ? 'THERMAL · LRF' : 'DAY · LRF';
    if (def.id === 'bandage' && W) mode = `${W.bandages} LEFT`;
    this.set('mode', this.el.mode, mode);
    const low = st.mag <= Math.ceil(def.mag * 0.25);
    const key = `${st.mag === 0}|${low}`;
    if (this.cache.ammoState !== key) {
      this.cache.ammoState = key;
      this.el.wpn.classList.toggle('empty', st.mag === 0);
      this.el.wpn.classList.toggle('low', low && st.mag > 0);
    }
    const slot = W && W.order ? W.order.indexOf(def.id) + 1 : def.slot;
    if (this.cache.slot !== slot) {
      this.cache.slot = slot;
      this.el.slots.querySelectorAll('span').forEach((s) => s.classList.toggle('on', Number(s.dataset.slot) === slot));
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

  updateMinimap(player, objective, dt, mates) {
    const ctx = this.mm, cv = this.el.minimap, R = cv.width / 2;
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!this.mapImg) return;
    const zoomK = this.mapTopo ? 1.6 : 0.85;
    const S = this.mapScale * zoomK, b = this.mapBounds;
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(R, R);
    ctx.rotate(player.yaw);
    ctx.scale(zoomK, zoomK);
    ctx.drawImage(this.mapImg, -(player.pos.x - b.minX) * this.mapScale, -(player.pos.z - b.minZ) * this.mapScale);
    ctx.scale(1 / zoomK, 1 / zoomK);
    if (mates) {
      for (const m of mates) {
        if (!m.alive) continue;
        ctx.fillStyle = 'rgba(150,200,140,0.95)';
        ctx.beginPath();
        ctx.arc((m.pos.x - player.pos.x) * S, (m.pos.z - player.pos.z) * S, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
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
    this.updateRadio(dt);
  }

  reset() {
    this.cache = {};
    if (this.m) { this.m.optic.classList.add('hidden'); this.m.radio.innerHTML = ''; this.radioLines = []; }
    this.pings.length = 0;
    this.dmgLevel = 0;
    this.el.notice.classList.remove('show');
    this.el.dmgDirs.innerHTML = '';
    this.interact(false);
  }

  // ------------------------------------------------------------------ modes & maps

  setMode(mode) {
    document.body.classList.toggle('mode-mountain', mode === 'mountain');
    this.mode = mode;
    this.m.radio.innerHTML = '';
    this.radioLines = [];
    this.cache.timer = this.cache.team = this.cache.med = this.cache.oType = null;
  }

  currentMap() { return { img: this.mapImg, scale: this.mapScale, bounds: this.mapBounds }; }

  useMap(m) {
    this.mapImg = m.img;
    this.mapScale = m.scale;
    this.mapBounds = m.bounds;
    this.mapTopo = !!m.topo;
  }

  // ------------------------------------------------------------------ survival panels

  timer(sec) {
    const s = Math.ceil(sec);
    if (this.cache.timer === s) return;
    this.cache.timer = s;
    const m = Math.floor(s / 60), r = s % 60;
    this.m.timer.textContent = `${m}:${String(r).padStart(2, '0')}`;
    this.m.timerBox.classList.toggle('urgent', s <= 60);
  }

  team(list) {
    if (!list) return;
    const key = list.map((m) => (m.alive ? (m.health < m.profile.hp * 0.5 ? 'w' : m.state === 'combat' ? 'c' : 'o') : 'd')).join('');
    if (this.cache.team === key) return;
    this.cache.team = key;
    this.m.team.innerHTML = list.map((m, i) => {
      const st = key[i];
      const label = st === 'd' ? 'DOWN' : st === 'w' ? 'WOUNDED' : st === 'c' ? 'ENGAGED' : 'OK';
      return `<div class="tm st-${st}"><i></i><b>${m.def.short}</b><span>${label}</span></div>`;
    }).join('');
  }

  bandage(count, progress, bleeding) {
    const key = `${count}|${bleeding}|${progress >= 0 ? Math.round(progress * 50) : -1}`;
    if (this.cache.med === key) return;
    this.cache.med = key;
    this.m.med.textContent = String(count);
    this.m.bleed.classList.toggle('show', !!bleeding);
    this.m.medBox.classList.toggle('active', progress >= 0);
    this.m.medFill.style.width = `${Math.max(0, progress) * 100}%`;
  }

  compass(yaw) {
    const deg = ((-yaw * 180) / Math.PI % 360 + 360) % 360;
    const px = Math.round(deg * 3 * 10) / 10;
    if (this.cache.compass === px) return;
    this.cache.compass = px;
    this.m.compass.style.transform = `translateX(${-px - 180 * 3}px)`;
    this.m.heading.textContent = String(Math.round(deg) % 360).padStart(3, '0');
  }

  buildCompass() {
    const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    let html = '';
    for (let d = -180; d <= 540; d += 15) {
      const n = ((d % 360) + 360) % 360;
      const x = (d + 180) * 3;
      html += names[n] ? `<span class="cd major" style="left:${x}px">${names[n]}</span>` : `<span class="cd" style="left:${x}px">${n % 45 === 0 ? '' : '·'}</span>`;
    }
    this.m.compass.innerHTML = html;
  }

  radio(who, text) {
    const d = document.createElement('div');
    d.className = 'rl';
    d.innerHTML = `<b>${who}</b>${text}`;
    this.m.radio.appendChild(d);
    this.radioLines.push({ el: d, t: 7 + text.length * 0.03 });
    while (this.radioLines.length > 4) { const r = this.radioLines.shift(); r.el.remove(); }
  }

  updateRadio(dt) {
    if (!this.radioLines) return;
    for (let i = this.radioLines.length - 1; i >= 0; i--) {
      const r = this.radioLines[i];
      r.t -= dt;
      if (r.t < 0.6) r.el.style.opacity = String(Math.max(0, r.t / 0.6));
      if (r.t <= 0) { r.el.remove(); this.radioLines.splice(i, 1); }
    }
  }

  // ------------------------------------------------------------------ optics overlay

  layoutOptic(type) {
    const w = window.innerWidth, h = window.innerHeight, cx = w / 2, cy = h / 2;
    const svg = this.m.opticSvg;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const R = Math.min(w, h) * (type === 'binos' ? 0.4 : 0.46);
    const circ = (x, r) => `M${x - r},${cy} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0 Z`;
    let d = `M0,0 H${w} V${h} H0 Z `;
    if (type === 'binos') {
      const off = R * 0.52;
      // union of two circles, drawn as one outline so the overlap stays clear
      const a = Math.acos(off / R);
      const yT = cy - R * Math.sin(a), yB = cy + R * Math.sin(a);
      d += `M${cx},${yT} A${R},${R} 0 1,0 ${cx},${yB} A${R},${R} 0 1,0 ${cx},${yT} Z`;
      this.m.ring.setAttribute('cx', cx); this.m.ring.setAttribute('cy', cy); this.m.ring.setAttribute('r', R * 1.5);
    } else {
      d += circ(cx, R);
      this.m.ring.setAttribute('cx', cx); this.m.ring.setAttribute('cy', cy); this.m.ring.setAttribute('r', R);
    }
    this.m.maskPath.setAttribute('d', d);
    this.m.reticles.setAttribute('transform', `translate(${cx},${cy}) scale(${R / 300})`);
    this.m.opticInfo.style.bottom = `${Math.max(12, cy - R * 0.92)}px`;
    this.opticR = R;
    this.opticW = w; this.opticH = h;
  }

  optic(W, camera, game) {
    const o = W.optic;
    const show = o > 0.01 && game.player.alive;
    const scoped = o > 0.5 && W.def.scope && W.def.scope.step > 0;
    if (this.cache.scoped !== scoped) { this.cache.scoped = scoped; document.body.classList.toggle('scoped', !!scoped); }
    if (!show) {
      if (this.cache.opticOn !== false) { this.cache.opticOn = false; this.m.optic.classList.add('hidden'); }
      return;
    }
    if (this.cache.opticOn !== true) { this.cache.opticOn = true; this.m.optic.classList.remove('hidden'); }
    this.set('opticO', this.m.optic.style, o.toFixed(2), 'opacity');
    const binos = W.currentId === 'binos';
    const type = binos ? 'binos' : (W.def.scope && W.def.scope.reticle) || 'mil';
    if (this.cache.oType !== type || this.opticW !== window.innerWidth || this.opticH !== window.innerHeight) {
      this.cache.oType = type;
      this.layoutOptic(type);
      for (const [k, el] of Object.entries(this.m.ret)) el.style.display = k === type ? '' : 'none';
    }
    const z = W.zoom();
    this.set('oZoom', this.m.oZoom, `${z.toFixed(1)}×`);
    this.set('oZero', this.m.oZero, binos ? (W.thermalOn ? 'THERMAL · WHT' : 'DAY') : `ZERO ${W.zero[W.currentId]} m`);
    if (binos) {
      const r = W.range;
      this.set('oRange', this.m.oRange, r ? `${String(Math.round(r)).padStart(4, '0')} m` : '---- m');
      const deg = ((-game.player.yaw * 180) / Math.PI % 360 + 360) % 360;
      this.set('oHead', this.m.oHead, `AZ ${String(Math.round(deg) % 360).padStart(3, '0')}°  EL ${(game.player.pitch * 57.3).toFixed(1)}°`);
    } else {
      this.set('oRange', this.m.oRange, W.holding ? `HOLD ${Math.max(0, 6 - W.breathHold).toFixed(1)}s` : W.gaspT > 0 ? 'BREATHE' : '');
      this.set('oHead', this.m.oHead, '');
    }
    this.m.optic.classList.toggle('thermal', binos && W.thermalOn);
  }
}
