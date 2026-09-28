# Greywater

A realistic tactical first-person shooter that runs in the browser, with two modes on two maps. It's a mobile-first PWA that also plays with mouse and keyboard, and it needs no backend and no build step.

**Operation Greywater.** An armed cell holds a stolen archive drive inside Kestrel Freight Depot. You breach from the south-east yard, recover the drive from the upper office in the main hall, then exfil at the breach point. Expect a response once the drive is gone.

**Mountain Survival.** You are the sniper of a six-man reconnaissance team inserted into the Koh-e Zard highlands, a fictional high valley with ridges, cliffs, villages and observation posts. About 26 fighters hold positions around the landing zone. Nothing spawns: the pre-placed groups move on your last known area over time. Survive ten minutes until the exfil helicopter arrives. If you die, it's game over, with no respawn.

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
| Rifle fire mode | V (B in the depot) | — |
| Pause | Esc / P | Pause button |

Mountain Survival adds:

| Action | Keyboard & mouse | Touch |
| --- | --- | --- |
| Prone | Z | Prone button |
| Binoculars (laser range finder; LMB marks a target for the squad) | B | Binoculars button |
| Thermal channel (binoculars) | T | IR button |
| Dress a wound | H | Cross button |
| Scope magnification | Mouse wheel while aiming | + / − (shown while scoped) |
| Scope zero | Page Up / Page Down | — |
| Hold breath | Shift while aiming | — |

## Features

- **Weapons**: K4 carbine (auto/semi, holographic sight), P9 pistol (slide lock on empty, three-dot sights) and Breacher 12 pump shotgun (9 pellets, shell-by-shell reload you can interrupt). Each has its own recoil pattern with partial recovery, first-shot accuracy, movement/air/crouch spread, falloff and hit-zone damage. Reloads know about the chambered round (30+1).
- **Feel**: procedural view model with sway, bob, sprint and wall-block poses, spring recoil, ADS alignment, keyframed reloads with moving magazine, slide and pump parts, muzzle flash with light, and shell casings that bounce with sound.
- **AI**: vision cones that build awareness (affected by distance, light, stance, movement and firing), hearing (shots, footsteps, reloads, impacts, near misses), team call-outs, auto-generated cover with peeking, repositioning and flanking under an "advance token" limit, searching, and burst fire with reaction time and aim that settles over time. The mission has three soldier kits, several skill levels, and a reinforcement squad.
- **World**: every texture is generated procedurally with PBR normal and roughness maps. Lighting uses an ambient-volume shader for believable interiors, baked floor AO, sun shadows, fake volumetric light shafts, dust, glass that shatters, decals, and auto exposure.
- **Audio**: everything is synthesised at load. Gunshots are layered (crack, body, thump, mechanics, tail) with indoor and outdoor convolution reverb, distance filtering, occlusion and speed-of-sound delay. There are surface-dependent footsteps and impacts, bullet whizz, casings, voices and radio, plus ambience.
- **Performance**: static geometry is merged per material, and effects and decals are pooled and instanced. There are three quality tiers, dynamic resolution, and a no-post Low tier for weak phones.

### Mountain Survival

- **Terrain**: a 1.6 km detailed heightfield (designed ridges, eroded flanks, a glacial valley with a dry riverbed, roads and trails) inside a 24 km ring of distant ranges with snow. The GPU bakes soft mountain shadows and horizon ambient occlusion. Slope, altitude and macro-noise blend soil, dry grass, scree and triplanar rock. The world also has aerial perspective, drifting cloud shadows and wind-blown dust.
- **Vegetation**: see-through foliage built from leaf cards painted into a procedural atlas. There are several bush species and distinct forest types: open juniper woodland, holm-oak groves, pine and deodar forest on the cool north-facing slopes, poplar and willow galleries along the wadi, and mulberry orchards by the village. Trees and bushes switch to cheap LODs at distance, sway in the wind, and dense bushes and crowns block line of sight but not bullets.
- **Weapons & ballistics**: SR-7 bolt-action rifle (4–12× scope, mil-dot reticle, zeroing, bolt cycling), DM-14 marksman rifle (4× prism scope) and a pistol. Rounds are projectiles with gravity, quadratic drag, retained energy and a supersonic crack. Sway depends on stance, fatigue and health, and you can hold your breath.
- **Binoculars & thermal**: 7× laser range-finding binoculars (range, azimuth, elevation), with target marking for the squad. The thermal channel renders every surface with a heat material: sun-soaked rock and soil, shaded ground, cool vegetation, walls, metal and warm bodies against a cold sky. A white-hot sensor pass adds gain, noise and blur.
- **Squad & AI**: five team-mates keep a formation, kneel and watch sectors, hold fire until the team is compromised, seek firing positions and cover, call contacts with bearing and range, and react to wounds and losses. Hostile fighters (tunics, pakols and turbans) guard, patrol and observe from ridges and roofs. They detect at range depending on attention, stance, movement, concealment and muzzle flash, fight from cover with drop and lead compensation, and hunt in groups on a schedule.
- **Medical**: no regeneration. Hits cause bleeding, and field dressings take about four seconds with your weapon lowered, stop the bleeding and restore part of your health.
- **Audio**: full-power rifle reports, a distinct distant-gunfire character, mountain echo reverb, gusting wind, surface footsteps (grass, gravel, dirt), bolt and dressing foley, breathing, radio squelch with squad chatter, and the exfil helicopter.

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
js/mountain.js, mountainLayout.js   the mountain world: terrain, rocks, sites, lighting, nav
js/terrain.js                  heightfield generation, queries, ray march, GPU light bake
js/vegetation.js               leaf atlas, bushes, forest types, LOD instancing
js/natureTextures.js, natureMaterials.js   rock / soil / grass textures and terrain shaders
js/survival.js                 mode logic: clock, hunt director, radio, bleeding, helicopter
js/ballistics.js, thermal.js   projectile flight & zeroing, thermal rendering
js/helicopter.js               exfil helicopter
```

Settings are stored in `localStorage`. Add `?touch=1` or `?touch=0` to the URL to force a control scheme.
