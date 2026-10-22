#!/bin/sh
# Rebuild the GBA cart dumper (web/gba-cart-dumper_mb.gba) and its screen
# graphics. Needs Python 3 and devkitARM (DEVKITARM set, or installed in
# /opt/devkitpro/devkitARM).
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
python3 "$root/tools/make_gba_ui.py"
cd "$root/source/gba_cart_dumper"
DEVKITPRO=${DEVKITPRO:-/opt/devkitpro} DEVKITARM=${DEVKITARM:-/opt/devkitpro/devkitARM} make
cp gba-cart-dumper_mb.gba "$root/web/"
