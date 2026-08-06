# Street Ops — 3D Urban Combat

A Call-of-Duty-style first-person shooter set in a downtown city street at
night, with sponsor advertising built into the world. It ships in **two
versions**:

| Version | Where | Tech |
|---|---|---|
| **Browser game** | `index.html` + `game.js` | Three.js (vendored in `lib/`), runs anywhere |
| **Unity game** | `unity/StreetOps/` | C# scripts, builds itself at Play time — see [`unity/README.md`](unity/README.md) |

## Play the browser version

The game uses JavaScript modules, so it needs to be served over HTTP:

```bash
# from the repo root
python3 -m http.server 8000
# then open http://localhost:8000
```

Or enable **GitHub Pages** on this repo (Settings → Pages → deploy from
branch) and the game is playable at your Pages URL.

### Controls

| Input | Action |
|---|---|
| W A S D | Move |
| Mouse | Look |
| Left click | Fire (hold for full-auto) |
| Right click | Aim down sights |
| Shift | Sprint |
| Space | Jump |
| R | Reload |

### Gameplay

- Escalating waves of hostiles spawn from the alleys and street ends —
  they chase, strafe, and fire with real line-of-sight checks.
- Use parked cars, concrete barriers, and crates as cover.
- COD-style regenerating health: break contact for 4 seconds to recover.
- Headshots deal double damage; ammo reserve refills each wave.

## Sponsors / advertising

Billboards on tower walls and street-level ad stands are configured in
[`sponsors.js`](sponsors.js) — edit the list to change sponsor names,
taglines, and brand colors. To show a real logo, add an image to the repo
(e.g. `ads/mybrand.png`) and set that entry's `logo` field to its path.
The Unity version has the same system in `unity/StreetOps/SponsorConfig.cs`.
