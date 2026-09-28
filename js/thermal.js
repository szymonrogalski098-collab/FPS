// Thermal channel for the binoculars. Not a colour filter: while it is active every visible mesh is
// drawn with a heat material for its category (sun-soaked rock and soil, shaded ground, cool
// vegetation, walls, metal, warm bodies, a cold sky), with sun exposure from the terrain bake,
// per-surface variation and atmospheric attenuation. The final pass turns it into a white-hot
// sensor image (gain, noise, slight blur) — see renderer.js.
import * as THREE from 'three';
import { ambientUniforms } from './materials.js';

const VERT = `
#include <common>
#include <skinning_pars_vertex>
varying vec3 vWN;
varying vec3 vWP;
varying vec2 vUvT;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 wp = vec4(transformed, 1.0);
  vec3 wn = objectNormal;
  #ifdef USE_INSTANCING
    wp = instanceMatrix * wp;
    wn = mat3(instanceMatrix) * wn;
  #endif
  wp = modelMatrix * wp;
  vWP = wp.xyz;
  vWN = normalize(mat3(modelMatrix) * wn);
  vUvT = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = `
uniform float uBase;
uniform float uSun;
uniform float uEdge;
uniform float uNoise;
uniform vec3 uSunDirT;
uniform sampler2D uAlphaMap;
uniform float uAlphaTest;
uniform sampler2D uTerrLightN;
uniform vec2 uTerrRect;
uniform float uTerrOn;
varying vec3 vWN;
varying vec3 vWP;
varying vec2 vUvT;
float h3(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  if (uAlphaTest > 0.0 && texture2D(uAlphaMap, vUvT).a < uAlphaTest) discard;
  vec3 n = normalize(vWN);
  vec3 V = normalize(cameraPosition - vWP);
  if (dot(n, V) < 0.0) n = -n;
  float vis = 1.0;
  if (uTerrOn > 0.5) {
    vec2 a = abs(vWP.xz);
    if (a.x < uTerrRect.x && a.y < uTerrRect.x) vis = texture2D(uTerrLightN, vWP.xz / (2.0 * uTerrRect.x) + 0.5).r;
  }
  float sunlit = max(dot(n, uSunDirT), 0.0) * vis;
  float heat = uBase + uSun * sunlit;
  heat -= uEdge * (1.0 - abs(dot(n, V)));
  heat += (h3(floor(vWP * 2.3)) - 0.5) * uNoise + (h3(floor(vWP * 0.21)) - 0.5) * uNoise * 0.8;
  float d = length(vWP - cameraPosition);
  heat = mix(heat, 0.3, 1.0 - exp(-d / 2400.0));
  gl_FragColor = vec4(vec3(clamp(heat, 0.0, 1.3)), 1.0);
}`;

const SKY_VERT = `
varying vec3 vDir;
void main() { vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const SKY_FRAG = `
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float heat = 0.04 + 0.2 * (1.0 - smoothstep(0.0, 0.35, d.y));
  gl_FragColor = vec4(vec3(heat), 1.0);
}`;

// base temperature, sun gain, silhouette cooling, variation
const HEAT = {
  terrain: [0.34, 0.24, 0, 0.05],
  rock: [0.38, 0.3, 0, 0.05],
  grass: [0.29, 0.1, 0, 0.04],
  veg: [0.25, 0.06, 0, 0.03],
  wall: [0.36, 0.22, 0, 0.03],
  wood: [0.33, 0.15, 0, 0.03],
  metal: [0.27, 0.38, 0, 0.02],
  fabric: [0.32, 0.16, 0, 0.03],
  body: [0.96, 0.03, 0.3, 0.03],
  flash: [1.3, 0, 0, 0],
};
const SURFACE_HEAT = { metal: 'metal', wood: 'wood', dirt: 'wall', rock: 'rock', fabric: 'fabric', flesh: 'body', concrete: 'wall', asphalt: 'terrain', glass: 'metal' };

export class ThermalView {
  constructor(world) {
    this.world = world;
    this.cache = new Map();
    this.swapped = [];
    this.hidden = [];
    this.sunDir = world.sunDir.clone().normalize();
    this.skyMat = new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false });
  }

  category(mat) {
    if (mat.userData.heat) return mat.userData.heat;
    if (mat.isShaderMaterial) return null;
    if (mat.isMeshBasicMaterial) return mat.blending === THREE.AdditiveBlending ? 'flash' : null;
    if (mat.transparent && mat.opacity < 0.95) return null;
    return SURFACE_HEAT[mat.userData.surface] || 'wall';
  }

  materialFor(mat) {
    const cat = mat.userData.heat === 'sky' ? 'sky' : this.category(mat);
    if (!cat) return null;
    if (cat === 'sky') return this.skyMat;
    const alpha = mat.alphaTest > 0 && mat.map;
    const key = cat + (alpha ? '|a' + mat.map.uuid : '') + (mat.side === THREE.DoubleSide ? '|d' : '');
    let m = this.cache.get(key);
    if (m) return m;
    const h = HEAT[cat] || HEAT.wall;
    const U = ambientUniforms;
    m = new THREE.ShaderMaterial({
      uniforms: {
        uBase: { value: h[0] }, uSun: { value: h[1] }, uEdge: { value: h[2] }, uNoise: { value: h[3] },
        uSunDirT: { value: this.sunDir }, uAlphaMap: { value: alpha ? mat.map : null }, uAlphaTest: { value: alpha ? mat.alphaTest : 0 },
        uTerrLightN: U.uTerrLightN, uTerrRect: U.uTerrRect, uTerrOn: U.uTerrOn,
      },
      vertexShader: VERT, fragmentShader: FRAG, side: mat.side,
    });
    this.cache.set(key, m);
    return m;
  }

  /** Swap every visible mesh to its heat material (and hide what a thermal sensor would not see). */
  begin(scene) {
    this.swapped.length = 0;
    this.hidden.length = 0;
    scene.traverseVisible((o) => {
      if (o.isMesh) {
        const src = o.material;
        const tm = Array.isArray(src) ? null : this.materialFor(src);
        if (!tm) { this.hidden.push(o); return; }
        this.swapped.push(o, src);
        o.material = tm;
      } else if (o.isPoints || o.isSprite || o.isLine) this.hidden.push(o);
    });
    for (const o of this.hidden) o.visible = false;
    this.fog = scene.fog;
    scene.fog = null;
  }

  end(scene) {
    for (let i = 0; i < this.swapped.length; i += 2) this.swapped[i].material = this.swapped[i + 1];
    for (const o of this.hidden) o.visible = true;
    this.swapped.length = 0;
    this.hidden.length = 0;
    scene.fog = this.fog;
  }
}
