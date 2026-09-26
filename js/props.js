// Prop library. Each function authors visual detail + a simplified collider through the LevelBuilder.
import * as THREE from 'three';
import { propBox, propCylinder, trs } from './geometry.js';
import { patchAmbient } from './materials.js';

const PI = Math.PI;

export function crate(b, x0, z0, x1, z1, y0 = 0, h = 1.2, mat = null) {
  const M = b.M, m = mat || M.plywood, e = 0.035;
  b.solid(x0, y0, z0, x1, y0 + h, z1, m, { cover: true, thin: false });
  // battens on the edges
  const bat = M.woodDark;
  b.vis(x0 - e, y0, z0 - e, x0 + 0.09, y0 + h, z0 + 0.09, bat);
  b.vis(x1 - 0.09, y0, z0 - e, x1 + e, y0 + h, z0 + 0.09, bat);
  b.vis(x0 - e, y0, z1 - 0.09, x0 + 0.09, y0 + h, z1 + e, bat);
  b.vis(x1 - 0.09, y0, z1 - 0.09, x1 + e, y0 + h, z1 + e, bat);
  b.vis(x0 - e, y0 + h - 0.09, z0 - e, x1 + e, y0 + h + 0.005, z0 + 0.09, bat, { ao: false });
  b.vis(x0 - e, y0 + h - 0.09, z1 - 0.09, x1 + e, y0 + h + 0.005, z1 + e, bat, { ao: false });
  b.vis(x0 - e, y0, z0 - e, x1 + e, y0 + 0.09, z0 + 0.09, bat);
  b.vis(x0 - e, y0, z1 - 0.09, x1 + e, y0 + 0.09, z1 + e, bat);
}

export function pallet(b, x, z, y = 0, alongX = true, mat = null) {
  const M = b.M, m = mat || M.wood;
  const L = 1.2, W = 1.0;
  const lx = alongX ? L : W, lz = alongX ? W : L;
  const x0 = x - lx / 2, z0 = z - lz / 2;
  // stringers
  for (let k = 0; k < 3; k++) {
    if (alongX) { const zz = z0 + 0.05 + k * (lz - 0.1) / 2; b.vis(x0, y, zz - 0.05, x0 + lx, y + 0.1, zz + 0.05, m); }
    else { const xx = x0 + 0.05 + k * (lx - 0.1) / 2; b.vis(xx - 0.05, y, z0, xx + 0.05, y + 0.1, z0 + lz, m); }
  }
  // top boards
  const n = 7;
  for (let k = 0; k < n; k++) {
    if (alongX) { const xx = x0 + 0.06 + k * (lx - 0.12) / (n - 1); b.vis(xx - 0.05, y + 0.1, z0, xx + 0.05, y + 0.125, z0 + lz, m, { ao: false }); }
    else { const zz = z0 + 0.06 + k * (lz - 0.12) / (n - 1); b.vis(x0, y + 0.1, zz - 0.05, x0 + lx, y + 0.125, zz + 0.05, m, { ao: false }); }
  }
  return y + 0.125;
}

export function palletStack(b, x, z, count, alongX = true) {
  let y = 0;
  for (let i = 0; i < count; i++) y = pallet(b, x, z, y + (i ? 0.005 : 0), alongX);
  const lx = alongX ? 1.2 : 1.0, lz = alongX ? 1.0 : 1.2;
  b.collider(x - lx / 2, 0, z - lz / 2, x + lx / 2, y, z + lz / 2, { cover: y > 0.7, surface: 'wood', thin: true });
}

/** Pallet loaded with shrink-wrapped cartons. */
export function loadedPallet(b, x, z, y = 0, h = 1.1, alongX = true, collide = true) {
  const M = b.M;
  const top = pallet(b, x, z, y, alongX);
  const lx = alongX ? 1.2 : 1.0, lz = alongX ? 1.0 : 1.2;
  const rows = Math.max(1, Math.round(h / 0.35));
  const ch = h / rows;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const inset = 0.02 + ((i + j + r) % 2) * 0.015;
      const cx0 = x - lx / 2 + i * lx / 2 + inset, cz0 = z - lz / 2 + j * lz / 2 + inset;
      b.vis(cx0, top + r * ch, cz0, cx0 + lx / 2 - inset * 2, top + (r + 1) * ch - 0.005, cz0 + lz / 2 - inset * 2, M.cardboard, { ao: r === 0 });
    }
  }
  if (collide) b.collider(x - lx / 2, y, z - lz / 2, x + lx / 2, top + h, z + lz / 2, { cover: true, surface: 'wood' });
  return top + h;
}

export function drum(b, x, z, y = 0, mat = null) {
  const M = b.M, m = mat || M.drumBlue;
  b.mesh(propCylinder(0.29, 0.29, 0.88, 16), m, trs(x, y + 0.44, z), { ao: true, baseY: y });
  for (const hy of [0.3, 0.58]) b.mesh(propCylinder(0.3, 0.3, 0.03, 16), m, trs(x, y + hy, z));
  b.mesh(propCylinder(0.27, 0.27, 0.01, 16), M.steelDark, trs(x, y + 0.885, z));
}

export function drumCluster(b, x, z, mats) {
  const offs = [[-0.31, -0.31], [0.31, -0.31], [-0.31, 0.31], [0.31, 0.31]];
  offs.forEach(([dx, dz], i) => drum(b, x + dx, z + dz, 0, mats[i % mats.length]));
  b.collider(x - 0.62, 0, z - 0.62, x + 0.62, 0.9, z + 0.62, { cover: true, surface: 'metal' });
}

/** Concrete jersey barrier from x0/z0 to x1/z1 (axis-aligned). */
export function jersey(b, x0, z0, x1, z1) {
  const M = b.M;
  const alongX = (x1 - x0) > (z1 - z0);
  const len = alongX ? x1 - x0 : z1 - z0;
  const sh = new THREE.Shape();
  sh.moveTo(-0.3, 0); sh.lineTo(0.3, 0); sh.lineTo(0.3, 0.08); sh.lineTo(0.12, 0.3); sh.lineTo(0.08, 0.81);
  sh.lineTo(-0.08, 0.81); sh.lineTo(-0.12, 0.3); sh.lineTo(-0.3, 0.08); sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: len, bevelEnabled: false });
  g.translate(0, 0, -len / 2);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  b.mesh(g, M.concrete, trs(cx, 0, cz, 0, alongX ? PI / 2 : 0, 0), { ao: true, baseY: 0 });
  const w = 0.3;
  if (alongX) b.collider(x0, 0, cz - w, x1, 0.81, cz + w, { cover: true, surface: 'concrete' });
  else b.collider(cx - w, 0, z0, cx + w, 0.81, z1, { cover: true, surface: 'concrete' });
}

/** 20ft shipping container (axis aligned). doorEnd: '+x' | '-x' | '+z' | '-z'. */
export function container(b, x0, z0, x1, z1, y0, mat, doorEnd = '+x') {
  const M = b.M, h = 2.59;
  b.solid(x0, y0, z0, x1, y0 + h, z1, mat, { cover: true, surface: 'metal', ao: y0 < 0.1 });
  const p = 0.12, e = 0.02;
  for (const [xa, za] of [[x0, z0], [x1 - p, z0], [x0, z1 - p], [x1 - p, z1 - p]]) {
    b.vis(xa - e, y0, za - e, xa + p + e, y0 + h + e, za + p + e, M.steelDark, { ao: y0 < 0.1 });
  }
  // top & bottom rails
  b.vis(x0 - e, y0 + h - 0.1, z0 - e, x1 + e, y0 + h + e, z1 + e, M.steelDark, { ao: false });
  b.vis(x0 - e, y0, z0 - e, x1 + e, y0 + 0.15, z1 + e, M.steelDark, { ao: y0 < 0.1 });
  // door lock bars
  const bars = 4;
  for (let i = 0; i < bars; i++) {
    const t = (i + 0.5) / bars;
    if (doorEnd === '+x' || doorEnd === '-x') {
      const x = doorEnd === '+x' ? x1 + 0.03 : x0 - 0.03, z = z0 + t * (z1 - z0);
      b.vis(x - 0.02, y0 + 0.2, z - 0.02, x + 0.02, y0 + h - 0.15, z + 0.02, M.bareMetal, { ao: false });
      b.vis(x - 0.03, y0 + 1.1, z - 0.06, x + 0.03, y0 + 1.25, z + 0.06, M.steelDark, { ao: false });
    } else {
      const z = doorEnd === '+z' ? z1 + 0.03 : z0 - 0.03, x = x0 + t * (x1 - x0);
      b.vis(x - 0.02, y0 + 0.2, z - 0.02, x + 0.02, y0 + h - 0.15, z + 0.02, M.bareMetal, { ao: false });
      b.vis(x - 0.06, y0 + 1.1, z - 0.03, x + 0.06, y0 + 1.25, z + 0.03, M.steelDark, { ao: false });
    }
  }
}

export function wheel(b, x, y, z, r, w, axisX = true) {
  const M = b.M;
  const rot = axisX ? [0, 0, PI / 2] : [PI / 2, 0, 0];
  b.mesh(propCylinder(r, r, w, 16), M.rubber, trs(x, y, z, ...rot), { cast: true });
  b.mesh(propCylinder(r * 0.55, r * 0.55, w + 0.01, 10), M.steelGrey, trs(x, y, z, ...rot));
}

/** Box truck facing +z (cab at z1 side). */
export function boxTruck(b, x0, z0, x1, z1) {
  const M = b.M, cabL = 2.2, zc = z1 - cabL;
  // cargo box
  b.solid(x0, 0.95, z0, x1, 3.55, zc - 0.1, M.steelWhite, { cover: true, ao: false });
  b.vis(x0 - 0.02, 0.95, z0 - 0.03, x1 + 0.02, 1.05, zc - 0.08, M.steelDark);
  b.collider(x0, 0, z0, x1, 0.95, zc, { cover: true, surface: 'metal' });
  // chassis
  b.vis(x0 + 0.3, 0.55, z0 + 0.2, x1 - 0.3, 0.95, z1 - 0.3, M.steelDark);
  // rear door detail
  b.vis(x0 + 0.05, 1.0, z0 - 0.04, x1 - 0.05, 3.5, z0, M.steelGrey, { ao: false });
  b.vis((x0 + x1) / 2 - 0.02, 1.0, z0 - 0.06, (x0 + x1) / 2 + 0.02, 3.5, z0 - 0.03, M.steelDark, { ao: false });
  // cab
  const cx0 = x0 + 0.1, cx1 = x1 - 0.1;
  b.solid(cx0, 0.6, zc, cx1, 1.75, z1, M.steelBlue, { cover: true, ao: false });
  b.solid(cx0, 1.75, zc, cx1, 2.85, z1 - 0.7, M.steelBlue, { cover: true, ao: false });
  b.collider(cx0, 0, zc, cx1, 0.6, z1, { cover: true, surface: 'metal' });
  b.vis(cx0 + 0.02, 1.8, z1 - 0.75, cx1 - 0.02, 2.75, z1 - 0.68, M.glassDark, { ao: false });
  b.vis(cx0 - 0.01, 1.85, zc + 0.2, cx0 + 0.01, 2.6, z1 - 0.8, M.glassDark, { ao: false });
  b.vis(cx1 - 0.01, 1.85, zc + 0.2, cx1 + 0.01, 2.6, z1 - 0.8, M.glassDark, { ao: false });
  b.vis(cx0 + 0.1, 0.55, z1 - 0.02, cx1 - 0.1, 0.9, z1 + 0.08, M.steelDark);
  // wheels
  const wx0 = x0 + 0.15, wx1 = x1 - 0.15;
  for (const wz of [z0 + 1.0, z0 + 2.1, z1 - 1.0]) {
    wheel(b, wx0, 0.5, wz, 0.5, 0.3);
    wheel(b, wx1, 0.5, wz, 0.5, 0.3);
  }
}

/** Sedan facing +z. */
export function car(b, x0, z0, x1, z1, mat) {
  const M = b.M, L = z1 - z0;
  b.solid(x0, 0.3, z0, x1, 0.95, z1, mat, { cover: true, ao: false });
  b.collider(x0, 0, z0, x1, 0.3, z1, { cover: true, surface: 'metal' });
  const c0 = z0 + L * 0.3, c1 = z0 + L * 0.72;
  b.solid(x0 + 0.08, 0.95, c0, x1 - 0.08, 1.42, c1, mat, { cover: true, ao: false });
  b.vis(x0 + 0.07, 1.0, c0 + 0.08, x1 - 0.07, 1.36, c1 - 0.08, M.glassDark, { ao: false });
  b.vis(x0 + 0.1, 1.0, c1 - 0.02, x1 - 0.1, 1.38, c1 + 0.01, M.glassDark, { ao: false });
  b.vis(x0 + 0.1, 1.0, c0 - 0.01, x1 - 0.1, 1.38, c0 + 0.02, M.glassDark, { ao: false });
  b.vis(x0 - 0.02, 0.3, z1 - 0.1, x1 + 0.02, 0.5, z1 + 0.04, M.plasticDark);
  b.vis(x0 - 0.02, 0.3, z0 - 0.04, x1 + 0.02, 0.5, z0 + 0.1, M.plasticDark);
  for (const wz of [z0 + L * 0.18, z1 - L * 0.18]) {
    wheel(b, x0 + 0.1, 0.32, wz, 0.32, 0.22);
    wheel(b, x1 - 0.1, 0.32, wz, 0.32, 0.22);
  }
}

/** Forklift facing +x at (x, z). */
export function forklift(b, x, z) {
  const M = b.M;
  const bx0 = x - 1.2, bx1 = x + 0.5, bz0 = z - 0.6, bz1 = z + 0.6;
  b.solid(bx0, 0.25, bz0, bx1, 1.15, bz1, M.steelYellow, { cover: true, ao: false });
  b.collider(bx0, 0, bz0, bx1, 0.25, bz1, { cover: true, surface: 'metal' });
  b.vis(bx0 - 0.1, 0.3, bz0 + 0.05, bx0 + 0.3, 1.25, bz1 - 0.05, M.steelDark); // counterweight
  // overhead guard posts
  for (const [px, pz] of [[bx0 + 0.2, bz0 + 0.05], [bx0 + 0.2, bz1 - 0.1], [bx1 - 0.15, bz0 + 0.05], [bx1 - 0.15, bz1 - 0.1]]) {
    b.vis(px, 1.15, pz, px + 0.06, 2.1, pz + 0.06, M.steelDark, { ao: false });
  }
  b.vis(bx0 + 0.15, 2.1, bz0, bx1 - 0.05, 2.16, bz1, M.steelDark, { ao: false });
  b.collider(bx0, 1.15, bz0, bx1, 2.16, bz1, { move: true, bullet: false, sight: false, walkTop: false });
  // seat
  b.vis(bx0 + 0.35, 1.15, z - 0.25, bx0 + 0.8, 1.3, z + 0.25, M.plasticDark, { ao: false });
  b.vis(bx0 + 0.3, 1.3, z - 0.25, bx0 + 0.38, 1.7, z + 0.25, M.plasticDark, { ao: false });
  // mast
  b.vis(bx1, 0.1, bz0 + 0.15, bx1 + 0.12, 2.3, bz0 + 0.27, M.steelDark);
  b.vis(bx1, 0.1, bz1 - 0.27, bx1 + 0.12, 2.3, bz1 - 0.15, M.steelDark);
  b.collider(bx1, 0, bz0 + 0.1, bx1 + 0.14, 2.3, bz1 - 0.1, { cover: false, surface: 'metal' });
  // forks + raised pallet
  const fy = 0.55;
  b.vis(bx1 + 0.12, fy, z - 0.4, bx1 + 1.3, fy + 0.05, z - 0.3, M.steelDark, { ao: false });
  b.vis(bx1 + 0.12, fy, z + 0.3, bx1 + 1.3, fy + 0.05, z + 0.4, M.steelDark, { ao: false });
  loadedPallet(b, bx1 + 0.75, z, fy + 0.05, 0.9, false, false);
  b.collider(bx1 + 0.14, 0.4, z - 0.6, bx1 + 1.35, fy + 1.1, z + 0.6, { cover: true, surface: 'wood' });
  for (const [wx, wz] of [[bx0 + 0.3, bz0 - 0.02], [bx0 + 0.3, bz1 + 0.02], [bx1 - 0.3, bz0 - 0.02], [bx1 - 0.3, bz1 + 0.02]]) {
    b.mesh(propCylinder(0.25, 0.25, 0.2, 14), M.rubber, trs(wx, 0.25, wz, PI / 2, 0, 0));
  }
}

/** Pallet rack between x0..x1 (long axis X), depth z0..z1. */
export function rack(b, x0, z0, x1, z1, h = 4.6, levels = [1.5, 3.0, 4.5], seed = 1) {
  const M = b.M, bays = Math.max(1, Math.round((x1 - x0) / 2.8));
  const bw = (x1 - x0) / bays, up = 0.08;
  for (let i = 0; i <= bays; i++) {
    const x = x0 + i * bw;
    for (const zz of [z0, z1 - up]) b.vis(x - up / 2, 0, zz, x + up / 2, h, zz + up, M.steelBlue);
    // bracing
    for (let k = 0; k < 4; k++) {
      const yy = 0.4 + k * (h - 0.6) / 3;
      b.vis(x - 0.02, yy, z0, x + 0.02, yy + 0.04, z1, M.steelBlue, { ao: false });
    }
  }
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (const ly of levels) {
    for (const zz of [z0, z1 - 0.1]) b.vis(x0, ly - 0.12, zz, x1, ly, zz + 0.1, M.steelOrange, { ao: false });
    b.vis(x0, ly - 0.02, z0 + 0.1, x1, ly, z1 - 0.1, M.plywood, { ao: false, cast: true });
  }
  const fillLevels = [0, ...levels.slice(0, -1)];
  const cz = (z0 + z1) / 2;
  for (const ly of fillLevels) {
    for (let i = 0; i < bays; i++) {
      for (let k = 0; k < 2; k++) {
        const r = rnd();
        if (r < 0.2) continue;
        const px = x0 + i * bw + bw * (k + 0.5) / 2;
        if (r < 0.75) loadedPallet(b, px, cz, ly, 0.7 + rnd() * 0.5, true, false);
        else {
          pallet(b, px, cz, ly, true);
          drum(b, px - 0.3, cz, ly + 0.125, M.drumBlue);
          drum(b, px + 0.32, cz, ly + 0.125, M.drumRust);
        }
      }
    }
  }
  b.collider(x0 - 0.05, 0, z0, x1 + 0.05, h, z1, { cover: true, surface: 'wood', walkTop: false });
}

export function table(b, x0, z0, x1, z1, h = 0.76, top = null) {
  const M = b.M, t = top || M.plywood, y = b.baseY;
  b.vis(x0, y + h - 0.04, z0, x1, y + h, z1, t, { ao: false });
  const l = 0.04;
  for (const [x, z] of [[x0 + 0.05, z0 + 0.05], [x1 - 0.05 - l, z0 + 0.05], [x0 + 0.05, z1 - 0.05 - l], [x1 - 0.05 - l, z1 - 0.05 - l]]) {
    b.vis(x, y, z, x + l, y + h - 0.04, z + l, M.steelGrey);
  }
  b.collider(x0, y, z0, x1, y + h, z1, { cover: false, bullet: false, sight: false, surface: 'wood' });
}

export function chair(b, x, z, ry = 0) {
  const M = b.M, y = b.baseY;
  const seat = propBox(0.44, 0.04, 0.42);
  b.mesh(seat, M.plasticDark, trs(x, y + 0.46, z, 0, ry, 0));
  const back = propBox(0.42, 0.4, 0.03);
  const bx = Math.sin(ry) * -0.2, bz = Math.cos(ry) * -0.2;
  b.mesh(back, M.plasticDark, trs(x + bx, y + 0.7, z + bz, -0.1, ry, 0));
  for (const [dx, dz] of [[-0.18, -0.17], [0.18, -0.17], [-0.18, 0.17], [0.18, 0.17]]) {
    const c = Math.cos(ry), s = Math.sin(ry);
    b.mesh(propCylinder(0.012, 0.012, 0.46, 6), M.steelGrey, trs(x + dx * c + dz * s, y + 0.23, z - dx * s + dz * c));
  }
}

export function lockers(b, x0, z0, x1, z1, h = 1.9, mat = null, facing = '+z') {
  const M = b.M, m = mat || M.steelGrey;
  b.solid(x0, 0, z0, x1, h, z1, m, { cover: true });
  const along = facing === '+z' || facing === '-z';
  const len = along ? x1 - x0 : z1 - z0, n = Math.max(1, Math.round(len / 0.4));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (along) {
      const x = x0 + t * len, z = facing === '+z' ? z1 : z0;
      b.vis(x - 0.008, 0.05, z - 0.006, x + 0.008, h - 0.05, z + 0.006, M.steelDark, { ao: false });
    } else {
      const z = z0 + t * len, x = facing === '+x' ? x1 : x0;
      b.vis(x - 0.006, 0.05, z - 0.008, x + 0.006, h - 0.05, z + 0.008, M.steelDark, { ao: false });
    }
  }
}

export function shelving(b, x0, z0, x1, z1, h = 2.2, shelves = 4, seed = 3) {
  const M = b.M, p = 0.04;
  for (const [x, z] of [[x0, z0], [x1 - p, z0], [x0, z1 - p], [x1 - p, z1 - p]]) b.vis(x, 0, z, x + p, h, z + p, M.steelGrey);
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < shelves; i++) {
    const y = 0.1 + i * (h - 0.2) / (shelves - 1);
    b.vis(x0, y, z0, x1, y + 0.025, z1, M.steelGrey, { ao: false });
    if (i === shelves - 1) break;
    // boxes on shelf
    const alongX = (x1 - x0) > (z1 - z0);
    const len = alongX ? x1 - x0 : z1 - z0;
    let c = 0.05;
    while (c < len - 0.3) {
      const w = 0.25 + rnd() * 0.3, bh = 0.15 + rnd() * 0.25;
      if (c + w > len - 0.05) break;
      if (rnd() > 0.2) {
        const mat = rnd() < 0.7 ? M.cardboard : M.plasticBlue;
        if (alongX) b.vis(x0 + c, y + 0.025, z0 + 0.04, x0 + c + w, y + 0.025 + bh, z1 - 0.04, mat, { ao: false });
        else b.vis(x0 + 0.04, y + 0.025, z0 + c, x1 - 0.04, y + 0.025 + bh, z0 + c + w, mat, { ao: false });
      }
      c += w + 0.04;
    }
  }
  b.collider(x0, 0, z0, x1, h, z1, { cover: true, bullet: true, surface: 'metal', thin: true });
}

export function sandbags(b, x0, z0, x1, z1, h = 0.9) {
  const M = b.M;
  const alongX = (x1 - x0) >= (z1 - z0);
  const len = alongX ? x1 - x0 : z1 - z0, depth = alongX ? z1 - z0 : x1 - x0;
  const rows = Math.round(h / 0.15), bagL = 0.55;
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * bagL * 0.5;
    const shrink = r * 0.02;
    for (let c = -off; c < len; c += bagL) {
      const a0 = Math.max(0, c) + 0.01, a1 = Math.min(len, c + bagL) - 0.01;
      if (a1 - a0 < 0.1) continue;
      const g = new THREE.SphereGeometry(0.5, 10, 6);
      if (alongX) g.scale(a1 - a0, 0.17, depth - shrink * 2);
      else g.scale(depth - shrink * 2, 0.17, a1 - a0);
      const cx = alongX ? x0 + (a0 + a1) / 2 : (x0 + x1) / 2;
      const cz = alongX ? (z0 + z1) / 2 : z0 + (a0 + a1) / 2;
      b.mesh(g, M.sandbag, trs(cx, b.baseY + r * 0.15 + 0.08, cz), { ao: true, baseY: b.baseY });
    }
  }
  b.collider(x0, b.baseY, z0, x1, b.baseY + rows * 0.15 + 0.02, z1, { cover: true, surface: 'dirt' });
}

export function dumpster(b, x0, z0, x1, z1) {
  const M = b.M;
  b.solid(x0, 0.12, z0, x1, 1.2, z1, M.steelGreen, { cover: true, ao: false });
  b.collider(x0, 0, z0, x1, 0.12, z1, { cover: true, surface: 'metal' });
  b.vis(x0 - 0.04, 1.2, z0 - 0.04, x1 + 0.04, 1.28, z1 + 0.04, M.plasticDark, { ao: false });
  b.vis(x0 - 0.06, 0.9, z0 + 0.1, x1 + 0.06, 0.96, z1 - 0.1, M.steelDark, { ao: false });
}

export function generator(b, x0, z0, x1, z1) {
  const M = b.M;
  b.solid(x0, 0, z0, x1, 0.25, z1, M.steelDark, { cover: true });
  b.solid(x0 + 0.05, 0.25, z0 + 0.05, x1 - 0.05, 1.45, z1 - 0.05, M.steelYellow, { cover: true, ao: false });
  const n = 8;
  for (let i = 0; i < n; i++) {
    const x = x0 + 0.3 + i * (x1 - x0 - 0.6) / (n - 1);
    b.vis(x - 0.015, 0.55, z1 - 0.06, x + 0.015, 1.2, z1 - 0.03, M.steelDark, { ao: false });
  }
  b.mesh(propCylinder(0.06, 0.06, 0.8, 10), M.steelDark, trs(x0 + 0.3, 1.85, z0 + 0.3));
  b.vis(x1 - 0.5, 1.45, z0 + 0.2, x1 - 0.2, 1.6, z0 + 0.5, M.steelDark, { ao: false });
}

export function workbench(b, x0, z0, x1, z1, h = 0.92) {
  const M = b.M;
  b.vis(x0, h - 0.05, z0, x1, h, z1, M.woodDark, { ao: false });
  b.vis(x0 + 0.05, 0, z0 + 0.05, x1 - 0.05, h - 0.05, z0 + 0.1, M.steelGrey);
  b.vis(x0 + 0.05, 0.15, z0 + 0.05, x1 - 0.05, 0.18, z1 - 0.05, M.steelGrey, { ao: false });
  for (const x of [x0 + 0.05, x1 - 0.1]) for (const z of [z0 + 0.05, z1 - 0.1]) b.vis(x, 0, z, x + 0.05, h - 0.05, z + 0.05, M.steelGrey);
  b.collider(x0, 0, z0, x1, h, z1, { cover: true, surface: 'wood', thin: true });
}

export function vending(b, x0, z0, x1, z1, faceZ = 1) {
  const M = b.M;
  b.solid(x0, 0, z0, x1, 1.85, z1, M.steelRed, { cover: true });
  const fz = faceZ > 0 ? z1 : z0;
  b.vis(x0 + 0.08, 0.7, fz - 0.01, x1 - 0.3, 1.7, fz + 0.01, M.lampGlow, { ao: false, cast: false });
  b.vis(x1 - 0.25, 0.9, fz - 0.015, x1 - 0.08, 1.4, fz + 0.015, M.plasticDark, { ao: false });
}

export function pipeRun(b, axis, a0, a1, y, c, r = 0.06, mat = null) {
  const M = b.M, m = mat || M.steelGrey, len = a1 - a0, mid = (a0 + a1) / 2;
  const tr = axis === 'x' ? trs(mid, y, c, 0, 0, PI / 2) : trs(c, y, mid, PI / 2, 0, 0);
  b.mesh(propCylinder(r, r, len, 10), m, tr);
  const n = Math.floor(len / 2.5);
  for (let i = 0; i <= n; i++) {
    const a = a0 + (i / Math.max(1, n)) * len;
    const t2 = axis === 'x' ? trs(a, y, c, 0, 0, PI / 2) : trs(c, y, a, PI / 2, 0, 0);
    b.mesh(propCylinder(r + 0.015, r + 0.015, 0.06, 10), M.steelDark, t2);
  }
}

export function cableTray(b, axis, a0, a1, y, c) {
  const M = b.M;
  if (axis === 'x') {
    b.vis(a0, y, c - 0.15, a1, y + 0.02, c + 0.15, M.galv, { ao: false });
    b.vis(a0, y, c - 0.15, a1, y + 0.08, c - 0.14, M.galv, { ao: false });
    b.vis(a0, y, c + 0.14, a1, y + 0.08, c + 0.15, M.galv, { ao: false });
    b.vis(a0, y + 0.02, c - 0.1, a1, y + 0.06, c + 0.08, M.rubber, { ao: false });
  } else {
    b.vis(c - 0.15, y, a0, c + 0.15, y + 0.02, a1, M.galv, { ao: false });
    b.vis(c - 0.15, y, a0, c - 0.14, y + 0.08, a1, M.galv, { ao: false });
    b.vis(c + 0.14, y, a0, c + 0.15, y + 0.08, a1, M.galv, { ao: false });
    b.vis(c - 0.1, y + 0.02, a0, c + 0.08, y + 0.06, a1, M.rubber, { ao: false });
  }
}

/** Hanging light fixture. type: 'tube' | 'bay' | 'bulb' */
export function lightFixture(b, x, y, z, type = 'tube', along = 'x', lit = true) {
  const M = b.M;
  if (type === 'tube') {
    const lx = along === 'x' ? 1.2 : 0.18, lz = along === 'x' ? 0.18 : 1.2;
    b.vis(x - lx / 2, y, z - lz / 2, x + lx / 2, y + 0.07, z + lz / 2, M.steelWhite, { ao: false, cast: false });
    const gx = along === 'x' ? 1.1 : 0.05, gz = along === 'x' ? 0.05 : 1.1;
    b.vis(x - gx / 2, y - 0.02, z - gz / 2, x + gx / 2, y, z + gz / 2, lit ? M.lampTube : M.steelGrey, { ao: false, cast: false });
  } else if (type === 'bay') {
    b.mesh(propCylinder(0.08, 0.28, 0.3, 14, true), M.steelGrey, trs(x, y + 0.15, z), { cast: false });
    b.mesh(propCylinder(0.24, 0.24, 0.02, 14), lit ? M.lampSodium : M.steelDark, trs(x, y + 0.02, z), { cast: false });
    b.mesh(propCylinder(0.006, 0.006, 1.2, 4), M.steelDark, trs(x, y + 0.9, z), { cast: false });
  } else {
    b.mesh(new THREE.SphereGeometry(0.05, 8, 6), M.lampGlow, trs(x, y, z), { cast: false });
    b.mesh(propCylinder(0.004, 0.004, 0.8, 4), M.steelDark, trs(x, y + 0.42, z), { cast: false });
  }
}

export function floodlight(b, x, z, aimYaw) {
  const M = b.M;
  for (let k = 0; k < 3; k++) {
    const a = aimYaw + k * (PI * 2 / 3);
    b.mesh(propCylinder(0.012, 0.012, 2.2, 5), M.steelDark, trs(x + Math.sin(a) * 0.25, 1.05, z + Math.cos(a) * 0.25, Math.cos(a) * 0.12, 0, -Math.sin(a) * 0.12));
  }
  b.mesh(propBox(0.4, 0.3, 0.12), M.steelYellow, trs(x, 2.25, z, -0.35, aimYaw, 0));
  const fx = x + Math.sin(aimYaw) * 0.07, fz = z + Math.cos(aimYaw) * 0.07;
  b.mesh(propBox(0.34, 0.24, 0.01), M.lampGlow, trs(fx, 2.23, fz, -0.35, aimYaw, 0), { cast: false });
  b.collider(x - 0.3, 0, z - 0.3, x + 0.3, 2.3, z + 0.3, { bullet: false, sight: false, cover: false, walkTop: false });
}

export function lightPole(b, x, z, h = 7) {
  const M = b.M;
  b.mesh(propCylinder(0.07, 0.1, h, 10), M.galv, trs(x, h / 2, z), { ao: true, baseY: 0 });
  b.mesh(propBox(0.1, 0.08, 1.2), M.galv, trs(x, h - 0.1, z + 0.55));
  b.mesh(propBox(0.35, 0.12, 0.6), M.steelGrey, trs(x, h - 0.2, z + 1.15));
  b.mesh(propBox(0.28, 0.02, 0.5), M.lampSodium, trs(x, h - 0.27, z + 1.15), { cast: false });
  b.collider(x - 0.1, 0, z - 0.1, x + 0.1, h, z + 0.1, { cover: false });
}

export function electricBox(b, x0, y0, z0, x1, y1, z1) {
  const M = b.M;
  b.vis(x0, y0, z0, x1, y1, z1, M.steelGrey, { ao: false });
}

export function fireExtinguisher(b, x, y, z) {
  const M = b.M;
  b.mesh(propCylinder(0.075, 0.075, 0.45, 10), M.steelRed, trs(x, y + 0.225, z));
  b.mesh(propCylinder(0.02, 0.03, 0.08, 6), M.steelDark, trs(x, y + 0.49, z));
}

export function gasCylinder(b, x, z, mat) {
  b.mesh(propCylinder(0.11, 0.11, 1.3, 10), mat, trs(x, 0.65, z), { ao: true, baseY: 0 });
  b.mesh(new THREE.SphereGeometry(0.11, 10, 6, 0, PI * 2, 0, PI / 2), mat, trs(x, 1.3, z));
  b.mesh(propCylinder(0.025, 0.025, 0.12, 6), b.M.bareMetal, trs(x, 1.46, z));
}

export function couch(b, x0, z0, x1, z1) {
  const M = b.M;
  b.solid(x0, 0, z0, x1, 0.45, z1, M.fabric, { cover: true });
  const alongZ = (z1 - z0) > (x1 - x0);
  if (alongZ) b.vis(x0, 0.45, z0, x0 + 0.22, 0.85, z1, M.fabric, { ao: false });
  else b.vis(x0, 0.45, z0, x1, 0.85, z0 + 0.22, M.fabric, { ao: false });
}

/** A flat picture/sign quad using its own textured material. */
export function signQuad(b, tex, x, y, z, w, h, ry = 0, emissive = false) {
  const mat = emissive
    ? new THREE.MeshBasicMaterial({ map: tex })
    : patchAmbient(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, metalness: 0 }));
  mat.userData.surface = 'metal';
  const geo = new THREE.PlaneGeometry(w, h);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.rotation.y = ry;
  mesh.receiveShadow = !emissive;
  b.scene.add(mesh);
  return mesh;
}
