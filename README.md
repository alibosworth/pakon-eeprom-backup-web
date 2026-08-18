# pakon-eeprom-backup-web

Back up a Pakon F-135 / F-135+ scanner's per-unit calibration EEPROM from a
web page. Chrome or Edge, a USB cable, three clicks, nothing to install. It
reads only; it cannot write to the scanner.

Live page: (to be published on GitHub Pages)

## Why

Every one of these scanners carries a small EEPROM holding data unique to
that unit: serial number, per-resolution motor speeds, the two colour
matrices. Kodak stores it twice with checksums, and the OEM software falls
back to the backup copy silently, so a chip can be half-bad for years
without anyone noticing; both units read so far were exactly like that. If
both copies go, there is nothing to download and no way to recreate it. The
longer version, and what else on the scanner can be damaged by software, is
at https://pakon-reference.alibosworth.com/per-unit-data-and-safety/ .

The tools that can read the chip today (pakon-tlx-macos, pakon-mac) need a
terminal, Homebrew, Python and a venv. Most people who own one of these
scanners will not do that. A page that does the same three steps, in the
browser, is the answer to "can you do a tutorial".

## What it does

1. Connect to the scanner (`0f05:f235` cold, or `0f05:f135` if already
   loaded).
2. If cold, load the application firmware into RAM: the standard Cypress
   FX2 load every client and the OEM perform after every power-on. RAM is
   wiped at power-off; this is not an EEPROM write. The image is picked from
   the scanner's own revision byte, and its SHA-256 is checked before
   anything is sent.
3. Read the calibration EEPROM with the OEM engine's own two requests
   (`0xA4 wValue 0x00A5 wIndex 0x1234` select, then `0xA9` at byte offsets),
   both copies of both sections, plus the 8-byte boot personality read
   during the load. Verify all four CRC-32s, compare primary with backup,
   decode the serial so you can see it is your unit.
4. Download the files, named with the serial and date, plus a `SHA256SUMS`.

Every USB request the code can issue is listed at the top of `app.js`; there
is no `0xA2` (EEPROM write) and no bulk transfer anywhere in it.

## Firmware files, and why they are here

`firmware/Pakon5.hex`, `Pakon7.hex`, `Pakon8.hex` are Kodak's application
firmware for the three F-135 revisions, taken from the Pakon software
installer. They are Kodak's property. They are hosted here because the
scanner cannot be read without them, they have been publicly mirrored for
years, and hosting them with a pinned hash is safer than fetching them from
somewhere at run time. If Kodak (or its successor in interest) objects,
they will be removed on request. `firmware/ezusb_stage2.ihex` is the generic
Cypress EZ-USB second-stage RAM loader from the Cypress development kit, not
Kodak code. `firmware/SHA256SUMS` lists all four; the same values are
compiled into `app.js` and checked before any byte reaches the scanner.

To point the page at a different firmware host, change `FIRMWARE_BASE_URL`
in `app.js`.

## Platform notes

- **macOS**: works. No kernel driver claims the scanner.
- **Linux**: works once your user may open the device; a udev rule such as
  `SUBSYSTEM=="usb", ATTR{idVendor}=="0f05", MODE="0666"`.
- **Windows**: the Pakon driver owns the device. WebUSB needs the WinUSB
  driver bound (Zadig), which stops the Pakon software working until you
  swap back. If you have the Kodak software installed, its own copy of most
  of this data is in the registry (`HKLM\Software\Pakon\TLB\ColorKodak`
  and the `Wow6432Node` twin); export that as a stop-gap. It is the OEM's
  decoded copy, not the raw bytes, and it does not tell you whether the
  chip is healthy.
- **Safari, Firefox, iOS, Android**: no WebUSB.

## Running it locally

Any static server; WebUSB needs `https://` or `http://localhost`.

    python3 -m http.server 8000
    open http://localhost:8000/

## Restoring

This page cannot write, on purpose. If a chip ever has to be restored, that
is an EEPROM write (`0xA2`) against the exact bytes in these files, section A
from whichever copy verified; not something to do casually, and not something
this page will grow to do.

## Credits

- The read sequence: Pablo Navarro's pakon-tlx-macos, `tools/eedump.py`,
  decoded from a live capture of TLB.dll's own transfers
  (https://github.com/pablonavarrob/pakon-tlx-macos); the both-copies read
  and CRC check from PR #4 there.
- The layout and CRC: Guy Langford-Lee's pakon-mac, `docs/69`
  (https://github.com/gazzdingo/pakon-mac); the direction bit in the select
  from their `tools/pakon_usb_guard.py`.
- The load procedure: FX35Loader, as ported in pakon-tlx-macos
  `server/pakonload.py`.
- What is per-unit and why: pakon-reference
  (https://pakon-reference.alibosworth.com/).

## Licence

Code and text: MIT. `firmware/Pakon*.hex`: Kodak's, see above.
`firmware/ezusb_stage2.ihex`: Cypress's, from the EZ-USB development kit.
