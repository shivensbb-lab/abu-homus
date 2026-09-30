// ============================================================================
// World.js — seamless port world: sky/ocean/lighting, a deterministic port
// layout, chunk streaming around the player, chunk-level frustum culling and
// THREE.LOD swapping of every modular asset (procedural or Blender-imported).
// ============================================================================
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { TAG } from './Physics.js';

export const CHUNK_SIZE = 48;
const LOAD_RADIUS = 2;         // chunks around the player kept resident (5x5)
const UNLOAD_RADIUS = 3;       // hysteresis so chunks don't thrash on borders
const CHUNKS_PER_FRAME = 2;    // streaming budget → no frame spikes
export const COAST_Z = 40;     // land for z < COAST_Z, sea beyond
export const WATER_Y = -0.6;

export class World {
  constructor({ scene, physics, renderer, materials }) {
    this.scene = scene;
    this.physics = physics;
    this.renderer = renderer;
    this.materials = materials;
    this.modules = {};              // name -> { lods, lodDistances, colliders }
    this.chunkPlacements = new Map(); // "cx,cz" -> placement[]
    this.loaded = new Map();        // "cx,cz" -> { group, box, visible }
    this.queue = [];
    this.patrols = [];
    this.syncPoints = [];
    this.spawn = new THREE.Vector3(0, 0.1, 20);
    this.frustum = new THREE.Frustum();
    this._pv = new THREE.Matrix4();
    this.stats = { loaded: 0, visible: 0, placements: 0 };
    this._buildEnvironment();
  }

  registerModules(kit) { Object.assign(this.modules, kit); }

  // ------------------------------------------------------------ environment
  _buildEnvironment() {
    const { scene, renderer } = this;
    scene.fog = new THREE.FogExp2(0xbfd4e0, 0.0032);

    this.sky = new Sky();
    this.sky.scale.setScalar(4000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 6; u.rayleigh.value = 1.6; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.82;
    this.sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(62), THREE.MathUtils.degToRad(215));
    u.sunPosition.value.copy(this.sunDir);
    scene.add(this.sky);

    // Image-based lighting baked from the sky so PBR materials pick up the tropical ambience.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const skyScene = new THREE.Scene();
    skyScene.add(this.sky.clone());
    scene.environment = pmrem.fromScene(skyScene, 0.02).texture;
    scene.environmentIntensity = 0.55;
    pmrem.dispose();

    this.sun = new THREE.DirectionalLight(0xfff1d6, 3.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.near = 1; sc.far = 260;
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun, this.sun.target);
    scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x6a5238, 0.4));

    // Ocean — planar-reflection water with a procedurally generated tileable normal map.
    this.water = new Water(new THREE.PlaneGeometry(3000, 3000), {
      textureWidth: 512, textureHeight: 512,
      waterNormals: makeWaterNormals(),
      sunDirection: this.sunDir.clone(), sunColor: 0xfff4dd, waterColor: 0x0b4a5c,
      distortionScale: 2.6, fog: true,
    });
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = WATER_Y;
    scene.add(this.water);

    // Island ground: cobbled town + sand beach strip.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(480, 280), this.materials.get('cobble', { repeat: 70 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(0, 0, COAST_Z - 140);
    ground.receiveShadow = true;
    const beach = new THREE.Mesh(new THREE.BoxGeometry(480, 1.4, 14), this.materials.get('sand', { repeat: 20 }));
    beach.position.set(0, -0.7, COAST_Z - 3); beach.receiveShadow = true;
    scene.add(ground, beach);
    this.physics.add({ min: { x: -240, y: -8, z: -240 }, max: { x: 240, y: 0, z: COAST_Z }, tags: [TAG.SOLID], name: 'island' });
    this.physics.add({ min: { x: -240, y: -8, z: COAST_Z }, max: { x: 240, y: WATER_Y, z: 1500 }, tags: [TAG.WATER], name: 'sea' });
  }

  // ----------------------------------------------------------------- layout
  /** placements: [{ module, x, y, z, rotY }] in world space (from Blender or procedural). */
  setLayout({ placements, patrols = [], spawn = null }) {
    this.chunkPlacements.clear();
    for (const p of placements) {
      if (!this.modules[p.module]) { console.warn(`[World] unknown module "${p.module}"`); continue; }
      const key = chunkKey(p.x, p.z);
      if (!this.chunkPlacements.has(key)) this.chunkPlacements.set(key, []);
      this.chunkPlacements.get(key).push(p);
      if (p.module === 'viewpoint_tower') {
        this.syncPoints.push(new THREE.Vector3(0, 25, 4).applyAxisAngle(UP, p.rotY || 0).add(new THREE.Vector3(p.x, p.y || 0, p.z)));
      }
    }
    this.patrols = patrols;
    if (spawn) this.spawn.copy(spawn);
    this.stats.placements = placements.length;
  }

  /** Deterministic procedural port used when no Blender manifest is present. */
  generateProceduralPort(seed = 1715) {
    const rnd = mulberry32(seed);
    const P = [];
    const occupied = new Set();
    const cell = (x, z) => `${Math.round(x / 20)},${Math.round(z / 20)}`;
    const put = (module, x, z, rotY = 0, y = 0) => { P.push({ module, x, y, z, rotY }); occupied.add(cell(x, z)); };

    // Viewpoints with their Leap-of-Faith haystacks (+Z local = beam direction).
    for (const [x, z, r] of [[0, -60, 0], [-120, -20, Math.PI / 2], [110, -110, -Math.PI / 2], [60, 0, 0]]) {
      put('viewpoint_tower', x, z, r);
      const hz = new THREE.Vector3(0, 0, 11).applyAxisAngle(UP, r);
      P.push({ module: 'haystack', x: x + hz.x, y: 0, z: z + hz.z, rotY: 0 });
      occupied.add(cell(x + hz.x, z + hz.z));
    }
    // Town blocks on a 20 m grid with streets every third row/column.
    for (let gx = -8; gx <= 8; gx++) for (let gz = -9; gz <= 1; gz++) {
      const x = gx * 20, z = gz * 20;
      if (occupied.has(cell(x, z)) || gx % 3 === 0 || gz % 4 === 0) continue;
      const r = rnd(), rot = Math.floor(rnd() * 4) * (Math.PI / 2);
      if (gz === 1 && r < 0.5) put('house_warehouse', x, z, 0);
      else if (r < 0.42) put('house_small', x, z, rot);
      else if (r < 0.7) put('house_tall', x, z, rot);
      else if (r < 0.8) { put('market_stall', x, z, rot); P.push({ module: 'haystack', x: x + 5, y: 0, z: z + 4, rotY: 0 }); }
      else if (r < 0.9) { put('palm_tree', x, z); P.push({ module: 'palm_bush', x: x + 4, y: 0, z: z + 3, rotY: 0 }); }
      else put('crates', x, z, rot);
    }
    // Street dressing: palms + bushes along the avenues (hiding spots).
    for (let x = -150; x <= 150; x += 30) { P.push({ module: 'palm_tree', x: x + 3, y: 0, z: 24, rotY: 0 }); if (rnd() < 0.5) P.push({ module: 'palm_bush', x: x - 4, y: 0, z: 26, rotY: 0 }); }
    // Fortress curtain wall to the north.
    for (let x = -168; x <= 168; x += 16) put('fort_wall', x, -196, 0);
    for (let z = -180; z <= -120; z += 16) { put('fort_wall', -176, z, Math.PI / 2); put('fort_wall', 176, z, Math.PI / 2); }
    // Waterfront boardwalk, piers and moored ships.
    for (let x = -150; x <= 150; x += 12) put('dock', x, COAST_Z + 3, 0);
    for (let x = -150; x <= 150; x += 24) if (rnd() < 0.5) P.push({ module: 'crates', x: x + 2, y: 1, z: COAST_Z + 2, rotY: 0 });
    for (const px of [-100, -40, 20, 80]) {
      for (let i = 0; i < 5; i++) P.push({ module: 'dock', x: px, y: 0, z: COAST_Z + 12 + i * 12, rotY: Math.PI / 2 });
      P.push({ module: 'ship_brig', x: px + 9, y: 0, z: COAST_Z + 38, rotY: 0 });
    }

    // Redcoat / Royal Navy patrol routes along streets and the waterfront.
    const patrols = [];
    for (const z of [-80, -160, 0]) patrols.push([[-100, z], [-20, z], [-20, z + 20], [-100, z + 20]]);
    for (const z of [-80, 0]) patrols.push([[20, z], [120, z], [120, z - 20]]);
    patrols.push([[-60, COAST_Z + 3], [60, COAST_Z + 3]], [[-140, 20], [-60, 20]], [[60, 20], [140, 20]]);
    for (const px of [-40, 80]) patrols.push([[px, COAST_Z + 12], [px, COAST_Z + 58]]);
    patrols.push([[-40, -120], [40, -120], [40, -40], [-40, -40]], [[-160, -180], [160, -180]]);

    this.setLayout({ placements: P, patrols: patrols.map((r) => r.map(([x, z]) => new THREE.Vector3(x, z > COAST_Z ? 1.05 : 0, z))), spawn: new THREE.Vector3(-10, 0.1, 30) });
  }

  // ------------------------------------------------------------- streaming
  update(dt, playerPos, camera, time) {
    const pcx = Math.floor(playerPos.x / CHUNK_SIZE), pcz = Math.floor(playerPos.z / CHUNK_SIZE);

    // enqueue missing chunks nearest-first
    const wanted = [];
    for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
      const key = `${pcx + dx},${pcz + dz}`;
      if (!this.loaded.has(key) && this.chunkPlacements.has(key)) wanted.push([dx * dx + dz * dz, key]);
    }
    wanted.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < Math.min(CHUNKS_PER_FRAME, wanted.length); i++) this._loadChunk(wanted[i][1]);

    for (const key of [...this.loaded.keys()]) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz)) > UNLOAD_RADIUS) this._unloadChunk(key);
    }

    // Strict chunk-level frustum culling (object-level culling still runs inside visible chunks).
    this._pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._pv);
    let visible = 0;
    for (const chunk of this.loaded.values()) {
      chunk.group.visible = this.frustum.intersectsBox(chunk.box);
      if (chunk.group.visible) visible++;
    }
    this.stats.loaded = this.loaded.size;
    this.stats.visible = visible;

    // Shadow frustum + ocean follow the player
    this.sun.position.copy(playerPos).addScaledVector(this.sunDir, 120);
    this.sun.target.position.copy(playerPos);
    this.water.material.uniforms.time.value = time * 0.6;
  }

  _loadChunk(key) {
    const group = new THREE.Group();
    group.name = `chunk_${key}`;
    for (const p of this.chunkPlacements.get(key)) {
      const def = this.modules[p.module];
      const lod = new THREE.LOD();
      def.lods.forEach((proto, i) => lod.addLevel(proto.clone(), def.lodDistances[i] ?? i * 50));
      lod.position.set(p.x, p.y || 0, p.z);
      lod.rotation.y = p.rotY || 0;
      if (p.scale) lod.scale.setScalar(p.scale);
      group.add(lod);
      this._addColliders(def, p, key);
    }
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3());
    box.expandByScalar(2);
    this.scene.add(group);
    this.loaded.set(key, { group, box });
  }

  _addColliders(def, p, key) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y || 0, p.z),
      new THREE.Quaternion().setFromAxisAngle(UP, p.rotY || 0), new THREE.Vector3().setScalar(p.scale || 1));
    for (const c of def.colliders) {
      const b = new THREE.Box3(new THREE.Vector3(...c.min), new THREE.Vector3(...c.max)).applyMatrix4(m);
      this.physics.add({ min: b.min, max: b.max, tags: c.tags, group: key, name: `${p.module}` });
    }
  }

  _unloadChunk(key) {
    const chunk = this.loaded.get(key);
    this.scene.remove(chunk.group);   // geometry/materials are shared prototypes → no dispose
    this.physics.removeGroup(key);
    this.loaded.delete(key);
  }

  /** Force-load the chunks around a point (spawn / respawn) so physics exists immediately. */
  preload(pos) {
    const cx = Math.floor(pos.x / CHUNK_SIZE), cz = Math.floor(pos.z / CHUNK_SIZE);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const key = `${cx + dx},${cz + dz}`;
      if (!this.loaded.has(key) && this.chunkPlacements.has(key)) this._loadChunk(key);
    }
  }
}

const UP = new THREE.Vector3(0, 1, 0);
export function chunkKey(x, z) { return `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`; }

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Tileable ocean normal map from a sum of integer-frequency sine waves. */
function makeWaterNormals(n = 256) {
  const waves = Array.from({ length: 10 }, () => ({ fx: Math.floor(Math.random() * 7) - 3, fz: Math.floor(Math.random() * 7) - 3, a: Math.random() * 0.6 + 0.2, p: Math.random() * 6.28 }))
    .filter((w) => w.fx || w.fz);
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let dx = 0, dz = 0;
    for (const w of waves) {
      const ph = ((w.fx * x + w.fz * y) / n) * Math.PI * 2 + w.p;
      const c = Math.cos(ph) * w.a;
      dx += c * w.fx; dz += c * w.fz;
    }
    const v = new THREE.Vector3(-dx * 0.08, 1, -dz * 0.08).normalize();
    const i = (y * n + x) * 4;
    data[i] = (v.x * 0.5 + 0.5) * 255; data[i + 1] = (v.z * 0.5 + 0.5) * 255; data[i + 2] = v.y * 255; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, n, n);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}
