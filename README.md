# Street Ops — 3D Urban Combat & Delivery

A Call-of-Duty-style browser game where you're a **delivery driver in a
living city** — pick up orders for real sponsor apps, ride scooters and
supercars, fight off robbers, level up to 100 — or switch to pure combat
waves. Sponsor advertising is built into the world (billboards, ad stands,
storefronts, courier uniforms).

**Play it live:** https://4-upartners-privacy.vercel.app

| Version | Where | Tech |
|---|---|---|
| **Browser game** | `index.html` + `game.js` + `sponsors.js` | Three.js (CDN import map), runs anywhere |
| **Unity port** | `unity/StreetOps/` | C# scripts, builds itself at Play time — see [`unity/README.md`](unity/README.md) |

## Features

- **👤 Driver profile** — create your username, choose man/woman, roll your
  look (skin tone, hair, outfit) with a live 3D preview. Saved locally.
- **🛵 Delivery Shift mode** — courier for the city's sponsor app
  (*SNOONU DRIVER* in Marina Bay): follow beacons to pick up and deliver
  orders, earn cash, defend deliveries from robbers.
- **🔫 Combat Waves mode** — classic survival against escalating hostiles.
- **⭐ 100 driver levels** — XP from deliveries, kills and wave clears;
  persistent across sessions; difficulty and payouts scale with level.
- **🌗 Real-time day/night** — the city matches your actual local clock
  (`?time=day` / `?time=night` to override).
- **🏙️ Three cities** — Neon District (rain-soaked megacity), Marina Bay
  (warm gulf downtown), Red Harbor (old-town brick) — each with its own
  weather, architecture and sponsor roster, on a full ~360 m street grid.
- **🚗 Vehicle fleet** — sedan, CRUISER 4X4, ROSSO GT, TORO HYPER (180 km/h),
  LUX SEDAN, PHANTOM LIMO, delivery scooters with branded boxes, and
  bicycles. Press E to drive anything; each handles differently.
- **⚡ Red Bull boost** — collect cans, press Q to drink: 8-second speed
  surge on foot or behind the wheel.
- **🚶 Living streets** — human pedestrians (men and women, varied looks)
  who flee gunfire; AI traffic that brakes for you; trees, traffic lights,
  awnings, contact shadows.
- **🎬 Cinematics** — letterboxed intro flyover, rain and thunder, slow-mo
  wave clears, film grain, death cam.
- **🔫 Weapon loadout** — MK-4 rifle, P9 sidearm, Viper SMG (keys 1/2/3),
  hitmarkers, headshot bonus, COD-style regenerating health.

## Controls

| Input | Action |
|---|---|
| W A S D | Move / drive |
| Mouse | Look, Left click fire, Right click aim |
| Shift / Space | Sprint / jump |
| E | Enter or exit vehicle |
| Q | Drink Red Bull (speed boost) |
| 1 2 3 | Switch weapon |
| R | Reload |

## Run locally

```bash
# from the repo root
python3 -m http.server 8000
# then open http://localhost:8000
```

Three.js loads from the jsDelivr CDN via the import map in `index.html`.
For fully offline play, download
[`three.module.min.js`](https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.min.js)
into a `lib/` folder and point the import map at `./lib/three.module.min.js`.

## Sponsors / advertising

Each city's sponsor roster lives in [`sponsors.js`](sponsors.js) — sponsors
appear as billboards, street ad stands, storefront signs, delivery-scooter
boxes and the driver's courier uniform. Edit names, taglines and brand
colors there.

To show a **real logo** (Snoonu, BMW, Coca-Cola, Red Bull, …): on GitHub
click *Add file → Upload files*, create an `ads/` folder, and upload the
official logo as the path named in that sponsor's `logo` field (e.g.
`ads/snoonu.png`). Billboards pick it up automatically. Use official brand
assets and get each sponsor's permission before publishing commercially
with their branding — the same applies to naming vehicles after real car
brands.

The Unity version has the same system in `unity/StreetOps/SponsorConfig.cs`.
