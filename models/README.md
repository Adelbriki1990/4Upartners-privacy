# 3D model assets

Drop game-ready **.glb** files in this folder (from Kenney, Quaternius,
Sketchfab, CGTrader, Tripo3D, etc.).

## Size — read this before uploading

**Raw exports are far too big to ship.** A Tripo3D or Sketchfab download is
normally 10–20 MB; the whole portal package has to stay under **50 MB** and
still load fast on a phone. Send the raw file anyway — then run it through
the compressor, which does the shrinking for you:

    npm i -g @gltf-transform/cli      # once
    ./shrink_models.sh --preset hero incoming/my_car.glb

| preset | use for | textures | target per file |
|--------|---------|----------|-----------------|
| `hero` | player cars, anything filling the screen | 1024px | ≤ 900 KB |
| `char` | uniforms, pedestrians, animals | 512px | ≤ 600 KB |
| `prop` | boxes, signs, street clutter | 256px | ≤ 200 KB |

Typical result: **19 MB → 1.1 MB**, with no visible difference at gameplay
distance. Compression is meshopt, which `game.js` already decodes — do not
use Draco, that decoder is not vendored.

The single biggest cost is the **number of materials**, not the triangle
count: every extra material drags its own texture set. Exporting one model
with one material beats a simplified model with thirty.

Suggested contents:
- 6–8 cars (sedan, SUV, sports, taxi, van, …)
- a delivery scooter / motorbike
- optional: character models

After uploading, tell Claude "models uploaded" and the game will be wired
to load them (parked cars, traffic, and drivable vehicles).

Keep the license terms of each asset pack — CC0 packs (Kenney/Quaternius)
need nothing; CC-BY assets need a credit line here:

## Credits
- (add asset credits here if required by their license)
