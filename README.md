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
   loaded). The page shows the revision it detected and which firmware
   image that means.
2. On a second click, load that firmware into RAM: the standard Cypress FX2
   load every client and the OEM perform after every power-on. RAM is wiped
   at power-off; this is not an EEPROM write. Before sending: the image's
   SHA-256 must match, the loader's 8-byte personality must carry the
   expected id/VID/PID, and the revision it reports must equal the one the
   scanner announced on USB (bcdDevice); any disagreement stops the page
   without loading anything.
3. Read the calibration EEPROM with the OEM engine's own two requests
   (`0xA4 wValue 0x00A5 wIndex 0x1234` select, then `0xA9` at byte offsets),
   both copies of both sections. Verify all four CRC-32s and the expected
   lengths (398 and 36 bytes), compare primary with backup, decode the
   serial so you can see it is your unit. The 8-byte personality the loader
   reported in step 2 is saved too, labelled as such: it is the loader's
   descriptor (id, VID, PID, revision), not a raw dump of the boot chip, and
   it is the same on every F-135.
4. Download the files, named with the serial and date, plus a `SHA256SUMS`.

Every USB request the code can issue is listed at the top of `app.js`; there
is no `0xA2` (EEPROM write) and no bulk transfer anywhere in it.

## Firmware files, and why they are here

`firmware/Pakon5.hex`, `Pakon7.hex`, `Pakon8.hex` are Kodak's application
firmware for the three F-135 revisions, taken from the `FX35Driver/` folder
of an unmodified install of the Pakon F-X35 software (the same installer
the community mirrors). The OEM install tree also carries a different build
of `Pakon7.hex` under `F-135/F135Driver/` (10 326-byte image versus 10 355);
the one here is the `FX35Driver/` build, which is byte-identical to the
file pakon-tlx-macos loaded onto F-135+ serial 16402 on 18 August 2026, so
it is the build proven on hardware. They are Kodak's property. They are hosted here because the
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
- **Linux**: works once your user may open the device. Put
  `SUBSYSTEM=="usb", ATTR{idVendor}=="0f05", TAG+="uaccess"` in
  `/etc/udev/rules.d/70-pakon.rules`, `sudo udevadm control --reload`,
  replug. (`uaccess` grants the logged-in seat, not every account.)
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
