GB-Link Cart Doctor
===================

Dump and restore **Game Boy / Game Boy Color / Game Boy Advance**
cartridges from the browser. A GBA console is the
cartridge reader; a `GBLink USB <https://github.com/GB-Link/GBLink-Firmware>`_
adapter connects its link port to the PC, and the web app in ``web/`` drives
everything over WebUSB (or WebSerial on Firefox 151+).

How it works
============

Everything starts with a GBA multiboot upload over the link cable. Which
payload is sent depends on the cartridge type picked in the app:

- **Game Boy** — ``web/gba-switch-to-gbc_mb.gba`` switches the GBA into GBC
  mode by software (the gba-switch-to-gbc trick), then dumps or restores the
  inserted GB/GBC cartridge; the operation is chosen with the console's
  buttons.
- **Game Boy Advance** — ``web/gba-cart-dumper_mb.gba`` (a port of FIX94's
  *GBA Link Cable Dumper* from GameCube JOY bus to 32-bit link-cable SIO)
  stays in GBA mode; every operation is driven from the browser.

Using the web app
=================

Serve ``web/`` as static files (e.g. ``python3 -m http.server``), open it in
Chrome/Edge or Firefox 151+, click **Connect**, and pick the cartridge type —
**Game Boy** or **Game Boy Advance**. Only the matching workflow is shown and
the choice is remembered across reloads. Both workflows follow the same
shape: load the homebrew (**Send Multiboot**, or **Homebrew Already Loaded**
to adopt a payload that is still running), dump, restore.

Game Boy / Game Boy Color
-------------------------

Power on the GBA **without** a cartridge, send the multiboot, and wait for it
to switch to GBC mode. Then insert the GB/GBC cartridge. Some cartridges have
a voltage supervisor that resets the GBA on insertion — a small piece of
kapton tape over pin 30 (/RESET, 3rd pin from the right), or inserting
slowly, avoids this. Once the cartridge is detected, press on the console:

- **A** — dump the cartridge ROM (``.gb`` file)
- **B** — dump the cartridge SRAM / save (``.sav`` file)
- **START** — dump both the ROM and the SRAM
- **SELECT** — restore: write the ``.sav`` loaded in the web app back into
  the cart's SRAM

Dumps download automatically, and several cartridges can be dumped in a row
without re-sending the multiboot. ROM and SRAM transfers handle the common
mappers — MBC1, MBC2, MBC3 and MBC5 (including rumble carts); MBC2's built-in
512×4-bit save works for both dump and restore.

Link voltage
~~~~~~~~~~~~

Multiboot runs at **3.3V** (the GBA-native serial), but the GB/GBC dump and
restore are driven at **5V** — they are clocked by the GBLink as SPI master
and the GBA's GBC-mode serial slave will not synchronize to that clock at
3.3V (the receiver sees only ``0x00``/``0xFF`` and the dump never starts).
The original GBA (AGB) link port is nominally 3.3V; if you are unsure your
unit tolerates 5V, verify before relying on this. Set
``window.CART_DOCTOR_DEBUG = true`` in the browser console before a dump to
log what the header poll actually receives. See ``docs/3.3v_5v_issues.md``.

Game Boy Advance
----------------

Power on the GBA **without** a cartridge (or hold **START+SELECT** at the
logo if one is inserted), send the multiboot, then insert the cartridge and
work from the browser:

- **Read Cartridge** — title, game code, ROM size, save size (save type is
  detected from the ROM's ``EEPROM_V``/``SRAM_V``/``FLASH*_V`` ID strings).
- **Dump ROM** — saved as ``TITLE [CODE].gba``.
- **Dump Save / Restore Save / Erase Save** — EEPROM 512 B/8 KB, SRAM 32 KB,
  Flash 64/128 KB.
- **Dump BIOS** — the 16 KB console BIOS (Dark Fader's ``MidiKey2Freq``
  method); no cartridge needed.

The whole GBA session runs at **3.3V** with the same 32-bit timing multiboot
uses — no voltage switching involved. Throughput is bounded by the USB round
trip at roughly 35–40 KB/s: about 2 minutes for a 4 MB ROM, 13–15 minutes for
32 MB; saves and the BIOS take seconds. EEPROM save detection reads the
EEPROM itself, so **Read Cartridge** can take a few extra seconds on EEPROM
games.

Restoring and erasing saves
===========================

Restoring is **destructive** — it overwrites the save on the cartridge, and
the web app asks for confirmation first. In both workflows the transfer is
**refused unless the loaded file's size exactly matches the cartridge's save
memory**; on a refusal nothing is written. Every 256-byte section is
checksum-verified and re-sent on a mismatch. The GBA workflow's **Erase
Save** zero-fills the save memory (also behind a confirmation).

Note: the only content check is the **size**. A raw ``.sav`` carries no game
identity, so a same-size save from a *different* game (for example a 32 KB
Pokémon Silver save written to a 32 KB Pokémon Yellow cart) will be accepted
and will overwrite the target. Back up the destination cart first if unsure.

Device results
==============

The GBC-mode switch (Game Boy workflow):

- GBA: It works.
- GBA SP: It works.
- GB Micro: Correct boot ROM animation, with sound. Nintendo logo is white,
  which means the GBC CPU is reading zeroes from the cart instead of data.
- DS: It doesn't work at all. Black screen. I suppose it hangs in the infinite
  loop at the end of the code.
- GB Player: It works.

The Game Boy Advance workflow is tested on a GBA; it needs a console with a
link port.

Building
========

**Game Boy payload chain** (RGBDS + devkitARM): assemble
``source/gbc_payload/payload_fast.asm`` with RGBDS, run
``source/gbc_payload/convert_to_c.py`` on the resulting ``payload_fast.gbc``
to regenerate ``source/payload_array.h``, ``make`` the GBA ROM, and copy the
output to ``web/gba-switch-to-gbc_mb.gba``. (``make_sender.ps1`` /
``make_receiver.ps1`` drive the legacy nybble-protocol payload and its dummy
receiver.)

**Game Boy Advance payload** (devkitARM)::

    cd source/gba_cart_dumper
    DEVKITPRO=/opt/devkitpro DEVKITARM=/opt/devkitpro/devkitARM make
    cp gba-cart-dumper_mb.gba ../../web/

**Protocol test** — the GBA protocol has a word-for-word simulation (no
hardware needed)::

    node web/test/gba_protocol_sim.mjs

Technical details
=================

Game Boy protocol
-----------------

The web app uses the fast payload (``source/gbc_payload/payload_fast.asm``):
raw bytes in 0x100-byte sections, one XOR checksum per section, an ACK per
section, failed sections re-sent. A restore runs the same section protocol in
reverse — the web client (the SPI master) clocks out each data byte, the
cartridge writes it into SRAM and ACKs every section. A direction flag in the
GBC payload selects dump (cart → master) vs restore (master → cart); SELECT
on the GBA chooses restore, the other buttons choose a dump.

The legacy payload (``payload.asm``, still readable via ``dump_reader.py``)
sent each byte as 2 nybble transfers masked with 0x10, echo-checked one
transfer later, restarting from a checkpoint on mismatch; ``payload2.asm`` is
its dummy receiver.

Game Boy Advance protocol
-------------------------

The payload (``source/gba_cart_dumper/``) is an SPI **slave** on the GBA's
32-bit normal-mode SIO; the GBLink clocks one word per exchange. Host control
words carry ``0x4742`` ("GB") in the high half so a word torn by a mid-clock
re-arm can never be mistaken for a command; while the payload is busy with
the cartridge it is un-armed and the host reads a constant ``0xFFFFFFFF``.
Commands use an echo-confirm handshake (command → bitwise-NOT echo → GO), and
slow phases end with a DONE gate the host must acknowledge. Bulk data moves
in 256-byte sections closed by an XOR32 checksum and a verdict word, re-sent
on mismatch (the original Wii protocol had no integrity checking). The
simulation test above models the payload state machine word for word.

Credits
=======

Thanks to:

- Dwedit, for the original ROM that tried to enter GBC mode:

  https://www.dwedit.org/dwedit_board/viewtopic.php?id=339

- Extrems, for discovering that the code needs to be in IWRAM to actually work.

- AntonioND, the original gba-switch-to-gbc ROM this has been forked from:

  https://github.com/AntonioND/gba-switch-to-gbc

GBA cartridge support is ported from `wii-gba-link-cable-dumper
<https://github.com/DamianS-eng/wii-gba-link-cable-dumper>`_ (MIT):

- FIX94, the original GBA Link Cable Dumper.

- Chishm, the cartridge save routines (SendSave / libSave).

- Dark Fader, the GBA BIOS dump method.
