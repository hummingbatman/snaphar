/**
 * make-icons.mjs — generate SnapHAR's placeholder PNG icons.
 *
 * Draws a brand-blue rounded square with a white lightning bolt (the "snap").
 * Pure Node + zlib, no native deps, so it runs anywhere. Re-run after tweaking
 * colors/shape: `node scripts/make-icons.mjs`.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../icons/', import.meta.url));
const SIZES = [16, 32, 48, 128];

const BG = [15, 108, 189, 255];     // #0f6cbd
const BG2 = [10, 80, 150, 255];     // subtle vertical gradient bottom
const BOLT = [255, 255, 255, 255];

// Lightning bolt polygon in a 0..1 unit square.
const BOLT_POLY = [
  [0.56, 0.08], [0.30, 0.55], [0.46, 0.55], [0.40, 0.92],
  [0.72, 0.40], [0.54, 0.40], [0.62, 0.08],
];

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function lerp(a, b, t) {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

function renderRGBA(size) {
  const data = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inCorner = roundedRectAlpha(x + 0.5, y + 0.5, size, radius);
      if (inCorner === 0) {
        data[i + 3] = 0; // transparent outside the rounded square
        continue;
      }
      const u = x / (size - 1);
      const v = y / (size - 1);
      let px = pointInPolygon(u, v, BOLT_POLY) ? BOLT : lerp(BG, BG2, v);
      data[i] = px[0];
      data[i + 1] = px[1];
      data[i + 2] = px[2];
      data[i + 3] = Math.round(px[3] * inCorner);
    }
  }
  return data;
}

// Returns coverage 0..1 for a rounded-rect mask (simple inside/outside, AA-ish).
function roundedRectAlpha(x, y, size, r) {
  const min = r;
  const max = size - r;
  let dx = 0;
  let dy = 0;
  if (x < min) dx = min - x;
  else if (x > max) dx = x - max;
  if (y < min) dy = min - y;
  else if (y > max) dy = y - max;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= r - 1) return 1;
  if (dist >= r) return 0;
  return r - dist; // 1px feather
}

function pngEncode(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = deflateSync(raw, { level: 9 });

  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    const typeBuf = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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
  return c ^ 0xffffffff;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = pngEncode(size, renderRGBA(size));
  writeFileSync(new URL(`icon${size}.png`, `file://${OUT_DIR}`), png);
  console.log(`wrote icons/icon${size}.png (${png.length} bytes)`);
}
