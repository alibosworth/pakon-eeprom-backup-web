// pakon-eeprom-backup-web: read-only backup of a Pakon F-135 / F-135+ per-unit
// EEPROM over WebUSB. See PLAN.md and README.md for what this does and never does.
//
// Every USB request this file can issue is listed here, and nowhere else:
//   0xA0  FX2 RAM write (firmware load; RAM only, wiped at power-off)
//   0xA3  FX2 external RAM write (firmware load, served by the stage-2 loader)
//   0xA4  wValue 0xA1: loader init.  wValue 0x00A5: select calibration EEPROM for READ.
//   0xA9  read: wIndex 0 = boot personality (under the loader);
//               wIndex 0x1234 = calibration EEPROM at byte offset wValue.
// There is no 0xA2 (EEPROM write) anywhere in this file, and no bulk transfer.

"use strict";

const VENDOR_ID = 0x0f05;
const PRODUCT_ID_COLD = 0xf235;    // powered on, no application firmware
const PRODUCT_ID_LOADED = 0xf135;  // application firmware running

const FIRMWARE_BASE_URL = "./firmware/";
const FIRMWARE_SHA256 = {
  "ezusb_stage2.ihex": "467d38b47f36be550fb2896e9b1da588798bcd12cbd507206aec5636d53770dc",
  "Pakon7.hex": "edd840680ef7714c5d93b89c3def5ed6ba3085166bc8e0a6a15a0390bef3f2b4",
};
// Revision aa07 is the F-135 and F-135+ (they share one FX2 image). aa05 is the
// F-235 and aa08 the F-335 (pakon-reference, usb-identity-and-firmware.md);
// this page is for the 135 line only and refuses the others.
const REVISION_TO_FIRMWARE = { 0xaa07: "Pakon7.hex" };
const REVISION_FAMILY = { 0xaa05: "F-235", 0xaa07: "F-135 / F-135+", 0xaa08: "F-335" };
// The 8-byte DEVICE_PERSONALITY the loader returns: id, VID (LE), PID (LE), revision (LE), one more byte.
const PERSONALITY_ID = 0xc0;
const PERSONALITY_LENGTH = 8;

// FX2 loader constants (FX35Loader.c / pakon-tlx-macos server/pakonload.py)
const REQUEST_LOAD_INTERNAL = 0xa0;
const REQUEST_LOAD_EXTERNAL = 0xa3;
const REQUEST_INIT_OR_SELECT = 0xa4;
const REQUEST_READ = 0xa9;
const CPUCS_EZUSB = 0x7f92;
const CPUCS_FX2 = 0xe600;
const MAX_INTERNAL_ADDRESS = 0x1b3f;
const LOAD_CHUNK_BYTES = 0x40;
const LOADER_INIT_VALUE = 0xa1;

// Calibration EEPROM read (TLB.dll's own sequence, from pakon-tlx-macos tools/eedump.py)
const EEPROM_INDEX = 0x1234;
const EEPROM_READ_SELECT = 0x00a5;   // (0x52 << 1) | 1 : chip 0x52, read direction
const EEPROM_CHUNK_BYTES = 32;
const SECTION_A_LENGTH = 398;
const SECTION_B_LENGTH = 36;
const SECTIONS = [
  { name: "sectionA_primary", base: 0x000, maxLength: 0x400, expectedLength: SECTION_A_LENGTH, pair: "sectionA_backup" },
  { name: "sectionA_backup", base: 0x400, maxLength: 0x400, expectedLength: SECTION_A_LENGTH },
  { name: "sectionB_primary", base: 0x800, maxLength: 0x200, expectedLength: SECTION_B_LENGTH, pair: "sectionB_backup" },
  { name: "sectionB_backup", base: 0xa00, maxLength: 0x200, expectedLength: SECTION_B_LENGTH },
];

// ---------------------------------------------------------------- utilities

const logElement = () => document.getElementById("log");

function log(message, cssClass) {
  const line = document.createElement("div");
  line.textContent = message;
  if (cssClass) line.className = cssClass;
  logElement().appendChild(line);
  logElement().scrollTop = logElement().scrollHeight;
}

function hex(value, width) {
  return value.toString(16).padStart(width || 2, "0");
}

function bytesToHex(bytes, separator) {
  return Array.from(bytes, (byte) => hex(byte, 2)).join(separator === undefined ? " " : separator);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest), "");
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readF32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getFloat32(0, true);
}

function todayStamp() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------- Intel HEX parsing

function parseIntelHex(text) {
  // Strict: every line must be a well-formed record with a good checksum, only
  // data (0) and EOF (1) record types, and EOF must be last. Anything else throws.
  const records = [];
  let sawEof = false;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  for (const line of lines) {
    if (!line.startsWith(":") || line.length % 2 !== 1 || !/^:[0-9A-Fa-f]+$/.test(line)) throw new Error("Intel HEX: malformed line");
    const bytes = Uint8Array.from(line.slice(1).match(/../g), (pair) => parseInt(pair, 16));
    const length = bytes[0];
    if (bytes.length !== length + 5) throw new Error("Intel HEX: record length does not match its length byte");
    const checksum = bytes.reduce((sum, byte) => (sum + byte) & 0xff, 0);
    if (checksum !== 0) throw new Error("Intel HEX: record checksum failed");
    const address = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    if (type === 1) { sawEof = true; continue; }   // a repeated EOF (the Cypress loader has two) is harmless
    if (type !== 0) throw new Error(`Intel HEX: unsupported record type ${type}`);
    if (sawEof) throw new Error("Intel HEX: data record after EOF");
    records.push({ address, data: bytes.slice(4, 4 + length) });
  }
  if (!sawEof) throw new Error("Intel HEX: no EOF record");
  return records;
}

async function fetchFirmware(name) {
  const response = await fetch(FIRMWARE_BASE_URL + name, { cache: "no-store" });
  if (!response.ok) throw new Error(`could not fetch ${name} (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = await sha256Hex(bytes);
  if (digest !== FIRMWARE_SHA256[name]) {
    throw new Error(`${name} does not match its expected SHA-256 (got ${digest}); refusing to send it to the scanner`);
  }
  log(`  ${name}: ${bytes.length} bytes, SHA-256 verified`);
  return parseIntelHex(new TextDecoder().decode(bytes));
}

// ------------------------------------------------------------- USB plumbing

let device = null;
let busy = false;

function setBusy(state) {
  busy = state;
  const step1 = document.getElementById("step1").dataset.state;
  document.getElementById("connectButton").disabled = state || step1 !== "ready";
  const step2 = document.getElementById("step2").dataset.state;
  const step3 = document.getElementById("step3").dataset.state;
  document.getElementById("loadButton").disabled = state || step2 !== "ready";
  document.getElementById("readButton").disabled = state || step3 !== "ready";
}

async function openDevice(candidate) {
  await candidate.open();
  if (candidate.configuration === null) await candidate.selectConfiguration(1);
  try {
    await candidate.claimInterface(0);
  } catch (error) {
    // Device-recipient control transfers do not strictly need the claim; note and continue.
    log(`  (interface claim skipped: ${error.message})`, "muted");
  }
  return candidate;
}

async function controlOut(request, value, index, data) {
  const result = await device.controlTransferOut(
    { requestType: "vendor", recipient: "device", request, value, index },
    data === undefined ? new Uint8Array(0) : data,
  );
  if (result.status !== "ok") throw new Error(`control OUT 0x${hex(request)} failed: ${result.status}`);
  const expected = data === undefined ? 0 : data.byteLength;
  if (result.bytesWritten !== expected) throw new Error(`control OUT 0x${hex(request)}: short write (${result.bytesWritten} of ${expected} bytes)`);
}

async function controlIn(request, value, index, length) {
  const result = await device.controlTransferIn({ requestType: "vendor", recipient: "device", request, value, index }, length);
  if (result.status !== "ok") throw new Error(`control IN 0x${hex(request)} failed: ${result.status}`);
  if (result.data.byteLength !== length) throw new Error(`control IN 0x${hex(request)}: short read (${result.data.byteLength} of ${length} bytes)`);
  return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
}

// ------------------------------------------------------------ firmware load

async function hold8051(hold) {
  await controlOut(REQUEST_LOAD_INTERNAL, CPUCS_EZUSB, 0, new Uint8Array([hold]));
  await controlOut(REQUEST_LOAD_INTERNAL, CPUCS_FX2, 0, new Uint8Array([hold]));
}

async function downloadRecords(records) {
  // External pass first (0xA3, needs the stage-2 loader running), then hold the CPU
  // and write internal RAM (0xA0). Same order as FX35Loader and pakon-tlx-macos.
  for (const record of records) {
    if (record.address > MAX_INTERNAL_ADDRESS) {
      for (let offset = 0; offset < record.data.length; offset += LOAD_CHUNK_BYTES) {
        await controlOut(REQUEST_LOAD_EXTERNAL, record.address + offset, 0, record.data.slice(offset, offset + LOAD_CHUNK_BYTES));
      }
    }
  }
  await hold8051(1);
  for (const record of records) {
    if (record.address <= MAX_INTERNAL_ADDRESS) {
      for (let offset = 0; offset < record.data.length; offset += LOAD_CHUNK_BYTES) {
        await controlOut(REQUEST_LOAD_INTERNAL, record.address + offset, 0, record.data.slice(offset, offset + LOAD_CHUNK_BYTES));
      }
    }
  }
}

let bootPersonality = null;

async function loadFirmware() {
  log("Loading the second-stage loader into scanner RAM…");
  const stage2 = await fetchFirmware("ezusb_stage2.ihex");
  await hold8051(1);
  await downloadRecords(stage2);
  await hold8051(0);
  await controlOut(REQUEST_INIT_OR_SELECT, LOADER_INIT_VALUE, 0);

  const personality = await controlIn(REQUEST_READ, 0, 0, PERSONALITY_LENGTH);
  const personalityId = personality[0];
  const personalityVendor = readU16(personality, 1);
  const personalityProduct = readU16(personality, 3);
  const revision = readU16(personality, 5);
  log(`Boot personality (as reported by the loader): ${bytesToHex(personality)}  (revision 0x${hex(revision, 4)})`);
  if (personalityId !== PERSONALITY_ID || personalityVendor !== VENDOR_ID || personalityProduct !== PRODUCT_ID_COLD) {
    throw new Error(`the scanner's personality does not look like a Pakon (id 0x${hex(personalityId)}, ${hex(personalityVendor, 4)}:${hex(personalityProduct, 4)}); stopping before the Kodak firmware (the generic loader is already in RAM; power-cycle to clear it)`);
  }
  // Cross-check against the revision the cold device announced on USB (bcdDevice).
  const usbRevision = ((device.deviceVersionMajor & 0xff) << 8) | ((device.deviceVersionMinor & 0xf) << 4) | (device.deviceVersionSubminor & 0xf);
  if (usbRevision !== revision) {
    throw new Error(`the loader reports revision 0x${hex(revision, 4)} but the scanner announced 0x${hex(usbRevision, 4)} on USB; the two must agree before the Kodak firmware is sent. Power-cycle the scanner and start again`);
  }
  bootPersonality = personality.slice();

  const firmwareName = REVISION_TO_FIRMWARE[revision];
  if (!firmwareName) throw new Error(`revision 0x${hex(revision, 4)} is not an F-135 / F-135+; stopping before the Kodak firmware (the generic loader is already in RAM; power-cycle to clear it)`);
  log(`Loading application firmware ${firmwareName}…`);
  const application = await fetchFirmware(firmwareName);
  await downloadRecords(application);
  await hold8051(1);
  try {
    await hold8051(0);
  } catch (error) {
    // The scanner drops off the bus as the application starts; that is expected.
  }
  log("Firmware sent and started. The scanner is now restarting itself with it; this takes about five seconds.", "ok");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// ------------------------------------------------------------- EEPROM read

async function readEepromRegion(offset, length) {
  await controlOut(REQUEST_INIT_OR_SELECT, EEPROM_READ_SELECT, EEPROM_INDEX);
  return controlIn(REQUEST_READ, offset, EEPROM_INDEX, length);
}

async function readSection(section) {
  const header = await readEepromRegion(section.base, 8);
  let length = readU32(header, 0);
  const storedCrc = readU32(header, 4);
  let plausible = length > 8 && length <= section.maxLength;
  if (!plausible) length = section.maxLength;
  const bytes = new Uint8Array(length);
  bytes.set(header, 0);
  for (let offset = 8; offset < length; offset += EEPROM_CHUNK_BYTES) {
    const chunk = await readEepromRegion(section.base + offset, Math.min(EEPROM_CHUNK_BYTES, length - offset));
    bytes.set(chunk, offset);
  }
  const computedCrc = plausible ? crc32(bytes.subarray(8, length)) : null;
  const crcOk = plausible && computedCrc === storedCrc;
  const lengthOk = length === section.expectedLength;
  return { ...section, bytes, length, storedCrc, computedCrc, plausible, crcOk, lengthOk, valid: crcOk && lengthOk };
}

function decodeSectionA(bytes) {
  const serial = readU32(bytes, 0x10);
  const triples = [0x14, 0x1a, 0x20].map((offset) => [readU16(bytes, offset), readU16(bytes, offset + 2), readU16(bytes, offset + 4)]);
  const negDiagonal = [0x26, 0x26 + 11 * 4, 0x26 + 22 * 4].map((offset) => readF32(bytes, offset));
  return { serial, triples, negDiagonal };
}

// ---------------------------------------------------------------- UI glue

const results = { sections: [], serial: null };

function setStep(stepNumber, state) {
  const step = document.getElementById(`step${stepNumber}`);
  step.dataset.state = state;
  if (stepNumber === 1) document.getElementById("connectButton").disabled = state !== "ready";
  if (stepNumber === 2) document.getElementById("loadButton").disabled = state !== "ready";
  if (stepNumber === 3) document.getElementById("readButton").disabled = state !== "ready";
}

function showError(error) {
  console.error(error);
  log(`Error: ${error.message}`, "error");
  const hint = document.getElementById("errorHint");
  hint.hidden = false;
}

async function requestScanner(filters) {
  const candidate = await navigator.usb.requestDevice({ filters });
  device = await openDevice(candidate);
  log(`Connected: ${hex(device.vendorId, 4)}:${hex(device.productId, 4)}  (${device.productName || "no name"}, rev 0x${hex(device.deviceVersionMajor, 2)}${hex(device.deviceVersionMinor, 2)})`);
  return device;
}

let pendingFirmwareName = null;

async function onConnectClick() {
  if (busy) return;
  setBusy(true);
  try {
    document.getElementById("errorHint").hidden = true;
    await requestScanner([
      { vendorId: VENDOR_ID, productId: PRODUCT_ID_COLD },
      { vendorId: VENDOR_ID, productId: PRODUCT_ID_LOADED },
    ]);
    setStep(1, "done");
    const connected = document.getElementById("connected");
    connected.textContent = device.productId === PRODUCT_ID_LOADED
      ? `Connected: F135-USB Film Scanner, firmware already running.`
      : `Connected: Unknown device [0f05:f235], the scanner before its firmware is loaded. Go to step 2.`;
    connected.hidden = false;
    if (device.productId === PRODUCT_ID_LOADED) {
      log("The scanner already has its firmware running; step 2 is not needed.");
      setStep(2, "done");
      setStep(3, "ready");
      return;
    }
    const usbRevision = ((device.deviceVersionMajor & 0xff) << 8) | ((device.deviceVersionMinor & 0xf) << 4) | (device.deviceVersionSubminor & 0xf);
    pendingFirmwareName = REVISION_TO_FIRMWARE[usbRevision] || null;
    const detected = document.getElementById("detected");
    if (pendingFirmwareName) {
      detected.textContent = `Detected a cold F-135-family scanner, revision 0x${hex(usbRevision, 4)}. Its original firmware for this revision is ${pendingFirmwareName}; click below to send it.`;
      setStep(2, "ready");
    } else {
      const family = REVISION_FAMILY[usbRevision];
      detected.textContent = family
        ? `This scanner announces revision 0x${hex(usbRevision, 4)}, which is an ${family}. This page only handles the F-135 and F-135+ (revision aa07); stopping here without sending anything.`
        : `This scanner announces revision 0x${hex(usbRevision, 4)}, which this page does not recognise. It handles the F-135 and F-135+ (revision aa07) only; stopping here without sending anything.`;
      setStep(2, "blocked");
    }
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

async function onLoadClick() {
  if (busy) return;
  setBusy(true);
  try {
    document.getElementById("errorHint").hidden = true;
    if (!device || device.productId !== PRODUCT_ID_COLD) throw new Error("connect to a cold scanner first (step 1)");
    setStep(2, "busy");
    await loadFirmware();
    try { await device.close(); } catch (error) { /* already gone */ }
    device = null;
    const detected = document.getElementById("detected");
    for (let secondsLeft = 5; secondsLeft > 0; secondsLeft--) {
      detected.textContent = `Firmware loaded. Waiting ${secondsLeft} s for the scanner to reconnect…`;
      await sleep(1000);
    }
    detected.textContent = "Firmware loaded and the scanner has had time to reconnect. Go to step 3.";
    setStep(2, "done");
    setStep(3, "ready");
    log("Step 2 done. Now click \"Read and verify\" in step 3 and choose 'F135-USB Film Scanner' in Chrome's picker. (Chrome cannot show the page the restarted scanner until you pick it again.)", "ok");
  } catch (error) {
    showError(error);
    // The scanner's RAM may now hold a partial load. Do not allow a retry against
    // that state: close the handle, block step 2, and require a power-cycle.
    try { if (device) await device.close(); } catch (closeError) { /* ignore */ }
    device = null;
    document.getElementById("detected").textContent = "The load did not complete. Turn the scanner off and on again (this clears its memory), then start again from step 1.";
    setStep(2, "blocked");
    setStep(3, "waiting");
    setStep(1, "ready");
    document.getElementById("connected").hidden = true;
  } finally {
    setBusy(false);
  }
}

async function onReadClick() {
  if (busy) return;
  setBusy(true);
  try {
    document.getElementById("errorHint").hidden = true;
    if (!device || device.productId !== PRODUCT_ID_LOADED) {
      await requestScanner([{ vendorId: VENDOR_ID, productId: PRODUCT_ID_LOADED }]);
    }
    setStep(3, "busy");
    log("Reading the calibration EEPROM (both copies of both sections)…");
    results.sections = [];
    for (const section of SECTIONS) {
      const read = await readSection(section);
      results.sections.push(read);
      const verdict = read.valid ? "CRC ok" : read.crcOk ? `CRC ok but unexpected length (expected ${read.expectedLength})` : read.plausible ? "CRC MISMATCH" : "no valid header";
      log(`  ${read.name.padEnd(17)} @0x${hex(read.base, 3)}  ${read.length} bytes  ${verdict}`, read.valid ? "ok" : "warn");
    }
    await renderResults();
    setStep(3, "done");
    log("Done. Nothing was written to the scanner. To read again, power-cycle the scanner first and start from step 1 (one read per power-on; see the note under Result).", "ok");
  } catch (error) {
    showError(error);
    try { if (device) await device.close(); } catch (closeError) { /* ignore */ }
    device = null;
    setStep(3, "blocked");
    setStep(1, "ready");
    document.getElementById("connected").hidden = true;
    log("Power-cycle the scanner and start again from step 1 before reading again.", "muted");
  } finally {
    setBusy(false);
  }
}

function sectionByName(name) {
  return results.sections.find((section) => section.name === name);
}

async function renderResults() {
  const table = document.getElementById("resultsTable");
  const rows = [];
  for (const section of results.sections) {
    let note = "";
    if (section.pair) {
      const other = sectionByName(section.pair);
      const same = other && section.bytes.length === other.bytes.length && section.bytes.every((byte, index) => byte === other.bytes[index]);
      if (!same && other) {
        const differing = [];
        const compareLength = Math.min(section.bytes.length, other.bytes.length);
        for (let index = 0; index < compareLength; index++) if (section.bytes[index] !== other.bytes[index]) differing.push(index);
        note = differing.length ? `${differing.length} byte(s) differ from the backup copy (first at 0x${hex(differing[0], 3)})` : "length differs from the backup copy";
      } else if (same) {
        note = "identical to the backup copy";
      }
    }
    const verdict = section.valid ? "good" : section.crcOk ? "unexpected length" : section.plausible ? "bad CRC" : "no header";
    rows.push(`<tr class="${section.valid ? "good" : "bad"}"><td>${section.name.replace("_", " ")}</td><td>0x${hex(section.base, 3)}</td><td>${section.length}</td><td>${verdict}</td><td>${note}</td></tr>`);
  }
  table.innerHTML = rows.join("");

  const primaryA = sectionByName("sectionA_primary");
  const backupA = sectionByName("sectionA_backup");
  const primaryB = sectionByName("sectionB_primary");
  const backupB = sectionByName("sectionB_backup");
  const goodA = primaryA.valid ? primaryA : backupA.valid ? backupA : null;
  const goodB = primaryB.valid ? primaryB : backupB.valid ? backupB : null;
  const allFour = primaryA.valid && backupA.valid && primaryB.valid && backupB.valid;
  const summary = document.getElementById("summary");
  const parts = [];
  if (goodA) {
    const decoded = decodeSectionA(goodA.bytes);
    results.serial = decoded.serial;
    parts.push(`<p>This is scanner <strong>serial ${decoded.serial}</strong>. Motor speeds per resolution base (offset / normal / IR):
      base 4 = ${decoded.triples[0].join(" / ")}, base 8 = ${decoded.triples[1].join(" / ")}, base 16 = ${decoded.triples[2].join(" / ")}.
      Negative matrix diagonal ${decoded.negDiagonal.map((value) => value.toFixed(4)).join(", ")}.</p>`);
  }
  const pairNote = (label, primary, backup) => {
    if (primary.valid && backup.valid) return `<p>Section ${label}: both copies good.</p>`;
    if (!primary.valid && backup.valid) return `<p><strong>Section ${label}: the primary copy is bad and the backup copy is good.</strong> This is common on these scanners (both units checked before this one were like this); the OEM software silently uses the backup. It is not a reason to write anything to the scanner. If this chip ever needs restoring, restore section ${label} from the <em>backup</em> file.</p>`;
    if (primary.valid && !backup.valid) return `<p><strong>Section ${label}: the primary copy is good and the backup copy is bad.</strong> The scanner works from the primary. Keep both files; if restoring, use the <em>primary</em> file for section ${label}.</p>`;
    return `<p><strong>Section ${label}: neither copy verified.</strong> Keep the files anyway, power-cycle the scanner and read again; if it repeats, the chip may be failing and these files are what you have.</p>`;
  };
  parts.push(pairNote("A", primaryA, backupA));
  parts.push(pairNote("B", primaryB, backupB));
  if (allFour) parts.push("<p><strong>All four copies verified.</strong> Download the files below and keep them somewhere safe (two places is better than one).</p>");
  else if (goodA && goodB) parts.push("<p><strong>Sufficient for recovery:</strong> at least one good copy of each section. Download the files below and keep them somewhere safe (two places is better than one).</p>");
  else parts.push("<p><strong>Not a complete backup yet.</strong> Download what was read, then try again after a power-cycle.</p>");
  summary.innerHTML = parts.join("");
  await renderDownloads();
  document.getElementById("results").hidden = false;
}

function download(name, bytes) {
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function renderDownloads() {
  const container = document.getElementById("downloads");
  container.innerHTML = "";
  const prefix = `pakon-eeprom-serial${results.serial === null ? "unknown" : results.serial}-${todayStamp()}`;
  const files = [];
  for (const section of results.sections) files.push({ name: `${prefix}-0x52-${section.name}.bin`, bytes: section.bytes });
  // The 8 bytes the loader reports (id, VID, PID, revision, one more byte), not a raw dump of the
  // 0x51 chip. Its contents are the same on every F-135 and are replaceable; kept for the record.
  if (bootPersonality) files.push({ name: `${prefix}-personality-8-bytes-from-loader.bin`, bytes: bootPersonality });
  const sums = [];
  for (const file of files) sums.push(`${await sha256Hex(file.bytes)}  ${file.name}`);
  files.push({ name: `${prefix}-SHA256SUMS`, bytes: new TextEncoder().encode(sums.join("\n") + "\n") });

  for (const file of files) {
    const button = document.createElement("button");
    button.textContent = `Download ${file.name}`;
    button.addEventListener("click", () => download(file.name, file.bytes));
    container.appendChild(button);
  }
  const all = document.createElement("button");
  all.className = "primary";
  all.textContent = "Download all files";
  all.addEventListener("click", async () => {
    for (const file of files) {
      download(file.name, file.bytes);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  });
  container.prepend(all);
}

function describePlatform() {
  const agent = navigator.userAgent || "";
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  const isMac = /Mac/i.test(platform) && !/iPhone|iPad/i.test(agent);
  const isWindows = /Win/i.test(platform);
  const isLinux = /Linux/i.test(platform) && !/Android/i.test(agent);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(agent);
  const isFirefox = /Firefox/i.test(agent);
  const isSafari = /Safari/i.test(agent) && !/Chrome|Chromium|Edg/i.test(agent);
  return { isMac, isWindows, isLinux, isMobile, isFirefox, isSafari, hasWebUsb: "usb" in navigator };
}

function showPlatformNotice() {
  const notice = document.getElementById("platformNotice");
  const info = describePlatform();
  let html = "";
  if (!info.hasWebUsb) {
    if (info.isMobile) html = "<strong>Phones and tablets can't do this.</strong> Use a Mac or Linux computer with Chrome or Edge.";
    else if (info.isFirefox || info.isSafari) html = "<strong>This browser can't talk to USB devices.</strong> Open this page in Chrome or Edge; Safari and Firefox don't support WebUSB.";
    else html = "<strong>This browser can't talk to USB devices.</strong> Open this page in Chrome or Edge.";
  } else if (info.isWindows) {
    html = "<strong>Windows: this page will most likely not see your scanner.</strong> The Pakon driver keeps the scanner to itself, and giving Chrome access means replacing that driver, which stops the Pakon software working until you put it back. If you have the Kodak software installed, use its own copy instead: export the registry key <code>HKLM\\Software\\Pakon\\TLB\\ColorKodak</code> (Regedit, right-click, Export) and keep that file. It is not the raw chip, but it is most of the data.";
  } else if (info.isLinux) {
    html = "<strong>Linux: one thing to do first.</strong> Your user needs permission to open the scanner. Create <code>/etc/udev/rules.d/70-pakon.rules</code> containing <code>SUBSYSTEM==\"usb\", ATTR{idVendor}==\"0f05\", TAG+=\"uaccess\"</code>, run <code>sudo udevadm control --reload</code>, then unplug and replug the scanner.";
  } else if (info.isMac) {
    html = "<strong>Mac: nothing to install.</strong> Plug the scanner in and follow the three steps.";
  }
  notice.innerHTML = html;
  notice.hidden = html === "";
  notice.className = info.hasWebUsb && !info.isWindows ? "notice" : "notice warn";
}

function init() {
  showPlatformNotice();
  const supported = "usb" in navigator;
  document.getElementById("app").hidden = !supported;
  if (!supported) return;
  document.getElementById("connectButton").addEventListener("click", onConnectClick);
  document.getElementById("loadButton").addEventListener("click", onLoadClick);
  document.getElementById("readButton").addEventListener("click", onReadClick);
  navigator.usb.addEventListener("disconnect", (event) => {
    if (device && event.device === device) {
      log("Scanner disconnected.", "muted");
      device = null;
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
