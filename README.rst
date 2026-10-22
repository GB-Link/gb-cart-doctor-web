GB-Link Cart Doctor
===================

Back up and restore **Game Boy, Game Boy Color and Game Boy Advance**
cartridges from your web browser, and write ROMs to **GB/GBC and GBA flash
carts** (including repro carts).

You need:

- a Game Boy Advance or GBA SP, which does the actual reading and writing;
- a `GB-Link USB <https://github.com/GB-Link/GBLink-Firmware>`_ adapter,
  which connects the GBA's link port to your computer;
- Chrome, Edge, or Firefox 151 or newer.

How it works
============

The web page sends a small program to the GBA over the link cable
("multiboot"), so the GBA runs it without a cartridge. Which program it sends
depends on the kind of cartridge you pick:

- **Game Boy** — the program switches the GBA into its built-in Game Boy
  Color mode, so it can read GB and GBC cartridges.
- **Game Boy Advance** — the program stays in GBA mode and reads GBA
  cartridges. It is based on FIX94's *GBA Link Cable Dumper*.

Everything after that is controlled from the page. The GBA's buttons do
nothing.

Using the page
==============

Serve the ``web`` folder as a website (for example with
``python3 -m http.server`` run inside it) and open it in your browser. Click
**Connect**, then pick **Game Boy** or **Game Boy Advance**. The page
remembers your choice.

A three-step checklist walks you through getting started:

1. **Connect** to the GB-Link.
2. **Load the homebrew**: click **Send Multiboot**. If the GBA is still
   running it from before (say you reloaded the page), click **Already
   Loaded** instead.
3. **Read the cartridge.**

Each step ticks itself off when it's done. The **Cartridge** card then shows
what's inserted, and the tabs below it hold the work: **Back Up**, restoring a
save, and **Flash Cart**.

The panel on the right shows what's running, how far along it is and roughly
how long is left, with a **Cancel** button. Finished backups appear in its
**Files** list. Nothing is saved to your computer until you click **Save**
next to a file. Anything that would overwrite a cartridge asks you first.

You can pick save and ROM files with a click or drop them onto the file
boxes. When you choose a save file, the page tells you straight away whether
its size matches the cartridge.

Game Boy and Game Boy Color
---------------------------

1. Turn on the GBA **without** a cartridge and click **Send Multiboot**.
   Wait for the GBA to switch to Game Boy Color mode. Its screen says
   "No cartridge".
2. Insert the GB or GBC cartridge. The screen changes to "Cartridge ready"
   and shows the game's title.
3. Work from the page:

   - **Read Cartridge** shows the title, mapper, ROM size and save size.
   - **Dump ROM** saves the game as ``TITLE.gb``, or ``TITLE.gbc`` for Game
     Boy Color games.
   - **Dump Save** and **Restore Save** back up or write the cartridge's
     battery save (``.sav``).

You can swap cartridges between jobs without sending the multiboot again.
The GBA's screen goes blank while the page is working with the cartridge and
comes back when it's done.

Supported cartridges: carts without a mapper, and the common mappers MBC1,
MBC2, MBC3 and MBC5 (including rumble carts). The clock in carts with a
real-time clock is not saved.

**If the GBA resets when you insert a cartridge:** some cartridges have a
voltage-check chip that resets the console. Insert the cartridge slowly, or
put a small piece of kapton tape over pin 30 (the third pin from the right).

Link voltage
~~~~~~~~~~~~


Game Boy Advance
----------------

1. Turn on the GBA **without** a cartridge and send the multiboot. (If a
   cartridge is already in, hold **START + SELECT** while the Nintendo logo
   shows.)
2. Insert the cartridge. The GBA's screen shows its title and game code.
3. Work from the page:

   - **Read Cartridge** shows the title, game code, ROM size and save type
     and size.
   - **Dump ROM** saves the game as ``TITLE [CODE].gba``. On a flash cart you
     get back the ROM that was written to it, without the empty space after
     it.
   - **Dump Save**, **Restore Save** and **Erase Save** work with every save
     type: EEPROM (512 bytes or 8 KB), SRAM (32 KB) and Flash (64 or 128 KB).
   - **Dump BIOS** saves the console's 16 KB BIOS. No cartridge needed.

While it works, the GBA's screen shows what it's doing and a progress bar.

A ROM dump takes about 1.5 minutes per 4 MB of game. Empty space at the end
of a ROM takes almost no time. Saves and the BIOS take a few seconds. Games
with an EEPROM save take a few extra seconds to read, because the save size
is found by testing the chip.

The whole GBA session runs at 3.3V.

Writing ROMs to GBA flash carts
-------------------------------

Repro ("bootleg") carts and flash carts can be rewritten with a ROM of your
choice:

1. Send the multiboot as above and insert the flash cart.
2. Click **Detect Flash Cart**. The page shows the cart type, the flash chip's
   ID and its size. If other cart types use the same chip, they are listed
   too.
3. Choose a ``.gba`` file and click **Write ROM**. Wait for *ROM written and
   checked*, then turn the GBA off and on again to play.

Writing 4 MB takes about 2 minutes. Parts of the chip that already hold the
right data are skipped, so writing the same ROM again, or finishing a
cancelled write, is quick. Everything is read back and checked after writing.
A ROM that is too big for the chip is refused before anything is erased.

Leftover data after the new ROM (from a bigger ROM written earlier) is erased
as well, so dumping the cart later gives you just the new ROM. Untick **Erase
old data after the ROM** if you want to keep it, for example if the cart
keeps its save there. Other games on a multi-game cart are never touched.

Supported carts:

- every GBA flash cart type that `FlashGBX
  <https://github.com/Lesserkuma/FlashGBX>`_ knows and a GBA can drive. That
  covers most repro carts, multi-chip carts and large multi-game carts.
- other carts: if no known type matches, the page searches for the flash
  chip the way `Burn2Slot <https://github.com/vrodin/Burn2Slot>`_ does, trying
  the common chip wirings.

If the page picks the wrong cart type, choose the right one from the **Cart
type** list and the write uses that.

Good to know:

- Some carts keep their save inside the flash chip instead of on a
  battery-backed chip ("batteryless" saves). Rewriting the ROM can wipe that
  save, so back it up first. Battery-backed saves are not touched.
- If the page says "No writable flash chip found", it couldn't recognise the
  chip. The message includes the IDs the chip answered with.
- If a ROM file ends in a run of 0xFF bytes, dumping it back leaves those off.
  The game plays the same, because an empty flash chip reads as 0xFF anyway.

Writing ROMs to GB/GBC flash carts
----------------------------------

1. Send the multiboot as above and insert the flash cart. A blank flash cart
   has no game on it, so the GBA keeps saying "No cartridge". That's fine.
2. Click **Detect Flash Cart**. The page shows the cart type, the flash chip's
   ID and its size.
3. Choose a ``.gb`` or ``.gbc`` file and click **Write ROM**. Wait for *ROM
   written and checked*, then turn the GBA off and on again to play.

Writing to an empty cart takes about 3.5 minutes per MB. Writing the same ROM
again takes about a minute per MB, and finishing a cancelled write is quick.
Everything is read back and checked. A ROM that is too big for the cart is
refused before anything is erased. As with GBA carts, leftover data after the
ROM is erased unless you untick **Erase old data after the ROM**.

Supported carts: most current GB/GBC flash carts, including insideGadgets and
GBFlash carts — every type `FlashGBX <https://github.com/Lesserkuma/FlashGBX>`_
knows that is written through the cartridge's normal write pin. A cart that
isn't in the list but answers like a flash chip is written with FlashGBX's
general settings. If the page picks the wrong cart type, choose the right one
from the **Cart type** list.

Not supported:

- carts written through the cartridge's audio pin (many older and home-made
  carts). A GBC has no way to drive that pin.
- carts that need their power or reset line switched while writing, and carts
  with their own systems (GB Memory, Action Replay, Xploder).

The cart's save is not touched. Carts with a batteryless save may lose it,
so back it up first.

Restoring and erasing saves
===========================

Restoring a save **overwrites** the save on the cartridge, so the page asks
you first. It only goes ahead if the file is **exactly the same size** as the
cartridge's save memory. Otherwise nothing is written. Everything sent is
checked and sent again if it arrives damaged.

**Erase Save** (GBA only) wipes the save memory, also after asking you first.

Be careful: the size is the only thing the page can check. A save file doesn't
say which game it belongs to, so a save from a *different* game of the same
size (for example a Pokémon Silver save on a Pokémon Yellow cart, both 32 KB)
is accepted and replaces the save on the cart. Back up the cartridge first if
you're not sure.

Which consoles work
===================

For Game Boy cartridges (the switch to Game Boy Color mode):

- GBA: works.
- GBA SP: works.
- Game Boy Player: works.
- Game Boy Micro: doesn't work. The startup animation plays, but the
  Nintendo logo is blank because the console can't read the cartridge.
- Nintendo DS: doesn't work. The screen stays black.

For GBA cartridges you need a console with a link port. Tested on a GBA.

Building
========

The ready-built programs are already in ``web``. You only need this if you
change them.

**Game Boy side** (needs RGBDS, Python 3 and devkitARM)::

    tools/build_gbc.sh

**Game Boy Advance side** (needs Python 3 and devkitARM)::

    tools/build_gba.sh

**Flash cart lists** are made from a copy of FlashGBX. Run this again to pick
up new cart types::

    python3 tools/import_flashgbx.py ../FlashGBX

Tests
-----

None of these need any hardware.

- GBA link test::

      node web/test/gba_protocol_sim.mjs

- GBA flash cart test, which writes ROMs to simulated flash chips (needs a C
  compiler)::

      node web/test/flashcart_test.mjs

- Game Boy test, which runs the real Game Boy programs on an emulated Game Boy
  CPU against simulated cartridges and flash carts. Needs a C compiler, RGBDS
  and a copy of the mGBA source code, either in a folder named ``mgba`` next
  to this one or set with ``MGBA_SRC=/path/to/mgba``::

      node web/test/gb_test.mjs

How the link works
==================

The GB-Link drives the link cable's clock, and the GBA answers one piece of
data at a time.

Data moves in small blocks. Each block carries a checksum, and the receiver
says whether it arrived intact. A damaged block is sent again. Commands are
confirmed in both directions before anything starts, so a garbled command
can't trigger the wrong job.

On the Game Boy side, the page also uploads a small helper program into the
Game Boy Color's memory. The page uses it to read the cartridge header and to
write flash carts.

On the GBA side, ROM dumps stream without waiting for a reply after every
block, which makes them faster. Long runs of identical data (such as empty
space) are sent as a single short block. If anything goes missing, the page
asks the GBA to resend from that point.

Credits
=======

Thanks to:

- Dwedit, for the original ROM that tried to enter GBC mode:
  https://www.dwedit.org/dwedit_board/viewtopic.php?id=339
- Extrems, for discovering that the code needs to be in the GBA's internal
  work RAM (IWRAM) to work.
- AntonioND, for gba-switch-to-gbc, which this project started from:
  https://github.com/AntonioND/gba-switch-to-gbc

GBA cartridge support is ported from `wii-gba-link-cable-dumper
<https://github.com/DamianS-eng/wii-gba-link-cable-dumper>`_ (MIT):

- FIX94, for the original GBA Link Cable Dumper.
- Chishm, for the cartridge save code (SendSave / libSave).
- Dark Fader, for the GBA BIOS dump method.

Flash cart writing uses:

- Lesserkuma's `FlashGBX <https://github.com/Lesserkuma/FlashGBX>`_
  (GPL-3.0): the flash cart lists, flash chip detection and chip
  information handling.
- vrodin's `Burn2Slot <https://github.com/vrodin/Burn2Slot>`_ (MIT): the
  flash chip search for carts no known type matches, by way of the Burn2Slot
  for GB-Link port.
