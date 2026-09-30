// ============================================================================
// Architecture.js — procedural Caribbean colonial architecture with scanned
// PBR materials: whitewashed townhouses with quoins, shuttered windows,
// balconies and clay-tile gable roofs; a stone bell tower (viewpoint); fort
// curtain walls; plank piers; hay carts; palms; market stalls; cargo.
// Every part is merged per material → a handful of draw calls per building.
// Module = { lods: [hi, mid, low], lodDistances, colliders }.
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { boxUV } from './Materials.js';
import { TAG } from './Physics.js';

const S = TAG.SOLID, L = TAG.LEDGE;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(1, 1, 1);
const PALETTE = [0xf3ead6, 0xe9c98f, 0xe9b3a0, 0xb9d3d6, 0xc9dcb7, 0xf0dcc0, 0xd7c6e0];
const SHUTTERS = [0x2f4f43, 0x2c4660, 0x6b2b24, 0x3c3a36, 0x4d6b3a];

/** Collects transformed geometry per material, then merges into one mesh per material. */
class Builder {
  constructor() { this.parts = new Map(); }
  add(geo, mat, pos = [0, 0, 0], rot = [0, 0, 0], scale = null, uvOffset = 0) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (!g.attributes.uv1) boxUV(g, uvOffset);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'uv1'].includes(k)) g.deleteAttribute(k);
    _e.set(rot[0], rot[1], rot[2]);
    g.applyMatrix4(_m.compose(new THREE.Vector3(...pos), _q.setFromEuler(_e), scale ? new THREE.Vector3(...scale) : _s));
    if (!this.parts.has(mat)) this.parts.set(mat, []);
    this.parts.get(mat).push(g);
    return this;
  }
  /** Box with its base at y. */
  box(mat, w, h, d, x = 0, y = 0, z = 0, rot = [0, 0, 0], uvOffset = 0) {
    return this.add(new THREE.BoxGeometry(w, h, d), mat, [x, y + h / 2, z], rot, null, uvOffset);
  }
  build({ shadows = true } = {}) {
    const group = new THREE.Group();
    for (const [mat, geos] of this.parts) {
      const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
      mesh.castShadow = shadows; mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }
}

const col = (minX, minY, minZ, maxX, maxY, maxZ, tags) => ({ min: [minX, minY, minZ], max: [maxX, maxY, maxZ], tags });

// --------------------------------------------------------------- buildings
function townhouse(M, { w, d, floors, seed }) {
  const rnd = mulberry(seed);
  const tint = PALETTE[Math.floor(rnd() * PALETTE.length)];
  const walls = M.pbr('plaster2', { tint, key: `h${tint}` });
  const stone = M.pbr('fort'), roof = M.pbr('roof'), wood = M.pbr('darkwood');
  const shutter = M.pbr('wood', { tint: SHUTTERS[Math.floor(rnd() * SHUTTERS.length)], key: 'sh' });
  const glass = M.flat(0x0e1114, { roughness: 0.15, metalness: 0.2 });
  const floorH = 3.4, h = floors * floorH + 0.6;
  const pitch = THREE.MathUtils.degToRad(30), overhang = 0.55;
  const alongX = w >= d;                          // ridge runs along the long side
  const span = alongX ? d : w, len = alongX ? w : d;
  const rise = (span / 2) * Math.tan(pitch);
  const uvo = rnd() * 10;

  const hi = new Builder(), mid = new Builder(), low = new Builder();
  hi.box(stone, w + 0.12, 0.7, d + 0.12, 0, 0, 0, undefined, uvo);                // plinth
  hi.box(walls, w, h - 0.7, d, 0, 0.7, 0, undefined, uvo);
  for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {                   // quoins
    for (let y = 0.7; y < h - 0.3; y += 0.6) {
      const big = ((y / 0.6) | 0) % 2 === 0;
      hi.box(stone, big ? 0.62 : 0.42, 0.56, big ? 0.42 : 0.62, cx * (w / 2 - (big ? 0.26 : 0.16)), y, cz * (d / 2 - (big ? 0.16 : 0.26)), undefined, y);
    }
  }
  for (let f = 1; f <= floors; f++) hi.box(stone, w + 0.3, 0.22, d + 0.3, 0, f * floorH + 0.6 - 0.22); // string courses (ledges)

  // Windows / doors on all four facades
  const facades = [[0, d / 2, 0, w], [0, -d / 2, Math.PI, w], [w / 2, 0, Math.PI / 2, d], [-w / 2, 0, -Math.PI / 2, d]];
  for (const [fx, fz, ry, flen] of facades) {
    const n = Math.max(1, Math.floor((flen - 1.2) / 2.6));
    const nx = Math.sin(ry), nz = Math.cos(ry), tx = Math.cos(ry), tz = -Math.sin(ry);
    for (let f = 0; f < floors; f++) {
      for (let i = 0; i < n; i++) {
        const t = (i - (n - 1) / 2) * (flen / n);
        const px = fx + tx * t, pz = fz + tz * t;
        const y0 = f * floorH + 0.7 + (f === 0 ? 0 : 0.6);
        const isDoor = f === 0 && ry === 0 && i === Math.floor(n / 2);
        const ww = isDoor ? 1.3 : 1.0, wh = isDoor ? 2.5 : 1.7;
        const at = (o, y) => [px + nx * o, y, pz + nz * o];
        hi.add(new THREE.BoxGeometry(ww, wh, 0.06), isDoor ? wood : glass, at(0.02, y0 + wh / 2), [0, ry, 0]);
        // frame
        hi.add(new THREE.BoxGeometry(ww + 0.3, 0.16, 0.14), stone, at(0.06, y0 + wh + 0.08), [0, ry, 0]);
        hi.add(new THREE.BoxGeometry(0.12, wh, 0.1), stone, at(0.05, y0 + wh / 2).map((v, k) => (k === 0 ? v - tx * (ww / 2 + 0.06) : k === 2 ? v - tz * (ww / 2 + 0.06) : v)), [0, ry, 0]);
        hi.add(new THREE.BoxGeometry(0.12, wh, 0.1), stone, at(0.05, y0 + wh / 2).map((v, k) => (k === 0 ? v + tx * (ww / 2 + 0.06) : k === 2 ? v + tz * (ww / 2 + 0.06) : v)), [0, ry, 0]);
        if (!isDoor) {
          hi.add(new THREE.BoxGeometry(ww + 0.36, 0.1, 0.3), stone, at(0.12, y0 - 0.05), [0, ry, 0]); // sill
          const open = 0.35 + rnd() * 1.1;                                                   // louvred shutters, half-open
          for (const side of [-1, 1]) {
            const hx = px + nx * 0.08 + tx * side * (ww / 2 + 0.1), hz = pz + nz * 0.08 + tz * side * (ww / 2 + 0.1);
            const a = ry + side * open;
            hi.add(new THREE.BoxGeometry(ww / 2, wh, 0.05), shutter, [hx + Math.cos(a) * side * ww / 4 + Math.sin(a) * 0.02, y0 + wh / 2, hz - Math.sin(a) * side * ww / 4 + Math.cos(a) * 0.02], [0, a, 0]);
          }
        }
      }
    }
    // Wooden balcony on the front of upper floors
    if (ry === 0 && floors >= 2) {
      const by = floorH + 0.6;
      hi.box(wood, flen * 0.7, 0.15, 1.2, fx, by, fz + 0.6);
      for (let x = -flen * 0.35; x <= flen * 0.35 + 0.01; x += 0.25) hi.box(wood, 0.06, 0.95, 0.06, fx + x, by + 0.15, fz + 1.15);
      hi.box(wood, flen * 0.7 + 0.1, 0.08, 0.12, fx, by + 1.1, fz + 1.15);
      for (const s of [-1, 0, 1]) hi.add(new THREE.BoxGeometry(0.12, 0.12, 1.2), wood, [fx + s * flen * 0.3, by - 0.35, fz + 0.55], [-0.6, 0, 0]);
    }
  }

  // Clay-tile gable roof: two slabs + ridge + gable ends + chimney
  const slabW = span / 2 / Math.cos(pitch) + overhang, rot = alongX ? 0 : Math.PI / 2;
  const roofParts = (b) => {
    for (const s of [-1, 1]) {
      const off = (span / 4 + overhang / 2 * Math.cos(pitch)) * s;
      const y = h + rise / 2 - Math.sin(pitch) * overhang / 2;
      const pos = alongX ? [0, y, off] : [off, y, 0];
      const r = alongX ? [s * pitch, 0, 0] : [0, 0, -s * pitch];
      b.add(new THREE.BoxGeometry(alongX ? len + overhang * 2 : slabW, 0.14, alongX ? slabW : len + overhang * 2), roof, pos, r);
    }
    b.add(new THREE.BoxGeometry(alongX ? len + overhang * 2 : 0.34, 0.24, alongX ? 0.34 : len + overhang * 2), roof, [0, h + rise + 0.02, 0]);
    const tri = new THREE.Shape([new THREE.Vector2(-span / 2, 0), new THREE.Vector2(span / 2, 0), new THREE.Vector2(0, rise)]);
    for (const s of [-1, 1]) {
      const g = new THREE.ExtrudeGeometry(tri, { depth: 0.2, bevelEnabled: false });
      b.add(g, walls, alongX ? [s * (len / 2 - 0.1) - 0.1, h, 0] : [0, h, s * (len / 2 - 0.1) - 0.1], [0, alongX ? Math.PI / 2 : 0, 0]);
    }
  };
  roofParts(hi);
  hi.box(stone, 0.9, rise + 1.6, 0.7, (alongX ? len : span) * 0.25 * (rnd() < 0.5 ? -1 : 1), h, alongX ? span * 0.12 : len * 0.2);

  mid.box(walls, w, h, d, 0, 0, 0, undefined, uvo);
  roofParts(mid);
  low.box(walls, w, h, d); roofParts(low);

  // Colliders: climbable walls + stepped roof so the slope is walkable
  const cols = [col(-w / 2, 0, -d / 2, w / 2, h, d / 2, [S, L])];
  const steps = Math.ceil(rise / 0.4);
  for (let i = 0; i < steps; i++) {
    const inset = (i + 0.5) * (span / 2) / steps, top = h + (i + 1) * rise / steps;
    if (alongX) cols.push(col(-w / 2, top - rise / steps, -d / 2 + inset - 0.3, w / 2, top, d / 2 - inset + 0.3, [S, L]));
    else cols.push(col(-w / 2 + inset - 0.3, top - rise / steps, -d / 2, w / 2 - inset + 0.3, top, d / 2, [S, L]));
  }
  return { lods: [hi.build(), mid.build(), low.build({ shadows: false })], lodDistances: [0, 55, 130], colliders: cols };
}

function bellTower(M) {
  const stone = M.pbr('fort'), plaster = M.pbr('plaster', { tint: 0xf2e8d5 }), roof = M.pbr('roof'), wood = M.pbr('darkwood');
  const w = 5, shaft = 20, top = 24;
  const hi = new Builder(), mid = new Builder();
  const body = (b) => {
    b.box(stone, w + 0.8, 1.2, w + 0.8);
    b.box(plaster, w, shaft - 1.2, w, 0, 1.2);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box(stone, 1, top - 1.2, 1, x * (w / 2 - 0.4), 1.2, z * (w / 2 - 0.4)); // belfry piers
    b.box(stone, w + 0.6, 0.5, w + 0.6, 0, shaft);
    b.box(stone, w + 0.6, 0.5, w + 0.6, 0, top);
    b.add(new THREE.ConeGeometry(w * 0.72, 4.5, 4), roof, [0, top + 0.5 + 2.25, 0], [0, Math.PI / 4, 0]);
    b.box(wood, 0.45, 0.4, 4.2, 0, top + 0.5, w / 2 + 1.7);                           // synchronisation beam
  };
  body(hi); body(mid);
  for (let y = 3; y < shaft; y += 3) hi.box(stone, w + 0.36, 0.25, w + 0.36, 0, y); // climbing ledges
  hi.add(new THREE.CylinderGeometry(0.9, 1.2, 1.5, 16, 1, true), M.flat(0x6b5a2e, { metalness: 1, roughness: 0.35 }), [0, shaft + 2.3, 0]); // bell
  return {
    lods: [hi.build(), mid.build(), mid.build({ shadows: false })], lodDistances: [0, 80, 200],
    colliders: [col(-w / 2 - 0.3, 0, -w / 2 - 0.3, w / 2 + 0.3, top + 0.5, w / 2 + 0.3, [S, L]),
      col(-0.25, top + 0.5, w / 2 + 0.3, 0.25, top + 0.9, w / 2 + 3.8, [S, TAG.SYNC])],
  };
}

function fortWall(M) {
  const stone = M.pbr('fort'), len = 16, h = 8, t = 3;
  const hi = new Builder(), low = new Builder();
  hi.box(stone, len, 1.4, t + 0.8);                                   // battered footing
  hi.box(stone, len, h - 1.4, t, 0, 1.4);
  hi.box(stone, len, 0.4, t + 0.3, 0, h - 0.4);
  for (let x = -len / 2 + 1; x < len / 2; x += 2.2) hi.box(stone, 1.2, 1.3, 0.7, x, h, t / 2 - 0.35);
  low.box(stone, len, h + 1, t);
  return { lods: [hi.build(), low.build(), low.build({ shadows: false })], lodDistances: [0, 70, 180], colliders: [col(-len / 2, 0, -t / 2 - 0.4, len / 2, h, t / 2 + 0.4, [S, L])] };
}

function pier(M) {
  const wood = M.pbr('darkwood'), w = 12, d = 6, top = 1.0;
  const hi = new Builder(), low = new Builder();
  for (let x = -w / 2 + 0.15; x < w / 2; x += 0.3) hi.box(wood, 0.28, 0.12, d, x, top - 0.12, 0, undefined, x);   // planks
  hi.box(wood, w, 0.25, 0.25, 0, top - 0.37, -d / 2 + 0.3); hi.box(wood, w, 0.25, 0.25, 0, top - 0.37, d / 2 - 0.3);
  for (let x = -w / 2 + 0.4; x < w / 2; x += 2.9) for (const z of [-d / 2 + 0.25, d / 2 - 0.25]) {
    hi.add(new THREE.CylinderGeometry(0.17, 0.2, top + 3.3, 8), wood, [x, top + 0.3 - (top + 3.3) / 2, z]);
  }
  hi.add(new THREE.CylinderGeometry(0.16, 0.2, 0.6, 8), wood, [w / 2 - 0.6, top + 0.3, d / 2 - 0.35]);          // bollard
  low.box(wood, w, 0.3, d, 0, top - 0.3);
  return { lods: [hi.build(), low.build(), low.build({ shadows: false })], lodDistances: [0, 50, 140], colliders: [col(-w / 2, -3, -d / 2, w / 2, top, d / 2, [S, L])] };
}

function hayCart(M) {
  const wood = M.pbr('wood'), straw = M.pbr('straw', { tint: 0xe6cf8a });
  const hi = new Builder();
  hi.box(wood, 2.8, 0.15, 2.4, 0, 0.55);
  for (const x of [-1.4, 1.4]) hi.box(wood, 0.1, 0.5, 2.4, x, 0.7);
  for (const z of [-1.3, 1.3]) hi.add(new THREE.CylinderGeometry(0.55, 0.55, 0.12, 14), wood, [0.7, 0.55, z], [Math.PI / 2, 0, 0]);
  hi.box(wood, 0.12, 0.12, 2.2, -2.2, 0.6, 0, [0, 0, 0.1]);
  const profile = [];
  for (let i = 0; i <= 10; i++) { const a = (i / 10) * Math.PI / 2; profile.push(new THREE.Vector2(Math.cos(a) * 1.5 + 0.01, Math.sin(a) * 1.25)); }
  const mound = new THREE.LatheGeometry(profile.reverse(), 16);
  hi.add(mound, straw, [0, 0.68, 0], [0, 0, 0], [1, 1, 0.85]);
  const g = hi.build();
  return { lods: [g, g.clone(), new Builder().box(straw, 2.8, 1.9, 2.4).build({ shadows: false })], lodDistances: [0, 50, 120],
    colliders: [col(-1.4, 0, -1.3, 1.4, 2.0, 1.3, [TAG.HAYSTACK, TAG.HIDE])] };
}

function frondTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 512;
  const g = c.getContext('2d');
  g.strokeStyle = '#5a6a2a'; g.lineWidth = 5; g.beginPath(); g.moveTo(64, 0); g.lineTo(64, 512); g.stroke();
  for (let y = 12; y < 500; y += 6) {
    const len = 58 * Math.sin((y / 512) * Math.PI) + 6;
    for (const s of [-1, 1]) {
      const hue = 85 + Math.random() * 25, lig = 22 + Math.random() * 14;
      g.strokeStyle = `hsl(${hue},45%,${lig}%)`; g.lineWidth = 8;
      g.beginPath(); g.moveTo(64, y); g.quadraticCurveTo(64 + s * len * 0.5, y - 4, 64 + s * len, y + 14); g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

function palms(M) {
  const leaf = new THREE.MeshStandardMaterial({ map: frondTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.75 });
  const bark = M.pbr('wood', { tint: 0x9d8b70, key: 'bark' });
  const frond = (b, x, y, z, yaw, droop, length = 4.2, tilt = 0.5) => {
    const g = new THREE.PlaneGeometry(1.1, length, 1, 8);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = (p.getY(i) + length / 2) / length;
      p.setZ(i, -t * t * droop * length); p.setY(i, t * length);
      p.setX(i, p.getX(i) * (0.4 + 0.6 * Math.sin(t * Math.PI)));
    }
    g.setAttribute('uv1', g.attributes.uv.clone());   // keep the frond's own UVs (skip box projection)
    g.rotateX(-Math.PI / 2 + tilt);            // tilt up, then fan around the crown (yaw last)
    g.rotateY(yaw);
    g.computeVertexNormals();
    b.add(g, leaf, [x, y, z]);
  };
  const tree = new Builder();
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.3, 3, 0), new THREE.Vector3(1.1, 6, 0), new THREE.Vector3(2.1, 8.6, 0)]);
  for (let i = 0; i < 12; i++) {
    const a = curve.getPoint(i / 12), bpt = curve.getPoint((i + 1) / 12);
    const dir = bpt.clone().sub(a), mid = a.clone().add(bpt).multiplyScalar(0.5);
    const r = 0.3 - i * 0.012;
    const cyl = new THREE.CylinderGeometry(r * 0.92, r, dir.length() * 1.04, 10, 1);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    const e = new THREE.Euler().setFromQuaternion(q);
    tree.add(cyl, bark, mid.toArray(), [e.x, e.y, e.z]);
  }
  const crown = curve.getPoint(1);
  for (let i = 0; i < 11; i++) frond(tree, crown.x, crown.y, crown.z, (i / 11) * Math.PI * 2 + Math.random() * 0.3, 0.35 + Math.random() * 0.3);
  for (let i = 0; i < 4; i++) tree.add(new THREE.SphereGeometry(0.17, 8, 6), M.flat(0x4a3a1c, { roughness: 0.6 }), [crown.x + Math.cos(i * 1.6) * 0.3, crown.y - 0.25, Math.sin(i * 1.6) * 0.3]);
  const bush = new Builder();
  for (let i = 0; i < 16; i++) frond(bush, 0, 0.05, 0, (i / 16) * Math.PI * 2 + Math.random() * 0.3, 0.35 + Math.random() * 0.25, 2.2 + Math.random() * 0.9, 1.05 + Math.random() * 0.35);
  const t = tree.build(), bsh = bush.build();
  return {
    palm_tree: { lods: [t, t.clone(), new THREE.Group()], lodDistances: [0, 90, 170], colliders: [col(-0.35, 0, -0.35, 0.35, 8, 0.35, [S])] },
    palm_bush: { lods: [bsh, bsh.clone(), new THREE.Group()], lodDistances: [0, 45, 90], colliders: [col(-1.6, 0, -1.6, 1.6, 1.8, 1.6, [TAG.HAYSTACK, TAG.HIDE])] },
  };
}

function awningTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  for (let x = 0; x < 128; x += 32) { g.fillStyle = '#e8dcc0'; g.fillRect(x, 0, 16, 128); g.fillStyle = '#9c2f28'; g.fillRect(x + 16, 0, 16, 128); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(0.5, 0.5);
  return t;
}

function marketStall(M) {
  const wood = M.pbr('wood'), cloth = new THREE.MeshStandardMaterial({ map: awningTexture(), roughness: 0.95, side: THREE.DoubleSide });
  const hi = new Builder();
  for (const [x, z] of [[-1.9, -1.4], [1.9, -1.4], [-1.9, 1.4], [1.9, 1.4]]) hi.box(wood, 0.14, 2.7, 0.14, x, 0, z);
  hi.add(new THREE.BoxGeometry(4.3, 0.06, 3.4), cloth, [0, 2.75, 0.1], [0.12, 0, 0]);
  hi.box(wood, 3.6, 0.95, 0.8, 0, 0, 1);
  for (let i = 0; i < 5; i++) hi.add(new THREE.SphereGeometry(0.16, 8, 6), M.flat([0xc5701f, 0xd4a21b, 0x7aa23a, 0xb8301f][i % 4]), [-1.3 + i * 0.65, 1.1, 1]);
  const g = hi.build();
  return { lods: [g, g.clone(), new THREE.Group()], lodDistances: [0, 50, 90],
    colliders: [col(-1.8, 0, 0.6, 1.8, 0.95, 1.4, [S, L]), col(-2.1, 2.62, -1.6, 2.1, 2.8, 1.8, [S, L])] };
}

function cargo(M) {
  const wood = M.pbr('wood'), dark = M.pbr('darkwood');
  const hi = new Builder();
  const crate = (x, y, z, s) => {
    hi.box(wood, s, s, s, x, y, z, undefined, x + z);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) hi.box(dark, 0.1, s + 0.02, 0.1, x + dx * s / 2, y - 0.01, z + dz * s / 2);
  };
  crate(0, 0, 0, 1.4); crate(1.5, 0, 0.1, 1.4); crate(0.75, 1.4, 0, 1.4);
  const g = hi.build();
  return { lods: [g, g.clone(), new THREE.Group()], lodDistances: [0, 55, 110],
    colliders: [col(-0.7, 0, -0.7, 2.2, 1.4, 0.8, [S, L]), col(0.05, 1.4, -0.7, 1.45, 2.8, 0.7, [S, L])] };
}

export function buildArchitectureKit(M) {
  const kit = {
    house_small: townhouse(M, { w: 10, d: 9, floors: 1, seed: 3 }),
    house_small_b: townhouse(M, { w: 11, d: 9.5, floors: 2, seed: 11 }),
    house_tall: townhouse(M, { w: 11, d: 11, floors: 2, seed: 7 }),
    house_tall_b: townhouse(M, { w: 12, d: 10, floors: 3, seed: 19 }),
    house_grand: townhouse(M, { w: 13, d: 12, floors: 3, seed: 29 }),
    house_warehouse: townhouse(M, { w: 13.5, d: 11, floors: 2, seed: 41 }),
    viewpoint_tower: bellTower(M),
    fort_wall: fortWall(M),
    dock: pier(M),
    haystack: hayCart(M),
    market_stall: marketStall(M),
    crates: cargo(M),
    ...palms(M),
  };
  for (const [name, def] of Object.entries(kit)) { def.name = name; def.batch = true; }
  return kit;
}

function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
