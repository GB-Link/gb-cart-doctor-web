GB-Link Cart Doctor
===================

Dump and restore **Game Boy / Game Boy Color / Game Boy Advance**
cartridges, and write ROMs to **GBA flash carts** (repros and flash carts),
from the browser. A GBA console is the
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
- **Dump ROM** — saved as ``TITLE [CODE].gba`` at the ROM's own size. On a
  flash cart that is the file that was written to it, without the erased
  space after it.
- **Dump Save / Restore Save / Erase Save** — EEPROM 512 B/8 KB, SRAM 32 KB,
  Flash 64/128 KB.
- **Dump BIOS** — the 16 KB console BIOS (Dark Fader's ``MidiKey2Freq``
  method); no cartridge needed.

The whole GBA session runs at **3.3V** with the same 32-bit timing multiboot
uses — no voltage switching involved. A ROM dump takes about 1.5 minutes per
4 MB of game data; padding and erased space take almost no time. Saves and
the BIOS take seconds. EEPROM save detection reads the EEPROM itself, so
**Read Cartridge** can take a few extra seconds on EEPROM games.

Writing ROMs to GBA flash carts
-------------------------------

Repro ("bootleg") carts and flash carts can be rewritten with a ROM of your
choice, from the same GBA workflow:

1. Send the multiboot as above and insert the flash cart.
2. Click **Detect Flash Cart**. The page names the cart type, its flash ID
   and size. If more than one cart type shares that flash ID, the others are
   listed too. If the chip reports more memory than its cart type lists, both
   sizes are shown and the chip's is used.
3. Choose a ``.gba`` file and click **Write ROM**. Wait for *Flash cart
   written and verified*, then power-cycle the GBA to play.

Writing takes roughly 2 minutes for 4 MB. Parts of the chip that already
hold the right data are skipped, so writing the same ROM again (or finishing
a cancelled write) is quick. Everything written is read back and checked. A
ROM bigger than the chip is refused before anything is erased.

Old data after the ROM, left from a bigger ROM written earlier, is erased
too, so a dump of the cart gives back just the new ROM. Untick **Erase old
data after the ROM** to keep it, for example a batteryless save stored
there. Other games on a multi-game cart are never touched.

Supported carts:

- every GBA flash cart type `FlashGBX <https://github.com/Lesserkuma/FlashGBX>`_
  knows that a GBA can drive: AMD-, Intel- and Sharp-style chips, single-word
  and buffered writing, chips with swapped data lines, two-chip
  Flash2Advance carts, carts with two 8-bit dies, and multi-game carts bigger
  than 32 MB that switch banks;
- carts none of those match: the page then scans for the chip the way
  `Burn2Slot <https://github.com/vrodin/Burn2Slot>`_ does, trying six
  data-line wirings and six command layouts for AMD-style chips, and also
  checking for Intel-style chips.

If detection picks the wrong type, choose one from the **Cart type** list;
the write then uses it as given.

Things to know:

- Carts that keep their save in the flash chip itself ("batteryless" saves)
  may lose it when the ROM is rewritten. Back the save up first. Saves on a
  battery-backed chip are not touched.
- Writing to GB/GBC flash carts is not supported yet.
- A cart with a flash chip none of the profiles or the scan recognise is
  reported as "No writable flash chip found", together with the flash IDs
  the cart answered with.
- A ROM file that ends in 0xFF bytes dumps back without them. The game plays
  the same, because the cart reads 0xFF there anyway.

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

**Flash cart test** — writes ROMs end to end to simulated flash chips (one
per kind of cart above), using the payload's real cart code compiled for the
PC. Needs a C compiler::

    node web/test/flashcart_test.mjs

**Flash cart profiles** — ``web/flashcart_profiles.js`` is generated from a
FlashGBX checkout; re-run this to pick up new carts::

    python3 tools/import_flashgbx.py ../FlashGBX

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
on mismatch (the original Wii protocol had no integrity checking). ROM dumps
instead stream numbered, checksummed records with no per-section reply; a
run of identical sections goes as one short record, and the host asks for a
resend from the first bad or missing record. The simulation test above
models the payload state machine word for word.

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

GBA flash cart writing uses:

- Lesserkuma's `FlashGBX <https://github.com/Lesserkuma/FlashGBX>`_ (GPL-3.0):
  the flash cart profiles, flash detection and CFI handling.

- vrodin's `Burn2Slot <https://github.com/vrodin/Burn2Slot>`_ (MIT): the
  flash chip scan for carts no profile matches, by way of the Burn2Slot for
  GB-Link port.
