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
  // Release the CPU: the first CPUCS write must succeed; the second (0xE600, the FX2's
  // real CPUCS) starts the application, which drops the scanner off the bus mid-request.
  // Only that disconnect is tolerated; any other error is real.
  await controlOut(REQUEST_LOAD_INTERNAL, CPUCS_EZUSB, 0, new Uint8Array([0]));
  try {
    await controlOut(REQUEST_LOAD_INTERNAL, CPUCS_FX2, 0, new Uint8Array([0]));
  } catch (error) {
    const looksLikeDisconnect = error.name === "NetworkError" || error.name === "NotFoundError" || /disconnected|device (was )?(removed|unavailable|not found)|no device/i.test(error.message);
    if (!looksLikeDisconnect) throw error;
    log(`  (scanner dropped off the bus as the firmware started: ${error.message})`, "muted");
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

// Section A payload, absolute offsets: 0x008 revision (the OEM shows it as "revision 400"),
// 0x00C scanner type (the OEM's logs say "Scanner Type 1351" for an F-135+), 0x010 serial.
const SCANNER_TYPE_NAMES = { 1351: "F-135+ (type 1351)" };

function decodeSectionA(bytes) {
  const revision = readU32(bytes, 0x08);
  const scannerType = readU32(bytes, 0x0c);
  const serial = readU32(bytes, 0x10);
  const triples = [0x14, 0x1a, 0x20].map((offset) => [readU16(bytes, offset), readU16(bytes, offset + 2), readU16(bytes, offset + 4)]);
  const negDiagonal = [0x26, 0x26 + 11 * 4, 0x26 + 22 * 4].map((offset) => readF32(bytes, offset));
  return { revision, scannerType, serial, triples, negDiagonal };
}

// ---------------------------------------------------------------- UI glue

const results = { sections: [], serial: null, decoded: null, overall: null };

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

function sameBytes(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
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
  const sameA = sameBytes(primaryA.bytes, backupA.bytes);
  const sameB = sameBytes(primaryB.bytes, backupB.bytes);
  const allValid = primaryA.valid && backupA.valid && primaryB.valid && backupB.valid;
  const allFour = allValid && sameA && sameB;
  const completeDivergent = allValid && (!sameA || !sameB);
  const overall = allFour ? "all four verified and identical" : completeDivergent ? "complete, one or both sections' copies differ" : goodA && goodB ? "sufficient for recovery" : "incomplete";
  results.overall = overall;
  const summary = document.getElementById("summary");
  const parts = [];
  if (goodA) {
    const decoded = decodeSectionA(goodA.bytes);
    results.serial = decoded.serial;
    results.decoded = decoded;
    const typeName = SCANNER_TYPE_NAMES[decoded.scannerType] || `type ${decoded.scannerType}`;
    parts.push(`<p>This is scanner <strong>serial ${decoded.serial}</strong>, ${typeName}, revision ${decoded.revision} (as the Kodak software shows it), USB firmware revision aa07. Motor speeds per resolution base (offset / normal / IR):
      base 4 = ${decoded.triples[0].join(" / ")}, base 8 = ${decoded.triples[1].join(" / ")}, base 16 = ${decoded.triples[2].join(" / ")}.
      Negative matrix diagonal ${decoded.negDiagonal.map((value) => value.toFixed(4)).join(", ")}.</p>`);
  }
  const pairNote = (label, primary, backup) => {
    if (primary.valid && backup.valid && sameBytes(primary.bytes, backup.bytes)) return `<p>Section ${label}: both copies good and identical.</p>`;
    if (primary.valid && backup.valid) return `<p><strong>Section ${label}: both copies pass their checksums but they are not the same.</strong> Each is internally consistent, so this is two different versions of the calibration, not damage. Keep both files. Which one is authoritative cannot be told from here (the Kodak software uses the primary when it validates); do not treat them as interchangeable if restoring.</p>`;
    if (!primary.valid && backup.valid) return `<p><strong>Section ${label}: the primary copy is bad and the backup copy is good.</strong> This appears common on these scanners (both units checked before this one were like this); the Kodak software quietly uses the backup copy and the scanner works normally. Nothing needs fixing; leave the scanner as it is and keep these files. (If the chip ever has to be restored, don't copy the files back one for one: the primary file contains the damaged byte and would put the fault back. Write the <em>backup</em> file's bytes into both the primary and the backup slot for section ${label}.)</p>`;
    if (primary.valid && !backup.valid) return `<p><strong>Section ${label}: the primary copy is good and the backup copy is bad.</strong> The scanner works normally from the primary. Nothing needs fixing; keep both files. (If the chip ever has to be restored, don't copy the files back one for one: the backup file contains the damage. Write the <em>primary</em> file's bytes into both slots for section ${label}.)</p>`;
    return `<p><strong>Section ${label}: neither copy verified.</strong> Keep the files anyway, power-cycle the scanner and read again; if it repeats, the chip may be failing and these files are what you have.</p>`;
  };
  parts.push(pairNote("A", primaryA, backupA));
  parts.push(pairNote("B", primaryB, backupB));
  if (allFour) parts.push("<p><strong>All four copies verified and each pair identical.</strong> Download the files below and keep them somewhere safe (two places is better than one).</p>");
  else if (completeDivergent) parts.push("<p><strong>Complete, with a divergence:</strong> every copy passes its checksum, but in one or both sections the two copies differ (see above). Download the files below and keep them somewhere safe (two places is better than one).</p>");
  else if (goodA && goodB) parts.push("<p><strong>Sufficient for recovery:</strong> at least one good copy of each section. Download the files below and keep them somewhere safe (two places is better than one).</p>");
  else parts.push("<p><strong>Not a complete backup yet.</strong> Download what was read, then try again after a power-cycle.</p>");
  summary.innerHTML = parts.join("");
  await renderDownloads();
  document.getElementById("results").hidden = false;
}

// A stored (uncompressed) zip: local file headers, central directory, end record.
// Enough for a handful of small files; no library needed.
function buildZip(files) {
  const encoder = new TextEncoder();
  const now = new Date();
  const dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
  const dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0xf) << 5) | (now.getDate() & 0x1f);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const u16 = (value) => [value & 0xff, (value >>> 8) & 0xff];
  const u32 = (value) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.bytes);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(dosTime), ...u16(dosDate),
      ...u32(crc), ...u32(file.bytes.length), ...u32(file.bytes.length), ...u16(nameBytes.length), ...u16(0),
      ...nameBytes,
    ]);
    localParts.push(local, file.bytes);
    centralParts.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(dosTime), ...u16(dosDate),
      ...u32(crc), ...u32(file.bytes.length), ...u32(file.bytes.length), ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ...nameBytes,
    ]));
    offset += local.length + file.bytes.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);
  const total = offset + centralSize + end.length;
  const zip = new Uint8Array(total);
  let position = 0;
  for (const part of [...localParts, ...centralParts, end]) { zip.set(part, position); position += part.length; }
  return zip;
}

function buildReadme(prefix) {
  const now = new Date();
  const lines = [];
  lines.push(`Pakon F-135 / F-135+ per-unit EEPROM backup`);
  lines.push(`Scanner serial: ${results.serial === null ? "unknown (no section A verified)" : results.serial}`);
  if (results.decoded) {
    lines.push(`Scanner type: ${results.decoded.scannerType} (${SCANNER_TYPE_NAMES[results.decoded.scannerType] || "not yet mapped to a model name"})`);
    lines.push(`Revision: ${results.decoded.revision} (as shown by the Kodak software); USB firmware revision aa07 (F-135 / F-135+)`);
  }
  lines.push(`Read on: ${now.toISOString()}`);
  lines.push(`Read with: pakon-eeprom-backup-web (https://github.com/alibosworth/pakon-eeprom-backup-web), browser ${navigator.userAgent}`);
  lines.push("");
  lines.push("What this is");
  lines.push("  The calibration EEPROM (I2C chip 0x52) of one scanner: serial number, per-resolution");
  lines.push("  motor speeds, colour correction. Kodak stores it as two sections, each with a primary");
  lines.push("  and a backup copy, each {u32 length; u32 crc32; payload} with zlib CRC-32 over the payload.");
  lines.push("  Read with the Kodak engine's own two requests (0xA4 wValue 0x00A5 wIndex 0x1234, then 0xA9");
  lines.push("  at byte offsets). Nothing was written to the scanner.");
  lines.push("");
  lines.push("Copies read");
  for (const section of results.sections) {
    const verdict = section.valid ? "good" : section.crcOk ? "CRC ok but unexpected length" : section.plausible ? "BAD CRC" : "no valid header";
    const stored = section.plausible ? hex(section.storedCrc, 8) : "-";
    const computed = section.computedCrc === null ? "-" : hex(section.computedCrc, 8);
    lines.push(`  ${section.name.padEnd(17)} @0x${hex(section.base, 3)}  ${String(section.length).padStart(3)} bytes  stored crc ${stored}  computed ${computed}  ${verdict}`);
  }
  const primaryA = sectionByName("sectionA_primary");
  const backupA = sectionByName("sectionA_backup");
  const primaryB = sectionByName("sectionB_primary");
  const backupB = sectionByName("sectionB_backup");
  lines.push("");
  lines.push(`Overall: ${results.overall || "not assessed"}`);
  lines.push("  (all four verified and identical / complete, one or both sections' copies differ /");
  lines.push("   sufficient for recovery = at least one good copy of each section / incomplete)");
  lines.push("");
  lines.push("Which file to restore from, if that is ever needed");
  const advise = (label, primary, backup) => {
    if (primary.valid && backup.valid && sameBytes(primary.bytes, backup.bytes)) return `  Section ${label}: both copies good and identical; either file, into both slots.`;
    if (primary.valid && backup.valid) return `  Section ${label}: both copies pass their checksums but DIFFER. Two internally consistent versions; which is authoritative is not known (the Kodak software uses the primary when it validates). Keep both. Do not treat them as interchangeable when restoring.`;
    if (!primary.valid && backup.valid) return `  Section ${label}: primary is bad, backup is good. Do NOT copy the files back one for one (that would put the fault back); write the BACKUP file's bytes into both the primary and the backup slot.`;
    if (primary.valid && !backup.valid) return `  Section ${label}: primary is good, backup is bad. Do NOT copy the files back one for one; write the PRIMARY file's bytes into both slots.`;
    return `  Section ${label}: neither copy verified; read again after a power-cycle.`;
  };
  lines.push(advise("A", primaryA, backupA));
  lines.push(advise("B", primaryB, backupB));
  lines.push("");
  lines.push("Notes");
  lines.push("  A bad primary with a good backup appears common on these scanners; the Kodak software uses the");
  lines.push("  backup silently and the scanner works normally. Nothing needs fixing. Restoring means an");
  lines.push("  EEPROM write, which this tool does not do; only do that with the exact bytes of the good copy.");
  lines.push(`  This data belongs to one scanner only: the F-135 / F-135+ with serial ${results.serial === null ? "(see above)" : results.serial}.`);
  lines.push("  It must only ever be used to restore that exact scanner, same model, same serial number.");
  lines.push("  Written to any other unit it would give that unit the wrong motor speeds and colour correction.");
  if (bootPersonality) {
    lines.push("  The personality-8-bytes-from-loader file is what the boot loader reported about itself in");
    lines.push("  step 2; it is the same on every F-135 and is kept for the record only.");
  } else {
    lines.push("  No personality file this time: the scanner already had its firmware running, so step 2");
    lines.push("  (where the loader reports it) was skipped. It is the same on every F-135 and not needed.");
  }
  lines.push("  Files: " + prefix + "-*. SHA-256 of every file (this one included) in the SHA256SUMS file.");
  return lines.join("\n") + "\n";
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
  files.push({ name: `${prefix}-README.txt`, bytes: new TextEncoder().encode(buildReadme(prefix)) });
  const sums = [];
  for (const file of files) sums.push(`${await sha256Hex(file.bytes)}  ${file.name}`);
  files.push({ name: `${prefix}-SHA256SUMS`, bytes: new TextEncoder().encode(sums.join("\n") + "\n") });

  for (const file of files) {
    const button = document.createElement("button");
    button.textContent = `Download ${file.name}`;
    button.addEventListener("click", () => download(file.name, file.bytes));
    container.appendChild(button);
  }
  const zipName = `${prefix}.zip`;
  const zipButton = document.createElement("button");
  zipButton.className = "primary";
  zipButton.textContent = `Download everything as ${zipName}`;
  zipButton.addEventListener("click", () => download(zipName, buildZip(files)));
  const separately = document.createElement("p");
  separately.className = "muted";
  separately.textContent = "Or the files one at a time:";
  container.prepend(separately);
  container.prepend(zipButton);
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
  const localTools = ' If you would rather not use a browser at all, two projects have command-line tools that read the same chip the same way: <a href="https://github.com/pablonavarrob/pakon-tlx-macos">pakon-tlx-macos</a> (<code>tools/eedump.py</code>) and <a href="https://github.com/gazzdingo/pakon-mac">pakon-mac</a> (<code>tools/eeprom_backup.py</code>); see the notes at the bottom of this page.';
  if (!info.hasWebUsb) {
    if (info.isMobile) html = "<strong>Phones and tablets can't do this.</strong> Use a Mac or Linux computer with Chrome or Edge." + localTools;
    else if (info.isFirefox || info.isSafari) html = "<strong>This browser can't talk to USB devices.</strong> Open this page in Chrome or Edge; Safari and Firefox don't support WebUSB." + localTools;
    else html = "<strong>This browser can't talk to USB devices.</strong> Open this page in Chrome or Edge." + localTools;
  } else if (info.isWindows) {
    html = "<strong>Windows: this page does not work here.</strong> The Pakon driver keeps the scanner to itself. Use a Mac, or boot a Linux live USB on this PC and open this page in Chrome there; nothing gets installed either way." + localTools;
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
