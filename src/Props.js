// ============================================================================
// Props.js — loads scanned CC0 glTF props (Poly Haven: Dutch sailing ships,
// cannon, barrels, lantern) and turns each into a world module. Ship
// colliders are derived from the actual mesh: the hull is sliced along its
// length into walkable/climbable deck boxes, masts are found from the rigging
// vertex density and tagged as climbable rigging with shroud nets beside them.
// ============================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TAG } from './Physics.js';

const S = TAG.SOLID, L = TAG.LEDGE, R = TAG.RIGGING;
const ROOT = 'assets/models/';
// Web-only hosts can't serve .bin buffers: `VITE_MODEL_EXT=.gltf.json` switches to self-contained glTF JSON.
const EXT = import.meta.env.VITE_MODEL_EXT || '.gltf';

const PROPS = {
  ship_medium: { file: 'dutch_ship_medium', lodDistances: [0, 400], ship: true },
  ship_large: { file: 'dutch_ship_large_01', lodDistances: [0, 400], ship: true },
  cannon: { file: 'cannon_01', lodDistances: [0, 60], box: true },
  barrels: { file: 'wooden_barrels_01', lodDistances: [0, 55], barrels: true },
  crate_small: { file: 'wooden_crate_01', lodDistances: [0, 35], box: true },
  lantern: { file: 'wooden_lantern_01', lodDistances: [0, 40] },
};

export async function loadPropKit(renderer) {
  const loader = new GLTFLoader();
  const kit = {};
  await Promise.all(Object.entries(PROPS).map(async ([name, cfg]) => {
    try {
      const gltf = await loader.loadAsync(`${ROOT}${cfg.file}/${cfg.file}${EXT}`);
      const scene = gltf.scene;
      scene.updateMatrixWorld(true);
      scene.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        const m = o.material;
        if (m.map) m.map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        if (/sail/i.test(m.name)) { m.side = THREE.DoubleSide; m.shadowSide = THREE.DoubleSide; }
        if (/glass/i.test(m.name)) { m.emissive = new THREE.Color(0xffa040); m.emissiveIntensity = 2.5; }
      });
      let colliders = [];
      if (cfg.ship) colliders = shipColliders(scene);
      else if (cfg.barrels) colliders = barrelColliders(scene);
      else if (cfg.box) { const b = new THREE.Box3().setFromObject(scene); colliders = [c(b.min, b.max, [S, L])]; }
      kit[name] = { name, lods: [cfg.ship ? scene : mergeByMaterial(scene), new THREE.Group()], lodDistances: cfg.lodDistances, colliders };
    } catch (e) {
      console.warn(`[Props] could not load ${cfg.file}`, e);
    }
  }));
  return kit;
}

const c = (min, max, tags) => ({ min: [min.x, min.y, min.z], max: [max.x, max.y, max.z], tags });

/** Collect every vertex of meshes whose material name matches, in model space. */
function vertices(root, re) {
  const out = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !re.test(o.material.name)) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); out.push(v.x, v.y, v.z); }
  });
  return out;
}

/**
 * Ships are modelled bow-to-stern along X. Slice the hull every 1.5 m: the
 * centre-line top gives deck height (forecastle / quarterdeck included), the
 * widest vertex under it gives the beam at that station.
 */
function shipColliders(root) {
  const cols = [];
  const hull = vertices(root, /hull/i);
  const box = new THREE.Box3().setFromArray(hull);
  const step = 1.5;
  for (let x0 = box.min.x; x0 < box.max.x; x0 += step) {
    let deck = -Infinity, beam = 0;
    for (let i = 0; i < hull.length; i += 3) {
      const x = hull[i], y = hull[i + 1], z = hull[i + 2];
      if (x < x0 || x >= x0 + step) continue;
      if (Math.abs(z) < 0.6 && y > deck) deck = y;
      if (Math.abs(z) > beam) beam = Math.abs(z);
    }
    if (deck === -Infinity || beam < 0.4) continue;
    cols.push(c(new THREE.Vector3(x0, box.min.y, -beam * 0.92), new THREE.Vector3(x0 + step, deck, beam * 0.92), [S, L]));
  }

  // Masts: dense vertical columns of rigging vertices high above the deck on the centre line.
  const rig = vertices(root, /rigging/i);
  const bins = new Map();
  const deckY = cols.length ? cols[Math.floor(cols.length / 2)].max[1] : 2;
  for (let i = 0; i < rig.length; i += 3) {
    if (Math.abs(rig[i + 2]) > 0.35 || rig[i + 1] < deckY + 6) continue;
    const k = Math.round(rig[i] / 0.5);
    const b = bins.get(k) || { n: 0, top: -Infinity };
    b.n++; b.top = Math.max(b.top, rig[i + 1]);
    bins.set(k, b);
  }
  const sorted = [...bins.entries()].sort((a, b) => b[1].n - a[1].n);
  const masts = [];
  for (const [k, b] of sorted) {
    if (b.n < 40) break;
    const x = k * 0.5;
    if (masts.some((m) => Math.abs(m.x - x) < 2.5)) continue;
    masts.push({ x, top: b.top });
  }
  const beamAt = (x) => { const s = cols.find((cc) => x >= cc.min[0] && x < cc.max[0]); return s ? s.max[2] : 2.5; };
  const deckAt = (x) => { const s = cols.find((cc) => x >= cc.min[0] && x < cc.max[0]); return s ? s.max[1] : deckY; };
  for (const m of masts) {
    const d = deckAt(m.x), bw = beamAt(m.x);
    cols.push(c(new THREE.Vector3(m.x - 0.4, d, -0.4), new THREE.Vector3(m.x + 0.4, m.top, 0.4), [S, R]));
    // shroud nets run from the rails up to ~60 % of the mast
    const netTop = d + (m.top - d) * 0.6;
    cols.push(c(new THREE.Vector3(m.x - 1.6, d, bw - 0.1), new THREE.Vector3(m.x + 1.6, netTop, bw + 0.5), [S, R]));
    cols.push(c(new THREE.Vector3(m.x - 1.6, d, -bw - 0.5), new THREE.Vector3(m.x + 1.6, netTop, -bw + 0.1), [S, R]));
  }
  return cols;
}

function barrelColliders(root) {
  const cols = [];
  root.traverse((o) => {
    if (!o.isMesh || !/barrel0/i.test(o.name)) return;
    const b = new THREE.Box3().setFromObject(o);
    cols.push(c(b.min, b.max, [S, L]));
  });
  return cols;
}

/** Collapse a prop's sub-meshes (barrel staves, cannon wheels…) into one mesh per material. */
function mergeByMaterial(root) {
  const byMat = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (!byMat.has(o.material)) byMat.set(o.material, []);
    byMat.get(o.material).push(g);
  });
  const out = new THREE.Group();
  for (const [mat, geos] of byMat) {
    const merged = geos.length > 1 ? mergeGeometries(geos) : geos[0];
    if (!merged) return root;                       // attribute mismatch → keep the original hierarchy
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    out.add(mesh);
  }
  return out;
}
