# Spec: 5V link for the GBC-mode dump/restore

## Problem

On some hardware the web app would multiboot fine, switch the GBA to GBC mode,
detect the cartridge, and show the on-cart menu — but pressing A/B/START blanked
the GBA screen and then nothing happened in the browser. No progress, no error.
The dump never started.

## Investigation

Symptom decomposition:

- The blank screen is expected: `payload_fast.asm` disables the LCD right before
  entering the transfer routine. So the GBA *did* register the press and armed
  its serial to send the 4-byte header `[0xF5, type, size, checksum]`.
- The browser sits in `FastDumpReceiver.readHeader()` clocking `0x00` bytes,
  waiting to see `0xF5`. That loop silently discarded every non-`0xF5` byte, so
  "nothing happened" hid the actual signal.

Temporary instrumentation was added to `readHeader()` (now gated behind
`window.CART_DOCTOR_DEBUG`) to log a per-second histogram of received bytes,
per-poll latency, a `0xF5` bit-rotation check, and the first non-rail byte. It
showed:

- **Idle (pre-button):** pure `0x00` at ~2,400 polls/sec, ~0.4 ms latency. The
  un-armed GBC holds `SO` = MSB of `SB=0x10` = 0, so the device reads `0x00`.
  Expected.
- **After pressing A:** only `0x00` (~70%) and `0xFF` (~30%) — **never a single
  mixed-bit byte.** A byte that is entirely low or entirely high means the data
  line did not change during the device's 8 clock pulses. The GBC armed its
  serial but **never shifted data in sync with the device's clock.**
- **During GBA power-off (brownout):** a clean, checksum-valid header appeared
  and the dump ran to ~17% before the dying GBA stopped responding. Reproducible.

### Root cause

The GBC-mode transfer is clocked by the GB-Link device acting as **SPI master**;
the GBA-in-GBC-mode serial is the **slave**. At the app's default **3.3V** link
voltage, the GBA's GBC-mode serial slave would not synchronize to the device's
clock — bytes never shifted. A real Game Boy / Game Boy Color link runs at
**5V**, and the dump only succeeded transiently as the GBA's levels drifted
during power-down.

This is consistent with the other observations:

- **Multiboot works at 3.3V** — it uses the GBA-*native* serial peripheral, not
  the GBC-mode one.
- **Pokémon trading works** (a separate GBLink project) — there the GBA is the
  clock master and the device is the slave, so the failing master→GBC-slave
  clocking is never exercised.

## Decision

- **Force 5V for the GBC dump and restore phases.** This was the user's chosen
  option over a UI toggle or auto-retry, given their GBA is confirmed 5V-tolerant
  (their trading setup already drives it at 5V).
- **Reset to 3.3V before every multiboot.** Multiboot uses the GBA-native serial
  and expects 3.3V. The device retains the last voltage set, so a re-multiboot
  after a dump/restore would otherwise run at 5V. `startDump()` phase 1 now sets
  3.3V explicitly so multiboot is deterministic regardless of prior state.
- **Restore** sets 5V explicitly rather than relying on the dump path having
  already switched it (Restore is only reachable after a multiboot, but the
  explicit call removes the hidden ordering dependency).
- **Keep the diagnostics** behind `window.CART_DOCTOR_DEBUG` (off by default) for
  future debugging without log spam.

### Caveat for upstream

All GBA hardware is 5V-tolerant *to some degree* in GB/GBC mode — it has to be,
since it runs GB/GBC games whose link is 5V — which is exactly the mode the dump
uses, so 5V there is expected. The **unknown is 5V while in GBA-native mode**
(multiboot): that is not what the hardware is designed for, so we deliberately
keep multiboot at 3.3V rather than risk it. If shared upstream, still prefer a
3.3V default with a 5V opt-in for the dump rather than forcing 5V globally, since
behavior across units/firmware revisions is not guaranteed.

## Changes

- `web/app.js` — `startDump()` (phase 2), `startDumpOnly()`, and `startRestore()`
  call `usb.setVoltage('5v')` before the GBC-mode transfer; `startDump()` phase 1
  calls `usb.setVoltage('3v3')` before multiboot so it never inherits 5V.
- `web/dump_receiver_fast.js` — `readHeader()` diagnostics gated behind
  `window.CART_DOCTOR_DEBUG`.

## Testing

No automated tests — the behavior is hardware-dependent (USB device + GBA + cart).
Verified manually: a full 32 KB ROM dump completed and downloaded on the
previously-failing hardware (original AGB, GBLink Unified firmware, Chromium/WebUSB).
