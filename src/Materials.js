// ============================================================================
// Materials.js — physically based material library built from CC0 scanned
// texture sets (Poly Haven: albedo / normal / AO-roughness-metal), world-scale
// UV projection so every surface keeps real-world texel density, and the HDR
// sky that drives background, image-based lighting and the sun direction.
// ============================================================================
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

const PBR_ROOT = 'assets/pbr/';

/** name -> metres covered by one texture tile. */
const SETS = {
  cobble: 3.0, plaster: 2.5, plaster2: 2.5, roof: 2.0, wood: 2.0, darkwood: 2.0,
  fort: 3.0, sand: 3.0, straw: 1.5,
};

export class MaterialLibrary {
  constructor(renderer) {
    this.renderer = renderer;
    this.loader = new THREE.TextureLoader();
    this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.cache = new Map();
    this.pending = [];
  }

  _tex(url, srgb) {
    let done;
    this.pending.push(new Promise((res) => { done = res; }));
    const t = this.loader.load(url, () => done(), undefined, () => { console.warn(`[Materials] missing ${url}`); done(); });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = this.anisotropy;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /**
   * Scanned PBR material. `tint` multiplies albedo (e.g. whitewash colours),
   * `tile` overrides metres-per-tile. Geometry must carry world-scale UVs
   * (see boxUV) — the library divides by tile size through texture.repeat.
   */
  pbr(name, { tint = 0xffffff, tile, roughness = 1, normalScale = 1, side = THREE.FrontSide, key = '' } = {}) {
    const id = `${name}|${tint}|${tile}|${side}|${key}`;
    if (this.cache.has(id)) return this.cache.get(id);
    const size = tile ?? SETS[name] ?? 2;
    const map = this._tex(`${PBR_ROOT}${name}_diff.jpg`, true);
    const normalMap = this._tex(`${PBR_ROOT}${name}_nor.jpg`, false);
    const arm = this._tex(`${PBR_ROOT}${name}_arm.jpg`, false);
    for (const t of [map, normalMap, arm]) t.repeat.set(1 / size, 1 / size);
    const mat = new THREE.MeshStandardMaterial({
      map, normalMap, aoMap: arm, roughnessMap: arm, metalnessMap: arm,
      color: tint, roughness, metalness: 1, side,
      normalScale: new THREE.Vector2(normalScale, normalScale),
    });
    mat.name = name;
    this.cache.set(id, mat);
    return mat;
  }

  /** Untextured PBR colour (glass, iron, cloth trims). */
  flat(color, { roughness = 0.8, metalness = 0, emissive = 0x000000, emissiveIntensity = 1, transparent = false, opacity = 1 } = {}) {
    const id = `flat|${color}|${roughness}|${metalness}|${emissive}|${opacity}`;
    if (!this.cache.has(id)) this.cache.set(id, new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity, transparent, opacity }));
    return this.cache.get(id);
  }

  ready() { return Promise.all(this.pending); }
}

/**
 * Box projection: UVs in metres from local vertex position, picking the plane
 * by the dominant normal axis. Also duplicates uv → uv1 for the AO map.
 */
export function boxUV(geo, offset = 0) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  const faceNormals = !geo.index;               // non-indexed: project each triangle by its flat normal (no seams/streaks)
  for (let i = 0; i < pos.count; i++) {
    if (faceNormals && i % 3 === 0) {
      a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
      n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    } else if (!faceNormals) n.fromBufferAttribute(nor, i);
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    let u, v;
    if (ay >= ax && ay >= az) { u = x; v = z; }
    else if (ax >= az) { u = z; v = y; }
    else { u = x; v = y; }
    uv[i * 2] = u + offset; uv[i * 2 + 1] = v + offset;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('uv1', new THREE.BufferAttribute(uv.slice(), 2));
  return geo;
}

/** Load the sky (HDR, or an 8-bit PNG/JPG fallback): background + PMREM environment + sun direction. */
export async function loadSky(renderer, scene, url = SKY_URL) {
  const hdr = /\.hdr$/i.test(url);
  const tex = hdr ? await new HDRLoader().loadAsync(url) : await new THREE.TextureLoader().loadAsync(url);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  if (!hdr) tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
  scene.backgroundIntensity = hdr ? 0.9 : 1.0;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(tex).texture;
  scene.environmentIntensity = hdr ? 0.75 : 1.1;           // LDR skies carry less energy
  pmrem.dispose();
  return findSun(tex);
}

export const SKY_URL = import.meta.env.VITE_SKY_URL || 'assets/hdri/sky_2k.hdr';

/** Brightest texel of the equirect image → world-space sun direction. */
function findSun(tex) {
  let { data, width, height } = tex.image;
  if (!data) {                                    // 8-bit image: read pixels back through a canvas
    const c = document.createElement('canvas');
    c.width = width = tex.image.width; c.height = height = tex.image.height;
    const g = c.getContext('2d');
    g.drawImage(tex.image, 0, 0);
    data = g.getImageData(0, 0, width, height).data;
  }
  const stride = data.length / (width * height);
  const half = tex.type === THREE.HalfFloatType && !(data instanceof Uint8ClampedArray);
  const read = (i) => (half ? THREE.DataUtils.fromHalfFloat(data[i]) : data[i]);
  let best = -1, bx = 0, by = 0;
  for (let y = 0; y < height / 2; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * stride;
      const l = read(i) * 0.2126 + read(i + 1) * 0.7152 + read(i + 2) * 0.0722;
      if (l > best) { best = l; bx = x; by = y; }
    }
  }
  // three.js equirect convention: u = atan2(dir.z, dir.x) / 2π + 0.5, v = asin(dir.y) / π + 0.5 (flipY)
  const u = (bx + 0.5) / width, v = 1 - (by + 0.5) / height;
  const phi = (u - 0.5) * Math.PI * 2, theta = (v - 0.5) * Math.PI;
  const dir = new THREE.Vector3(Math.cos(theta) * Math.cos(phi), Math.sin(theta), Math.cos(theta) * Math.sin(phi));
  if (dir.y < 0.25) dir.y = 0.25;            // keep shadows readable even for a low sun
  return dir.normalize();
}
