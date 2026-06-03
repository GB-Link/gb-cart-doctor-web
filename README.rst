gba-dump-gb
=================

Switch a GBA into GBC mode by software, then **dump and restore** GB/GBC
cartridges over the link cable — read out a cartridge's ROM or save, or write a
save back into it.

Boot ``gba-switch-to-gbc_mb.gba`` on the GBA **without** a cartridge inserted,
wait for it to switch to GBC mode, then properly insert your GB/GBC cartridge.
Once the cartridge is detected, the on-cart menu maps the buttons to:

- **A** — dump the cartridge ROM (saved as a ``.gb`` file)
- **B** — dump the cartridge SRAM / save (saved as a ``.sav`` file)
- **START** — dump both the ROM and the SRAM
- **SELECT** — **restore** a save: write a loaded ``.sav`` back into the cart's SRAM

GBLink Cart Doctor (web app)
----------------------------

The ``web/`` folder is **GBLink Cart Doctor**, a browser front-end (WebUSB, or
WebSerial on Firefox 151+) that drives the whole process for you. It requires the
`GBLink USB firmware <https://github.com/starlarkus/GBLink-Firmware>`_.

- **Send Multiboot** — push the dumper ROM to the GBA and start listening.
- **Homebrew Already Loaded** — skip the multiboot when the GBA is already
  running the dumper ROM (e.g. after a previous dump).
- **Restore Save** — load a ``.sav`` file, click, then press **SELECT** on the
  GBA to write it back.

Dumps download automatically, and several cartridges can be dumped in a row
without re-sending the multiboot. Some cartridges have a voltage supervisor that
resets the GBA on insertion — a small piece of kapton tape over pin 30 (/RESET,
3rd pin from the right), or inserting slowly, avoids this.

Restoring a save
----------------

Restoring is **destructive** — it overwrites the save currently on the
cartridge. The web app asks for confirmation first, and the transfer is
**refused unless the loaded file's size exactly matches the inserted cart's SRAM
size**; on a refusal the cart returns to its menu so nothing is written. Each
256-byte section is checksum-verified and re-sent on a mismatch.

Note: the only content check is the SRAM **size**. A raw ``.sav`` carries no game
identity, so a same-size save from a *different* game (for example a 32 KB
Pokémon Silver save written to a 32 KB Pokémon Yellow cart) will be accepted and
will overwrite the target. Back up the destination cart first if you are unsure.

Cartridge support
-----------------

ROM and SRAM transfers handle the common mappers — MBC1, MBC2, MBC3 and MBC5
(including rumble carts). MBC2's built-in 512×4-bit save is supported for both
dump and restore.

Device results
==================

- GBA: It works.
- GBA SP: It works.
- GB Micro: Correct boot ROM animation, with sound. Nintendo logo is white,
  which means the GBC CPU is reading zeroes from the cart instead of data.
- DS: It doesn't work at all. Black screen. I suppose it hangs in the infinite
  loop at the end of the code.
- GB Player: It works.

Building
==================

To build it, you need devkitPro (devkitARM) for the GBA ROM, and RGBDS for the
GBC payload.

The actual GBA ROM can be built using make_sender.ps1.

make_receiver.ps1 will make a dummy receiver which can be used to test the sender.

The web app uses the fast-protocol payload (``source/gbc_payload/payload_fast.asm``).
To rebuild it: assemble the payload with RGBDS, run
``source/gbc_payload/convert_to_c.py`` on the resulting ``payload_fast.gbc`` to
regenerate ``source/payload_array.h``, ``make`` the GBA ROM, and copy the output
to ``web/gba-switch-to-gbc_mb.gba``.

Technical details
=================

The Dumper (payload.asm) sends "single byte"s in 2 nybble transfers (masked with 0x10),
and it expects to receive the "single byte" it sent during the next "single byte" transfer.
Failing to do so will cause the transfer to restart from a checkpoint at the first occasion
by sending a FAIL. OK and FAIL are masked with 0x40. Details below.

First the GBC payload sends information about the transfer: whether it will be a ROM
one or a SRAM one. After that, it sends the size and does an extra transfer to check
that the receiver got the right size. If all went well, it sends an OK and starts
the actual transfer.

During the transfer, the dumper will send 0x100 "single byte"s and do an extra transfer
to also check the last byte it sent. If all went well, it sends an OK and continues on
to the next batch of 0x100 "single byte"s.

payload2.asm contains a dummy receiver which sends back what it just received.

The web app uses a faster variant (payload_fast.asm) that transfers raw bytes (no
nybble masking) with a single XOR checksum per 0x100-byte section. A restore runs
the same section protocol in reverse: the web client (the SPI master) clocks out each
data byte, the cartridge writes it into SRAM, and the cartridge ACKs every section.
A direction flag in the GBC payload selects dump (cart → master) vs restore
(master → cart); SELECT on the GBA chooses restore, the other buttons choose a dump.

Credits
=================

Thanks to:

- Dwedit, for the original ROM that tried to enter GBC mode:

  https://www.dwedit.org/dwedit_board/viewtopic.php?id=339

- Extrems, for discovering that the code needs to be in IWRAM to actually work.

- AntonioND, the original gba-switch-to-gbc ROM this has been forked from:

  https://github.com/AntonioND/gba-switch-to-gbc

- ShinyQuagsire, the idea for the project.
