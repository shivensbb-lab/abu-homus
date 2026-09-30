// ============================================================================
// Assets.js — material library (SpriteCook textures w/ procedural fallback)
// and the procedural module kit that mirrors the Blender asset collections.
// Every module = { name, lods: [hi, mid, low], lodDistances, colliders }.
// Colliders are local-space AABBs (Y-up, metres) with gameplay tags.
// ============================================================================
import * as THREE from 'three';
import { TAG } from './Physics.js';

const S = TAG.SOLID, L = TAG.LEDGE, R = TAG.RIGGING;

// ------------------------------------------------------------------ textures
/** Procedural painters: used until a SpriteCook texture is found on disk. */
const PAINTERS = {
  stone: (g, n) => bricks(g, n, '#8d8778', '#6f6a5d', 64, 32, 0.25),
  plaster: (g, n) => { fillNoise(g, n, '#d9ccb0', 22); stains(g, n, 'rgba(120,95,60,0.10)', 25); },
  terracotta: (g, n) => {
    fillNoise(g, n, '#a4532f', 20);
    for (let y = 0; y < n; y += 24) for (let x = (y / 24) % 2 ? 16 : 0; x < n; x += 32) {
      g.fillStyle = `rgba(60,20,10,${0.25 + Math.random() * 0.2})`; g.fillRect(x, y + 20, 32, 4);
      g.fillStyle = 'rgba(255,190,140,0.12)'; g.fillRect(x + 4, y + 2, 10, 16);
    }
  },
  wood: (g, n) => {
    fillNoise(g, n, '#6b4a2e', 18);
    for (let y = 0; y < n; y += 32) {
      g.fillStyle = 'rgba(25,15,5,0.55)'; g.fillRect(0, y, n, 2);
      for (let i = 0; i < 30; i++) { g.fillStyle = 'rgba(40,25,10,0.18)'; g.fillRect(Math.random() * n, y + Math.random() * 30, 40 + Math.random() * 80, 1); }
    }
  },
  sand: (g, n) => { fillNoise(g, n, '#cdb98e', 30); stains(g, n, 'rgba(110,90,55,0.08)', 40); },
  cobble: (g, n) => bricks(g, n, '#7a7263', '#57514a', 28, 22, 0.45),
  sail: (g, n) => { fillNoise(g, n, '#e6dcc3', 10); for (let x = 0; x < n; x += 42) { g.fillStyle = 'rgba(90,70,40,0.18)'; g.fillRect(x, 0, 2, n); } },
  hay: (g, n) => { fillNoise(g, n, '#c9a646', 25); for (let i = 0; i < 900; i++) { g.strokeStyle = `rgba(${90 + Math.random() * 80},${70 + Math.random() * 50},20,0.5)`; g.beginPath(); const x = Math.random() * n, y = Math.random() * n; g.moveTo(x, y); g.lineTo(x + (Math.random() - 0.5) * 30, y + (Math.random() - 0.5) * 30); g.stroke(); } },
  leaf: (g, n) => { fillNoise(g, n, '#3f6b2a', 35); stains(g, n, 'rgba(20,50,10,0.25)', 60); },
  rope: (g, n) => { g.fillStyle = 'rgba(0,0,0,0)'; g.clearRect(0, 0, n, n); g.strokeStyle = '#6e5a3a'; g.lineWidth = 5; for (let i = 0; i <= n; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, n); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(n, i); g.stroke(); } },
  redcoat: (g, n) => { fillNoise(g, n, '#9b1c1c', 12); },
};

function fillNoise(g, n, base, amp) {
  g.fillStyle = base; g.fillRect(0, 0, n, n);
  const img = g.getImageData(0, 0, n, n), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const r = (Math.random() - 0.5) * amp; d[i] += r; d[i + 1] += r; d[i + 2] += r; }
  g.putImageData(img, 0, 0);
}
function stains(g, n, color, count) {
  g.fillStyle = color;
  for (let i = 0; i < count; i++) { g.beginPath(); g.arc(Math.random() * n, Math.random() * n, 6 + Math.random() * 40, 0, Math.PI * 2); g.fill(); }
}
function bricks(g, n, base, mortar, bw, bh, jitter) {
  g.fillStyle = mortar; g.fillRect(0, 0, n, n);
  for (let y = 0; y < n; y += bh) for (let x = ((y / bh) % 2) * (bw / 2) - bw; x < n; x += bw) {
    const c = new THREE.Color(base).offsetHSL(0, 0, (Math.random() - 0.5) * jitter * 0.4);
    g.fillStyle = `#${c.getHexString()}`; g.fillRect(x + 2, y + 2, bw - 4, bh - 4);
  }
  const img = g.getImageData(0, 0, n, n), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const r = (Math.random() - 0.5) * 18; d[i] += r; d[i + 1] += r; d[i + 2] += r; }
  g.putImageData(img, 0, 0);
}

export class MaterialLibrary {
  constructor(renderer, textureRoot = 'assets/textures/') {
    this.root = textureRoot;
    this.anisotropy = renderer.capabilities.getMaxAnisotropy();
    this.loader = new THREE.TextureLoader();
    this.cache = new Map();
  }

  /** Shared material; hot-swaps in `assets/textures/<name>.png` (SpriteCook) when present. */
  get(name, { repeat = 1, roughness = 0.85, metalness = 0, transparent = false, side = THREE.FrontSide } = {}) {
    const key = `${name}|${repeat}|${side}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const tex = this._procedural(name, repeat);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness, metalness, transparent, side, alphaTest: transparent ? 0.4 : 0 });
    this.cache.set(key, mat);
    this.loader.load(`${this.root}${name}.png`, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
      t.anisotropy = this.anisotropy;
      mat.map = t; mat.needsUpdate = true;
    }, undefined, () => { /* no SpriteCook texture yet — keep procedural */ });
    return mat;
  }

  _procedural(name, repeat) {
    const n = 256, canvas = document.createElement('canvas');
    canvas.width = canvas.height = n;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    (PAINTERS[name] || PAINTERS.plaster)(g, n);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = this.anisotropy;
    return t;
  }
}

// ------------------------------------------------------------ mesh helpers
function mesh(geo, mat, x = 0, y = 0, z = 0, shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow; m.receiveShadow = true;
  return m;
}
/** Box whose base sits at y. */
function box(w, h, d, mat, x = 0, y = 0, z = 0, shadow = true) {
  return mesh(new THREE.BoxGeometry(w, h, d), mat, x, y + h / 2, z, shadow);
}
function group(...children) { const g = new THREE.Group(); children.forEach((c) => g.add(c)); return g; }
function col(minX, minY, minZ, maxX, maxY, maxZ, tags) { return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], tags }; }

// --------------------------------------------------------------- module kit
export function buildModuleKit(M) {
  const stone = M.get('stone', { repeat: 2 }), plaster = M.get('plaster', { repeat: 2 });
  const terracotta = M.get('terracotta', { repeat: 3 }), wood = M.get('wood', { repeat: 2 });
  const hay = M.get('hay'), leaf = M.get('leaf', { side: THREE.DoubleSide });
  const sail = M.get('sail', { side: THREE.DoubleSide, roughness: 0.95 });
  const rope = M.get('rope', { repeat: 4, transparent: true, side: THREE.DoubleSide });
  const flat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 });
  const kit = {};

  // Townhouse with terracotta hip roof — whole facade is climbable (AC-style).
  const house = (w, d, h, tint) => {
    const walls = tint ? plaster.clone() : plaster;
    if (tint) walls.color = new THREE.Color(tint);
    const roof = mesh(new THREE.ConeGeometry(Math.hypot(w, d) / 2 + 0.4, 2.6, 4, 1), terracotta, 0, h + 1.3, 0);
    roof.rotation.y = Math.PI / 4; roof.scale.set(1, 1, d / w);
    const hi = group(box(w, h, d, walls), roof.clone(),
      box(w + 0.3, 0.3, d + 0.3, wood, 0, h / 2), box(w + 0.5, 0.25, d + 0.5, wood, 0, h - 0.25), // ledge beams
      box(1.4, 2.4, 0.2, wood, 0, 0, d / 2 + 0.05));
    for (const sx of [-w / 4, w / 4]) hi.add(box(1.2, 1.4, 0.35, wood, sx, h / 2 + 0.6, d / 2 + 0.1)); // shutters
    const mid = group(box(w, h, d, walls), roof.clone());
    const low = group(box(w, h + 1.2, d, flat(0xb8a584), 0, 0, 0, false));
    return {
      lods: [hi, mid, low], lodDistances: [0, 45, 110],
      colliders: [col(-w / 2, 0, -d / 2, w / 2, h, d / 2, [S, L]), col(-w / 2 + 0.6, h, -d / 2 + 0.6, w / 2 - 0.6, h + 0.9, d / 2 - 0.6, [S, L])],
    };
  };
  kit.house_small = house(7, 7, 5.5);
  kit.house_tall = house(8, 9, 9, 0xe8d8bc);
  kit.house_warehouse = house(14, 10, 7, 0xc9b28c);

  // Viewpoint tower — synchronisation beam jutting out at the top.
  {
    const h = 24, w = 5;
    const hi = group(box(w, h, w, stone), box(w + 0.6, 0.5, w + 0.6, stone, 0, h), box(0.5, 0.4, 4, wood, 0, h + 0.5, w / 2 + 1.6));
    for (let y = 3; y < h; y += 3) hi.add(box(w + 0.35, 0.25, w + 0.35, stone, 0, y)); // climbing ledges
    for (const [x, z] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) hi.add(box(0.7, 1, 0.7, stone, x, h + 0.5, z));
    const mid = group(box(w, h, w, stone), box(0.5, 0.4, 4, wood, 0, h + 0.5, w / 2 + 1.6));
    const low = group(box(w, h + 1, w, flat(0x7c7668), 0, 0, 0, false));
    kit.viewpoint_tower = {
      lods: [hi, mid, low], lodDistances: [0, 60, 160],
      colliders: [col(-w / 2 - 0.3, 0, -w / 2 - 0.3, w / 2 + 0.3, h + 0.5, w / 2 + 0.3, [S, L]),
        col(-0.3, h + 0.5, w / 2 + 0.2, 0.3, h + 0.9, w / 2 + 3.6, [S, TAG.SYNC])],
    };
  }

  // Fortress curtain wall with crenellations.
  {
    const len = 16, h = 8, t = 3;
    const hi = group(box(len, h, t, stone), box(len, 0.4, t + 0.4, stone, 0, h - 0.4));
    for (let x = -len / 2 + 1; x < len / 2; x += 2) hi.add(box(1, 1.2, 0.6, stone, x, h, t / 2 - 0.3));
    const mid = group(box(len, h + 0.6, t, stone));
    const low = group(box(len, h + 0.6, t, flat(0x7c7668), 0, 0, 0, false));
    kit.fort_wall = { lods: [hi, mid, low], lodDistances: [0, 60, 160], colliders: [col(-len / 2, 0, -t / 2, len / 2, h, t / 2, [S, L])] };
  }

  // Wooden pier section (sits over water).
  {
    const w = 12, d = 6, top = 1.0;
    const hi = group(box(w, 0.3, d, wood, 0, top - 0.3));
    for (let x = -w / 2 + 0.5; x < w / 2; x += 2.75) for (const z of [-d / 2 + 0.3, d / 2 - 0.3]) hi.add(box(0.35, top + 2.5, 0.35, wood, x, -2.5, z));
    const mid = group(box(w, 0.3, d, wood, 0, top - 0.3));
    const low = group(box(w, 0.3, d, flat(0x5a4029), 0, top - 0.3, 0, false));
    kit.dock = { lods: [hi, mid, low], lodDistances: [0, 50, 120], colliders: [col(-w / 2, -3, -d / 2, w / 2, top, d / 2, [S, L])] };
  }

  // Brig / frigate with climbable masts and shroud rigging.
  {
    const len = 26, beam = 7, deck = 3.4;
    const hull = box(beam, deck + 1.5, len, wood, 0, -1.5, 0);
    const bow = mesh(new THREE.ConeGeometry(beam / 2, 6, 4), wood, 0, deck / 2 - 0.5, len / 2 + 3);
    bow.rotation.set(Math.PI / 2, Math.PI / 4, 0); bow.scale.set(1, 1, 0.65);
    const hi = group(hull, bow, box(beam, 1.5, 6, wood, 0, deck, -len / 2 + 3));
    const mid = group(hull.clone(), bow.clone());
    const cols = [col(-beam / 2, -1.5, -len / 2, beam / 2, deck, len / 2, [S, L]),
      col(-beam / 2, deck, -len / 2, beam / 2, deck + 1.5, -len / 2 + 6, [S, L])];
    for (const [z, mh] of [[-4, 22], [6, 19]]) {
      const mast = mesh(new THREE.CylinderGeometry(0.28, 0.4, mh, 8), wood, 0, deck + mh / 2, z);
      const yard1 = mesh(new THREE.CylinderGeometry(0.15, 0.15, 12, 6), wood, 0, deck + mh * 0.55, z); yard1.rotation.z = Math.PI / 2;
      const yard2 = yard1.clone(); yard2.position.y = deck + mh * 0.85; yard2.scale.set(1, 0.75, 1);
      const sail1 = mesh(new THREE.PlaneGeometry(11, mh * 0.28, 8, 4), sail, 0, deck + mh * 0.41, z + 0.4, true);
      bendSail(sail1.geometry, 0.9);
      const sail2 = mesh(new THREE.PlaneGeometry(8.5, mh * 0.26, 8, 4), sail, 0, deck + mh * 0.72, z + 0.4, true);
      bendSail(sail2.geometry, 0.7);
      const nest = box(2.2, 0.25, 2.2, wood, 0, deck + mh * 0.9, z);
      const shroudL = mesh(new THREE.PlaneGeometry(3.6, mh * 0.8), rope, -beam / 2 - 0.2, deck + mh * 0.4, z, false);
      shroudL.rotation.set(0, Math.PI / 2, -0.12);
      const shroudR = shroudL.clone(); shroudR.position.x = beam / 2 + 0.2; shroudR.rotation.z = 0.12;
      hi.add(mast, yard1, yard2, sail1, sail2, nest, shroudL, shroudR);
      mid.add(mast.clone(), sail1.clone(), sail2.clone());
      cols.push(col(-0.45, deck, z - 0.45, 0.45, deck + mh, z + 0.45, [S, R]),
        col(-1.1, deck + mh * 0.9, z - 1.1, 1.1, deck + mh * 0.9 + 0.25, z + 1.1, [S, L]),
        col(-beam / 2 - 0.5, deck, z - 1.8, -beam / 2 + 0.1, deck + mh * 0.75, z + 1.8, [S, R]),
        col(beam / 2 - 0.1, deck, z - 1.8, beam / 2 + 0.5, deck + mh * 0.75, z + 1.8, [S, R]));
    }
    const low = group(box(beam, deck + 1.5, len, flat(0x4a3322), 0, -1.5, 0, false), box(0.8, 20, 0.8, flat(0x4a3322), 0, deck, 0, false));
    kit.ship_brig = { lods: [hi, mid, low], lodDistances: [0, 70, 180], colliders: cols };
  }

  // Leap-of-Faith landing zones.
  {
    const cart = group(box(2.6, 0.5, 2.6, wood, 0, 0.3), mesh(new THREE.SphereGeometry(1.45, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), hay, 0, 0.8, 0));
    kit.haystack = { lods: [cart, cart.clone(), group(box(2.6, 1.8, 2.6, flat(0xc9a646), 0, 0, 0, false))], lodDistances: [0, 40, 100],
      colliders: [col(-1.3, 0, -1.3, 1.3, 2.1, 1.3, [TAG.HAYSTACK, TAG.HIDE])] };
    const bush = new THREE.Group();
    for (let i = 0; i < 9; i++) {
      const frond = mesh(new THREE.PlaneGeometry(0.9, 2.6, 1, 3), leaf, 0, 0.9, 0);
      frond.rotation.set(-0.7 + Math.random() * 0.3, (i / 9) * Math.PI * 2, 0);
      frond.position.set(Math.sin((i / 9) * Math.PI * 2) * 0.5, 0.9, Math.cos((i / 9) * Math.PI * 2) * 0.5);
      bush.add(frond);
    }
    bush.add(mesh(new THREE.SphereGeometry(1.1, 10, 6), leaf, 0, 0.6, 0));
    kit.palm_bush = { lods: [bush, group(mesh(new THREE.SphereGeometry(1.4, 8, 5), leaf, 0, 0.7, 0)), group()], lodDistances: [0, 35, 80],
      colliders: [col(-1.5, 0, -1.5, 1.5, 1.9, 1.5, [TAG.HAYSTACK, TAG.HIDE])] };
  }

  // Palm tree, cargo crates, market stall.
  {
    const trunk = mesh(new THREE.CylinderGeometry(0.18, 0.3, 9, 7), wood, 0, 4.5, 0);
    trunk.rotation.z = 0.08;
    const crown = new THREE.Group();
    for (let i = 0; i < 8; i++) {
      const f = mesh(new THREE.PlaneGeometry(1.1, 4.5, 1, 4), leaf, 0, 9, 0);
      f.rotation.set(-1.1, (i / 8) * Math.PI * 2, 0);
      f.position.set(Math.sin((i / 8) * Math.PI * 2) * 1.8, 8.6, Math.cos((i / 8) * Math.PI * 2) * 1.8);
      crown.add(f);
    }
    kit.palm_tree = { lods: [group(trunk, crown), group(trunk.clone(), mesh(new THREE.SphereGeometry(2, 6, 4), leaf, 0.7, 9, 0)), group()], lodDistances: [0, 50, 140],
      colliders: [col(-0.3, 0, -0.3, 0.3, 9, 0.3, [S])] };
    const crates = group(box(1.5, 1.5, 1.5, wood, 0, 0, 0), box(1.5, 1.5, 1.5, wood, 1.6, 0, 0.1), box(1.5, 1.5, 1.5, wood, 0.8, 1.5, 0));
    kit.crates = { lods: [crates, group(box(3.1, 3, 1.6, wood, 0.8)), group()], lodDistances: [0, 40, 90],
      colliders: [col(-0.75, 0, -0.75, 2.35, 1.5, 0.85, [S, L]), col(0.05, 1.5, -0.75, 1.55, 3, 0.75, [S, L])] };
    const awning = box(4, 0.12, 3, sail, 0, 2.6, 0);
    const stall = group(awning, box(3.6, 1, 0.8, wood, 0, 0, 1), ...[[-1.9, -1.4], [1.9, -1.4], [-1.9, 1.4], [1.9, 1.4]].map(([x, z]) => box(0.15, 2.6, 0.15, wood, x, 0, z)));
    kit.market_stall = { lods: [stall, group(awning.clone(), box(3.6, 1, 0.8, wood, 0, 0, 1)), group()], lodDistances: [0, 40, 90],
      colliders: [col(-1.8, 0, 0.6, 1.8, 1, 1.4, [S, L]), col(-2, 2.6, -1.5, 2, 2.72, 1.5, [S, L])] };
  }

  for (const [name, def] of Object.entries(kit)) def.name = name;
  return kit;
}

function bendSail(geo, depth) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, Math.cos((p.getX(i) / 6) * Math.PI * 0.5) * depth);
  geo.computeVertexNormals();
}
