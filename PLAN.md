# Plan: pakon-eeprom-backup-web

A single static web page that backs up a Pakon F-135 / F-135+ scanner's
per-unit EEPROM from Chrome or Edge, with nothing to install. Written for
someone who has never opened a terminal.

## What it does, in order

1. **Connect (cold).** `navigator.usb.requestDevice` filtered to
   `0f05:f235` (scanner just powered on, no firmware) or `0f05:f135`
   (already loaded by something else). Chrome shows its own picker; the
   user chooses the scanner.
2. **Load firmware (only if cold, and only on a second click).** After
   Connect the page shows the revision it detected and which image that
   means; the user clicks "Load the scanner's original firmware". The load
   is the standard Cypress FX2 RAM load that every client and the OEM
   perform after every power-on:
   - hold the 8051 (`0xA0` to CPUCS `0x7F92` and `0xE600`, value 1)
   - write the generic Cypress second-stage loader (`0xA0`, internal RAM)
   - release the 8051 (value 0), send init `0xA4 wValue 0xA1`
   - read the 8-byte personality (`0xA9`, `wValue 0`, `wIndex 0`): this
     gives the revision, which must be `aa07` (F-135 / F-135+; `aa05` is the
     F-235 and `aa08` the F-335, refused) and must equal the USB bcdDevice;
     the 8 bytes are kept as the loader's descriptor
   - write the application firmware: external pass (`0xA3`, CPU running),
     then hold the 8051 and write the internal pass (`0xA0`), then release
   - the scanner drops off the bus and re-enumerates as `0f05:f135`
   Every image is fetched from `firmware/` and its SHA-256 checked against
   the values compiled into the page before a single byte is sent.
3. **Connect (loaded).** Second `requestDevice` (WebUSB needs a click per
   device), filtered to `0f05:f135`.
4. **Read.** The OEM engine's own two requests and nothing else:
   `0xA4 wValue 0x00A5 wIndex 0x1234` (select the calibration chip for
   reading), then `0xA9 wValue = byte offset, wIndex 0x1234`, 32 bytes at a
   time, re-selecting before each chunk. Both copies of both sections:
   A at 0x000 and 0x400, B at 0x800 and 0xA00, each `{u32 len; u32 crc32;
   payload}`.
5. **Verify.** CRC-32 (zlib) over each payload against its header and the
   expected length (398 / 36); compare primary with backup; decode and show
   the serial number, scanner type (0x00C, 1351 = F-135+), revision (0x008,
   400, as the OEM shows it) and the per-resolution words so the user can
   see it is their unit. One read per power-on: Read disables afterwards.
6. **Save.** One zip (built in the page, stored) holding the four section
   files, the loader's 8-byte personality if step 2 ran, a `SHA256SUMS`, and
   a generated `README.txt` with the per-copy CRC table, which file to
   restore from and why not one-for-one, and the same-model-same-serial
   rule; plus the files individually. Named with the serial and the date.
   Plain language beside every result.

## What it never does

- No `0xA2` (EEPROM write). No `0xA4` with any `wValue` other than `0xA1`
  (loader init, before the app firmware is up) and `0x00A5` (read select).
- No PPB command frames at all (no bulk transfers): it never talks to the
  PIC controllers, so none of the motor / LED / bootloader hazards apply.
- No network requests except fetching its own firmware files from the same
  origin (and those are hash-checked).
- The RAM load is not an EEPROM write; it is what the scanner needs after
  every power-on and is wiped at power-off.

## Files

```
index.html        the page: three steps, plain-language text, results table
app.js            WebUSB, Intel HEX parser, loader, reader, CRC-32, downloads
style.css
firmware/
  ezusb_stage2.ihex   generic Cypress EZ-USB second-stage RAM loader (not Kodak's)
  Pakon7.hex          Kodak's F-135 / F-135+ application firmware (aa07)
  SHA256SUMS
README.md         what, why, safety, hosting the firmware, credits, licence
PLAN.md           this file
```

The firmware location is one constant (`FIRMWARE_BASE_URL`, default
`./firmware/`) so it can be pointed at another host without touching the
logic.

## Platform notes

- macOS: works as is; no kernel driver claims the FX2.
- Linux: needs a udev rule granting the user access to `0f05:*`, or Chrome
  run as a user that has it.
- Windows: the OEM driver owns the device; WebUSB needs WinUSB bound
  (Zadig), which disables the OEM software until reverted. State this
  plainly and point Windows users at the OEM's own registry mirror as the
  no-driver-swap alternative.
- Safari / Firefox / iOS: no WebUSB. Say so on the page.

## Verification (done 18 August 2026, Chrome on macOS, serial 16402)

1. Cold path: Connect showed `Unknown device [0f05:f235]`, Load completed
   ("Firmware sent and started"), scanner re-enumerated as `F135-USB Film
   Scanner`. Loaded path: Connect skipped step 2, Read gave A-primary bad
   (1 byte at 0x0a5), A-backup good, B both good, serial 16402. The four
   downloaded section files are byte-identical to the pakon-tlx-macos
   backup in `~/projects/pakon-eeprom-backup/F135plus-16402/eeprom/`, and
   the SHA256SUMS verifies.
2. `claimInterface(0)`: not yet confirmed either way from the log; the
   code claims in a try/catch and continues if refused.
3. Personality read: cold Load path ran; value not captured in the notes.
4. Unplug mid-read: not yet tried.

Two independent reviews (nine and six findings) applied before the
hardware test; see git history.

## Credits to carry in the README

- Read sequence: pakon-tlx-macos (Pablo Navarro), `tools/eedump.py`, from a
  live capture of TLB.dll's own transfers; the two-copy read from
  Ali's PR #4 to that project.
- Layout and CRC: pakon-mac (Guy Langford-Lee), `docs/69`.
- Load procedure: FX35Loader / pakon-tlx-macos `server/pakonload.py`;
  second-stage loader from the Cypress EZ-USB kit.
- Documentation of what is per-unit and why: pakon-reference,
  `per-unit-data-and-safety.md`.
