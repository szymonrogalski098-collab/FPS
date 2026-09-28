// Vegetation for the mountain map: see-through foliage built from alpha-tested leaf cards (a
// procedurally painted leaf atlas), several bush species and distinct forest types placed by
// altitude, aspect, slope and water: open juniper woodland, holm-oak groves, pine / deodar forest on
// the cool north-facing slopes, poplar and willow galleries along the wadi and mulberry orchards by
// the village. Near trees and bushes are full card models; distant ones switch to cheap solid LODs.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchAmbient } from './materials.js';
import { mulberry32, clamp, lerp, smoothstep } from './util.js';
import { MOUNTAIN_LAYOUT } from './mountainLayout.js';
import { distToPolyline } from './terrain.js';

// atlas layout (u, v in texture space, v up): four 0.5 x 0.5 leaf cells, bark strip under the juniper cell
const CELL = {
  broad: [0, 0.5, 0.5, 1], oak: [0.5, 0.5, 1, 1], needle: [0, 0, 0.5, 0.5], juniper: [0.5, 0.07, 1, 0.5], bark: [0.5, 0, 1, 0.06],
};

// ------------------------------------------------------------------ leaf atlas

/** Paints the leaf atlas: broad leaves, small leathery oak leaves, pine needle fascicles, juniper sprays, bark. */
export function leafAtlas(size, aniso) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const rng = mulberry32(2718);
  const S = size / 2, k = size / 1024;
  const cellOrigin = (u0, v1) => [u0 * size, (1 - v1) * size];
  const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
  const twig = (x0, y0, len, ang, bend, w) => {
    const pts = [];
    let x = x0, y = y0, a = ang;
    const n = 12;
    for (let i = 0; i <= n; i++) {
      pts.push([x, y, a]);
      a += bend / n + (rng() - 0.5) * 0.08;
      x += Math.cos(a) * len / n; y += Math.sin(a) * len / n;
    }
    g.strokeStyle = hsl(28, 30, 22);
    g.lineWidth = w;
    g.lineCap = 'round';
    g.beginPath();
    pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
    g.stroke();
    return pts;
  };
  const leaf = (x, y, ang, L, W, h, s, l) => {
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    const grad = g.createLinearGradient(0, 0, L, 0);
    grad.addColorStop(0, hsl(h, s, l - 6));
    grad.addColorStop(1, hsl(h + 6, s + 4, l + 6));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(L * 0.45, -W, L, 0);
    g.quadraticCurveTo(L * 0.45, W, 0, 0);
    g.fill();
    g.strokeStyle = hsl(h, s - 10, l - 12, 0.6);
    g.lineWidth = Math.max(0.6, W * 0.12);
    g.beginPath(); g.moveTo(0, 0); g.lineTo(L * 0.92, 0); g.stroke();
    g.restore();
  };
  const leafyCell = (u0, v1, count, L, W, hue, sat, lig) => {
    const [ox, oy] = cellOrigin(u0, v1);
    g.save();
    g.beginPath(); g.rect(ox + 2, oy + 2, S - 4, S - 4); g.clip();
    for (let t = 0; t < 7; t++) {
      const ang = -Math.PI / 2 + (rng() - 0.5) * 2.2;
      const pts = twig(ox + S * (0.4 + rng() * 0.2), oy + S * 0.98, S * (0.55 + rng() * 0.4), ang, (rng() - 0.5) * 1.2, 3.2 * k);
      for (let i = 2; i < pts.length; i++) {
        for (let side = -1; side <= 1; side += 2) {
          if (rng() < 0.15) continue;
          const [px, py, pa] = pts[i];
          const a = pa + side * (0.6 + rng() * 0.6);
          leaf(px, py, a, L * k * (0.7 + rng() * 0.5), W * k * (0.7 + rng() * 0.4), hue + (rng() - 0.5) * 16, sat + (rng() - 0.5) * 12, lig + (rng() - 0.5) * 12);
        }
      }
    }
    for (let i = 0; i < count; i++) {
      leaf(ox + S * (0.1 + rng() * 0.8), oy + S * (0.08 + rng() * 0.8), rng() * 6.28, L * k * (0.6 + rng() * 0.5), W * k * (0.6 + rng() * 0.4), hue + (rng() - 0.5) * 16, sat + (rng() - 0.5) * 12, lig + (rng() - 0.5) * 14);
    }
    g.restore();
  };
  // broad leaves (poplar, willow, mulberry, bushes)
  leafyCell(0, 1, 90, 34, 13, 84, 38, 30);
  // holm oak: small, dark, leathery
  leafyCell(0.5, 1, 520, 26, 12, 92, 28, 24);
  // pine needles: fascicles radiating from twigs
  {
    const [ox, oy] = cellOrigin(0, 0.5);
    g.save(); g.beginPath(); g.rect(ox + 2, oy + 2, S - 4, S - 4); g.clip();
    for (let t = 0; t < 8; t++) {
      const pts = twig(ox + S * (0.3 + rng() * 0.4), oy + S * 0.98, S * (0.6 + rng() * 0.35), -Math.PI / 2 + (rng() - 0.5) * 1.8, (rng() - 0.5) * 0.8, 3.5 * k);
      for (let i = 1; i < pts.length; i++) {
        const [px, py] = pts[i];
        const n = 14 + Math.floor(rng() * 8);
        for (let j = 0; j < n; j++) {
          const a = rng() * 6.28, L = (22 + rng() * 22) * k;
          g.strokeStyle = hsl(150 + (rng() - 0.5) * 20, 22 + rng() * 10, 16 + rng() * 12);
          g.lineWidth = 1.3 * k;
          g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(a) * L, py + Math.sin(a) * L * 0.8); g.stroke();
        }
      }
    }
    g.restore();
  }
  // juniper: thin scale-leaf branchlets in dull grey-green, with plenty of air between them
  {
    const [ox, oy] = cellOrigin(0.5, 0.5);
    const H = S * 0.86;
    g.save(); g.beginPath(); g.rect(ox + 2, oy + 2, S - 4, H - 4); g.clip();
    const branchlet = (x, y, a, len, depth, w) => {
      const n = Math.max(5, Math.round(len / (2.2 * k)));
      let px = x, py = y, aa = a;
      for (let i = 0; i < n; i++) {
        aa += (rng() - 0.5) * 0.12;
        px += Math.cos(aa) * len / n; py += Math.sin(aa) * len / n;
        const t = 1 - i / n;
        g.fillStyle = hsl(112 + (rng() - 0.5) * 22, 12 + rng() * 10, 21 + rng() * 14);
        g.beginPath(); g.ellipse(px, py, (1.6 + 1.6 * t) * w * k, (1.1 + 0.9 * t) * w * k, aa, 0, 6.28); g.fill();
        if (depth > 0 && i > 1 && i % 3 === 0) branchlet(px, py, aa + (rng() < 0.5 ? -1 : 1) * (0.45 + rng() * 0.45), len * (0.35 + rng() * 0.2), depth - 1, w * 0.85);
      }
    };
    for (let t = 0; t < 7; t++) {
      const pts = twig(ox + S * (0.3 + rng() * 0.4), oy + H * 0.98, H * (0.55 + rng() * 0.35), -Math.PI / 2 + (rng() - 0.5) * 1.6, (rng() - 0.5) * 1.0, 2.6 * k);
      for (let i = 2; i < pts.length; i += 2) {
        const [px, py, pa] = pts[i];
        branchlet(px, py, pa + (rng() < 0.5 ? -1 : 1) * (0.5 + rng() * 0.6), S * (0.12 + rng() * 0.12), 2, 1.25);
      }
    }
    g.restore();
  }
  // bark strip
  {
    const x0 = size / 2, y0 = size * (1 - 0.06), w = size / 2, h = size * 0.06;
    g.fillStyle = hsl(28, 18, 24);
    g.fillRect(x0, y0, w, h);
    for (let i = 0; i < 260; i++) {
      g.strokeStyle = hsl(26 + rng() * 10, 12 + rng() * 10, 12 + rng() * 22, 0.8);
      g.lineWidth = (1 + rng() * 2) * k;
      const x = x0 + rng() * w;
      g.beginPath(); g.moveTo(x, y0); g.lineTo(x + (rng() - 0.5) * 8, y0 + h); g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// ------------------------------------------------------------------ geometry helpers

const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();

/** One leaf card: a quad of size w x h, oriented by euler, centred at p, UVs into atlas rect. */
function card(out, rect, p, w, h, rx, ry, rz, center, tint, droop = 0) {
  const g = new THREE.PlaneGeometry(w, h, 1, 2);
  if (droop) {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); pos.setZ(i, -droop * (y / h + 0.5) ** 2 * h * 0.35); }
  }
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _m.compose(p, _q, _s.set(1, 1, 1));
  g.applyMatrix4(_m);
  const uv = g.attributes.uv, pos = g.attributes.position;
  const [u0, v0, u1, v1] = rect;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  // canopy normals: point away from the crown centre so the foliage shades like a volume
  const nrm = g.attributes.normal;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i);
    _n.subVectors(_v, center).normalize();
    _n.y += 0.35;
    _n.normalize();
    nrm.setXYZ(i, _n.x, _n.y, _n.z);
    const inner = clamp(_v.distanceTo(center) / 2.5, 0.55, 1);
    col[i * 3] = tint[0] * inner; col[i * 3 + 1] = tint[1] * inner; col[i * 3 + 2] = tint[2] * inner;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.push(g);
}

/** Bark-mapped tapered limb between two points. */
function limb(out, a, b, r0, r1, seg = 6) {
  const d = _v.subVectors(b, a);
  const len = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 2, false);
  // slight irregular bulge so trunks do not read as machined prisms
  {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), y = pos.getY(i);
      const k = 1 + Math.sin(y * 3.1 + x * 7.3) * 0.06 + Math.cos(z * 6.1 - y * 2.3) * 0.05;
      pos.setXYZ(i, x * k, y, z * k);
    }
  }
  g.translate(0, len / 2, 0);
  _q.setFromUnitVectors(_n.set(0, 1, 0), d.clone().normalize());
  _m.compose(a, _q, _s.set(1, 1, 1));
  g.applyMatrix4(_m);
  const uv = g.attributes.uv;
  const [u0, v0, u1, v1] = CELL.bark;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  const col = new Float32Array(uv.count * 3).fill(1);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.push(g);
}

function finish(parts) {
  const g = mergeGeometries(parts, false);
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------ species

const TINTS = {
  juniper: [0.78, 0.86, 0.78], oak: [0.86, 0.92, 0.8], pine: [0.82, 0.92, 0.86], deodar: [0.8, 0.9, 0.9],
  poplar: [1.0, 1.02, 0.86], willow: [0.95, 1.02, 0.84], mulberry: [0.9, 1.0, 0.82],
};

/** Returns { geo, height, trunk } for a tree species (height ~ metres at scale 1). */
export function treeModel(type, seed) {
  const rng = mulberry32(seed);
  const parts = [];
  const T = TINTS[type];
  const tint = () => { const k = 0.78 + rng() * 0.32; return [T[0] * k, T[1] * k, T[2] * k]; };
  const p = new THREE.Vector3(), c = new THREE.Vector3();
  let H = 6, trunkR = 0.18;
  const trunk = (h, r, lean = 0.12) => {
    const a = new THREE.Vector3(0, -0.3, 0), m = new THREE.Vector3((rng() - 0.5) * lean * h, h * 0.5, (rng() - 0.5) * lean * h), b = new THREE.Vector3((rng() - 0.5) * lean * h, h, (rng() - 0.5) * lean * h);
    limb(parts, a, m, r, r * 0.8, 10);
    limb(parts, m, b, r * 0.82, r * 0.35, 8);
    return b;
  };
  if (type === 'pine' || type === 'deodar') {
    H = type === 'deodar' ? 13 : 11;
    trunkR = 0.24;
    const top = trunk(H, trunkR, 0.04);
    const tiers = type === 'deodar' ? 11 : 10;
    const R = type === 'deodar' ? 3.4 : 2.6;
    for (let t = 0; t < tiers; t++) {
      const k = t / (tiers - 1);
      const y = H * (0.28 + 0.7 * k);
      const r = R * Math.pow(1 - k, type === 'deodar' ? 0.95 : 1.15) + 0.35;
      c.set(top.x * k, y, top.z * k);
      const n = Math.max(4, Math.round(10 * (1 - k) + 3));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rng() * 0.6;
        const rr = r * (0.45 + rng() * 0.6);
        p.set(c.x + Math.cos(a) * rr * 0.55, y - (type === 'deodar' ? 0.25 : 0.1) * rr, c.z + Math.sin(a) * rr * 0.55);
        const w = rr * 1.25 + 0.5, h = Math.max(0.8, rr * 0.85);
        card(parts, CELL.needle, p, w, h, -Math.PI / 2 + 0.35 + (rng() - 0.5) * 0.4, -a + Math.PI / 2, (rng() - 0.5) * 0.3, c, tint(), type === 'deodar' ? 0.6 : 0.2);
        if (i % 2 === 0) limb(parts, new THREE.Vector3(c.x, y, c.z), p, 0.05, 0.02, 4);
      }
    }
    card(parts, CELL.needle, new THREE.Vector3(top.x, H + 0.4, top.z), 1.0, 1.4, 0, rng() * 3, 0, new THREE.Vector3(top.x, H - 1, top.z), tint());
  } else if (type === 'poplar') {
    H = 14;
    trunkR = 0.2;
    const top = trunk(H * 0.92, trunkR, 0.04);
    for (let i = 0; i < 110; i++) {
      const y = H * (0.2 + 0.8 * Math.pow(rng(), 0.8));
      const hk = (y - H * 0.2) / (H * 0.8);
      const r = 1.35 * Math.sin(Math.PI * clamp(hk * 0.95 + 0.05, 0, 1)) + 0.2;
      const a = rng() * 6.28;
      c.set(top.x * hk, y, top.z * hk);
      p.set(c.x + Math.cos(a) * r * rng(), y, c.z + Math.sin(a) * r * rng());
      card(parts, CELL.broad, p, 1.1 + rng() * 0.5, 1.3 + rng() * 0.6, (rng() - 0.5) * 0.8, rng() * 6.28, (rng() - 0.5) * 0.5, c, tint());
    }
  } else if (type === 'willow') {
    H = 7.5;
    trunkR = 0.28;
    const top = trunk(H * 0.55, trunkR, 0.35);
    c.set(top.x, H * 0.72, top.z);
    for (let i = 0; i < 9; i++) {
      const a = rng() * 6.28, r = 1.2 + rng() * 1.6;
      limb(parts, top, new THREE.Vector3(top.x + Math.cos(a) * r, H * (0.75 + rng() * 0.2), top.z + Math.sin(a) * r), 0.1, 0.04, 5);
    }
    for (let i = 0; i < 70; i++) {
      const a = rng() * 6.28, r = rng() * 3.2;
      p.set(c.x + Math.cos(a) * r, H * (0.66 + rng() * 0.28), c.z + Math.sin(a) * r);
      card(parts, CELL.broad, p, 1.2 + rng() * 0.6, 1.3, -Math.PI / 2 + (rng() - 0.5) * 0.7, rng() * 6.28, 0, c, tint());
    }
    // hanging curtains
    for (let i = 0; i < 46; i++) {
      const a = rng() * 6.28, r = 2.2 + rng() * 1.4;
      p.set(c.x + Math.cos(a) * r, H * (0.5 + rng() * 0.18), c.z + Math.sin(a) * r);
      card(parts, CELL.broad, p, 0.7, 2.4 + rng() * 1.2, (rng() - 0.5) * 0.3, -a, 0, c, tint());
    }
  } else {
    // juniper / holm oak / mulberry: gnarled trunk, several foliage masses
    const isJ = type === 'juniper', isOak = type === 'oak';
    H = isJ ? 5.5 : isOak ? 7 : 7.5;
    trunkR = isJ ? 0.22 : 0.26;
    const top = trunk(H * (isJ ? 0.45 : 0.5), trunkR, isJ ? 0.5 : 0.25);
    const masses = isJ ? 6 + Math.floor(rng() * 3) : 7 + Math.floor(rng() * 3);
    const crownC = new THREE.Vector3(top.x, H * (isJ ? 0.62 : 0.66), top.z);
    for (let m = 0; m < masses; m++) {
      const a = rng() * 6.28, r = (isJ ? 1.1 : 1.9) * Math.sqrt(rng());
      const mc = new THREE.Vector3(crownC.x + Math.cos(a) * r, crownC.y + (rng() - 0.35) * H * (isJ ? 0.35 : 0.28), crownC.z + Math.sin(a) * r);
      limb(parts, top, mc, 0.11, 0.04, 5);
      const n = isJ ? 22 : 15;
      const R = isJ ? 1.0 : 1.45;
      for (let i = 0; i < n; i++) {
        p.set(mc.x + (rng() - 0.5) * R * 1.6, mc.y + (rng() - 0.5) * R * 1.1, mc.z + (rng() - 0.5) * R * 1.6);
        const sz = (isJ ? 0.75 : 1.25) + rng() * (isJ ? 0.45 : 0.6);
        card(parts, isJ ? CELL.juniper : isOak ? CELL.oak : CELL.broad, p, sz, sz * 0.9, (rng() - 0.5) * 1.6, rng() * 6.28, (rng() - 0.5) * 1.2, crownC, tint());
      }
    }
  }
  return { geo: finish(parts), height: H, trunk: trunkR };
}

/** See-through bush from leaf cards around a few stems. */
export function bushModel(type, seed) {
  const rng = mulberry32(seed);
  const parts = [];
  const rect = type === 'oakScrub' ? CELL.oak : type === 'juniper' || type === 'sage' ? CELL.juniper : CELL.broad;
  const base = type === 'sage' ? [0.9, 0.95, 0.88] : type === 'broad' ? [0.95, 1.0, 0.8] : type === 'juniper' ? [0.8, 0.88, 0.8] : [0.88, 0.94, 0.8];
  const R = type === 'sage' ? 0.55 : type === 'juniper' ? 0.9 : 0.8, Hh = type === 'sage' ? 0.6 : type === 'juniper' ? 1.1 : 1.3;
  const center = new THREE.Vector3(0, Hh * 0.45, 0);
  for (let i = 0; i < 5; i++) {
    const a = rng() * 6.28;
    limb(parts, new THREE.Vector3(0, -0.1, 0), new THREE.Vector3(Math.cos(a) * R * 0.6, Hh * (0.5 + rng() * 0.4), Math.sin(a) * R * 0.6), 0.035, 0.012, 4);
  }
  const n = type === 'sage' ? 18 : 30;
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a = rng() * 6.28, r = R * Math.sqrt(rng());
    p.set(Math.cos(a) * r, Hh * (0.2 + rng() * 0.75), Math.sin(a) * r);
    const sz = (type === 'sage' ? 0.55 : 0.75) + rng() * 0.45;
    const k = 0.8 + rng() * 0.3;
    card(parts, rect, p, sz, sz * 0.85, (rng() - 0.5) * 1.8, rng() * 6.28, (rng() - 0.5) * 1.4, center, [base[0] * k, base[1] * k, base[2] * k]);
  }
  return { geo: finish(parts), height: Hh, radius: R };
}

/** Cheap solid stand-in for distant trees / bushes (a few noisy blobs + trunk), vertex-coloured. */
function lodModel(kind, height, color, seed) {
  const rng = mulberry32(seed);
  const parts = [];
  const blob = (x, y, z, rx, ry, rz, col) => {
    let g = new THREE.IcosahedronGeometry(1, 1);
    g.deleteAttribute('uv'); g.deleteAttribute('normal');
    g = mergeVertices(g);
    const pos = g.attributes.position, c = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const d = 0.85 + rng() * 0.3;
      pos.setXYZ(i, x + pos.getX(i) * rx * d, y + pos.getY(i) * ry * d, z + pos.getZ(i) * rz * d);
      const sh = 0.6 + 0.4 * clamp(pos.getY(i) - y + 0.5, 0, 1);
      c[i * 3] = col[0] * sh; c[i * 3 + 1] = col[1] * sh; c[i * 3 + 2] = col[2] * sh;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    parts.push(g);
  };
  if (kind === 'cone') {
    let g = new THREE.ConeGeometry(height * 0.24, height * 0.82, 9, 3);
    g.deleteAttribute('uv'); g.deleteAttribute('normal');
    g = mergeVertices(g);
    const pos = g.attributes.position, c = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      pos.setXYZ(i, pos.getX(i) * (0.85 + rng() * 0.3), y + height * 0.55, pos.getZ(i) * (0.85 + rng() * 0.3));
      const sh = 0.55 + 0.45 * clamp(y / height + 0.5, 0, 1);
      c[i * 3] = color[0] * sh; c[i * 3 + 1] = color[1] * sh; c[i * 3 + 2] = color[2] * sh;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    parts.push(g);
  }
  else if (kind === 'column') { blob(0, height * 0.55, 0, height * 0.11, height * 0.44, height * 0.11, color); }
  else if (kind === 'bush') { blob(0, height * 0.45, 0, height * 0.7, height * 0.5, height * 0.7, color); }
  else { blob(0, height * 0.68, 0, height * 0.3, height * 0.22, height * 0.3, color); blob(height * 0.12, height * 0.6, 0.1, height * 0.2, height * 0.16, height * 0.2, color); }
  const g = mergeGeometries(parts, false);
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ LOD instancing

/** Instances split each refresh between a near (full cards) and a far (solid LOD) InstancedMesh. */
class LodSet {
  constructor(scene, nearGeo, farGeo, nearMat, farMat, nearDist, farDist, opts) {
    this.list = [];
    this.nearGeo = nearGeo; this.farGeo = farGeo;
    this.nearMat = nearMat; this.farMat = farMat;
    this.nearDist = nearDist; this.farDist = farDist;
    this.opts = opts;
    this.scene = scene;
  }
  add(m) { this.list.push(m); }
  build() {
    const n = this.list.length;
    if (!n) return;
    this.pos = new Float32Array(n * 2);
    this.list.forEach((m, i) => { this.pos[i * 2] = m.elements[12]; this.pos[i * 2 + 1] = m.elements[14]; });
    this.near = new THREE.InstancedMesh(this.nearGeo, this.nearMat, n);
    this.near.frustumCulled = false;
    this.near.castShadow = !!this.opts.castNear;
    this.near.receiveShadow = true;
    this.near.count = 0;
    this.scene.add(this.near);
    if (this.farGeo) {
      this.far = new THREE.InstancedMesh(this.farGeo, this.farMat, n);
      this.far.frustumCulled = false;
      this.far.castShadow = false;
      this.far.receiveShadow = true;
      this.far.count = 0;
      this.scene.add(this.far);
    }
  }
  update(cx, cz) {
    if (!this.near) return;
    const nd2 = this.nearDist * this.nearDist, fd2 = this.farDist * this.farDist;
    let a = 0, b = 0;
    const ne = this.near.instanceMatrix.array, fe = this.far ? this.far.instanceMatrix.array : null;
    for (let i = 0; i < this.list.length; i++) {
      const dx = this.pos[i * 2] - cx, dz = this.pos[i * 2 + 1] - cz, d2 = dx * dx + dz * dz;
      if (d2 < nd2) { this.list[i].toArray(ne, a * 16); a++; }
      else if (fe && d2 < fd2) { this.list[i].toArray(fe, b * 16); b++; }
    }
    this.near.count = a;
    this.near.instanceMatrix.needsUpdate = true;
    if (this.far) { this.far.count = b; this.far.instanceMatrix.needsUpdate = true; }
  }
}

// ------------------------------------------------------------------ materials

function addWind(mat, windU, amp, heightK) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    sh.uniforms.uTime = windU.uTime;
    sh.uniforms.uWind = windU.uWind;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec2 uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  #ifdef USE_INSTANCING
    vec3 gwIP = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  #else
    vec3 gwIP = vec3(0.0);
  #endif
  float gwK = clamp(position.y * ${heightK.toFixed(3)}, 0.0, 1.4);
  gwK *= gwK;
  float gwPh = uTime * ${amp.speed.toFixed(2)} + gwIP.x * 0.19 + gwIP.z * 0.13;
  float gwFl = sin(uTime * 3.7 + position.x * 2.1 + position.z * 1.7 + gwIP.x) * ${amp.flutter.toFixed(3)};
  transformed.x += (sin(gwPh) * ${amp.a.toFixed(3)} + uWind.x * ${amp.w.toFixed(3)}) * gwK + gwFl * gwK;
  transformed.z += (cos(gwPh * 0.87) * ${(amp.a * 0.7).toFixed(3)} + uWind.y * ${amp.w.toFixed(3)}) * gwK;
  transformed.y += gwFl * 0.5 * gwK;`);
  };
}

function foliageMaterial(atlas, windU, q, tag, amp, heightK) {
  const m = new THREE.MeshStandardMaterial({
    map: atlas, vertexColors: true, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.82, metalness: 0,
    alphaToCoverage: q.msaa > 0,
  });
  m.userData.surface = 'dirt';
  m.userData.heat = 'veg';
  addWind(m, windU, amp, heightK);
  m.customProgramCacheKey = () => 'foliage-' + tag;
  return patchAmbient(m);
}

// ------------------------------------------------------------------ placement

export class Vegetation {
  constructor(world) {
    this.world = world;
    this.sets = [];
    this.stats = {};
    this.refreshT = 0;
  }

  build() {
    const W = this.world, q = W.q, T = W.terrain, scene = W.scene;
    const atlas = leafAtlas(q.lightTier >= 1 ? 1024 : 512, Math.min(q.anisotropy, W.game.pipe.maxAniso));
    this.atlas = atlas;
    const treeMat = foliageMaterial(atlas, W.windU, q, 'tree', { speed: 0.9, a: 0.09, w: 0.12, flutter: 0.025 }, 0.09);
    const bushMat = foliageMaterial(atlas, W.windU, q, 'bush', { speed: 1.4, a: 0.05, w: 0.07, flutter: 0.02 }, 0.8);
    const lodMat = patchAmbient(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.35 }));
    lodMat.userData.heat = 'veg';
    lodMat.userData.surface = 'dirt';
    const rng = mulberry32(90210);
    const hiQ = q.lightTier >= 2, midQ = q.lightTier >= 1;
    const treeNear = hiQ ? 300 : midQ ? 220 : 150, treeFar = hiQ ? 1400 : 900;
    const bushNear = hiQ ? 170 : midQ ? 120 : 80, bushFar = hiQ ? 520 : 320;

    // --- species sets (two variants each where it matters)
    const SPECIES = {
      juniper: { lod: 'blob', col: [0.1, 0.13, 0.09], vars: 2 },
      oak: { lod: 'blob', col: [0.13, 0.17, 0.08], vars: 2 },
      pine: { lod: 'cone', col: [0.07, 0.11, 0.08], vars: 2 },
      deodar: { lod: 'cone', col: [0.08, 0.12, 0.1], vars: 1 },
      poplar: { lod: 'column', col: [0.2, 0.25, 0.1], vars: 1 },
      willow: { lod: 'blob', col: [0.18, 0.23, 0.1], vars: 1 },
      mulberry: { lod: 'blob', col: [0.15, 0.21, 0.08], vars: 1 },
    };
    const treeSets = {};
    const treeInfo = {};
    for (const [sp, d] of Object.entries(SPECIES)) {
      treeSets[sp] = [];
      for (let v = 0; v < d.vars; v++) {
        const mdl = treeModel(sp, 1000 + v * 77 + sp.length * 13);
        treeInfo[sp + v] = mdl;
        const set = new LodSet(scene, mdl.geo, lodModel(d.lod, mdl.height, d.col, 5 + v), treeMat, lodMat, treeNear, treeFar, { castNear: q.shadows });
        treeSets[sp].push({ set, mdl });
        this.sets.push(set);
      }
    }
    const BUSHES = { broad: [0.2, 0.24, 0.1], oakScrub: [0.14, 0.17, 0.08], juniper: [0.11, 0.14, 0.1], sage: [0.3, 0.32, 0.26] };
    const bushSets = {};
    for (const [bt, col] of Object.entries(BUSHES)) {
      bushSets[bt] = [];
      for (let v = 0; v < 2; v++) {
        const mdl = bushModel(bt, 300 + v * 31 + bt.length * 7);
        const set = new LodSet(scene, mdl.geo, lodModel('bush', mdl.height, col, 11 + v), bushMat, lodMat, bushNear, bushFar, { castNear: hiQ });
        bushSets[bt].push({ set, mdl });
        this.sets.push(set);
      }
    }

    const m = new THREE.Matrix4(), qt = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
    const phys = W.physics;
    const counts = {};
    const plant = (sp, x, z, scale, collide) => {
      const opts = treeSets[sp];
      const { set, mdl } = opts[Math.floor(rng() * opts.length)];
      const y = phys.floorAt(x, z, T.heightAt(x, z) + 0.5).y;
      e.set((rng() - 0.5) * 0.08, rng() * 6.28, (rng() - 0.5) * 0.08);
      qt.setFromEuler(e);
      ps.set(x, y - 0.15, z);
      sc.set(scale, scale * (0.9 + rng() * 0.2), scale);
      set.add(m.compose(ps, qt, sc).clone());
      counts[sp] = (counts[sp] || 0) + 1;
      if (collide) {
        const r = mdl.trunk * scale * 0.9;
        phys.addBox(x - r, y - 0.3, z - r, x + r, y + mdl.height * 0.45 * scale, z + r, { surface: 'wood', cover: r > 0.2 });
        // dense crowns hide what is behind them
        const cr = (sp === 'pine' || sp === 'deodar' || sp === 'juniper') ? 1.1 * scale : 0;
        if (cr) phys.addBox(x - cr, y + mdl.height * 0.3 * scale, z - cr, x + cr, y + mdl.height * 0.85 * scale, z + cr, { move: false, bullet: false, sight: true, walkTop: false, surface: 'wood' });
      }
    };
    const bush = (bt, x, z, scale, collide) => {
      const opts = bushSets[bt];
      const { set, mdl } = opts[Math.floor(rng() * opts.length)];
      const y = T.heightAt(x, z);
      e.set((rng() - 0.5) * 0.15, rng() * 6.28, (rng() - 0.5) * 0.15);
      qt.setFromEuler(e);
      ps.set(x, y - 0.05, z);
      sc.set(scale, scale * (0.8 + rng() * 0.4), scale);
      set.add(m.compose(ps, qt, sc).clone());
      counts['bush_' + bt] = (counts['bush_' + bt] || 0) + 1;
      // big bushes break line of sight (not bullets): real concealment
      const h = mdl.height * scale;
      if (collide && h > 0.85) {
        const r = mdl.radius * scale * 0.6;
        phys.addBox(x - r, y, z - r, x + r, y + h * 0.9, z + r, { move: false, bullet: false, sight: true, walkTop: false, surface: 'wood' });
      }
    };

    const valley = MOUNTAIN_LAYOUT.valley;
    const nrm = new THREE.Vector3();
    const inPlay = (x, z) => Math.hypot(x, z) < 660;
    const blocked = (x, z, r) => W.blockedForScatter(x, z, r) || W.insideStructure(x, z) || T.maskAt(x, z) > 0.08;
    const treeCap = hiQ ? 3200 : midQ ? 1900 : 750;
    const bushCap = hiQ ? 14000 : midQ ? 8000 : 3000;
    let trees = 0, bushes = 0;

    // --- riparian galleries along the wadi and the village orchards
    for (let i = 0; i < 1400 && trees < treeCap; i++) {
      const kf = rng() * (valley.length - 1), a = Math.floor(kf), f = kf - a;
      const A = valley[a], B = valley[a + 1];
      const x = A[0] + (B[0] - A[0]) * f + (rng() - 0.5) * 60, z = A[1] + (B[1] - A[1]) * f + (rng() - 0.5) * 60;
      if (Math.abs(x) > 780 || Math.abs(z) > 780) continue;
      const dv = distToPolyline(x, z, valley).d;
      if (dv < 6 || dv > 32 || T.slopeAt(x, z) > 0.2) continue;
      const patch = T.fbm(T.n2, x / 120 + 3, z / 120, 2);
      if (patch < -0.05 || rng() > 0.55) continue;
      if (blocked(x, z, 2.5)) continue;
      plant(rng() < 0.55 ? 'poplar' : 'willow', x, z, 0.8 + rng() * 0.45, inPlay(x, z));
      trees++;
    }
    for (const t of W.siteTrees) { plant('mulberry', t.x, t.z, 1.0 + rng() * 0.2, true); trees++; }
    const vill = W.pads.village;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) {
      const x = vill.x - 44 + c * 9 + (rng() - 0.5) * 2, z = vill.z + 34 + r * 10 + (rng() - 0.5) * 2;
      if (blocked(x, z, 2) || T.slopeAt(x, z) > 0.2) continue;
      plant(rng() < 0.75 ? 'mulberry' : 'poplar', x, z, 0.85 + rng() * 0.3, true);
      trees++;
    }

    // --- mountain forests
    const step = 7;
    for (let z = -780; z < 780 && trees < treeCap; z += step) {
      for (let x = -780; x < 780; x += step) {
        const jx = x + rng() * step, jz = z + rng() * step;
        const y = T.heightAt(jx, jz), slope = T.slopeAt(jx, jz);
        if (slope > 0.42) continue;
        T.normalAt(jx, jz, nrm);
        const north = -nrm.z; // > 0 on north-facing slopes (cool, moist)
        const patch = T.fbm(T.n3, jx / 170 + 9, jz / 170, 3);
        const fine = T.fbm(T.n1, jx / 40, jz / 40 + 4, 2);
        let sp = null, p = 0;
        if (y > 170 && north > 0.12 && slope > 0.08) { sp = rng() < 0.62 ? 'pine' : 'deodar'; p = smoothstep(0.0, 0.25, patch) * 0.75 * smoothstep(0.12, 0.35, north); }
        else if (y > 110 && y < 480) { sp = 'juniper'; p = smoothstep(-0.1, 0.25, patch) * 0.22; }
        else if (y > 25 && y < 200 && slope < 0.33) { sp = 'oak'; p = smoothstep(0.05, 0.3, patch + fine * 0.3) * 0.4; }
        if (!sp || rng() > p) continue;
        if (blocked(jx, jz, 2.5)) continue;
        const scale = sp === 'juniper' ? 0.6 + rng() * 0.6 : 0.75 + rng() * 0.5;
        plant(sp, jx, jz, scale, inPlay(jx, jz));
        trees++;
        if (trees >= treeCap) break;
      }
    }

    // --- bushes: everywhere the ground is not too steep, species by altitude and shade
    for (let i = 0; i < bushCap * 5 && bushes < bushCap; i++) {
      const x = (rng() * 2 - 1) * 740, z = (rng() * 2 - 1) * 760;
      const y = T.heightAt(x, z), slope = T.slopeAt(x, z);
      if (slope > 0.4 || y > 620) continue;
      const patch = T.fbm(T.n2, x / 90 + 5, z / 90, 2);
      const gm = W.grassMask ? W.grassMask(x, z, y, slope) : 0.3;
      const pr = 0.18 + gm * 0.35 + Math.max(0, patch) * 0.6;
      if (rng() > pr) continue;
      if (blocked(x, z, 1.2)) continue;
      T.normalAt(x, z, nrm);
      let bt;
      if (distToPolyline(x, z, valley).d < 40 && y < 80) bt = rng() < 0.7 ? 'broad' : 'oakScrub';
      else if (y > 200) bt = rng() < 0.55 ? 'juniper' : 'sage';
      else bt = rng() < 0.45 ? 'oakScrub' : rng() < 0.6 ? 'sage' : 'broad';
      bush(bt, x, z, 0.65 + rng() * 0.8, inPlay(x, z));
      bushes++;
    }
    for (const s of this.sets) s.build();
    this.stats = { trees, bushes, ...counts };
    return this;
  }

  /** Re-sorts instances into near / far LODs around the viewer (a few times a second). */
  update(dt, cam) {
    this.refreshT -= dt;
    const moved = !this.last || Math.hypot(cam.x - this.last.x, cam.z - this.last.z) > 6;
    if (this.refreshT > 0 && !moved) return;
    this.refreshT = 0.5;
    this.last = { x: cam.x, z: cam.z };
    for (const s of this.sets) s.update(cam.x, cam.z);
  }
}
