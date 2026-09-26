// Material library + "ambient volume" shader patch.
// The ambient volume darkens indirect light (hemisphere + environment) inside the building so
// interiors read as enclosed spaces instead of flat, evenly-lit boxes. This is a cheap stand-in for GI.
import * as THREE from 'three';

const AMB_COUNT = 6;

export const ambientUniforms = {
  uAmbMin: { value: Array.from({ length: AMB_COUNT }, () => new THREE.Vector3(1e5, 1e5, 1e5)) },
  uAmbMax: { value: Array.from({ length: AMB_COUNT }, () => new THREE.Vector3(1e5, 1e5, 1e5)) },
  uAmbVal: { value: new Array(AMB_COUNT).fill(1) },
  uAmbSoft: { value: new Array(AMB_COUNT).fill(1) },
};

/** zones: [{min:[x,y,z], max:[x,y,z], value, soft}] ordered from large to small. */
export function setAmbientZones(zones) {
  zones.slice(0, AMB_COUNT).forEach((z, i) => {
    ambientUniforms.uAmbMin.value[i].set(...z.min);
    ambientUniforms.uAmbMax.value[i].set(...z.max);
    ambientUniforms.uAmbVal.value[i] = z.value;
    ambientUniforms.uAmbSoft.value[i] = z.soft;
  });
}

/** CPU mirror of the GLSL function; used for view-model lighting and auto exposure. */
export function ambientAt(p) {
  let f = 1;
  const { uAmbMin, uAmbMax, uAmbVal, uAmbSoft } = ambientUniforms;
  for (let i = 0; i < AMB_COUNT; i++) {
    const mn = uAmbMin.value[i], mx = uAmbMax.value[i], soft = uAmbSoft.value[i];
    const dx = Math.max(mn.x - p.x, p.x - mx.x), dy = Math.max(mn.y - p.y, p.y - mx.y), dz = Math.max(mn.z - p.z, p.z - mx.z);
    const outside = Math.max(dx, dy, dz);
    const t = Math.min(1, Math.max(0, (outside + soft) / (soft * 1.3)));
    const m = 1 - t * t * (3 - 2 * t);
    f = f + (uAmbVal.value[i] - f) * m;
  }
  return f;
}

const AMB_VERT_DECL = 'varying vec3 vAmbPos;';
const AMB_VERT = `
  vec4 ambWp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    ambWp = instanceMatrix * ambWp;
  #endif
  vAmbPos = (modelMatrix * ambWp).xyz;
`;
const AMB_FRAG_DECL = `
varying vec3 vAmbPos;
uniform vec3 uAmbMin[${AMB_COUNT}];
uniform vec3 uAmbMax[${AMB_COUNT}];
uniform float uAmbVal[${AMB_COUNT}];
uniform float uAmbSoft[${AMB_COUNT}];
float ambientVolume(vec3 p) {
  float f = 1.0;
  for (int i = 0; i < ${AMB_COUNT}; i++) {
    vec3 d = max(uAmbMin[i] - p, p - uAmbMax[i]);
    float outside = max(max(d.x, d.y), d.z);
    float m = 1.0 - smoothstep(-uAmbSoft[i], uAmbSoft[i] * 0.3, outside);
    f = mix(f, uAmbVal[i], m);
  }
  return f;
}
`;
const AMB_FRAG = `
  float ambF = ambientVolume(vAmbPos);
  #if defined( RE_IndirectDiffuse )
    irradiance *= ambF;
    iblIrradiance *= ambF;
  #endif
  #if defined( RE_IndirectSpecular )
    radiance *= ambF;
  #endif
`;

export function patchAmbient(mat) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    Object.assign(shader.uniforms, ambientUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${AMB_VERT_DECL}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${AMB_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${AMB_FRAG_DECL}`)
      .replace('#include <lights_fragment_end>', `${AMB_FRAG}\n#include <lights_fragment_end>`);
  };
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : null;
  mat.customProgramCacheKey = () => 'amb' + (prevKey ? prevKey() : '');
  return mat;
}

function tiled(tex, meters) {
  if (!tex) return null;
  const t = tex.clone();
  t.repeat.set(1 / meters, 1 / meters);
  t.needsUpdate = true;
  return t;
}

/**
 * Builds every material the level uses. `surface` is the acoustic/impact tag used by physics.
 */
export function createMaterials(tf, quality) {
  const useNormals = quality.texSize >= 512 || true;
  const aoRamp = tf.aoRamp();
  const T = {
    concreteFloor: tf.concreteFloor(),
    concreteWall: tf.concreteWall(),
    block: tf.paintedBlock(),
    corrugated: tf.corrugated(),
    steel: tf.steelPaint(),
    bare: tf.bareMetal(),
    wood: tf.wood(),
    asphalt: tf.asphalt(),
    checker: tf.checkerPlate(),
    fabric: tf.fabric(),
    ceiling: tf.ceilingTile(),
    lino: tf.linoleum(),
  };

  const std = (name, set, meters, params = {}, surface = 'concrete', ao = true) => {
    const m = new THREE.MeshStandardMaterial({
      map: tiled(set.map, meters),
      normalMap: useNormals ? tiled(set.normalMap, meters) : null,
      roughnessMap: tiled(set.roughMap, meters),
      metalnessMap: params.metalness !== undefined && params.metalness > 0 ? tiled(set.roughMap, meters) : null,
      aoMap: ao ? aoRamp : null,
      aoMapIntensity: 1,
      ...params,
    });
    if (m.normalMap && params.normalScale === undefined) m.normalScale.set(1, 1);
    m.name = name;
    m.userData.surface = surface;
    return patchAmbient(m);
  };

  const M = {};
  M.floor = std('floor', T.concreteFloor, 4, { color: 0xb9b6ae, roughness: 1, metalness: 0 }, 'concrete', false);
  M.concrete = std('concrete', T.concreteWall, 4, { color: 0xc4c0b6, roughness: 1 }, 'concrete');
  M.concreteDark = std('concreteDark', T.concreteWall, 3, { color: 0x8c8880, roughness: 1 }, 'concrete');
  M.blockCream = std('blockCream', T.block, 1.6, { color: 0xd8d0bc, roughness: 1 }, 'concrete');
  M.blockGreen = std('blockGreen', T.block, 1.6, { color: 0x6c7a6a, roughness: 1 }, 'concrete');
  M.blockGrey = std('blockGrey', T.block, 1.6, { color: 0x9b9c98, roughness: 1 }, 'concrete');
  M.roofMetal = std('roofMetal', T.corrugated, 2, { color: 0x8b8f92, roughness: 1, metalness: 1 }, 'metal');
  M.cladding = std('cladding', T.corrugated, 2, { color: 0x7d8784, roughness: 1, metalness: 1 }, 'metal');
  M.containerRed = std('containerRed', T.corrugated, 2.4, { color: 0x7c3a2c, roughness: 1, metalness: 0.4 }, 'metal');
  M.containerBlue = std('containerBlue', T.corrugated, 2.4, { color: 0x3f5563, roughness: 1, metalness: 0.4 }, 'metal');
  M.containerGreen = std('containerGreen', T.corrugated, 2.4, { color: 0x4f5a45, roughness: 1, metalness: 0.4 }, 'metal');
  M.shutter = std('shutter', T.corrugated, 1.2, { color: 0x7e8580, roughness: 1, metalness: 1 }, 'metal');
  M.steelBlue = std('steelBlue', T.steel, 1, { color: 0x51606b, roughness: 1, metalness: 1 }, 'metal');
  M.steelYellow = std('steelYellow', T.steel, 1, { color: 0xb08a3c, roughness: 1, metalness: 1 }, 'metal');
  M.steelOrange = std('steelOrange', T.steel, 1, { color: 0x9a5a2e, roughness: 1, metalness: 1 }, 'metal');
  M.steelGreen = std('steelGreen', T.steel, 1, { color: 0x56624f, roughness: 1, metalness: 1 }, 'metal');
  M.steelGrey = std('steelGrey', T.steel, 1, { color: 0x77797a, roughness: 1, metalness: 1 }, 'metal');
  M.steelDark = std('steelDark', T.steel, 1, { color: 0x3a3c3d, roughness: 1, metalness: 1 }, 'metal');
  M.steelWhite = std('steelWhite', T.steel, 1, { color: 0xc9c7bf, roughness: 1, metalness: 1 }, 'metal');
  M.steelRed = std('steelRed', T.steel, 0.6, { color: 0x8a2a22, roughness: 1, metalness: 1 }, 'metal');
  M.bareMetal = std('bareMetal', T.bare, 1, { color: 0xa9abad, roughness: 1, metalness: 1 }, 'metal');
  M.galv = std('galv', T.bare, 2, { color: 0x9aa0a3, roughness: 1, metalness: 1 }, 'metal', false);
  M.checker = std('checker', T.checker, 0.5, { color: 0x8f9396, roughness: 1, metalness: 1 }, 'metal', false);
  M.wood = std('wood', T.wood, 1, { color: 0xc9b48f, roughness: 1 }, 'wood');
  M.woodDark = std('woodDark', T.wood, 1, { color: 0x7d6446, roughness: 1 }, 'wood');
  M.plywood = std('plywood', T.wood, 1.4, { color: 0xd8c29a, roughness: 1 }, 'wood');
  M.asphalt = std('asphalt', T.asphalt, 6, { color: 0xb8b8b8, roughness: 1 }, 'asphalt', false);
  M.ground = std('ground', T.asphalt, 9, { color: 0x8f8a7c, roughness: 1 }, 'asphalt', false);
  M.road = std('road', T.asphalt, 6, { color: 0x9c9c9c, roughness: 1 }, 'asphalt', false);
  M.foliage = patchAmbient(new THREE.MeshStandardMaterial({ color: 0x2c3526, roughness: 1, metalness: 0 }));
  M.foliage.userData.surface = 'wood';
  M.woodPole = std('woodPole', T.wood, 1, { color: 0x4a3a2a, roughness: 1 }, 'wood', false);
  M.paintLine = patchAmbient(new THREE.MeshStandardMaterial({
    color: 0xa38a45, roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    map: tiled(T.concreteFloor.map, 4),
  }));
  M.paintLine.userData.surface = 'concrete';
  M.ceiling = std('ceiling', T.ceiling, 1.2, { color: 0xd9d6cc, roughness: 1, metalness: 1 }, 'concrete', false);
  M.lino = std('lino', T.lino, 1.2, { color: 0xcfc6b2, roughness: 1 }, 'concrete', false);
  M.fabric = std('fabric', T.fabric, 0.5, { color: 0x5c5e52, roughness: 1 }, 'fabric');
  M.sandbag = std('sandbag', T.fabric, 0.35, { color: 0x8b7c5e, roughness: 1 }, 'dirt');
  M.tarp = std('tarp', T.fabric, 0.8, { color: 0x4d5b4a, roughness: 1 }, 'fabric');
  M.rubber = patchAmbient(new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9, metalness: 0 }));
  M.rubber.userData.surface = 'wood';
  M.plasticDark = patchAmbient(new THREE.MeshStandardMaterial({ color: 0x2a2b2c, roughness: 0.55, metalness: 0 }));
  M.plasticDark.userData.surface = 'wood';
  M.plasticBlue = patchAmbient(new THREE.MeshStandardMaterial({ color: 0x2f4a66, roughness: 0.6, metalness: 0 }));
  M.plasticBlue.userData.surface = 'wood';
  M.drumBlue = std('drumBlue', T.steel, 0.8, { color: 0x34506e, roughness: 1, metalness: 1 }, 'metal');
  M.drumRust = std('drumRust', T.corrugated, 1.5, { color: 0x6e5140, roughness: 1, metalness: 0.5 }, 'metal');
  M.cardboard = std('cardboard', T.fabric, 0.6, { color: 0xa88b62, roughness: 1 }, 'wood');
  M.glass = new THREE.MeshStandardMaterial({
    color: 0x9fb0b0, roughness: 0.08, metalness: 0.0, transparent: true, opacity: 1,
    map: tf.glassGrime(), depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.4,
  });
  M.glass.userData.surface = 'glass';
  patchAmbient(M.glass);
  M.glassDark = new THREE.MeshStandardMaterial({ color: 0x1c2224, roughness: 0.1, metalness: 0.3, envMapIntensity: 1.2 });
  M.glassDark.userData.surface = 'glass';
  M.chainlink = new THREE.MeshStandardMaterial({
    map: tf.chainLink(), alphaTest: 0.45, side: THREE.DoubleSide, metalness: 0.7, roughness: 0.45, color: 0xb9bdc0,
  });
  M.chainlink.map.repeat.set(2, 2);
  M.chainlink.userData.surface = 'metal';
  patchAmbient(M.chainlink);
  M.lampGlow = new THREE.MeshBasicMaterial({ color: 0xfff1d6 });
  M.lampGlow.userData.surface = 'glass';
  M.lampSodium = new THREE.MeshBasicMaterial({ color: 0xffc27a });
  M.lampSodium.userData.surface = 'glass';
  M.lampTube = new THREE.MeshBasicMaterial({ color: 0xe8f0ff });
  M.lampTube.userData.surface = 'glass';
  M.black = new THREE.MeshBasicMaterial({ color: 0x050505 });
  M.black.userData.surface = 'concrete';

  M._textures = T;
  M._aoRamp = aoRamp;
  return M;
}
