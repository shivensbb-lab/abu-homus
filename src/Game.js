// ============================================================================
// Game.js — engine core. Owns the WebGL renderer, scene and systems, and runs
// a robust requestAnimationFrame loop: clamped frame delta, fixed-timestep
// simulation (120 Hz) with an accumulator, variable-rate rendering, and
// dynamic resolution scaling that holds the frame rate at 60 FPS.
// ============================================================================
import * as THREE from 'three';
import { Physics } from './Physics.js';
import { Input } from './Input.js';
import { FollowCamera } from './Camera.js';
import { MaterialLibrary, loadSky } from './Materials.js';
import { buildArchitectureKit } from './Architecture.js';
import { loadPropKit } from './Props.js';
import { CharacterFactory } from './Character.js';
import { PostFX } from './PostFX.js';
import { World } from './World.js';
import { Player } from './Player.js';
import { EnemyDirector, Guard } from './Enemy.js';
import { HUD } from './HUD.js';

const FIXED_DT = 1 / 120;
const MAX_FRAME_DT = 0.1;       // avoid the spiral of death after tab switches / hitches
const MAX_STEPS = 12;
const TARGET_MS = 1000 / 60;

export class Game {
  constructor(container) {
    this.container = container;
    this.clock = { last: 0, time: 0, acc: 0 };
    this.perf = { fps: 60, ms: 16.7, calls: 0, tris: 0, chunks: 0, visible: 0, scale: 1 };
    this._emaMs = TARGET_MS; this._slowT = 0; this._fastT = 0;
    this.running = false;
  }

  async init(progress = () => {}) {
    // ---------------------------------------------------------- renderer
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.maxScale = Math.min(devicePixelRatio, 2);
    this.resScale = this.maxScale;
    r.setPixelRatio(this.resScale);
    r.setSize(innerWidth, innerHeight);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.85;
    r.info.autoReset = false;               // count every pass of the frame, not just the last one
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.container.appendChild(r.domElement);

    // ----------------------------------------------------------- systems
    this.scene = new THREE.Scene();
    this.physics = new Physics();
    this.input = new Input(r.domElement);
    this.hud = new HUD();
    this.materials = new MaterialLibrary(r);
    this.cam = new FollowCamera(innerWidth / innerHeight, this.physics);

    progress('Raising the sky');
    const sunDir = await loadSky(r, this.scene);
    this.world = new World({ scene: this.scene, physics: this.physics, renderer: r, materials: this.materials });
    this.world.buildEnvironment(sunDir);
    progress('Building Nassau');
    this.world.registerModules(buildArchitectureKit(this.materials));
    progress('Mooring the fleet');
    const [props, characters] = await Promise.all([loadPropKit(r), CharacterFactory.load()]);
    this.world.registerModules(props);
    this.world.generateProceduralPort();
    this.world.preload(this.world.spawn);
    await this.materials.ready();

    progress('Mustering the Redcoats');
    this.player = new Player({ scene: this.scene, physics: this.physics, world: this.world, hud: this.hud, cam: this.cam,
      character: characters.create({ tint: 0x3b4150, outfit: 'assassin' }) });
    this.director = new EnemyDirector({ scene: this.scene, physics: this.physics, hud: this.hud, cam: this.cam, characters });
    this.director.spawn(this.world.patrols);
    this.player.director = this.director;
    this.cam.pivot.copy(this.player.pos);
    this.post = new PostFX(r, this.scene, this.cam.camera);

    // Pre-compile every shader variant so the first seconds of footage don't stutter.
    this.world.update(0, this.player.pos, this.cam.camera, 0);
    this.cam.update(1 / 60, this.player.pos);
    await r.compileAsync(this.scene, this.cam.camera);

    addEventListener('resize', () => this._resize());
    addEventListener('keydown', (e) => {
      if (e.code === 'Backquote') this.hud.showPerf = !this.hud.showPerf;
      if (e.code === 'KeyV') Guard.showCones = !Guard.showCones;
    });
    return this;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.last = performance.now();
    requestAnimationFrame((t) => this._frame(t));
  }

  // --------------------------------------------------------------- loop
  _frame(now) {
    if (!this.running) return;
    requestAnimationFrame((t) => this._frame(t));

    const frameMs = now - this.clock.last;
    this.clock.last = now;
    const dt = Math.min(Math.max(frameMs, 0) / 1000, MAX_FRAME_DT);
    const paused = !this.input.active;

    if (!paused) {
      this.input.keyLook(dt);
      this.cam.handleMouse(this.input);
      this.clock.acc += dt;
      let steps = 0;
      while (this.clock.acc >= FIXED_DT && steps < MAX_STEPS) {
        this.player.update(FIXED_DT, this.input);
        this.director.update(FIXED_DT, this.player);
        this.clock.acc -= FIXED_DT;
        this.clock.time += FIXED_DT;
        steps++;
        this._consumeEdges();           // one-shot presses fire on the first sub-step only
      }
      if (steps === MAX_STEPS) this.clock.acc = 0;
    }

    // Variable-rate: world streaming, camera, HUD, render
    const p = this.player;
    this.world.update(dt, p.pos, this.cam.camera, this.clock.time);
    this.cam.update(dt, p.pos, { sprinting: p.sprinting, leaping: p.state === 'leap', climbing: p.state === 'climb' });
    this.player.animate(dt);
    this.director.animate(dt);
    this.post.setDamage(Math.max(0, 1 - this.player.health / 60));
    this.renderer.info.reset();
    this.post.render(dt);

    this._updatePerf(frameMs, dt);
    this.hud.update(dt, { player: p, director: this.director, camera: this.cam.camera, perf: this.perf });
    this.input.endFrame();
  }

  _consumeEdges() {
    this.input.pressed.clear();
    this.input.mouse.leftPressed = false;
    this.input.mouse.rightPressed = false;
  }

  // ------------------------------------------------ dynamic resolution
  _updatePerf(frameMs, dt) {
    if (frameMs > 0 && frameMs < 250) this._emaMs += (frameMs - this._emaMs) * 0.05;
    const info = this.renderer.info.render;
    Object.assign(this.perf, {
      ms: this._emaMs, fps: 1000 / this._emaMs, calls: info.calls, tris: info.triangles,
      chunks: this.world.stats.loaded, visible: this.world.stats.visible, scale: this.resScale,
    });
    // Drop resolution quickly when we miss 60 FPS, raise it slowly when there's headroom.
    if (this._emaMs > TARGET_MS * 1.12) { this._slowT += dt; this._fastT = 0; }
    else if (this._emaMs < TARGET_MS * 0.8) { this._fastT += dt; this._slowT = 0; }
    else { this._slowT = 0; this._fastT = 0; }
    if (this._slowT > 1) {
      if (this.resScale > 0.7) this._setScale(this.resScale - 0.1);
      else if (this.post.quality > 0) this.post.setQuality(this.post.quality - 1);   // shed AO, then bloom
      this._slowT = 0;
    }
    if (this._fastT > 3) {
      if (this.post.quality < 2) this.post.setQuality(this.post.quality + 1);
      else if (this.resScale < this.maxScale) this._setScale(this.resScale + 0.05);
      this._fastT = 0;
    }
  }

  _setScale(s) {
    this.resScale = THREE.MathUtils.clamp(s, 0.6, this.maxScale);
    this.renderer.setPixelRatio(this.resScale);
    this.renderer.setSize(innerWidth, innerHeight);
    this.post.setSize(innerWidth, innerHeight, this.resScale);
  }

  _resize() {
    this.cam.resize(innerWidth / innerHeight);
    this.renderer.setSize(innerWidth, innerHeight);
    this.post.setSize(innerWidth, innerHeight, this.resScale);
  }
}
