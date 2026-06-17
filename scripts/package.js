/**
 * package.js — bundle the unpacked extension into dist/snaphar-<version>.zip.
 *
 * Implements a minimal store-only (no compression) ZIP writer so packaging has
 * zero dependencies and runs identically on macOS / Linux / Windows.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// Only ship what the browser loads.
const INCLUDE = ['manifest.json', 'src', 'icons', 'LICENSE', 'PRIVACY.md'];

function walk(rel, out = []) {
  const abs = join(ROOT, rel);
  const st = statSync(abs);
  if (st.isDirectory()) {
    for (const name of readdirSync(abs).sort()) walk(join(rel, name), out);
  } else {
    out.push(rel.split('\\').join('/'));
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function zip(files) {
  const { time, date } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const name of files) {
    const data = readFileSync(join(ROOT, name));
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);             // version needed
    local.writeUInt16LE(0, 6);              // flags
    local.writeUInt16LE(0, 8);              // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);   // compressed size
    local.writeUInt32LE(data.length, 22);   // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralStart, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

const files = INCLUDE.flatMap((entry) => {
  try {
    return walk(entry);
  } catch {
    return []; // optional file (e.g. PRIVACY.md) not present yet
  }
});

mkdirSync(join(ROOT, 'dist'), { recursive: true });
const outName = `snaphar-${pkg.version}.zip`;
const outPath = join(ROOT, 'dist', outName);
writeFileSync(outPath, zip(files));
console.log(`Packaged ${files.length} files -> dist/${outName}`);
console.log(files.map((f) => `  ${relative('.', f)}`).join('\n'));
