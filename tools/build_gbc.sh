#!/bin/sh
# Rebuild the GB/GBC side: the GBC payload and its menu font, the GBA
# multiboot image that carries it (web/gba-switch-to-gbc_mb.gba), and the
# cartridge program the web page uploads to the GBC (web/gbc-agent.bin). Needs RGBDS, Python 3
# and devkitARM (DEVKITARM set, or installed in /opt/devkitpro/devkitARM).
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
python3 "$root/tools/make_gbc_ui.py"
cd "$root/source/gbc_payload"
rgbasm -i inc/ -o payload_fast.o payload_fast.asm
rgblink -x -o payload_fast.gbc payload_fast.o
rgbfix -C -p 0 -r 0 -t CGB_EXAMPLE -v payload_fast.gbc
python3 convert_to_c.py payload_fast.gbc > ../payload_array.h
rgbasm -i inc/ -o agent.o agent.asm
rgblink -x -o "$root/web/gbc-agent.bin" agent.o
rm -f payload_fast.o agent.o
cd "$root"
DEVKITARM=${DEVKITARM:-/opt/devkitpro/devkitARM} make
mv "$root/$(basename "$root")_mb.gba" "$root/web/gba-switch-to-gbc_mb.gba"
