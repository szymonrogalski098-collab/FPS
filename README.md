# Greywater

A compact, realistic tactical first-person shooter that runs in the browser: one polished mission in one detailed map. It's a mobile-first PWA that also plays with mouse and keyboard, and it needs no backend and no build step.

**Operation Greywater.** An armed cell holds a stolen archive drive inside Kestrel Freight Depot. You breach from the south-east yard, recover the drive from the upper office in the main hall, then exfil at the breach point. Expect a response once the drive is gone.

## Run it

Any static file server works:

```bash
python -m http.server 8080
```

Then open <http://localhost:8080>. Opening `index.html` straight from the file system won't work, because ES modules need to be served over HTTP.

### Deploy to GitHub Pages

1. Push the repository contents (`index.html` at the root).
2. In **Settings → Pages**, pick the branch and the `/ (root)` folder.
3. Open the Pages URL. `.nojekyll` is included, and every path is relative.

Three.js 0.160 loads from jsDelivr through an import map. The service worker caches the app shell and the CDN modules, so after the first visit the game also works offline and can be installed to the home screen.

## Controls

| Action | Keyboard & mouse | Touch (landscape) |
| --- | --- | --- |
| Move | W A S D | Floating left stick (push fully forward to sprint) |
| Look | Mouse | Drag anywhere on the right side |
| Fire | Left mouse button | Fire button (drag while holding to track), or the small left fire button |
| Aim down sights | Right mouse button (hold) | Sight button (toggle) |
| Sprint | Shift | Sprint button or full stick |
| Crouch | Ctrl (hold) / C (toggle) | Crouch button |
| Jump / vault | Space | Jump button |
| Reload | R | Reload button |
| Switch weapon | 1 2 3 / mouse wheel | Switch button |
| Lean | Q / E | — |
| Interact | F (hold) | USE button (appears in context) |
| Rifle fire mode | B | — |
| Pause | Esc / P | Pause button |

## Features

- **Weapons**: K4 carbine (auto/semi, holographic sight), P9 pistol (slide lock on empty, three-dot sights) and Breacher 12 pump shotgun (9 pellets, shell-by-shell reload you can interrupt). Each has its own recoil pattern with partial recovery, first-shot accuracy, movement/air/crouch spread, falloff and hit-zone damage. Reloads know about the chambered round (30+1).
- **Feel**: procedural view model with sway, bob, sprint and wall-block poses, spring recoil, ADS alignment, keyframed reloads with moving magazine, slide and pump parts, muzzle flash with light, and shell casings that bounce with sound.
- **AI**: vision cones that build awareness (affected by distance, light, stance, movement and firing), hearing (shots, footsteps, reloads, impacts, near misses), team call-outs, auto-generated cover with peeking, repositioning and flanking under an "advance token" limit, searching, and burst fire with reaction time and aim that settles over time. The mission has three soldier kits, several skill levels, and a reinforcement squad.
- **World**: every texture is generated procedurally with PBR normal and roughness maps. Lighting uses an ambient-volume shader for believable interiors, baked floor AO, sun shadows, fake volumetric light shafts, dust, glass that shatters, decals, and auto exposure.
- **Audio**: everything is synthesised at load. Gunshots are layered (crack, body, thump, mechanics, tail) with indoor and outdoor convolution reverb, distance filtering, occlusion and speed-of-sound delay. There are surface-dependent footsteps and impacts, bullet whizz, casings, voices and radio, plus ambience.
- **Performance**: static geometry is merged per material, and effects and decals are pooled and instanced. There are three quality tiers, dynamic resolution, and a no-post Low tier for weak phones.

## Code map

```
index.html / css/style.css     UI shell, HUD, menus, touch controls
js/main.js                     bootstrap, menus, pause / settings / pointer lock, main loop
js/game.js                     mission orchestration, bullets, noise, pickups, objectives
js/level.js, props.js          the map and prop library (built through builder.js)
js/physics.js, nav.js          AABB collision & ray casts, layered nav grid + A* + cover points
js/player.js, weapons.js       movement / stance / lean, weapon handling
js/viewmodel.js, weaponModels.js   first-person rendering and animation
js/enemy.js, enemyModel.js     AI brain, skinned soldier mesh + IK
js/effects.js, audio.js        particles / decals / shells, synthesised audio engine
js/renderer.js, sky.js         HDR pipeline, grading pass, bloom, sky + environment
js/textures.js, materials.js   procedural textures, materials, ambient-volume shader patch
```

Settings are stored in `localStorage`. Add `?touch=1` or `?touch=0` to the URL to force a control scheme.
