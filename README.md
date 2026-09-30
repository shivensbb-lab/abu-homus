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
| `Game.js` | Engine core: WebGL renderer (ACES, shadows), clamped-delta rAF loop, fixed 120 Hz simulation, dynamic resolution scaling to hold 60 FPS |
| `Camera.js` | Over-the-shoulder follow cam: mouse yaw/pitch, damped rear-vector tracking, wall collision, sprint/leap FOV kick, sync orbit |
| `Physics.js` | Spatial-hashed AABB world, tagged colliders (`solid`, `ledge`, `rigging`, `haystack`, `hide`, `sync`, `water`), raycasts, line of sight, cylinder resolution |
| `Player.js` | WASD movement, Swashbuckling Sprint + stamina, ray-based climb / mantle / vault / wall-jump, synchronise, Leap of Faith, swimming, combat input |
| `Enemy.js` | Redcoat guards: patrols, 3D view frustum (90° FOV + LOS), Detection Gauge, alerts, musket fire; `EnemyDirector` runs directional parry/counter combat, assassinations |
| `World.js` | Sky + IBL, reflective ocean, procedural port layout, chunk streaming (5×5 around player), chunk frustum culling, `THREE.LOD` swapping |
| `Assets.js` | Material library (auto-loads textures from `public/assets/textures/<name>.png`, procedural fallback) and the modular 3-LOD asset kit |
| `HUD.js` | Health/stamina, detection diamonds, parry telegraph, prompts, banners, desync screen, perf panel; skinnable from `public/assets/ui/` |
| `Input.js` | Keyboard + pointer-lock mouse with per-frame edge events |

## Controls

WASD + mouse · **Shift** sprint (auto-climb) · **Space** jump / Leap of Faith / back-eject · **F** synchronise · **LMB** assassinate / attack / counter · **Q / E / R** parry left / right / high · **Ctrl/C** walk / drop · **V** view cones · **`** perf panel

## Custom art

Drop PNGs (e.g. from SpriteCook) into `public/assets/textures/` named `stone`, `plaster`, `terracotta`, `wood`, `sand`, `cobble`, `sail`, `hay`, `leaf`, `rope`. They hot-swap over the procedural textures. HUD skins go in `public/assets/ui/` (`vitals_frame.png`, `health_fill.png`, `stamina_fill.png`, `emblem.png`, `parry_ring.png`).

Blender asset import is not wired up yet. It will plug into `World.registerModules()` / `World.setLayout()`.
