// Materials for natural surfaces. All of them are MeshStandardMaterials extended through onBeforeCompile
// and then passed through the shared ambient patch, so they get the same lighting model as the rest of
// the game (sun + baked mountain shadows, cloud shadows, terrain AO, aerial perspective).
import * as THREE from 'three';
import { patchAmbient } from './materials.js';

const ROCK_GLSL = `
uniform sampler2D tRockA;
uniform sampler2D tRockN;
void gwRock(vec3 wp, vec3 wn, float scale, float detail, out vec3 alb, out vec3 nrm, out float rough, out float hgt) {
  vec3 bw = pow(abs(wn), vec3(5.0));
  bw /= (bw.x + bw.y + bw.z);
  vec2 ux = wp.zy * scale, uy = wp.xz * scale * 0.8, uz = wp.xy * scale;
  vec3 a1 = texture2D(tRockA, ux).rgb * bw.x + texture2D(tRockA, uy).rgb * bw.y + texture2D(tRockA, uz).rgb * bw.z;
  vec3 a2 = texture2D(tRockA, ux * 0.21 + 0.3).rgb * bw.x + texture2D(tRockA, uy * 0.19 + 0.6).rgb * bw.y + texture2D(tRockA, uz * 0.21 + 0.1).rgb * bw.z;
  alb = mix(a1, a2, 0.35);
  vec4 nX = texture2D(tRockN, ux), nY = texture2D(tRockN, uy), nZ = texture2D(tRockN, uz);
  vec2 dx = (nX.xy * 2.0 - 1.0) * detail, dy = (nY.xy * 2.0 - 1.0) * detail, dz = (nZ.xy * 2.0 - 1.0) * detail;
  float sx = wn.x >= 0.0 ? 1.0 : -1.0, sz = wn.z >= 0.0 ? 1.0 : -1.0;
  vec3 n1 = vec3(wn.x, wn.y + dx.y, wn.z + dx.x * sx);
  vec3 n2 = vec3(wn.x + dy.x, wn.y, wn.z + dy.y);
  vec3 n3 = vec3(wn.x + dz.x * sz, wn.y + dz.y, wn.z);
  nrm = normalize(n1 * bw.x + n2 * bw.y + n3 * bw.z);
  rough = nX.b * bw.x + nY.b * bw.y + nZ.b * bw.z;
  hgt = nX.a * bw.x + nY.a * bw.y + nZ.a * bw.z;
}
`;

const WORLD_NORMAL_VERT = `
  vec3 gwN = objectNormal;
  #ifdef USE_INSTANCING
    gwN = mat3(instanceMatrix) * gwN;
  #endif
  vGwN = normalize(mat3(modelMatrix) * gwN);
`;

/** Terrain: slope/height/macro-noise driven blend of soil, dry grass, scree and triplanar rock. */
export function createTerrainMaterial(T, maskTex, maskHalf) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.userData.surface = 'dirt';
  mat.userData.heat = 'terrain';
  const uniforms = {
    tRockA: { value: T.rock.map }, tRockN: { value: T.rock.nrh },
    tDirtA: { value: T.dirt.map }, tDirtN: { value: T.dirt.nrh },
    tGrassA: { value: T.grass.map }, tGrassN: { value: T.grass.nrh },
    tGravA: { value: T.gravel.map }, tGravN: { value: T.gravel.nrh },
    tMacro: { value: T.macro }, tMask: { value: maskTex }, uMaskHalf: { value: maskHalf },
  };
  mat.userData.terrainUniforms = uniforms;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGwN;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + WORLD_NORMAL_VERT);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vGwN;
uniform sampler2D tDirtA; uniform sampler2D tDirtN; uniform sampler2D tGrassA; uniform sampler2D tGrassN;
uniform sampler2D tGravA; uniform sampler2D tGravN; uniform sampler2D tMacro; uniform sampler2D tMask; uniform float uMaskHalf;
float gwRoughT; vec3 gwNrmT; float gwAOT;
${ROCK_GLSL}`)
      .replace('#include <map_fragment>', `
  vec3 wp = vAmbPos;
  vec3 wn = normalize(vGwN);
  float camDist = length(wp - cameraPosition);
  float slope = 1.0 - wn.y;
  vec4 mac = texture2D(tMacro, wp.xz / 470.0);
  vec4 mac2 = texture2D(tMacro, wp.xz / 86.0 + vec2(0.37, 0.61));
  vec4 msk = texture2D(tMask, wp.xz / (2.0 * uMaskHalf) + 0.5);
  float rockM = smoothstep(0.2, 0.34, slope + (mac2.g - 0.5) * 0.2 + (mac.b - 0.5) * 0.1);
  float gravM = smoothstep(0.12, 0.24, slope + (mac.b - 0.5) * 0.14) * (1.0 - rockM);
  float grassM = (1.0 - smoothstep(0.07, 0.2, slope)) * smoothstep(0.42, 0.62, mac.r * 0.65 + mac2.g * 0.45) * (1.0 - smoothstep(380.0, 700.0, wp.y));
  float snowM = smoothstep(1250.0, 1650.0, wp.y + (mac.g - 0.5) * 420.0) * (1.0 - smoothstep(0.5, 0.78, slope));
  float roadM = msk.r * (1.0 - rockM), wadiM = msk.g * (1.0 - rockM * 0.7), trailM = msk.b * (1.0 - rockM);
  vec2 uvA = wp.xz / 3.3, uvB = wp.xz / 37.0 + 0.5;
  vec3 dirtC = mix(texture2D(tDirtA, uvA).rgb, texture2D(tDirtA, uvB).rgb, 0.22);
  vec4 dirtN = texture2D(tDirtN, uvA);
  vec3 grassC = mix(texture2D(tGrassA, wp.xz / 2.7).rgb, texture2D(tGrassA, wp.xz / 9.5 + 0.2).rgb, 0.35);
  vec4 grassN = texture2D(tGrassN, wp.xz / 2.7);
  vec3 gravC = mix(texture2D(tGravA, wp.xz / 2.4).rgb, texture2D(tGravA, wp.xz / 8.0 + 0.7).rgb, 0.3);
  vec4 gravN = texture2D(tGravN, wp.xz / 2.4);
  float detail = 1.0 - smoothstep(70.0, 280.0, camDist);
  vec3 rockC; vec3 rockNrm; float rockR; float rockH;
  gwRock(wp, wn, 1.0 / 7.5, detail, rockC, rockNrm, rockR, rockH);
  vec3 alb = dirtC;
  alb = mix(alb, grassC, grassM);
  alb = mix(alb, gravC, gravM * 0.8);
  alb = mix(alb, dirtC * vec3(0.9, 0.87, 0.83) + gravC * 0.06, roadM * 0.92);
  alb = mix(alb, gravC * vec3(1.03, 1.0, 0.95), wadiM * 0.85);
  alb = mix(alb, dirtC * 1.07, trailM * 0.8);
  alb = mix(alb, rockC, rockM);
  alb *= mix(vec3(0.95, 0.97, 1.0), vec3(1.05, 1.0, 0.93), mac.r) * (0.9 + mac2.b * 0.2);
  alb = mix(alb, vec3(0.88, 0.9, 0.94), snowM);
  diffuseColor.rgb = alb;
  vec4 pl = mix(mix(dirtN, grassN, grassM), gravN, gravM);
  vec2 pd = (pl.xy * 2.0 - 1.0) * 0.9 * detail;
  vec3 nPlanar = normalize(vec3(wn.x + pd.x, wn.y, wn.z + pd.y));
  gwNrmT = normalize(mix(nPlanar, rockNrm, rockM));
  gwRoughT = mix(mix(mix(dirtN.b, grassN.b, grassM), gravN.b, gravM), rockR, rockM);
  gwRoughT = mix(gwRoughT, 0.5, snowM);
  float hgt = mix(mix(dirtN.a, gravN.a, gravM), rockH, rockM);
  gwAOT = mix(0.74, 1.0, smoothstep(0.08, 0.55, hgt));
`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gwRoughT;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(gwNrmT, 0.0)).xyz);')
      .replace('#include <aomap_fragment>', `
  float ambientOcclusion = gwAOT;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif`);
  };
  mat.customProgramCacheKey = () => 'terrain';
  return patchAmbient(mat);
}

/** Boulders / scree: triplanar rock texture on displaced icospheres (vertex colour = cavity AO). */
export function createRockMaterial(T, scale = 1 / 2.4) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  mat.userData.surface = 'rock';
  mat.userData.heat = 'rock';
  const uniforms = { tRockA: { value: T.rock.map }, tRockN: { value: T.rock.nrh }, uRockScale: { value: scale } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGwN;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + WORLD_NORMAL_VERT);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vGwN;\nuniform float uRockScale;\nfloat gwRoughT; vec3 gwNrmT;\n${ROCK_GLSL}`)
      .replace('#include <map_fragment>', `
  vec3 rA; vec3 rN; float rR; float rH;
  float dRock = 1.0 - smoothstep(40.0, 200.0, length(vAmbPos - cameraPosition));
  gwRock(vAmbPos, normalize(vGwN), uRockScale, 1.1 * dRock, rA, rN, rR, rH);
  diffuseColor.rgb = rA * 1.06;
  gwNrmT = rN; gwRoughT = rR;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gwRoughT;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(gwNrmT, 0.0)).xyz);');
  };
  mat.customProgramCacheKey = () => 'rock';
  return patchAmbient(mat);
}

function addWind(mat, uniforms, amp, fade) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    sh.uniforms.uTime = uniforms.uTime;
    sh.uniforms.uWind = uniforms.uWind;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec2 uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  #ifdef USE_INSTANCING
    vec3 gwIP = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  #else
    vec3 gwIP = vec3(0.0);
  #endif
  float gwK = ${amp.useUv ? 'uv.y * uv.y' : 'clamp(position.y, 0.0, 2.0) * 0.5'};
  float gwPh = uTime * ${amp.speed.toFixed(2)} + gwIP.x * 0.21 + gwIP.z * 0.17;
  float gwG = 0.6 + 0.4 * sin(uTime * 0.31 + gwIP.x * 0.013);
  transformed.x += (sin(gwPh) * ${amp.a.toFixed(3)} + sin(gwPh * 2.3) * ${(amp.a * 0.35).toFixed(3)} + uWind.x * ${amp.w.toFixed(3)} * gwG) * gwK;
  transformed.z += (cos(gwPh * 0.83) * ${(amp.a * 0.7).toFixed(3)} + uWind.y * ${amp.w.toFixed(3)} * gwG) * gwK;
  ${fade ? `transformed *= 1.0 - smoothstep(${fade[0].toFixed(1)}, ${fade[1].toFixed(1)}, distance(gwIP, cameraPosition));` : ''}`);
  };
}

/** Dry grass tufts: alpha-tested blade cards with wind sway and distance fade-out. */
export function createGrassMaterial(bladesTex, windU) {
  const mat = new THREE.MeshStandardMaterial({ map: bladesTex, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 });
  mat.userData.surface = 'dirt';
  mat.userData.heat = 'grass';
  addWind(mat, windU, { useUv: true, speed: 1.7, a: 0.07, w: 0.09 }, [120, 165]);
  mat.customProgramCacheKey = () => 'grass';
  return patchAmbient(mat);
}
