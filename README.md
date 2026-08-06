# Street Ops — 3D Urban Combat

A Call-of-Duty-style first-person shooter set in a downtown city street at
night, with sponsor advertising built into the world. It ships in **two
versions**:

| Version | Where | Tech |
|---|---|---|
| **Browser game** | `index.html` + `game.js` | Three.js (via CDN import map), runs anywhere |
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

Three.js loads from the jsDelivr CDN via the import map in `index.html`.
For fully offline play, download
[`three.module.min.js`](https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.min.js)
into a `lib/` folder and point the import map at `./lib/three.module.min.js`.

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

- **Three selectable cities**, each with its own atmosphere and sponsor
  roster: Neon District (rain-soaked megacity), Marina Bay (warm gulf
  downtown), Red Harbor (old-town brick). Your choice is remembered.
- A **full city grid** (~360 m across): streets, intersections, crosswalks,
  storefronts with neon signs, towers with lit windows, rooftop clutter.
- **Drivable cars** — walk to any parked car and press E; run hostiles
  over, press E again to bail out.
- Cinematic intro flyover, rain/thunder (per city), slow-mo wave-clears,
  minimap with live enemy positions.
- Escalating hostile waves spawn on nearby streets — enemies chase, strafe,
  and fire with real line-of-sight checks. Use cars and barriers as cover.
- COD-style regenerating health: break contact for 4 seconds to recover.
- Headshots deal double damage; ammo reserve refills each wave.

## Sponsors / advertising

Each city has its own sponsor roster in [`sponsors.js`](sponsors.js) —
sponsors appear as billboards on tower walls, street-level ad stands, and
storefront signs in that city. Edit names, taglines, and brand colors there.

To show a **real logo** (Snoonu, BMW, Coca-Cola, Red Bull, …): create an
`ads/` folder in the repo, drop the official logo file in (e.g.
`ads/snoonu.png`), and set that sponsor's `logo` field to the path — it is
drawn on the billboards automatically. Use each brand's official assets and
make sure you have the sponsor's permission before publishing the game
commercially with their branding.

The Unity version has the same system in `unity/StreetOps/SponsorConfig.cs`.
