#!/usr/bin/env bash
# Squeeze a raw model export (Tripo3D, Sketchfab, Blender...) down to something
# the browser can download on a phone. Raw AI exports are 10-20 MB each; the
# whole portal package has to stay under 50 MB, so nothing ships uncompressed.
#
#   ./shrink_models.sh incoming/*.glb            # -> models/, default quality
#   ./shrink_models.sh --preset hero  car.glb    # bigger textures, keep detail
#   ./shrink_models.sh --preset prop  box.glb    # tiny, for background objects
#
# Presets pick texture resolution + how hard the mesh is simplified:
#   hero   1024px  error 0.002   player car / anything filling the screen
#   char    512px  error 0.005   uniforms, pedestrians, animals   (default)
#   prop    256px  error 0.02    boxes, signs, street clutter
#
# Compression is meshopt, NOT draco: lib/jsm/libs/meshopt_decoder.module.js is
# already vendored and wired up in game.js, so meshopt files need no new
# download. Draco would mean shipping a decoder we don't currently have.
set -euo pipefail
cd "$(dirname "$0")"

command -v gltf-transform >/dev/null 2>&1 || {
  echo "gltf-transform missing. install it with:"
  echo "  npm i -g @gltf-transform/cli"
  exit 1
}

PRESET=char
OUT=models
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --preset) PRESET="$2"; shift 2 ;;
    --out)    OUT="$2";    shift 2 ;;
    -*)       echo "unknown flag: $1"; exit 1 ;;
    *)        ARGS+=("$1"); shift ;;
  esac
done
[ ${#ARGS[@]} -gt 0 ] || { echo "usage: ./shrink_models.sh [--preset hero|char|prop] file.glb ..."; exit 1; }

case "$PRESET" in
  hero) TEX=1024; ERR=0.002; BUDGET=900 ;;
  char) TEX=512;  ERR=0.005; BUDGET=600 ;;
  prop) TEX=256;  ERR=0.02;  BUDGET=200 ;;
  *)    echo "unknown preset: $PRESET (hero|char|prop)"; exit 1 ;;
esac

mkdir -p "$OUT"
echo "preset $PRESET — textures ${TEX}px, simplify error $ERR, budget ${BUDGET} KB"
over=0
for src in "${ARGS[@]}"; do
  base=$(basename "$src")
  # game.js only ever looks for lowercase a-z0-9_ names
  name=$(echo "${base%.*}" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_]/_/g')
  dst="$OUT/$name.glb"
  before=$(( $(stat -c%s "$src") / 1024 ))
  gltf-transform optimize "$src" "$dst" \
    --compress meshopt \
    --texture-size "$TEX" \
    --texture-compress webp \
    --simplify-error "$ERR" >/dev/null 2>&1
  after=$(( $(stat -c%s "$dst") / 1024 ))
  flag=""
  if [ "$after" -gt "$BUDGET" ]; then flag="  <-- OVER BUDGET"; over=$((over+1)); fi
  printf "  %-26s %6s KB -> %5s KB%s\n" "$name.glb" "$before" "$after" "$flag"
  if [ -n "$flag" ]; then
    echo "      most likely too many materials — in Tripo export ONE material,"
    echo "      or drop a preset (hero -> char -> prop)"
  fi
done

total=$(du -sk "$OUT" | cut -f1)
echo "$OUT/ now $(( total / 1024 )) MB total  (portal limit is 50 MB for the whole package)"
[ "$over" -eq 0 ] || echo "$over file(s) over budget — rerun those with a smaller preset."
