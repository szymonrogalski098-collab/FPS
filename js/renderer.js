// Render pipeline: world pass + view-model pass into an HDR target, optional bloom,
// then a single "camera" pass (exposure, ACES, grade, vignette, grain, damage) to screen.
// The Low tier skips post entirely and renders straight to the canvas.
import * as THREE from 'three';

const QUAD_VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FINAL_FRAG = `
  uniform sampler2D tColor; uniform sampler2D tBloom;
  uniform float uBloom, uExposure, uTime, uVignette, uGrain, uDamage, uDesat, uFlash, uCA;
  uniform vec2 uRes;
  varying vec2 vUv;
  vec3 gwRRTFit(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }
  vec3 gwAces(vec3 c) {
    const mat3 IN = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
    const mat3 OUT = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
    c *= 1.0 / 0.6;
    c = IN * c; c = gwRRTFit(c); c = OUT * c;
    return clamp(c, 0.0, 1.0);
  }
  vec3 toSRGB(vec3 c) {
    return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    vec2 d = vUv - 0.5;
    float r2 = dot(d, d);
    vec2 off = d * r2 * uCA;
    vec3 col;
    col.r = texture2D(tColor, vUv - off).r;
    col.g = texture2D(tColor, vUv).g;
    col.b = texture2D(tColor, vUv + off).b;
    col += texture2D(tBloom, vUv).rgb * uBloom;
    col *= uExposure;
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(lum), col, 0.9 - uDesat * 0.75);
    col *= mix(vec3(0.95, 1.0, 1.07), vec3(1.05, 1.0, 0.93), smoothstep(0.02, 0.7, lum));
    col = gwAces(col);
    col = mix(col, col * col * (3.0 - 2.0 * col), 0.22);
    float vig = 1.0 - uVignette * smoothstep(0.25, 0.95, length(d * vec2(uRes.x / uRes.y, 1.0)));
    col *= vig;
    col = mix(col, vec3(0.28, 0.015, 0.01), clamp(uDamage, 0.0, 1.0) * smoothstep(0.12, 0.72, length(d) * 1.25));
    col = toSRGB(col);
    col += (hash(vUv * uRes + fract(uTime * 7.13) * 91.0) - 0.5) * uGrain;
    col += uFlash;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const BRIGHT_FRAG = `
  uniform sampler2D tColor; uniform vec2 uTexel; uniform float uThreshold; uniform float uExposure;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tColor, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
    c += texture2D(tColor, vUv + uTexel * vec2(0.5, -0.5)).rgb;
    c += texture2D(tColor, vUv + uTexel * vec2(-0.5, 0.5)).rgb;
    c += texture2D(tColor, vUv + uTexel * vec2(0.5, 0.5)).rgb;
    c *= 0.25 * uExposure;
    float l = max(c.r, max(c.g, c.b));
    c *= smoothstep(uThreshold, uThreshold * 2.5, l);
    gl_FragColor = vec4(min(c, vec3(12.0)), 1.0);
  }
`;

const BLUR_FRAG = `
  uniform sampler2D tColor; uniform vec2 uDir;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tColor, vUv).rgb * 0.227027;
    c += texture2D(tColor, vUv + uDir * 1.3846).rgb * 0.3162162;
    c += texture2D(tColor, vUv - uDir * 1.3846).rgb * 0.3162162;
    c += texture2D(tColor, vUv + uDir * 3.2307).rgb * 0.0702702;
    c += texture2D(tColor, vUv - uDir * 3.2307).rgb * 0.0702702;
    gl_FragColor = vec4(c, 1.0);
  }
`;

function quadScene(material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const m = new THREE.Mesh(g, material);
  m.frustumCulled = false;
  const s = new THREE.Scene();
  s.add(m);
  return { scene: s, mesh: m };
}

export class RenderPipeline {
  constructor(canvas) {
    const r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1;
    r.autoClear = false;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.shadowMap.autoUpdate = false;
    r.setClearColor(0x000000, 1);
    this.r = r;
    this.exposure = 1;
    this.frame = 0;
    this.time = 0;
    this.fx = { damage: 0, desat: 0, flash: 0 };
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.dynScale = 1;
    this.quality = null;
    this.rt = null;
    this.maxAniso = r.capabilities.getMaxAnisotropy();

    this.finalMat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null }, tBloom: { value: null }, uBloom: { value: 0 }, uExposure: { value: 1 },
        uTime: { value: 0 }, uVignette: { value: 0.32 }, uGrain: { value: 0.028 }, uDamage: { value: 0 },
        uDesat: { value: 0 }, uFlash: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uCA: { value: 0.006 },
      },
      vertexShader: QUAD_VERT, fragmentShader: FINAL_FRAG, depthTest: false, depthWrite: false,
    });
    this.final = quadScene(this.finalMat);
    this.brightMat = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.4 }, uExposure: { value: 1 } },
      vertexShader: QUAD_VERT, fragmentShader: BRIGHT_FRAG, depthTest: false, depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: QUAD_VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
    });
    this.bright = quadScene(this.brightMat);
    this.blur = quadScene(this.blurMat);
    this.blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.blackTex.needsUpdate = true;
  }

  applyQuality(q) {
    this.quality = q;
    const r = this.r;
    r.shadowMap.enabled = q.shadows;
    this.shadowEvery = q.shadows ? q.shadowEvery : 0;
    r.shadowMap.needsUpdate = true;
    this.postEnabled = q.post;
    this.bloomEnabled = q.bloom;
    this.finalMat.uniforms.uCA.value = q.bloom ? 0.006 : 0.0;
    this.disposeTargets();
    this.resize();
  }

  pixelRatio() {
    const q = this.quality;
    return Math.min(window.devicePixelRatio || 1, q.maxDpr) * q.renderScale * this.dynScale;
  }

  setDynamicScale(s) {
    if (Math.abs(s - this.dynScale) < 0.01) return;
    this.dynScale = s;
    this.resize();
  }

  disposeTargets() {
    for (const t of [this.rt, this.rtBright, this.rtBlurA, this.rtBlurB]) if (t) t.dispose();
    this.rt = this.rtBright = this.rtBlurA = this.rtBlurB = null;
  }

  resize() {
    if (!this.quality) return;
    const w = this.forceW || window.innerWidth, h = this.forceH || window.innerHeight;
    const pr = this.pixelRatio();
    this.r.setPixelRatio(pr);
    this.r.setSize(w, h, false);
    const W = Math.max(1, Math.floor(w * pr)), H = Math.max(1, Math.floor(h * pr));
    this.width = W; this.height = H;
    this.finalMat.uniforms.uRes.value.set(W, H);
    if (!this.postEnabled) { this.disposeTargets(); return; }
    const opts = { type: THREE.HalfFloatType, depthBuffer: true, samples: this.quality.msaa };
    if (!this.rt) this.rt = new THREE.WebGLRenderTarget(W, H, opts);
    else this.rt.setSize(W, H);
    if (this.bloomEnabled) {
      const o2 = { type: THREE.HalfFloatType, depthBuffer: false };
      const hw = Math.max(1, W >> 1), hh = Math.max(1, H >> 1), qw = Math.max(1, W >> 2), qh = Math.max(1, H >> 2);
      if (!this.rtBright) {
        this.rtBright = new THREE.WebGLRenderTarget(hw, hh, o2);
        this.rtBlurA = new THREE.WebGLRenderTarget(qw, qh, o2);
        this.rtBlurB = new THREE.WebGLRenderTarget(qw, qh, o2);
      } else {
        this.rtBright.setSize(hw, hh); this.rtBlurA.setSize(qw, qh); this.rtBlurB.setSize(qw, qh);
      }
    }
  }

  render(scene, camera, viewScene, viewCamera, dt) {
    const r = this.r;
    this.time += dt;
    if (this.shadowEvery > 0 && this.frame % this.shadowEvery === 0) r.shadowMap.needsUpdate = true;
    this.frame++;
    if (!this.postEnabled) {
      r.toneMappingExposure = this.exposure;
      r.setRenderTarget(null);
      r.clear();
      r.render(scene, camera);
      if (viewScene) { r.clearDepth(); r.render(viewScene, viewCamera); }
      return;
    }
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(scene, camera);
    if (viewScene) { r.clearDepth(); r.render(viewScene, viewCamera); }
    const u = this.finalMat.uniforms;
    if (this.bloomEnabled && this.rtBright) {
      this.brightMat.uniforms.tColor.value = this.rt.texture;
      this.brightMat.uniforms.uTexel.value.set(1 / this.rt.width, 1 / this.rt.height);
      this.brightMat.uniforms.uExposure.value = this.exposure;
      r.setRenderTarget(this.rtBright); r.render(this.bright.scene, this.quadCam);
      this.blurMat.uniforms.tColor.value = this.rtBright.texture;
      this.blurMat.uniforms.uDir.value.set(1 / this.rtBright.width, 0);
      r.setRenderTarget(this.rtBlurA); r.render(this.blur.scene, this.quadCam);
      this.blurMat.uniforms.tColor.value = this.rtBlurA.texture;
      this.blurMat.uniforms.uDir.value.set(0, 1 / this.rtBlurA.height);
      r.setRenderTarget(this.rtBlurB); r.render(this.blur.scene, this.quadCam);
      u.tBloom.value = this.rtBlurB.texture;
      u.uBloom.value = 0.16 / Math.max(0.2, this.exposure);
    } else {
      u.tBloom.value = this.blackTex;
      u.uBloom.value = 0;
    }
    u.tColor.value = this.rt.texture;
    u.uExposure.value = this.exposure;
    u.uTime.value = this.time;
    u.uDamage.value = this.fx.damage;
    u.uDesat.value = this.fx.desat;
    u.uFlash.value = this.fx.flash;
    r.setRenderTarget(null);
    r.render(this.final.scene, this.quadCam);
  }
}
