#!/usr/bin/env bash
# Build one clean-brand package per portal. Every package is trademark-free and
# fully self-contained (three.js vendored in lib/, no CDN, no service worker);
# they differ only in which ad SDK is switched on.
#
#   ./build_portals.sh              # all portals
#   ./build_portals.sh poki itch    # just these
#
# GameDistribution needs the game id they assign after registration:
#   GD_GAME_ID=xxxxxxxx ./build_portals.sh gd
set -euo pipefail
cd "$(dirname "$0")"

TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ]; then TARGETS=(crazygames poki gd itch); fi
GD_GAME_ID="${GD_GAME_ID:-}"

build_one() {
  local name="$1" sdk="$2" dist="dist_$1" zipf="$1.zip"
  rm -rf "$dist" "$zipf"
  mkdir "$dist"

  cp -r icons lib "$dist/"
  cp game.js sponsors.js manifest.json "$dist/"

  # only the models game.js actually loads — stray uploads (huge test cars,
  # duplicate people, brand art) would blow past the portals' size limits
  mkdir "$dist/models"
  for f in $(grep -oE "models/[a-z0-9_]+\.(glb|png|jpg)" game.js | sort -u); do
    cp "$f" "$dist/models/"
  done

  # CLEAN_BUILD strips every real trademark; PORTAL_SDK picks the ad network
  # (empty on itch/Y8/own-site builds, where the ad buttons stay hidden)
  local flags="window.CLEAN_BUILD=true;"
  if [ -n "$sdk" ]; then
    # only this portal's SDK address ends up in this package
    local sdksrc=""
    case "$sdk" in
      crazygames) sdksrc="https://sdk.crazygames.com/crazygames-sdk-v3.js" ;;
      poki)       sdksrc="https://game-cdn.poki.com/scripts/v2/poki-sdk.js" ;;
      gd)         sdksrc="https://html5.api.gamedistribution.com/main.min.js" ;;
    esac
    flags="${flags}window.PORTAL_SDK='${sdk}';window.PORTAL_SDK_SRC='${sdksrc}';"
  fi
  if [ "$sdk" = "gd" ] && [ -n "$GD_GAME_ID" ]; then
    flags="${flags}window.GD_GAME_ID='${GD_GAME_ID}';"
  fi
  sed "s|<head>|<head><script>${flags}</script>|" index.html > "$dist/index.html"

  # portal builds carry no uploaded logo art and no service worker
  mkdir "$dist/ads"
  cp ads/README.md "$dist/ads/" 2>/dev/null || true

  (cd "$dist" && zip -qr "../$zipf" .)
  echo "  $zipf — $(du -h "$zipf" | cut -f1)  (sdk: ${sdk:-none})"
}

echo "building portal packages:"
for t in "${TARGETS[@]}"; do
  case "$t" in
    crazygames) build_one crazygames crazygames ;;
    poki)       build_one poki poki ;;
    gd)         build_one gamedistribution gd ;;
    itch|y8|generic) build_one itch "" ;;
    *) echo "  unknown target: $t" ;;
  esac
done
echo "done."
