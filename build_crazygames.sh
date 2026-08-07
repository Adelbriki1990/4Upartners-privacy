#!/usr/bin/env bash
# Build the clean-brand CrazyGames package: no real trademarks, no external
# CDN (three.js is vendored in lib/), CrazyGames SDK enabled via CLEAN_BUILD.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist_crazygames crazygames.zip
mkdir dist_crazygames

cp -r icons lib dist_crazygames/
cp game.js sponsors.js manifest.json dist_crazygames/

# only the models game.js actually loads — stray uploads (huge test cars,
# duplicate people, brand art) would push the package past the 50MB limit
mkdir dist_crazygames/models
for f in $(grep -oE "models/[a-z0-9_]+\.(glb|png|jpg)" game.js | sort -u); do
  cp "$f" dist_crazygames/models/
done

# flag the build as clean so the game swaps every real brand for a
# fictional one and activates the CrazyGames SDK
sed 's|<head>|<head><script>window.CLEAN_BUILD=true</script>|' index.html \
  > dist_crazygames/index.html

# the portal build carries no uploaded logo art and no service worker
mkdir dist_crazygames/ads
cp ads/README.md dist_crazygames/ads/ 2>/dev/null || true

(cd dist_crazygames && zip -qr ../crazygames.zip .)
echo "built: $(du -h crazygames.zip | cut -f1) crazygames.zip"
