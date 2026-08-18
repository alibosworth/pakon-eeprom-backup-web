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
  "Pakon5.hex": "6ea86ecf77e281cf0fbea0a94eea16ec9661bcc6ca265e69660e74a2b569f2da",
  "Pakon7.hex": "edd840680ef7714c5d93b89c3def5ed6ba3085166bc8e0a6a15a0390bef3f2b4",
  "Pakon8.hex": "1f21fb0809a432ab1b4c4cf566be609a2eee9c156017018e645a8088aab70a67",
};
const REVISION_TO_FIRMWARE = { 0xaa05: "Pakon5.hex", 0xaa07: "Pakon7.hex", 0xaa08: "Pakon8.hex" };

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
const SECTIONS = [
  { name: "sectionA_primary", base: 0x000, maxLength: 0x400, pair: "sectionA_backup" },
  { name: "sectionA_backup", base: 0x400, maxLength: 0x400 },
  { name: "sectionB_primary", base: 0x800, maxLength: 0x200, pair: "sectionB_backup" },
  { name: "sectionB_backup", base: 0xa00, maxLength: 0x200 },
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
  const records = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith(":")) continue;
    const bytes = Uint8Array.from(line.slice(1).match(/../g), (pair) => parseInt(pair, 16));
    const length = bytes[0];
    const address = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    if (type === 0) records.push({ address, data: bytes.slice(4, 4 + length) });
    // type 1 = EOF; other types are not used by these images
  }
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
}

async function controlIn(request, value, index, length) {
  const result = await device.controlTransferIn({ requestType: "vendor", recipient: "device", request, value, index }, length);
  if (result.status !== "ok") throw new Error(`control IN 0x${hex(request)} failed: ${result.status}`);
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

  const personality = await controlIn(REQUEST_READ, 0, 0, 8);
  bootPersonality = personality.slice();
  const revision = readU16(personality, 5);
  log(`Boot personality: ${bytesToHex(personality)}  (revision 0x${hex(revision, 4)})`);

  const firmwareName = REVISION_TO_FIRMWARE[revision];
  if (!firmwareName) throw new Error(`no application firmware known for revision 0x${hex(revision, 4)}; stopping`);
  log(`Loading application firmware ${firmwareName}…`);
  const application = await fetchFirmware(firmwareName);
  await downloadRecords(application);
  await hold8051(1);
  try {
    await hold8051(0);
  } catch (error) {
    // The scanner drops off the bus as the application starts; that is expected.
  }
  log("Firmware started. The scanner will now reconnect as 0f05:f135; this takes a few seconds.", "ok");
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
  return { ...section, bytes, length, storedCrc, computedCrc, valid: plausible && computedCrc === storedCrc, plausible };
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

async function onConnectClick() {
  try {
    document.getElementById("errorHint").hidden = true;
    await requestScanner([
      { vendorId: VENDOR_ID, productId: PRODUCT_ID_COLD },
      { vendorId: VENDOR_ID, productId: PRODUCT_ID_LOADED },
    ]);
    if (device.productId === PRODUCT_ID_LOADED) {
      log("The scanner already has firmware running; skipping the load step.");
      setStep(1, "done");
      setStep(2, "done");
      setStep(3, "ready");
      return;
    }
    setStep(1, "done");
    setStep(2, "busy");
    await loadFirmware();
    try { await device.close(); } catch (error) { /* already gone */ }
    device = null;
    setStep(2, "done");
    setStep(3, "ready");
  } catch (error) {
    showError(error);
  }
}

async function onReadClick() {
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
      const verdict = read.valid ? "CRC ok" : read.plausible ? "CRC MISMATCH" : "no valid header";
      log(`  ${read.name.padEnd(17)} @0x${hex(read.base, 3)}  ${read.length} bytes  ${verdict}`, read.valid ? "ok" : "warn");
    }
    renderResults();
    setStep(3, "done");
    log("Done. Nothing was written to the scanner.", "ok");
  } catch (error) {
    showError(error);
    setStep(3, "ready");
  }
}

function sectionByName(name) {
  return results.sections.find((section) => section.name === name);
}

function renderResults() {
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
    rows.push(`<tr class="${section.valid ? "good" : "bad"}"><td>${section.name.replace("_", " ")}</td><td>0x${hex(section.base, 3)}</td><td>${section.length}</td><td>${section.valid ? "good" : section.plausible ? "bad CRC" : "no header"}</td><td>${note}</td></tr>`);
  }
  table.innerHTML = rows.join("");

  const goodA = sectionByName("sectionA_primary").valid ? sectionByName("sectionA_primary") : sectionByName("sectionA_backup").valid ? sectionByName("sectionA_backup") : null;
  const summary = document.getElementById("summary");
  if (goodA) {
    const decoded = decodeSectionA(goodA.bytes);
    results.serial = decoded.serial;
    summary.innerHTML = `
      <p>This is scanner <strong>serial ${decoded.serial}</strong>. Motor speeds per resolution base (offset / normal / IR):
      base 4 = ${decoded.triples[0].join(" / ")}, base 8 = ${decoded.triples[1].join(" / ")}, base 16 = ${decoded.triples[2].join(" / ")}.
      Negative matrix diagonal ${decoded.negDiagonal.map((value) => value.toFixed(4)).join(", ")}.</p>
      ${sectionByName("sectionA_primary").valid ? "" : "<p><strong>Your primary copy of section A is bad and the backup copy is good.</strong> This is common on these scanners (both units checked so far are like this); the OEM software silently uses the backup. It is not a reason to write anything to the scanner. If this chip ever needs restoring, restore section A from the <em>backup</em> file.</p>"}
      ${goodA.valid && sectionByName("sectionB_primary").valid ? "<p>You have a complete, verified backup. Download the files below and keep them somewhere safe (two places is better than one).</p>" : ""}`;
  } else {
    summary.innerHTML = `<p><strong>Neither copy of section A verified.</strong> Keep the files anyway (they may still be readable), power-cycle the scanner and try again; if it repeats, the chip may be failing and these files are what you have.</p>`;
  }
  renderDownloads();
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
  if (bootPersonality) files.push({ name: `${prefix}-0x51-boot-personality.bin`, bytes: bootPersonality });
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

function init() {
  const supported = "usb" in navigator;
  document.getElementById("unsupported").hidden = supported;
  document.getElementById("app").hidden = !supported;
  if (!supported) return;
  document.getElementById("connectButton").addEventListener("click", onConnectClick);
  document.getElementById("readButton").addEventListener("click", onReadClick);
  navigator.usb.addEventListener("disconnect", (event) => {
    if (device && event.device === device) {
      log("Scanner disconnected.", "muted");
      device = null;
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
