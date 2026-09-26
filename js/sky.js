// Procedural late-afternoon sky dome + a PMREM environment map generated from it.
import * as THREE from 'three';

const SKY_FRAG = `
  uniform vec3 uSun; uniform float uTime; uniform float uCloudCover;
  varying vec3 vDir;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
    return v;
  }
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 zenith = vec3(0.16, 0.24, 0.38);
    vec3 horizon = vec3(0.62, 0.58, 0.52);
    vec3 ground = vec3(0.23, 0.22, 0.2);
    float sunAmt = max(dot(d, uSun), 0.0);
    vec3 col = mix(horizon, zenith, pow(smoothstep(0.0, 0.55, h), 0.7));
    col += vec3(1.0, 0.62, 0.32) * pow(sunAmt, 6.0) * 0.55 * (1.0 - smoothstep(0.0, 0.5, h));
    col += vec3(1.0, 0.8, 0.55) * pow(sunAmt, 64.0) * 1.4;
    col += vec3(1.0, 0.9, 0.75) * smoothstep(0.9993, 0.99965, sunAmt) * 22.0;
    // clouds on a virtual plane
    if (h > 0.0) {
      vec2 cp = d.xz / (h + 0.12) * 1.6 + vec2(uTime * 0.004, uTime * 0.0015);
      float n = fbm(cp);
      float c = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.32, n);
      float lit = pow(sunAmt, 3.0);
      vec3 cloudCol = mix(vec3(0.5, 0.5, 0.53), vec3(1.25, 0.95, 0.72), lit);
      cloudCol *= 0.75 + 0.35 * fbm(cp * 2.3 + 4.0);
      col = mix(col, cloudCol, c * 0.85 * smoothstep(0.0, 0.12, h));
    }
    col = mix(col, ground, smoothstep(0.0, -0.08, h));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const SKY_VERT = `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;

export function createSkyMaterial(sunDir) {
  return new THREE.ShaderMaterial({
    uniforms: { uSun: { value: sunDir.clone() }, uTime: { value: 0 }, uCloudCover: { value: 0.46 } },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
  });
}

export function createSky(scene, sunDir) {
  const mat = createSkyMaterial(sunDir);
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  scene.add(mesh);
  return mesh;
}

/** Bakes the sky (plus a dark ground plane and a few silhouettes) into a PMREM env map. */
export function createEnvironment(renderer, sunDir) {
  const env = new THREE.Scene();
  const mat = createSkyMaterial(sunDir);
  mat.uniforms.uCloudCover.value = 0.4;
  env.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), mat));
  const ground = new THREE.Mesh(new THREE.CircleGeometry(49, 24), new THREE.MeshBasicMaterial({ color: 0x3b3833 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.6;
  env.add(ground);
  const blockMat = new THREE.MeshBasicMaterial({ color: 0x2a2a2a });
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.3;
    const box = new THREE.Mesh(new THREE.BoxGeometry(10, 6 + (i % 3) * 4, 6), blockMat);
    box.position.set(Math.cos(a) * 40, 0, Math.sin(a) * 40);
    box.lookAt(0, 0, 0);
    env.add(box);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.02, 0.1, 100);
  pmrem.dispose();
  return rt.texture;
}
