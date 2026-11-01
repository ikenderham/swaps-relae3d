#!/usr/bin/env bash
# Relæet i 3D-testmiljøet (XAMPP): port 3013, 3D's lokale PHP og rummene fra 3d/filer/rum ved siden af.
# Hemmeligheden læses fra den lokale 3d_config.php, som 3D's PHP også bruger, og skrives aldrig ud.
set -euo pipefail
cd "$(dirname "$0")"

KONFIG="${S3D_KONFIG:-C:/xampp/swaps3d_privat/3d_config.php}"
S3D_RELAE_HEMMELIGHED="$(php -r 'require $argv[1]; echo S3D_RELAE_HEMMELIGHED;' "$KONFIG")"
export S3D_RELAE_HEMMELIGHED
export PHP_BASE=http://swaps3d.localhost/swaps3d/3d
export RUM_BASE=../3d/filer/rum
export CORS_ORIGIN=http://swaps3d.localhost
export PORT=3013
exec node index.js
