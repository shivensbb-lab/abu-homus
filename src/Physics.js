// ============================================================================
// Physics.js — lightweight static-world physics tuned for parkour.
// Every collider is an axis-aligned box (baked from Blender bounding boxes or
// from procedural modules) stored in a 2D spatial hash on the XZ plane.
// Dynamic bodies (player, guards) are vertical cylinders resolved against it.
// ============================================================================
import * as THREE from 'three';

export const TAG = Object.freeze({
  SOLID: 'solid',       // blocks movement, blocks line of sight
  LEDGE: 'ledge',       // climbable stone/wood edges
  RIGGING: 'rigging',   // climbable ship ropes / nets (faster climb)
  HAYSTACK: 'haystack', // Leap-of-Faith landing zone + hiding spot
  HIDE: 'hide',         // palm-leaf bushes, crowds, awnings: hides the player
  SYNC: 'sync',         // viewpoint synchronisation platform
  WATER: 'water',
});

const SOFT_TAGS = [TAG.HAYSTACK, TAG.HIDE, TAG.WATER]; // never block movement

export class Physics {
  constructor({ cellSize = 16 } = {}) {
    this.cellSize = cellSize;
    this.gravity = -24;
    this.colliders = new Map();   // id -> collider
    this.grid = new Map();        // "cx,cz" -> Set<collider>
    this.groups = new Map();      // group key (chunk) -> Set<id>
    this._nextId = 1;
    this._stamp = 0;              // de-dupe token for multi-cell queries
    this._tmpBox = new THREE.Box3();
  }

  // ---------------------------------------------------------------- registry
  add({ min, max, tags = [TAG.SOLID], group = 'static', name = '', owner = null }) {
    const tagSet = new Set(tags);
    const c = {
      id: this._nextId++,
      box: new THREE.Box3(new THREE.Vector3().copy(min), new THREE.Vector3().copy(max)),
      tags: tagSet,
      solid: !SOFT_TAGS.some((t) => tagSet.has(t)),
      climbable: tagSet.has(TAG.LEDGE) || tagSet.has(TAG.RIGGING),
      group, name, owner, _stamp: 0,
    };
    this.colliders.set(c.id, c);
    this._forCells(c.box, (key) => {
      if (!this.grid.has(key)) this.grid.set(key, new Set());
      this.grid.get(key).add(c);
    });
    if (!this.groups.has(group)) this.groups.set(group, new Set());
    this.groups.get(group).add(c.id);
    return c;
  }

  remove(id) {
    const c = this.colliders.get(id);
    if (!c) return;
    this._forCells(c.box, (key) => {
      const cell = this.grid.get(key);
      if (!cell) return;
      cell.delete(c);
      if (cell.size === 0) this.grid.delete(key);
    });
    this.colliders.delete(id);
    this.groups.get(c.group)?.delete(id);
  }

  removeGroup(group) {
    const ids = this.groups.get(group);
    if (!ids) return;
    for (const id of [...ids]) this.remove(id);
    this.groups.delete(group);
  }

  _forCells(box, fn) {
    const s = this.cellSize;
    const x0 = Math.floor(box.min.x / s), x1 = Math.floor(box.max.x / s);
    const z0 = Math.floor(box.min.z / s), z1 = Math.floor(box.max.z / s);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) fn(`${x},${z}`);
  }

  /** All colliders whose box intersects `box`, optionally filtered. */
  query(box, filter = null, out = []) {
    const stamp = ++this._stamp;
    this._forCells(box, (key) => {
      const cell = this.grid.get(key);
      if (!cell) return;
      for (const c of cell) {
        if (c._stamp === stamp) continue;
        c._stamp = stamp;
        if (c.box.intersectsBox(box) && (!filter || filter(c))) out.push(c);
      }
    });
    return out;
  }

  // ----------------------------------------------------------------- raycast
  /**
   * Ray vs. all colliders. `dir` must be normalised.
   * Returns { collider, distance, point, normal } for the nearest hit or null.
   */
  raycast(origin, dir, maxDist, filter = null) {
    const end = new THREE.Vector3().copy(dir).multiplyScalar(maxDist).add(origin);
    this._tmpBox.makeEmpty().expandByPoint(origin).expandByPoint(end);
    const candidates = this.query(this._tmpBox, filter);
    let best = null;
    for (const c of candidates) {
      const hit = rayBox(origin, dir, c.box);
      if (hit && hit.t <= maxDist && (!best || hit.t < best.distance)) {
        best = { collider: c, distance: hit.t, normal: hit.normal };
      }
    }
    if (best) best.point = new THREE.Vector3().copy(dir).multiplyScalar(best.distance).add(origin);
    return best;
  }

  /** True if nothing solid lies between a and b. */
  lineOfSight(a, b) {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return true;
    d.divideScalar(len);
    const hit = this.raycast(a, d, len, (c) => c.solid);
    return !hit || hit.distance >= len - 0.25;
  }

  // ------------------------------------------------------- cylinder bodies
  /** Returns the first collider with `tag` overlapping the upright cylinder. */
  overlapsTag(pos, radius, height, tag) {
    this._tmpBox.min.set(pos.x - radius, pos.y, pos.z - radius);
    this._tmpBox.max.set(pos.x + radius, pos.y + height, pos.z + radius);
    const hits = this.query(this._tmpBox, (c) => c.tags.has(tag));
    return hits.length ? hits[0] : null;
  }

  /**
   * Push an upright cylinder (feet at pos.y) out of every solid box.
   * Mutates pos / vel. Returns { grounded, ground, wallNormal }.
   */
  resolveCylinder(pos, vel, radius, height, stepHeight = 0.45) {
    const result = { grounded: false, ground: null, wallNormal: null };
    for (let iter = 0; iter < 3; iter++) {
      this._tmpBox.min.set(pos.x - radius, pos.y - 0.05, pos.z - radius);
      this._tmpBox.max.set(pos.x + radius, pos.y + height, pos.z + radius);
      const hits = this.query(this._tmpBox, (c) => c.solid);
      if (!hits.length) break;
      let moved = false;
      for (const c of hits) {
        const b = c.box;
        // closest point of the box footprint to the cylinder axis
        const cx = THREE.MathUtils.clamp(pos.x, b.min.x, b.max.x);
        const cz = THREE.MathUtils.clamp(pos.z, b.min.z, b.max.z);
        let dx = pos.x - cx, dz = pos.z - cz;
        const distSq = dx * dx + dz * dz;
        if (distSq >= radius * radius) continue;
        if (pos.y >= b.max.y + 0.001 || pos.y + height <= b.min.y) continue;

        const up = b.max.y - pos.y;
        const down = pos.y + height - b.min.y;
        let side, nx = 0, nz = 0;
        if (distSq > 1e-8) {
          const dist = Math.sqrt(distSq);
          side = radius - dist; nx = dx / dist; nz = dz / dist;
        } else {
          // axis inside the footprint: exit via nearest face
          const exits = [
            [pos.x - b.min.x, -1, 0], [b.max.x - pos.x, 1, 0],
            [pos.z - b.min.z, 0, -1], [b.max.z - pos.z, 0, 1],
          ].sort((p, q) => p[0] - q[0]);
          side = exits[0][0] + radius; nx = exits[0][1]; nz = exits[0][2];
        }

        if (up <= stepHeight && vel.y <= 0.5 && up <= side + stepHeight) {
          pos.y = b.max.y;
          if (vel.y < 0) vel.y = 0;
          result.grounded = true; result.ground = c;
        } else if (down < side && down < up && vel.y > 0) {
          pos.y = b.min.y - height;
          vel.y = 0;
        } else {
          pos.x += nx * side; pos.z += nz * side;
          const into = vel.x * nx + vel.z * nz;
          if (into < 0) { vel.x -= into * nx; vel.z -= into * nz; }
          result.wallNormal = new THREE.Vector3(nx, 0, nz);
        }
        moved = true;
      }
      if (!moved) break;
    }
    // resting-contact probe so standing still still counts as grounded
    if (!result.grounded && vel.y <= 0) {
      this._tmpBox.min.set(pos.x - radius * 0.7, pos.y - 0.08, pos.z - radius * 0.7);
      this._tmpBox.max.set(pos.x + radius * 0.7, pos.y + 0.02, pos.z + radius * 0.7);
      const under = this.query(this._tmpBox, (c) => c.solid && c.box.max.y <= pos.y + 0.03);
      if (under.length) { result.grounded = true; result.ground = under[0]; }
    }
    return result;
  }

  /** Height of the highest solid top below `pos` within `maxDrop`, or null. */
  groundHeight(pos, maxDrop = 50) {
    const origin = new THREE.Vector3(pos.x, pos.y + 0.5, pos.z);
    const hit = this.raycast(origin, DOWN, maxDrop + 0.5, (c) => c.solid);
    return hit ? hit.point.y : null;
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);

/** Slab test. Returns { t, normal } of the entry face, or null. */
function rayBox(o, d, box) {
  let tmin = -Infinity, tmax = Infinity, axis = 0, sign = 0;
  const axes = ['x', 'y', 'z'];
  for (let i = 0; i < 3; i++) {
    const a = axes[i];
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < box.min[a] || o[a] > box.max[a]) return null;
      continue;
    }
    const inv = 1 / d[a];
    let t1 = (box.min[a] - o[a]) * inv;
    let t2 = (box.max[a] - o[a]) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) { tmin = t1; axis = i; sign = -Math.sign(d[a]); }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  const normal = new THREE.Vector3();
  if (tmin < 0) return { t: 0, normal: normal.copy(d).negate() }; // started inside
  normal.setComponent(axis, sign);
  return { t: tmin, normal };
}
