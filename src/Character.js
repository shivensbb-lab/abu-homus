// ============================================================================
// Character.js — skinned, motion-captured humans (Mixamo rig) driven by an
// AnimationMixer with weight-blended Idle / Walk / Run, plus procedural
// bone layers on top for states that have no clip yet: climbing, mantling,
// swan-dive, sword strikes, parries, aiming and death. Rotations are applied
// in character space so they work for any Mixamo-rigged replacement model.
// ============================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const BONES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg'];

export class CharacterFactory {
  static async load(url = 'assets/models/Soldier.glb') {
    const gltf = await new GLTFLoader().loadAsync(url);
    return new CharacterFactory(gltf);
  }

  constructor(gltf) {
    this.gltf = gltf;
    this.clips = Object.fromEntries(gltf.animations.map((a) => [a.name, a]));
  }

  /** tint multiplies the body texture; outfit adds era props (hat, sword, hood). */
  create({ tint = 0xffffff, outfit = 'guard' } = {}) {
    const model = SkeletonUtils.clone(this.gltf.scene);
    model.rotation.y = Math.PI;                       // clip faces -Z → make +Z forward
    const mats = new Map();
    model.traverse((o) => {
      if (!o.isMesh) return;
      if (/visor/i.test(o.name)) { o.visible = false; return; }
      o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
      if (!mats.has(o.material)) {
        const m = o.material.clone();
        m.color = new THREE.Color(tint);
        m.roughness = 0.85; m.metalness = 0;
        mats.set(o.material, m);
      }
      o.material = mats.get(o.material);
    });
    return new Character(model, this.clips, outfit);
  }
}

const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _axis = new THREE.Vector3();
const _v = new THREE.Vector3();

export class Character {
  constructor(model, clips, outfit) {
    this.root = new THREE.Group();
    this.root.add(model);
    this.model = model;
    this.bones = {};
    model.traverse((o) => {
      if (!o.isBone) return;
      const key = BONES.find((b) => o.name.endsWith(b) && !o.name.endsWith(`Hand${b}`));
      if (key && !this.bones[key]) this.bones[key] = o;
    });
    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    for (const name of ['Idle', 'Walk', 'Run']) {
      if (!clips[name]) continue;
      const a = this.mixer.clipAction(clips[name]);
      a.play(); a.setEffectiveWeight(name === 'Idle' ? 1 : 0);
      this.actions[name] = a;
    }
    this.weights = { Idle: 1, Walk: 0, Run: 0 };
    this.t = 0;
    this._dress(outfit);
  }

  _attach(boneName, obj) {
    const bone = this.bones[boneName];
    if (!bone) return;
    this.model.updateMatrixWorld(true);
    bone.add(obj);
    bone.getWorldScale(_v);
    obj.scale.divide(_v).multiplyScalar(1);         // bones are in centimetres → cancel parent scale
  }

  _dress(outfit) {
    const steel = new THREE.MeshStandardMaterial({ color: 0xd5dbe0, metalness: 1, roughness: 0.25 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xb08a3c, metalness: 1, roughness: 0.35 });
    const felt = new THREE.MeshStandardMaterial({ color: outfit === 'guard' ? 0x141414 : 0xd9d2c0, roughness: 0.9, side: THREE.DoubleSide });
    // Sword in the right hand (blade along the hand's local +Y after the grip rotation)
    const sword = new THREE.Group();
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.85, 0.008), steel);
    blade.position.y = 0.5;
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.012, 6, 12, Math.PI), brass);
    guard.position.y = 0.08;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.14, 6), brass);
    sword.add(blade, guard, grip);
    sword.traverse((o) => { o.castShadow = true; });
    sword.position.set(0, 0.08, 0.02);
    sword.rotation.set(0, 0, 0);
    this.sword = sword;
    this._attach('RightHand', sword);
    sword.visible = false;
    // Redcoats get a black tricorne
    if (outfit === 'guard') {
      const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.1, 3), felt);
      hat.castShadow = true;
      hat.position.set(0, 0.19, 0);
      this._attach('Head', hat);
    }
  }

  /** Rotate a bone about an axis given in character space (x = left, y = up, z = forward). */
  _rot(name, ax, ay, az, angle) {
    const bone = this.bones[name];
    if (!bone || !angle) return;
    _axis.set(ax, ay, az).applyQuaternion(this.root.getWorldQuaternion(_q)).normalize();
    bone.parent.getWorldQuaternion(_pq);
    const rotW = new THREE.Quaternion().setFromAxisAngle(_axis, angle);
    const local = _pq.clone().invert().multiply(rotW).multiply(_pq);
    bone.quaternion.premultiply(local);
    bone.updateMatrixWorld(true);
  }

  /**
   * pose: { speed, state, phase, swing (0..1), parry ('left'|'right'|'high'|null),
   *         leap (0..1), aim (0..1), weapon (bool), dead (0..1) }
   */
  update(dt, pose) {
    this.t += dt;
    const { speed = 0, state = 'ground' } = pose;
    const moving = state === 'ground' || state === 'swim';
    const target = { Idle: 1, Walk: 0, Run: 0 };
    if (moving && speed > 0.3) {
      if (speed < 2.8) { target.Idle = 0; target.Walk = 1; }
      else { target.Idle = 0; target.Run = 1; }
    }
    const k = 1 - Math.exp(-10 * dt);
    for (const n of Object.keys(this.actions)) {
      this.weights[n] += (target[n] - this.weights[n]) * k;
      this.actions[n].setEffectiveWeight(this.weights[n]);
    }
    if (this.actions.Walk) this.actions.Walk.timeScale = THREE.MathUtils.clamp(speed / 1.6, 0.6, 1.8);
    if (this.actions.Run) this.actions.Run.timeScale = THREE.MathUtils.clamp(speed / 5.2, 0.8, 1.9);
    this.mixer.update(state === 'air' || state === 'leap' ? dt * 0.3 : dt);
    this.root.updateMatrixWorld(true);
    this._procedural(pose);
    this.sword.visible = !!pose.weapon;
  }

  _procedural(p) {
    const R = [-1, 0, 0], F = [0, 0, 1], U = [0, 1, 0];
    const rot = (b, axis, a) => this._rot(b, axis[0], axis[1], axis[2], a);
    const s = Math.sin(p.phase || 0);
    switch (p.state) {
      case 'climb': case 'mantle': {
        const reach = p.state === 'mantle' ? 0.6 : 1;
        rot('LeftArm', R, (2.5 + s * 0.35) * reach); rot('RightArm', R, (2.5 - s * 0.35) * reach);
        rot('LeftForeArm', R, 0.4); rot('RightForeArm', R, 0.4);
        rot('LeftUpLeg', R, 0.9 + s * 0.45); rot('RightUpLeg', R, 0.9 - s * 0.45);
        rot('LeftLeg', R, -1.2 - s * 0.3); rot('RightLeg', R, -1.2 + s * 0.3);
        rot('Spine', R, -0.15);
        break;
      }
      case 'air':
        rot('LeftUpLeg', R, 0.7); rot('RightUpLeg', R, 0.3); rot('LeftLeg', R, -1.1); rot('RightLeg', R, -0.6);
        rot('LeftArm', F, 0.5); rot('RightArm', F, -0.5);
        break;
      case 'leap': {
        const spread = Math.min(1, (p.leap || 0) * 3);
        rot('LeftArm', F, -1.3 * spread); rot('RightArm', F, 1.3 * spread);   // swan dive: arms wide
        rot('Spine', R, 0.25 * spread);
        break;
      }
      case 'swim':
        rot('LeftArm', R, 1.2 + s * 1.4); rot('RightArm', R, 1.2 - s * 1.4);
        break;
      case 'dead':
        rot('Spine', R, 0.4); rot('LeftArm', F, -0.8); rot('RightArm', F, 0.9);
        break;
    }
    // Upper-body combat layer
    if (p.swing > 0) {
      const t = p.swing;                                              // 0 → 1 slash from high-right to low-left
      rot('RightArm', F, 1.6 - t * 0.8); rot('RightArm', U, 1.2 - t * 2.6); rot('RightForeArm', R, 0.6);
      rot('Spine1', U, 0.5 - t * 1.0);
    } else if (p.parry) {
      const a = { left: [0.8, -0.9], right: [0.8, 0.6], high: [2.6, 0] }[p.parry];
      rot('RightArm', R, a[0]); rot('RightArm', U, a[1]); rot('RightForeArm', R, 0.9);
    } else if (p.weapon && p.state === 'ground') {
      rot('RightArm', R, 0.7); rot('RightForeArm', R, 0.9);          // guard stance
    }
    if (p.aim > 0) {                                                  // shouldering a musket
      rot('RightArm', R, 1.45 * p.aim); rot('LeftArm', R, 1.35 * p.aim); rot('LeftArm', U, -0.5 * p.aim);
    }
  }
}
