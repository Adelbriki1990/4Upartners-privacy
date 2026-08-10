# Raw model drop folder

Put **uncompressed** exports here — straight from Tripo3D, Sketchfab, Blender,
your USB stick, wherever. Do not shrink them yourself, do not rename them.
Big is fine here: 20 MB per file is normal and expected.

## How to get files here from your computer

1. Open https://github.com/adelbriki1990/4upartners-privacy
2. Switch to the branch `claude/3d-street-game-cod-style-sty46w` (top-left button)
3. Open this `incoming` folder
4. **Add file -> Upload files**, then drag the .glb files in from your USB
5. Green **Commit changes** button at the bottom

GitHub's web upload takes files up to 25 MB each, up to 100 at a time. If a
single file is bigger than 25 MB, re-export it from Tripo at a lower quality
setting first.

## Naming

Name them so it is obvious what they are — the name decides where they go in
the game:

    car_*        drivable / traffic cars      -> hero preset
    uniform_*    player outfits               -> char preset
    person_*     pedestrians                  -> char preset
    prop_*       boxes, signs, street clutter -> prop preset

## What happens next

Tell Claude "models uploaded". Each file gets run through
`../shrink_models.sh` (19 MB -> ~1 MB), checked against the package budget,
wired into the game, screenshotted, and then the raw copy is deleted from
this folder so the shipped package stays small.
