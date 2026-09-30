// ============================================================================
// World.js — seamless port world: sky/ocean/lighting, a deterministic port
// layout, chunk streaming around the player, chunk-level frustum culling and
// THREE.LOD swapping of every modular asset (procedural or Blender-imported).
// ============================================================================
import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { TAG } from './Physics.js';
import { boxUV } from './Materials.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const CHUNK_SIZE = 48;
const LOAD_RADIUS = 2;         // chunks around the player kept resident (5x5)
const UNLOAD_RADIUS = 3;       // hysteresis so chunks don't thrash on borders
const CHUNKS_PER_FRAME = 1;    // streaming budget → no frame spikes
const HLOD_NEAR = 75;          // metres from camera to chunk bounds for full-detail batches
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
  }

  registerModules(kit) { Object.assign(this.modules, kit); }

  // ------------------------------------------------------------ environment
  /** Sun, IBL-matched fog, ocean and island ground. The HDR sky is loaded by Game (Materials.loadSky). */
  buildEnvironment(sunDir) {
    const { scene } = this;
    this.sunDir = sunDir.clone();
    scene.fog = new THREE.FogExp2(0xbfcfd6, 0.0019);

    this.sun = new THREE.DirectionalLight(0xfff0d8, 3.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera;
    sc.left = -55; sc.right = 55; sc.top = 55; sc.bottom = -55; sc.near = 1; sc.far = 300;
    this.sun.shadow.bias = -0.0003; this.sun.shadow.normalBias = 0.035;
    scene.add(this.sun, this.sun.target);

    // Ocean — planar-reflection water (reflects the HDR sky and the ships) with tileable procedural normals.
    this.water = new Water(new THREE.PlaneGeometry(3000, 3000), {
      textureWidth: 512, textureHeight: 512,
      waterNormals: makeWaterNormals(),
      sunDirection: this.sunDir.clone(), sunColor: 0xfff4dd, waterColor: 0x0f6b73,
      distortionScale: 4.2, fog: true, alpha: 1,
    });
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = WATER_Y;
    this.water.material.uniforms.size.value = 0.9;
    scene.add(this.water);

    // Island ground: scanned cobblestones in town, damp sand on the shoreline.
    const groundGeo = boxUV(new THREE.PlaneGeometry(480, 280, 1, 1));
    const ground = new THREE.Mesh(groundGeo, this.materials.pbr('cobble'));
    ground.rotation.x = -Math.PI / 2; ground.position.set(0, 0, COAST_Z - 140);
    ground.receiveShadow = true;
    const beach = new THREE.Mesh(boxUV(new THREE.BoxGeometry(480, 1.4, 14)), this.materials.pbr('sand'));
    beach.position.set(0, -0.69, COAST_Z - 3); beach.receiveShadow = true;
    scene.add(ground, beach, makeHills());
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
        this.syncPoints.push(new THREE.Vector3(0, 25, 4.5).applyAxisAngle(UP, p.rotY || 0).add(new THREE.Vector3(p.x, p.y || 0, p.z)));
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
    const G = 15;                                   // town grid (m); every 4th row/column is a street
    const occupied = new Set();
    const cell = (x, z) => `${Math.round(x / G)},${Math.round(z / G)}`;
    const put = (module, x, z, rotY = 0, y = 0, claim = true) => { if (this.modules[module]) P.push({ module, x, y, z, rotY }); if (claim) occupied.add(cell(x, z)); };

    // Bell-tower viewpoints with their Leap-of-Faith hay carts (+Z local = beam direction).
    for (const [x, z, r] of [[15, -45, 0], [-105, -30, Math.PI / 2], [105, -105, -Math.PI / 2], [45, -150, 0], [-75, -135, Math.PI]]) {
      put('viewpoint_tower', x, z, r);
      const hz = new THREE.Vector3(0, 0, 11.5).applyAxisAngle(UP, r);
      put('haystack', x + hz.x, z + hz.z, r);
    }
    // Dense colonial town blocks.
    const houses = ['house_small', 'house_small_b', 'house_tall', 'house_tall_b', 'house_tall', 'house_grand'];
    for (let gx = -11; gx <= 11; gx++) for (let gz = -12; gz <= 1; gz++) {
      const x = gx * G, z = gz * G;
      if (occupied.has(cell(x, z)) || gx % 4 === 0 || gz % 4 === 0) continue;
      const r = rnd(), rot = Math.floor(rnd() * 4) * (Math.PI / 2);
      if (gz === 1) put(r < 0.6 ? 'house_warehouse' : 'house_tall_b', x, z, 0);
      else if (r < 0.82) put(houses[Math.floor(rnd() * houses.length)], x, z, rot);
      else if (r < 0.9) { put('market_stall', x, z, rot); put('haystack', x + 4.5, z - 4, 0, 0, false); put('barrels', x - 3, z - 4, rnd() * 6, 0, false); }
      else { put('palm_tree', x, z, rnd() * 6); put('palm_bush', x + 4, z + 3, 0, 0, false); put('crates', x - 4, z - 3, rot, 0, false); }
    }
    // Street life: barrels, crates and palms at street corners.
    for (let gx = -8; gx <= 8; gx += 4) for (let gz = -12; gz <= 0; gz += 4) {
      const x = gx * G + 4, z = gz * G + 4;
      if (rnd() < 0.5) put('barrels', x, z, rnd() * 6, 0, false);
      else if (rnd() < 0.5) put('palm_bush', x, z, 0, 0, false);
    }
    // Beachfront palms.
    for (let x = -160; x <= 160; x += 13) { put('palm_tree', x + rnd() * 4, 30 + rnd() * 5, rnd() * 6, 0, false); if (rnd() < 0.35) put('palm_bush', x + 6, 28, 0, 0, false); }
    // Fortress curtain wall with cannon embrasures.
    for (let x = -168; x <= 168; x += 16) { put('fort_wall', x, -196, 0); if (((x / 16) | 0) % 2 === 0) put('cannon', x, -196.5, Math.PI, 8, false); }
    for (let z = -180; z <= -100; z += 16) { put('fort_wall', -176, z, Math.PI / 2); put('fort_wall', 176, z, Math.PI / 2); }
    // Waterfront boardwalk, piers and moored Dutch merchantmen.
    for (let x = -150; x <= 150; x += 12) put('dock', x, COAST_Z + 3, 0);
    for (let x = -144; x <= 144; x += 16) {
      const k = rnd();
      if (k < 0.3) put('crates', x, COAST_Z + 1.4, 0, 1, false);
      else if (k < 0.6) put('barrels', x, COAST_Z + 3, rnd() * 6, 1, false);
      else if (k < 0.72) put('cannon', x, COAST_Z + 4.5, 0, 1, false);
    }
    [-100, -40, 20, 80].forEach((px, i) => {
      for (let j = 0; j < 5; j++) put('dock', px, COAST_Z + 12 + j * 12, Math.PI / 2);
      put('barrels', px, COAST_Z + 40, rnd() * 6, 1, false);
      put(i % 2 ? 'ship_medium' : 'ship_large', px + (i % 2 ? 6.8 : 8.2), COAST_Z + 38, Math.PI / 2, WATER_Y - 0.2, false);
    });

    // Redcoat / Royal Navy patrol routes along the streets and waterfront.
    const patrols = [
      [[-120, 0], [0, 0]], [[0, -60], [120, -60]], [[-120, -60], [-120, -120], [-60, -120]], [[60, 0], [60, -120]],
      [[0, -120], [0, -180]], [[-150, -180], [150, -180]], [[120, 0], [120, -60], [60, -60]], [[-60, -60], [-60, 0]],
      [[-60, COAST_Z + 3], [60, COAST_Z + 3]], [[-140, 22], [-20, 22]], [[20, 22], [140, 22]],
      [[-40, COAST_Z + 12], [-40, COAST_Z + 58]], [[80, COAST_Z + 12], [80, COAST_Z + 58]],
    ];
    this.setLayout({ placements: P, patrols: patrols.map((r) => r.map(([x, z]) => new THREE.Vector3(x, z > COAST_Z ? 1.05 : 0, z))), spawn: new THREE.Vector3(-8, 0.1, 30) });
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
      if (!chunk.group.visible) continue;
      visible++;
      const near = chunk.box.distanceToPoint(camera.position) < HLOD_NEAR;
      chunk.near.visible = near; chunk.far.visible = !near;
    }
    this.stats.loaded = this.loaded.size;
    this.stats.visible = visible;

    // Shadow frustum + ocean follow the player
    this.sun.position.copy(playerPos).addScaledVector(this.sunDir, 120);
    this.sun.target.position.copy(playerPos);
    this.water.material.uniforms.time.value = time * 0.6;
  }

  /**
   * Static batching (HLOD): all architecture in a chunk is merged per material
   * into a near (LOD0) and a far (LOD1) set → a few draw calls per chunk
   * instead of hundreds. Props with their own textures stay as THREE.LOD.
   */
  _loadChunk(key) {
    const group = new THREE.Group();
    group.name = `chunk_${key}`;
    const batches = [new Map(), new Map()];
    const pm = new THREE.Matrix4(), mm = new THREE.Matrix4();
    for (const p of this.chunkPlacements.get(key)) {
      const def = this.modules[p.module];
      if (def.batch) {
        pm.compose(new THREE.Vector3(p.x, p.y || 0, p.z), new THREE.Quaternion().setFromAxisAngle(UP, p.rotY || 0), new THREE.Vector3().setScalar(p.scale || 1));
        for (let lv = 0; lv < 2; lv++) {
          const proto = def.lods[lv];
          proto.updateMatrixWorld(true);
          proto.traverse((o) => {
            if (!o.isMesh) return;
            const g = o.geometry.clone().applyMatrix4(mm.multiplyMatrices(pm, o.matrixWorld));
            if (!batches[lv].has(o.material)) batches[lv].set(o.material, []);
            batches[lv].get(o.material).push(g);
          });
        }
      } else {
        const lod = new THREE.LOD();
        def.lods.forEach((proto, i) => lod.addLevel(proto.clone(), def.lodDistances[i] ?? i * 50));
        lod.position.set(p.x, p.y || 0, p.z);
        lod.rotation.y = p.rotY || 0;
        if (p.scale) lod.scale.setScalar(p.scale);
        group.add(lod);
      }
      this._addColliders(def, p, key);
    }
    const [near, far] = batches.map((mats) => {
      const g = new THREE.Group();
      for (const [mat, geos] of mats) {
        const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
        mesh.castShadow = true; mesh.receiveShadow = true;
        g.add(mesh);
      }
      return g;
    });
    far.visible = false;
    group.add(near, far);
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3());
    box.expandByScalar(2);
    this.scene.add(group);
    this.loaded.set(key, { group, box, near, far });
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
    this.scene.remove(chunk.group);   // LOD props share prototype geometry; batched chunk geometry is unique → dispose
    for (const g of [chunk.near, chunk.far]) g.traverse((o) => o.isMesh && o.geometry.dispose());
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

/** Jungle-covered hills rising behind the fort, vertex-coloured sand → grass → dark canopy. */
function makeHills() {
  const geo = new THREE.PlaneGeometry(1400, 520, 140, 52);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position, colors = new Float32Array(p.count * 3);
  const sand = new THREE.Color(0xb9a57a), grass = new THREE.Color(0x5d7a3a), canopy = new THREE.Color(0x2f4a24), rock = new THREE.Color(0x77705f);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const back = THREE.MathUtils.clamp((260 - z) / 520, 0, 1);             // 0 at the fort edge → 1 far inland
    const n = Math.sin(x * 0.011) * Math.cos(z * 0.017) + 0.5 * Math.sin(x * 0.031 + z * 0.023) + 0.25 * Math.sin(x * 0.07 - z * 0.05);
    const h = Math.max(0, back * back * 150 * (0.7 + 0.35 * n) + n * 6 * back);
    p.setY(i, h);
    const t = THREE.MathUtils.clamp(h / 90, 0, 1);
    c.copy(sand).lerp(grass, THREE.MathUtils.smoothstep(h, 1, 8)).lerp(canopy, t * 0.9);
    if (n > 1.1 && h > 40) c.lerp(rock, 0.5);
    c.offsetHSL(0, 0, (Math.sin(x * 0.9) * Math.cos(z * 1.1)) * 0.03);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const hills = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  hills.position.set(0, -0.05, -205 - 260);
  hills.receiveShadow = true;
  return hills;
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
    const v = new THREE.Vector3(-dx * 0.3, 1, -dz * 0.3).normalize();
    const i = (y * n + x) * 4;
    data[i] = (v.x * 0.5 + 0.5) * 255; data[i + 1] = (v.z * 0.5 + 0.5) * 255; data[i + 2] = v.y * 255; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, n, n);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}
