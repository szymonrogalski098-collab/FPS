// Unified input: keyboard + pointer-lock mouse on desktop, virtual stick / look pad / buttons on touch.
import { isTouchDevice, clamp } from './util.js';

const KEYMAP = {
  KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  ControlLeft: 'crouch', ControlRight: 'crouch',
  KeyQ: 'leanL', KeyE: 'leanR', KeyF: 'interact', Space: 'jump',
};
const TAPMAP = {
  KeyR: 'reload', Digit1: 'weapon1', Digit2: 'weapon2', Digit3: 'weapon3', KeyV: 'firemode', KeyB: 'binoculars',
  KeyC: 'crouchToggle', Space: 'jump', KeyF: 'interactTap', KeyP: 'pause', Escape: 'pause',
  KeyZ: 'prone', KeyT: 'thermal', KeyH: 'bandage', PageUp: 'zeroUp', PageDown: 'zeroDown', Equal: 'zoomIn', Minus: 'zoomOut',
};

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.isTouch = isTouchDevice();
    this.held = new Set();
    this.taps = new Set();
    this.lookX = 0;          // raw mouse pixels / touch pixels accumulated this frame
    this.lookY = 0;
    this.lookSource = 'mouse';
    this.enabled = false;
    this.locked = false;
    this.move = { x: 0, y: 0 };
    this.touchToggles = { ads: false, crouch: false, sprint: false };
    this.stickSprint = false;
    this.pointers = new Map();
    this.onPauseRequest = null;
    this.onLockChange = null;
    this.bindKeyboard();
    this.bindMouse();
    if (this.isTouch) this.bindTouch();
  }

  // ------------------------------------------------------------------ desktop

  bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const hold = KEYMAP[e.code], tap = TAPMAP[e.code];
      if (hold || tap) e.preventDefault();
      if (hold) this.held.add(hold);
      if (tap && !e.repeat) this.taps.add(tap);
    });
    window.addEventListener('keyup', (e) => {
      const hold = KEYMAP[e.code];
      if (hold) this.held.delete(hold);
    });
    window.addEventListener('blur', () => this.clearAll());
  }

  bindMouse() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('contextmenu', (e) => { if (this.enabled) e.preventDefault(); });
    document.addEventListener('mousedown', (e) => {
      if (!this.enabled || this.isTouchEvent(e)) return;
      if (!this.locked) return;
      if (e.button === 0) this.held.add('fire');
      if (e.button === 2) this.held.add('ads');
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.held.delete('fire');
      if (e.button === 2) this.held.delete('ads');
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled || !this.locked) return;
      this.lookX += e.movementX || 0;
      this.lookY += e.movementY || 0;
      this.lookSource = 'mouse';
    });
    document.addEventListener('wheel', (e) => {
      if (!this.enabled || !this.locked) return;
      this.taps.add(e.deltaY > 0 ? 'nextWeapon' : 'prevWeapon');
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.held.delete('fire'); this.held.delete('ads'); }
      if (this.onLockChange) this.onLockChange(this.locked);
    });
  }

  isTouchEvent(e) { return e.pointerType === 'touch' || (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents); }

  async requestLock() {
    if (this.isTouch) return true;
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.then) await p;
      return true;
    } catch (err) {
      try {
        const p2 = this.canvas.requestPointerLock();
        if (p2 && p2.then) await p2;
        return true;
      } catch (err2) {
        return false;
      }
    }
  }

  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // ------------------------------------------------------------------ touch

  bindTouch() {
    const root = document.getElementById('touch');
    const pad = document.getElementById('touch-pad');
    this.stickBase = document.getElementById('stick-base');
    this.stickKnob = document.getElementById('stick-knob');
    this.stickR = 58;

    pad.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      pad.setPointerCapture(e.pointerId);
      const leftZone = e.clientX < window.innerWidth * 0.42;
      const hasStick = [...this.pointers.values()].some((p) => p.kind === 'stick');
      if (leftZone && !hasStick) {
        this.pointers.set(e.pointerId, { kind: 'stick', ox: e.clientX, oy: e.clientY });
        this.showStick(e.clientX, e.clientY);
      } else {
        this.pointers.set(e.pointerId, { kind: 'look', lx: e.clientX, ly: e.clientY });
      }
    });
    pad.addEventListener('pointermove', (e) => this.touchMove(e));
    const end = (e) => this.touchEnd(e);
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);

    root.querySelectorAll('[data-act]').forEach((el) => {
      const act = el.dataset.act, mode = el.dataset.mode || 'tap';
      el.addEventListener('pointerdown', (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        e.stopPropagation();
        el.setPointerCapture(e.pointerId);
        el.classList.add('pressed');
        if (mode === 'hold') this.held.add(act);
        else if (mode === 'toggle') {
          this.touchToggles[act] = !this.touchToggles[act];
          el.classList.toggle('on', this.touchToggles[act]);
        } else this.taps.add(act);
        // the fire button doubles as a look pad so you can track while shooting
        if (el.dataset.look) this.pointers.set(e.pointerId, { kind: 'look', lx: e.clientX, ly: e.clientY, btn: act });
      });
      el.addEventListener('pointermove', (e) => { if (el.dataset.look) this.touchMove(e); });
      const release = (e) => {
        el.classList.remove('pressed');
        if (mode === 'hold') this.held.delete(act);
        if (el.dataset.look) this.pointers.delete(e.pointerId);
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
    });
  }

  touchMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.enabled) return;
    e.preventDefault();
    if (p.kind === 'stick') {
      let dx = e.clientX - p.ox, dy = e.clientY - p.oy;
      const d = Math.hypot(dx, dy), R = this.stickR;
      if (d > R) { dx *= R / d; dy *= R / d; }
      this.move.x = dx / R;
      this.move.y = -dy / R;
      const mag = Math.hypot(this.move.x, this.move.y);
      if (mag < 0.12) { this.move.x = 0; this.move.y = 0; }
      this.stickSprint = this.move.y > 0.9 && Math.abs(this.move.x) < 0.4 && d > R * 1.25;
      this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    } else {
      this.lookX += e.clientX - p.lx;
      this.lookY += e.clientY - p.ly;
      p.lx = e.clientX; p.ly = e.clientY;
      this.lookSource = 'touch';
    }
  }

  touchEnd(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    if (p.kind === 'stick') {
      this.move.x = 0; this.move.y = 0;
      this.stickSprint = false;
      this.hideStick();
    }
    this.pointers.delete(e.pointerId);
  }

  showStick(x, y) {
    const R = this.stickR;
    x = clamp(x, R + 12, window.innerWidth * 0.42);
    y = clamp(y, R + 12, window.innerHeight - R - 12);
    const base = this.stickBase;
    base.style.left = `${x}px`;
    base.style.top = `${y}px`;
    base.classList.add('active');
    this.stickKnob.style.transform = 'translate(0px, 0px)';
    const p = [...this.pointers.values()].find((q) => q.kind === 'stick');
    if (p) { p.ox = x; p.oy = y; }
  }

  hideStick() {
    this.stickBase.classList.remove('active');
    this.stickKnob.style.transform = 'translate(0px, 0px)';
  }

  // ------------------------------------------------------------------ queries

  getMove() {
    if (this.isTouch && (this.move.x || this.move.y)) return this.move;
    const f = (this.held.has('forward') ? 1 : 0) - (this.held.has('back') ? 1 : 0);
    const r = (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0);
    const len = Math.hypot(f, r) || 1;
    this._mv = this._mv || { x: 0, y: 0 };
    this._mv.x = r / len; this._mv.y = f / len;
    return this._mv;
  }

  isDown(action) {
    if (action === 'ads' && this.touchToggles.ads) return true;
    if (action === 'sprint' && (this.touchToggles.sprint || this.stickSprint)) return true;
    return this.held.has(action);
  }

  consumeTap(action) {
    if (this.taps.has(action)) { this.taps.delete(action); return true; }
    return false;
  }

  consumeLook() {
    const x = this.lookX, y = this.lookY;
    this.lookX = 0; this.lookY = 0;
    return { x, y, source: this.lookSource };
  }

  /** Touch toggles that gameplay may need to cancel (e.g. ADS when sprinting). */
  setToggle(name, v) {
    if (this.touchToggles[name] === v) return;
    this.touchToggles[name] = v;
    const el = document.querySelector(`[data-act="${name}"]`);
    if (el) el.classList.toggle('on', v);
  }

  endFrame() { this.taps.clear(); }

  clearAll() {
    this.held.clear();
    this.taps.clear();
    this.lookX = this.lookY = 0;
    this.move.x = this.move.y = 0;
    this.stickSprint = false;
    for (const k of Object.keys(this.touchToggles)) this.setToggle(k, false);
    this.pointers.clear();
    if (this.stickBase) this.hideStick();
  }
}
