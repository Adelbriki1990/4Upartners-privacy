# Street Ops — Unity version

A complete Call-of-Duty-style urban combat FPS that builds itself **entirely
from code** — no prefabs, no scenes, no imported assets. The whole downtown
map (towers with lit windows, sponsor billboards, cars, barriers, street
lamps), the player, the weapons, the enemy AI, the HUD and even the sound
effects are generated procedurally at Play time.

## Setup (2 minutes)

1. Install **Unity 2021.3 LTS or newer** (any 3D template — Built-in RP or URP both work).
2. Create a new **3D project** (or open an existing one).
3. Copy the `StreetOps` folder from here into your project's `Assets/` folder.
4. Open any empty scene and press **Play**. That's it — the game bootstraps itself.

> If your project uses the new Input System only, set
> **Edit → Project Settings → Player → Active Input Handling** to
> **Both** (or *Input Manager (Old)*), since the scripts use the classic
> `Input` API for portability.

## Controls

| Input | Action |
|---|---|
| W A S D | Move |
| Mouse | Look |
| Left click | Fire (hold for full-auto) |
| Right click | Aim down sights |
| Shift | Sprint |
| Space | Jump |
| R | Reload |
| Esc | Release cursor (click to re-lock) |

## Gameplay

- Escalating waves of hostile soldiers spawn from the alleys and street ends.
- Enemies chase, strafe and fire with distance-based accuracy and real
  line-of-sight checks — use the cars, barriers and crates as cover.
- COD-style regenerating health: break contact for 4 seconds to recover.
- Headshots deal double damage. Ammo reserve refills each wave.

## Sponsors / advertising

Billboards around the city are driven by `StreetOps/SponsorConfig.cs`.
Edit the `Sponsors` array to change names, taglines and brand colors —
each entry becomes glowing ad panels on tower walls and street-level stands.

To show a **real sponsor logo**: create an `Assets/Resources/` folder, drop
the logo PNG in it, and set that entry's `LogoResource` to the file name
(without extension).

## File map

| File | Purpose |
|---|---|
| `GameBootstrap.cs` | Zero-setup entry point + game state / restart |
| `CityGenerator.cs` | Procedural downtown: street, towers, billboards, props |
| `SponsorConfig.cs` | Sponsor/advertising configuration |
| `Materials.cs` | Pipeline-agnostic materials + window/billboard textures |
| `PlayerController.cs` | FPS movement, look, health & regen |
| `Weapon.cs` | Hitscan rifle, ADS, recoil, tracers, muzzle flash |
| `EnemyAI.cs` | Enemy rig, chase/strafe/shoot AI, damage & death |
| `WaveManager.cs` | Wave spawning and escalation |
| `HUDController.cs` | Crosshair, health, ammo, hitmarkers, game over |
| `AudioSynth.cs` | Procedurally synthesized sound effects |
