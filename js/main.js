// TEMP visual test harness (replaced by the real bootstrap later)
import * as THREE from 'three';
import { QUALITY, loadSettings } from './config.js';
import { TextureFactory } from './textures.js';
import { createMaterials } from './materials.js';
import { PhysicsWorld } from './physics.js';
import { buildLevel, buildLights, buildLightShafts, buildDust, SUN_DIR } from './level.js';
import { createSky, createEnvironment } from './sky.js';
import { RenderPipeline } from './renderer.js';
import { nextFrame } from './util.js';

const settings = loadSettings();
const q = QUALITY[new URLSearchParams(location.search).get('q') || settings.quality];
const canvas = document.getElementById('game');
const pipe = new RenderPipeline(canvas);
pipe.applyQuality(q);
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xa9a398, 0.0065);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 700);
const t0 = performance.now();
const tf = new TextureFactory(q.texSize, Math.min(q.anisotropy, pipe.maxAniso));
const M = createMaterials(tf, q);
console.log('textures', performance.now() - t0);
const physics = new PhysicsWorld();
const lvl = buildLevel(scene, physics, M, tf, q);
console.log('level', performance.now() - t0, physics.colliders.length);
buildLights(scene, q);
createSky(scene, SUN_DIR);
scene.environment = createEnvironment(pipe.r, SUN_DIR);
const shafts = buildLightShafts(scene);
buildDust(scene, 400);
document.getElementById('screen-loading').classList.remove('active');
const p = new URLSearchParams(location.search);
const cam = (p.get('cam') || '22,1.7,23.8,0.64,0').split(',').map(Number);
camera.position.set(cam[0], cam[1], cam[2]);
camera.rotation.set(cam[4], cam[3], 0, 'YXZ');
pipe.exposure = Number(p.get('exp') || 1);
window.__cam = camera; window.__pipe = pipe; window.__scene = scene;
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); pipe.resize(); });
function loop() {
  requestAnimationFrame(loop);
  pipe.render(scene, camera, null, null, 1 / 60);
}
loop();
