// First-person view model: rendered in its own scene (no wall clipping), lit to match the world
// around the player, and animated procedurally (sway, bob, recoil springs, ADS, reloads, pump, switch).
import * as THREE from 'three';
import { buildRifle, buildPistol, buildShotgun, buildArms, poseArm, createWeaponMaterials } from './weaponModels.js';
import { Spring, lerp, clamp, damp, sampleTrack, easeInOutSine, rand } from './util.js';

const V3 = () => new THREE.Vector3();
const _v = V3(), _w = V3();

// Reload keyframes, normalised time. Values are offsets (radians / metres).
export const RELOAD_TRACKS = {
  rifle: {
    rotZ: [[0, 0], [0.12, 0.42], [0.82, 0.42], [0.96, 0]],
    rotX: [[0, 0], [0.12, 0.1], [0.5, 0.16], [0.6, 0.04], [0.82, 0.08], [0.96, 0]],
    posX: [[0, 0], [0.12, -0.03], [0.85, -0.03], [1, 0]],
    posY: [[0, 0], [0.12, 0.025], [0.85, 0.025], [1, 0]],
    magY: [[0, 0], [0.15, 0], [0.27, -0.42], [0.38, -0.42], [0.53, -0.06], [0.6, 0]],
    magHidden: [0.27, 0.38],
    hand: [[0, 0], [0.1, 1], [0.62, 1], [0.74, 0]],
    chHand: [[0.66, 0], [0.73, 1], [0.84, 1], [0.92, 0]],
    chPull: [[0.73, 0], [0.77, 0.075], [0.8, 0]],
    sounds: [[0.15, 'magOut'], [0.58, 'magIn']],
    emptySounds: [[0.78, 'boltRelease']],
  },
  pistol: {
    rotZ: [[0, 0], [0.15, 0.35], [0.8, 0.35], [0.95, 0]],
    rotX: [[0, 0], [0.15, 0.25], [0.55, 0.3], [0.62, 0.15], [0.8, 0.2], [0.95, 0]],
    posX: [[0, 0], [0.15, -0.02], [0.85, -0.02], [1, 0]],
    posY: [[0, 0], [0.15, 0.03], [0.85, 0.03], [1, 0]],
    magY: [[0, 0], [0.14, 0], [0.26, -0.3], [0.4, -0.3], [0.55, -0.04], [0.62, 0]],
    magHidden: [0.26, 0.4],
    hand: [[0, 0], [0.12, 1], [0.64, 1], [0.76, 0]],
    sounds: [[0.16, 'magOut'], [0.6, 'magIn']],
    emptySounds: [[0.8, 'slideRelease']],
  },
};

export class ViewModel {
  constructor(tf, T, envMap) {
    this.scene = new THREE.Scene();
    this.scene.environment = envMap;
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.008, 20);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.M = createWeaponMaterials(T);
    this.weapons = { rifle: buildRifle(this.M), pistol: buildPistol(this.M), shotgun: buildShotgun(this.M) };
    for (const w of Object.values(this.weapons)) {
      w.group.visible = false;
      w.adsPos = new THREE.Vector3(-w.sight.x, -w.sight.y, -w.adsDist - w.sight.z);
      this.root.add(w.group);
    }
    this.arms = buildArms(this.M);
    this.buildFlash(tf);
    this.buildLights();
    this.springs = {
      kz: new Spring(210, 17), krx: new Spring(170, 13), kry: new Spring(160, 14), krz: new Spring(150, 12),
      sx: new Spring(90, 12), sy: new Spring(90, 12), land: new Spring(120, 11),
    };
    this.swayTargetX = 0;
    this.swayTargetY = 0;
    this.current = null;
    this.flashT = 0;
    this.time = 0;
    this.setWeapon('rifle');
  }

  buildFlash(tf) {
    const front = tf.muzzleFlash(), side = tf.muzzleFlashSide();
    const mk = (map) => new THREE.MeshBasicMaterial({ map, color: new THREE.Color(4.5, 3.4, 2.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.flashGroup = new THREE.Group();
    const f = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.13), mk(front));
    const sg = new THREE.PlaneGeometry(0.24, 0.085);
    sg.rotateY(Math.PI / 2);
    sg.translate(0, 0, -0.11);
    const s1 = new THREE.Mesh(sg, mk(side));
    const sg2 = sg.clone();
    sg2.rotateZ(Math.PI / 2);
    const s2 = new THREE.Mesh(sg2, s1.material);
    [f, s1, s2].forEach((m) => { m.renderOrder = 20; m.frustumCulled = false; this.flashGroup.add(m); });
    this.flashFront = f;
    this.flashGroup.visible = false;
  }

  buildLights() {
    this.hemi = new THREE.HemisphereLight(0xb2c3d8, 0x5b5045, 1);
    this.sun = new THREE.DirectionalLight(0xffd7a8, 2.5);
    this.sun.target.position.set(0, 0, 0);
    this.fill = new THREE.PointLight(0xffd7a8, 0, 14, 2);
    this.flashLight = new THREE.PointLight(0xffc98a, 0, 2.5, 2);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.fill, this.flashLight);
  }

  setWeapon(id) {
    if (this.current) this.current.group.visible = false;
    const w = this.weapons[id];
    this.current = w;
    w.group.visible = true;
    w.group.add(this.arms.left.group, this.arms.right.group, this.flashGroup);
    this.flashGroup.position.copy(w.muzzle);
    for (const s of Object.values(this.springs)) s.reset();
    this.resetParts();
  }

  resetParts() {
    const w = this.current;
    if (w.parts.mag) { w.parts.mag.position.copy(w.magRest); w.parts.mag.visible = true; }
    if (w.parts.charging) w.parts.charging.position.copy(w.chRest);
    if (w.parts.slide) w.parts.slide.position.copy(w.slideRest);
    if (w.parts.pump) w.parts.pump.position.copy(w.pumpRest);
    if (w.parts.shell) w.parts.shell.visible = false;
  }

  kick(k, adsBlend) {
    const s = this.springs, a = 1 - adsBlend * 0.45;
    s.kz.impulse(k.z * 30 * a);
    s.krx.impulse(k.rotX * 0.0175 * 18 * a);
    s.kry.impulse(rand(-1, 1) * k.rotY * 0.0175 * 18 * a);
    s.krz.impulse(rand(-1, 1) * k.rotZ * 0.0175 * 18 * a);
    this.flashT = 0.034;
    this.flashGroup.visible = true;
    this.flashGroup.rotation.z = Math.random() * Math.PI * 2;
    const sc = rand(0.75, 1.25) * (this.current.id === 'shotgun' ? 1.5 : this.current.id === 'pistol' ? 0.8 : 1);
    this.flashGroup.scale.set(sc, sc, sc * rand(0.8, 1.3));
    this.flashFront.visible = adsBlend < 0.7 || Math.random() < 0.5;
    this.flashLight.intensity = 2.2;
  }

  land(amount) { this.springs.land.impulse(-amount * 0.06); }

  /** World-space muzzle position (needs the camera world position since the view scene is camera-centred). */
  muzzleWorld(camPos, out) {
    this.current.group.updateWorldMatrix(true, false);
    out.copy(this.current.muzzle).applyMatrix4(this.current.group.matrixWorld);
    return out.add(camPos);
  }

  ejectWorld(camPos, out) {
    this.current.group.updateWorldMatrix(true, false);
    out.copy(this.current.eject).applyMatrix4(this.current.group.matrixWorld);
    return out.add(camPos);
  }

  /** Right/up/forward of the view (for shell ejection velocity). */
  axes(right, up, fwd) {
    right.set(1, 0, 0).applyQuaternion(this.root.quaternion);
    up.set(0, 1, 0).applyQuaternion(this.root.quaternion);
    fwd.set(0, 0, -1).applyQuaternion(this.root.quaternion);
  }

  /** Match lighting to the player's surroundings. */
  syncLighting(ambient, sunVis, sunDir, sunIntensity, hemi, fillLight, camPos) {
    this.hemi.color.copy(hemi.color);
    this.hemi.groundColor.copy(hemi.groundColor);
    this.hemi.intensity = hemi.intensity * ambient * 1.05;
    this.sun.position.copy(sunDir).multiplyScalar(10);
    this.sun.intensity = sunIntensity * sunVis * 0.85;
    for (const m of Object.values(this.M)) if (m.envMapIntensity !== undefined && m !== this.M.lens) m.envMapIntensity = 0.25 + ambient * 0.75;
    if (fillLight) {
      this.fill.color.copy(fillLight.color);
      this.fill.intensity = fillLight.intensity * 0.8;
      this.fill.position.copy(fillLight.position).sub(camPos);
      this.fill.distance = fillLight.distance || 12;
    } else this.fill.intensity = 0;
  }

  /**
   * st: { ads, sprint, crouch, lookDX, lookDY, bobPhase, bobAmount, lower, reload, reloadEmpty, pump,
   *       slideBack, shotgunReload, wall, time, moving, fovV }
   */
  update(dt, camera, st) {
    this.time += dt;
    this.root.quaternion.copy(camera.quaternion);
    this.camera.quaternion.copy(camera.quaternion);
    this.camera.fov = st.fovV;
    this.camera.aspect = camera.aspect;
    this.camera.updateProjectionMatrix();

    const w = this.current, S = this.springs;
    const ads = easeInOutSine(clamp(st.ads, 0, 1));
    const hipK = 1 - ads;
    // sway: weapon lags behind look motion
    this.swayTargetX = clamp(-st.lookDX * 1.6, -0.05, 0.05) * (1 - ads * 0.85);
    this.swayTargetY = clamp(st.lookDY * 1.6, -0.05, 0.05) * (1 - ads * 0.85);
    S.sx.target = this.swayTargetX; S.sy.target = this.swayTargetY;
    for (const s of Object.values(S)) s.update(dt);

    const pos = (this._pos || (this._pos = V3())).copy(w.hip).lerp(w.adsPos, ads);
    let rx = 0, ry = 0, rz = 0;
    // sway
    pos.x += S.sx.x * 0.35;
    pos.y += S.sy.x * 0.3;
    ry += S.sx.x * 1.2;
    rx += S.sy.x * 0.9;
    rz += S.sx.x * 1.5;
    // bob + breathing
    const bob = st.bobAmount * (1 - ads * 0.85);
    const ph = st.bobPhase;
    pos.x += Math.sin(ph) * 0.009 * bob;
    pos.y += -Math.abs(Math.cos(ph)) * 0.008 * bob + 0.004 * bob;
    rz += Math.sin(ph) * 0.02 * bob;
    rx += Math.cos(ph * 2) * 0.008 * bob;
    const br = 1 - ads * 0.75;
    pos.y += Math.sin(this.time * 1.4) * 0.0014 * br;
    rx += Math.sin(this.time * 1.1) * 0.004 * br;
    ry += Math.sin(this.time * 0.7) * 0.003 * br;
    // crouch tilt
    rz += st.crouch * 0.04 * hipK;
    pos.y -= st.crouch * 0.005;
    // sprint pose
    const sp = easeInOutSine(st.sprint);
    if (sp > 0) {
      if (w.id === 'pistol') { pos.y -= 0.07 * sp; pos.z += 0.06 * sp; rx -= 0.7 * sp; }
      else { pos.x -= 0.03 * sp; pos.y -= 0.035 * sp; pos.z += 0.03 * sp; ry += 0.75 * sp; rx -= 0.18 * sp; rz += 0.35 * sp; }
      pos.y += Math.abs(Math.sin(ph)) * 0.012 * sp;
      ry += Math.sin(ph) * 0.05 * sp;
    }
    // wall proximity: pull back & raise
    const wb = st.wall * hipK;
    pos.z += 0.09 * wb;
    rx += 0.55 * wb;
    ry += 0.15 * wb;
    // landing
    pos.y += S.land.x;
    // recoil
    pos.z += S.kz.x * 0.01;
    rx += S.krx.x;
    ry += S.kry.x;
    rz += S.krz.x;
    // weapon switch (lower / raise)
    const lo = easeInOutSine(st.lower);
    pos.y -= 0.22 * lo;
    rx -= 0.9 * lo;
    rz += 0.3 * lo;

    this.animateParts(st, w);
    pos.x += this.anim.px; pos.y += this.anim.py;
    rx += this.anim.rx; rz += this.anim.rz;
    w.group.position.copy(pos);
    w.group.rotation.set(rx, ry, rz, 'XYZ');

    // arms
    const L = this.anim.leftHand, R = w.rightHand;
    poseArm(this.arms.right, R, w.rightElbow, w.rightHandRot);
    poseArm(this.arms.left, L, w.leftElbow, this.anim.leftRot);

    // flash
    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) { this.flashGroup.visible = false; }
    }
    this.flashLight.intensity = Math.max(0, this.flashLight.intensity - dt * 60);
    _w.copy(w.muzzle).applyMatrix4(w.group.matrix);
    this.flashLight.position.copy(_w).applyQuaternion(this.root.quaternion);
  }

  animateParts(st, w) {
    const A = this.anim || (this.anim = { px: 0, py: 0, rx: 0, rz: 0, leftHand: V3(), leftRot: new THREE.Euler() });
    A.px = A.py = A.rx = A.rz = 0;
    A.leftHand.copy(w.leftHand);
    A.leftRot.copy(w.leftHandRot);
    if (w.id === 'rifle' || w.id === 'pistol') {
      const T = RELOAD_TRACKS[w.id];
      const mag = w.parts.mag;
      if (st.reload >= 0) {
        const t = st.reload;
        A.rz = sampleTrack(T.rotZ, t); A.rx = sampleTrack(T.rotX, t);
        A.px = sampleTrack(T.posX, t); A.py = sampleTrack(T.posY, t);
        const my = sampleTrack(T.magY, t);
        mag.position.set(w.magRest.x, w.magRest.y + my, w.magRest.z + my * (w.id === 'rifle' ? -0.12 : 0.1));
        mag.visible = !(t > T.magHidden[0] && t < T.magHidden[1]);
        const hk = sampleTrack(T.hand, t);
        const magBottom = _v.set(mag.position.x, mag.position.y - (w.id === 'rifle' ? 0.16 : 0.1), mag.position.z + (w.id === 'rifle' ? -0.035 : 0.01));
        A.leftHand.lerp(magBottom.add(_w.set(-0.005, -0.01, 0.01)), hk);
        if (w.id === 'rifle' && st.reloadEmpty && T.chHand) {
          const ck = sampleTrack(T.chHand, t);
          const pull = sampleTrack(T.chPull, t);
          w.parts.charging.position.set(w.chRest.x, w.chRest.y, w.chRest.z + pull);
          A.leftHand.lerp(_w.set(-0.02, 0.07, 0.09 + pull), ck);
        }
      } else {
        mag.position.copy(w.magRest);
        mag.visible = true;
        if (w.parts.charging) w.parts.charging.position.copy(w.chRest);
      }
      if (w.id === 'pistol') {
        w.parts.slide.position.set(0, 0, w.slideRest.z + st.slideBack * 0.045);
      }
    } else if (w.id === 'shotgun') {
      const pump = w.parts.pump, shell = w.parts.shell;
      let pz = 0;
      if (st.pump >= 0) pz = sampleTrack([[0, 0], [0.35, 0.085], [0.72, 0]], st.pump);
      pump.position.set(w.pumpRest.x, w.pumpRest.y, w.pumpRest.z + pz);
      A.leftHand.z += pz;
      shell.visible = false;
      const sr = st.shotgunReload;
      if (sr) {
        // tilt the gun to present the loading port
        const tilt = sr.tilt;
        A.rz = -0.45 * tilt; A.rx = 0.12 * tilt; A.py = 0.02 * tilt; A.px = -0.015 * tilt;
        if (sr.shellT >= 0) {
          const t = sr.shellT;
          const k = sampleTrack([[0, 0], [0.3, 1], [0.62, 1], [0.8, 0.3], [1, 0]], t);
          const inT = sampleTrack([[0.3, 0], [0.62, 1]], t);
          const port = _v.set(0, -0.01, -0.13 - inT * 0.05);
          const pouch = _w.set(-0.12, -0.25, -0.05);
          const handPos = pouch.lerp(port, k);
          A.leftHand.lerp(handPos, sampleTrack([[0, 0.6], [0.15, 1], [0.85, 1], [1, 0.6]], t));
          shell.visible = t > 0.05 && t < 0.62;
          shell.position.set(handPos.x, handPos.y + 0.018, handPos.z + 0.01);
        }
      }
    }
  }
}
