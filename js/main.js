// Bootstrap + menu / UI flow. The game itself lives in game.js.
import { loadSettings, saveSettings, QUALITY } from './config.js';
import { setSunMask } from './materials.js';
import { RenderPipeline } from './renderer.js';
import { AudioEngine } from './audio.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { Game } from './game.js';
import { formatTime } from './util.js';

const $ = (id) => document.getElementById(id);
const settings = loadSettings();
const canvas = $('game');

function fatal(msg) {
  const f = $('fatal');
  f.innerHTML = msg;
  f.classList.remove('hidden');
}

let pipe;
try {
  pipe = new RenderPipeline(canvas);
} catch (e) {
  fatal('Greywater needs WebGL 2. Please use an up-to-date Chrome, Edge, Firefox or Safari.');
  throw e;
}
const audio = new AudioEngine();
audio.volume = settings.volume;
const input = new Input(canvas);
const hud = new HUD();
const game = new Game(pipe, audio, input, hud, settings);
const touch = input.isTouch;
document.body.classList.toggle('touch', touch);
if (touch) $('touch').classList.add('is-touch');

let ui = 'loading';
let panelOpen = null;

// ------------------------------------------------------------------ screens

function showScreen(name) {
  for (const id of ['screen-loading', 'screen-menu', 'screen-pause', 'screen-end']) $(id).classList.remove('active');
  if (name) $('screen-' + name).classList.add('active');
  const inGame = ui === 'playing';
  hud.show(inGame);
  $('touch').classList.toggle('hidden', !(inGame && touch));
}

function openPanel(id) {
  panelOpen = id;
  $(id).classList.add('active');
  audio.playUI('click');
}

function closePanel() {
  if (!panelOpen) return;
  $(panelOpen).classList.remove('active');
  panelOpen = null;
  audio.playUI('click');
}

async function enterFullscreen() {
  if (!touch) return;
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch (e) { /* not supported (iOS) */ }
  try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch (e) { /* ignored */ }
}

async function lockPointer() {
  if (touch) return;
  const ok = await input.requestLock();
  $('click-resume').classList.toggle('hidden', ok);
}

async function play() {
  await audio.resume();
  audio.playUI('click');
  await enterFullscreen();
  game.startMission();
  ui = 'playing';
  input.enabled = true;
  showScreen(null);
  await lockPointer();
}

function pause() {
  if (ui !== 'playing') return;
  ui = 'paused';
  input.enabled = false;
  input.clearAll();
  $('click-resume').classList.add('hidden');
  showScreen('pause');
}

async function resume() {
  if (ui !== 'paused') return;
  closePanel();
  audio.playUI('click');
  ui = 'playing';
  input.enabled = true;
  showScreen(null);
  await lockPointer();
}

async function restart() {
  closePanel();
  await audio.resume();
  audio.playUI('click');
  game.startMission();
  ui = 'playing';
  input.enabled = true;
  showScreen(null);
  await lockPointer();
}

function quitToMenu() {
  closePanel();
  audio.playUI('click');
  input.enabled = false;
  input.clearAll();
  input.releaseLock();
  ui = 'menu';
  game.state = 'menu';
  game.menuT = 0;
  game.resetWorld();
  showScreen('menu');
}

game.onEnd = (kind, s) => {
  ui = 'end';
  input.enabled = false;
  input.clearAll();
  input.releaseLock();
  $('click-resume').classList.add('hidden');
  const ok = kind === 'complete';
  $('end-title').textContent = ok ? 'MISSION COMPLETE' : 'KILLED IN ACTION';
  $('end-title').classList.toggle('fail', !ok);
  $('end-sub').textContent = ok ? 'Drive recovered. You made it out.' : 'Your operation ended inside Kestrel Freight Depot.';
  const cells = [
    [formatTime(s.time), 'Time'], [String(s.kills), 'Hostiles down'], [String(s.headshots), 'Headshots'],
    [`${s.accuracy}%`, 'Accuracy'], [String(s.shots), 'Rounds fired'], [String(Math.round(s.damage)), 'Damage taken'],
  ];
  $('end-stats').innerHTML = cells.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
  showScreen('end');
};

input.onLockChange = (locked) => {
  if (!locked && ui === 'playing' && !touch) pause();
};

// ------------------------------------------------------------------ buttons

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  if (!b) return;
  const cmd = b.dataset.cmd;
  if (cmd === 'play') play();
  else if (cmd === 'resume') resume();
  else if (cmd === 'restart') restart();
  else if (cmd === 'quit') quitToMenu();
  else if (cmd === 'settings') openPanel('panel-settings');
  else if (cmd === 'controls') openPanel('panel-controls');
  else if (cmd === 'back') closePanel();
});
document.querySelectorAll('.mbtn').forEach((b) => b.addEventListener('mouseenter', () => audio.playUI('hover')));
$('click-resume').addEventListener('click', () => lockPointer());
document.querySelectorAll('.panel').forEach((p) => p.addEventListener('click', (e) => { if (e.target === p) closePanel(); }));
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && panelOpen) { closePanel(); e.preventDefault(); }
});

// ------------------------------------------------------------------ settings panel

const fmt = {
  fov: (v) => `${Math.round(v)}°`, mouseSens: (v) => Number(v).toFixed(2), touchSens: (v) => Number(v).toFixed(2),
  adsSensMul: (v) => Number(v).toFixed(2), volume: (v) => `${Math.round(v * 100)}%`,
};

function refreshSettingsUI() {
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const k = el.dataset.setting, v = settings[k];
    if (el.classList.contains('seg')) el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    else if (el.classList.contains('tog')) el.classList.toggle('on', !!v);
    else if (el.type === 'range') el.value = v;
  });
  document.querySelectorAll('[data-out]').forEach((el) => { const k = el.dataset.out; el.textContent = fmt[k] ? fmt[k](settings[k]) : settings[k]; });
}

function applySetting(k) {
  saveSettings(settings);
  if (k === 'volume') audio.setVolume(settings.volume);
  if (k === 'quality') {
    const q = QUALITY[settings.quality];
    pipe.applyQuality(q);
    setSunMask(!q.shadows);
    if (game.lights) game.lights.sun.castShadow = q.shadows;
    if (game.scene) {
      const bump = (o) => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; }); };
      game.scene.traverse(bump);
      game.viewmodel.scene.traverse(bump);
    }
  }
  if (k === 'dynamicRes' && !settings.dynamicRes) pipe.setDynamicScale(1);
  refreshSettingsUI();
}

document.querySelectorAll('[data-setting]').forEach((el) => {
  const k = el.dataset.setting;
  if (el.classList.contains('seg')) {
    el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { settings[k] = b.dataset.v; audio.playUI('click'); applySetting(k); }));
  } else if (el.classList.contains('tog')) {
    el.addEventListener('click', () => { settings[k] = !settings[k]; audio.playUI('click'); applySetting(k); });
  } else if (el.type === 'range') {
    el.addEventListener('input', () => { settings[k] = Number(el.value); applySetting(k); });
  }
});
refreshSettingsUI();
$('fps').classList.toggle('hidden', false);

// ------------------------------------------------------------------ main loop

let last = performance.now();
let fpsAcc = 0, fpsFrames = 0, fpsText = '';
let perfAcc = 0, perfFrames = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt <= 0) return;
  const rawDt = dt;
  dt = Math.min(dt, 0.05);
  if (ui === 'playing' && input.consumeTap('pause')) pause();
  if (ui === 'loading' || ui === 'paused' || ui === 'end') return;
  game.update(dt);
  hud.update(dt, settings.showFps ? fpsText : '');
  // fps + dynamic resolution
  fpsAcc += rawDt; fpsFrames++;
  if (fpsAcc >= 0.5) { fpsText = `${Math.round(fpsFrames / fpsAcc)} FPS · ${(pipe.pixelRatio()).toFixed(2)}x`; fpsAcc = 0; fpsFrames = 0; }
  if (settings.dynamicRes && ui === 'playing' && rawDt < 0.1 && !document.hidden) {
    perfAcc += rawDt; perfFrames++;
    if (perfAcc >= 1.5) {
      const ms = (perfAcc / perfFrames) * 1000;
      if (ms > 23 && pipe.dynScale > 0.55) pipe.setDynamicScale(Math.max(0.55, pipe.dynScale * 0.88));
      else if (ms < 14.5 && pipe.dynScale < 1) pipe.setDynamicScale(Math.min(1, pipe.dynScale * 1.06));
      perfAcc = 0; perfFrames = 0;
    }
  }
}

window.addEventListener('resize', () => game.onResize());
window.addEventListener('orientationchange', () => setTimeout(() => game.onResize(), 250));
window.addEventListener('beforeunload', (e) => { if (ui === 'playing') { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

async function boot() {
  const fill = $('load-fill'), text = $('load-text');
  try {
    await game.load(async (k, label) => {
      fill.style.width = `${Math.round(k * 100)}%`;
      text.textContent = label;
      await new Promise((r) => setTimeout(r, 0));
    });
  } catch (e) {
    console.error(e);
    fatal(`Something went wrong while loading.<br><small>${String(e && e.message || e)}</small>`);
    return;
  }
  ui = 'menu';
  showScreen('menu');
  last = performance.now();
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

window.__game = game;
boot();
