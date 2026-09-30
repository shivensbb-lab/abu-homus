# Black Flag Creed

A third-person action-adventure prototype in Three.js: a hooded pirate assassin in an 18th-century Caribbean port (Nassau, 1715).

## Run

```bash
npm install
npm run dev        # http://localhost:5173 — click to lock the mouse
npm run build      # production bundle in dist/
```

## Architecture (`src/`, every file < 500 lines)

| File | Responsibility |
|---|---|
| `Game.js` | Engine core: renderer, clamped-delta rAF loop, fixed 120 Hz simulation, dynamic resolution + post-FX quality scaling to hold 60 FPS |
| `Camera.js` | Over-the-shoulder follow cam: mouse yaw/pitch, damped rear-vector tracking, wall collision, sprint/leap FOV kick, sync orbit |
| `Physics.js` | Spatial-hashed AABB world, tagged colliders (`solid`, `ledge`, `rigging`, `haystack`, `hide`, `sync`, `water`), raycasts, line of sight |
| `Player.js` | Movement, Swashbuckling Sprint + stamina, ray-based climb / mantle / vault / wall-jump, sync, Leap of Faith, swimming, combat input |
| `Enemy.js` | Redcoat guards: patrols, 3D view frustum (90° FOV + LOS), Detection Gauge, alerts, musket fire, directional parry/counter combat |
| `Character.js` | Skinned Mixamo-rig characters: blended Idle/Walk/Run clips + procedural bone layers (climb, dive, sword, parry, aim, death) |
| `World.js` | HDR-lit environment, reflective ocean, jungle hills, port layout, chunk streaming, frustum culling, per-chunk static batching (HLOD) |
| `Architecture.js` | Procedural colonial buildings (quoins, shutters, balconies, clay-tile gable roofs), bell towers, fort walls, piers, palms, stalls |
| `Props.js` | Scanned glTF props (Dutch ships, cannon, barrels, crates, lanterns) with colliders generated from the ship hull and rigging |
| `Materials.js` | Scanned PBR material sets with world-scale UVs; HDR sky loader that derives the sun direction from the image |
| `PostFX.js` | MSAA → GTAO ambient occlusion → bloom → ACES output → colour grade + vignette |
| `HUD.js` · `Input.js` | Cinematic HUD (skinnable from `public/assets/ui/`) · keyboard + pointer-lock mouse |

## Assets & licences

- Textures, HDRI sky, ships, cannon, barrels, crates, lantern: [Poly Haven](https://polyhaven.com), **CC0**.
- Character: `Soldier.glb` from the three.js examples (Mixamo rig and animations). It is a **stand-in**: a modern armoured soldier, not an 18th-century assassin. Replace `public/assets/models/Soldier.glb` with any Mixamo-rigged character that has `Idle`, `Walk` and `Run` clips. The procedural climb, combat and dive poses work with any Mixamo rig.

## Controls

WASD + mouse · **Shift** sprint (auto-climb) · **Space** jump / Leap of Faith / back-eject · **F** synchronise · **LMB** assassinate / attack / counter · **Q / E / R** parry left / right / high · **Ctrl/C** walk / drop · **V** view cones · **`** perf panel

## Custom art

To swap materials, replace the `<name>_diff/_nor/_arm.jpg` sets in `public/assets/pbr/`. HUD skins (e.g. SpriteCook art) go in `public/assets/ui/`: `vitals_frame.png`, `health_fill.png`, `stamina_fill.png`, `emblem.png`, `parry_ring.png`.

Blender asset import is not wired up yet. It will plug into `World.registerModules()` / `World.setLayout()`.
