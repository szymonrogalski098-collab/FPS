// Static game configuration: quality tiers, weapons, enemy profiles, settings persistence.
import { isTouchDevice } from './util.js';

export const QUALITY = {
  low: {
    label: 'Low', maxDpr: 1, renderScale: 0.75, shadows: false, shadowSize: 512,
    post: false, msaa: 0, bloom: false, texSize: 256, lightTier: 0, anisotropy: 1,
    dust: false, shadowEvery: 0,
  },
  medium: {
    label: 'Medium', maxDpr: 1.5, renderScale: 1, shadows: true, shadowSize: 1024,
    post: true, msaa: 0, bloom: false, texSize: 512, lightTier: 1, anisotropy: 4,
    dust: true, shadowEvery: 2,
  },
  high: {
    label: 'High', maxDpr: 2, renderScale: 1, shadows: true, shadowSize: 2048,
    post: true, msaa: 4, bloom: true, texSize: 512, lightTier: 2, anisotropy: 8,
    dust: true, shadowEvery: 1,
  },
};

export const WEAPONS = {
  rifle: {
    id: 'rifle', slot: 1, name: 'K4 CARBINE', short: 'K4', caliber: '5.56',
    auto: true, rpm: 760, pellets: 1,
    damage: 34, headMult: 4.0, limbMult: 0.75, range: 250, falloffStart: 60, falloffEnd: 180, minDamageMul: 0.75,
    mag: 30, reserve: 120, chamber: true,
    reloadTime: 2.2, reloadEmptyTime: 2.75,
    spread: { hip: 2.1, ads: 0.08, move: 2.6, adsMove: 0.9, air: 6, crouchMul: 0.8, bloomPerShot: 0.11, bloomMax: 1.4 },
    recoil: { up: 0.6, upGrow: 0.06, upMax: 1.05, side: 0.24, drift: 0.05, recover: 7, permanent: 0.38, punch: 1.1, adsMul: 0.8, crouchMul: 0.85 },
    kick: { z: 0.034, rotX: 2.6, rotY: 0.8, rotZ: 1.8 },
    adsZoom: 1.3, adsTime: 0.2, moveMul: 0.95, switchTime: 0.42, sprintOutTime: 0.17,
    sound: 'rifle', shell: 'brass', noise: 48,
  },
  pistol: {
    id: 'pistol', slot: 2, name: 'P9 COMPACT', short: 'P9', caliber: '9mm',
    auto: false, rpm: 450, pellets: 1,
    damage: 29, headMult: 3.6, limbMult: 0.8, range: 120, falloffStart: 20, falloffEnd: 60, minDamageMul: 0.65,
    mag: 15, reserve: 60, chamber: true,
    reloadTime: 1.5, reloadEmptyTime: 1.9,
    spread: { hip: 1.5, ads: 0.3, move: 1.7, adsMove: 0.8, air: 5, crouchMul: 0.85, bloomPerShot: 0.35, bloomMax: 1.6 },
    recoil: { up: 1.8, upGrow: 0.1, upMax: 2.4, side: 0.5, drift: 0, recover: 10, permanent: 0.3, punch: 1.3, adsMul: 0.85, crouchMul: 0.9 },
    kick: { z: 0.045, rotX: 7, rotY: 1.2, rotZ: 2.5 },
    adsZoom: 1.12, adsTime: 0.15, moveMul: 1.0, switchTime: 0.32, sprintOutTime: 0.12,
    sound: 'pistol', shell: 'brass9', noise: 38,
  },
  shotgun: {
    id: 'shotgun', slot: 3, name: 'BREACHER 12', short: 'B12', caliber: '12ga',
    auto: false, rpm: 80, pellets: 9,
    damage: 17, headMult: 1.8, limbMult: 0.85, range: 45, falloffStart: 7, falloffEnd: 28, minDamageMul: 0.2,
    mag: 7, reserve: 28, chamber: false,
    reloadStart: 0.42, reloadShell: 0.52, reloadEnd: 0.4, pumpTime: 0.6,
    spread: { hip: 3.6, ads: 2.7, move: 1.2, adsMove: 0.6, air: 3, crouchMul: 0.95, bloomPerShot: 0, bloomMax: 0 },
    recoil: { up: 4.4, upGrow: 0, upMax: 4.4, side: 0.9, drift: 0, recover: 5, permanent: 0.45, punch: 1.6, adsMul: 0.85, crouchMul: 0.85 },
    kick: { z: 0.075, rotX: 9, rotY: 1.8, rotZ: 3 },
    adsZoom: 1.15, adsTime: 0.24, moveMul: 0.92, switchTime: 0.5, sprintOutTime: 0.2,
    sound: 'shotgun', shell: 'shell12', noise: 55,
  },
};

export const WEAPON_ORDER = ['rifle', 'pistol', 'shotgun'];

export const ENEMY_PROFILES = {
  rookie: {
    hp: 100, spread: 4.2, reaction: [0.8, 1.25], burst: [2, 4], burstGap: [0.6, 1.1],
    rpm: 600, damage: 11, detectRate: 0.8, fov: 110, palette: 'rookie', aggression: 0.45, helmet: false,
  },
  regular: {
    hp: 100, spread: 3.2, reaction: [0.55, 0.9], burst: [3, 5], burstGap: [0.45, 0.85],
    rpm: 680, damage: 13, detectRate: 1.0, fov: 120, palette: 'regular', aggression: 0.6, helmet: true,
  },
  veteran: {
    hp: 120, spread: 2.4, reaction: [0.35, 0.6], burst: [3, 5], burstGap: [0.35, 0.65],
    rpm: 720, damage: 15, detectRate: 1.25, fov: 130, palette: 'veteran', aggression: 0.7, helmet: true,
  },
};

export const DIFFICULTY = {
  recruit: { label: 'Recruit', spread: 1.5, damage: 0.65, reaction: 1.35, detect: 0.8 },
  regular: { label: 'Regular', spread: 1.0, damage: 1.0, reaction: 1.0, detect: 1.0 },
  veteran: { label: 'Veteran', spread: 0.75, damage: 1.3, reaction: 0.8, detect: 1.2 },
};

export const PLAYER = {
  radius: 0.3,
  standHeight: 1.8, crouchHeight: 1.2,
  standEye: 1.64, crouchEye: 1.08,
  walkSpeed: 3.4, sprintSpeed: 5.9, crouchSpeed: 1.7, adsSpeedMul: 0.6,
  accel: 11, airAccel: 1.6, jumpVel: 4.1, gravity: 9.81 * 1.25,
  stepUp: 0.42, leanDist: 0.36, leanRoll: 11,
  maxHealth: 100,
};

function detectDefaultQuality() {
  if (isTouchDevice()) {
    const mem = navigator.deviceMemory || 4;
    return mem <= 3 ? 'low' : 'medium';
  }
  return 'high';
}

const DEFAULT_SETTINGS = {
  quality: null,
  dynamicRes: true,
  fov: 90,
  mouseSens: 1.0,
  touchSens: 1.0,
  adsSensMul: 0.75,
  invertY: false,
  volume: 0.8,
  difficulty: 'regular',
  hitMarkers: false,
  showFps: false,
};

const STORAGE_KEY = 'greywater.settings.v2';

export function loadSettings() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) { stored = {}; }
  const s = { ...DEFAULT_SETTINGS, ...stored };
  if (!s.quality || !QUALITY[s.quality]) s.quality = detectDefaultQuality();
  if (!DIFFICULTY[s.difficulty]) s.difficulty = 'regular';
  return s;
}

export function saveSettings(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) { /* storage unavailable */ }
}
