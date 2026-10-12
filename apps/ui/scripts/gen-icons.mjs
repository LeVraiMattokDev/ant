// Generates the PWA icons (PNG) and the SVG favicon using Node built-ins only.
// Mark: an amber hexagon (the cell of a colony) carrying three dark segments (an ant seen from above).
// Usage: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(out, { recursive: true });

const BG = [0x14, 0x15, 0x18];
const AMBER = [0xe0, 0x9a, 0x3e];
const INK = [0x14, 0x15, 0x18];

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Point-in-regular-hexagon (pointy top), centred at (cx, cy) with circumradius r. */
function inHex(x, y, cx, cy, r) {
  const dx = Math.abs(x - cx);
  const dy = Math.abs(y - cy);
  const h = (Math.sqrt(3) / 2) * r;
  if (dx > h) return false;
  return dy <= r - dx / Math.sqrt(3);
}

function inEllipse(x, y, cx, cy, rx, ry) {
  const nx = (x - cx) / rx;
  const ny = (y - cy) / ry;
  return nx * nx + ny * ny <= 1;
}

/** Returns the colour of the mark at unit coordinates (0..1). `scale` shrinks the mark for maskable icons. */
function sample(u, v, scale, rounded) {
  // Rounded-square background (or full bleed for maskable).
  if (rounded) {
    const rr = 0.18;
    const qx = Math.max(Math.abs(u - 0.5) - (0.5 - rr), 0);
    const qy = Math.max(Math.abs(v - 0.5) - (0.5 - rr), 0);
    if (qx * qx + qy * qy > rr * rr) return null;
  }
  const x = (u - 0.5) / scale + 0.5;
  const y = (v - 0.5) / scale + 0.5;
  if (!inHex(x, y, 0.5, 0.5, 0.36)) return BG;
  // Ant body: head, thorax, abdomen along the vertical axis.
  if (inEllipse(x, y, 0.5, 0.33, 0.055, 0.05)) return INK;
  if (inEllipse(x, y, 0.5, 0.45, 0.045, 0.06)) return INK;
  if (inEllipse(x, y, 0.5, 0.62, 0.085, 0.11)) return INK;
  return AMBER;
}

function render(size, { scale = 1, rounded = true } = {}) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, scale, rounded);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const i = (py * size + px) * 4;
      const n = ss * ss;
      buf[i] = a ? Math.round(r / a) : 0;
      buf[i + 1] = a ? Math.round(g / a) : 0;
      buf[i + 2] = a ? Math.round(b / a) : 0;
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePng(size, buf);
}

writeFileSync(join(out, 'pwa-192.png'), render(192));
writeFileSync(join(out, 'pwa-512.png'), render(512));
writeFileSync(join(out, 'maskable-512.png'), render(512, { scale: 0.78, rounded: false }));
writeFileSync(join(out, 'apple-touch-icon.png'), render(180, { rounded: false }));
writeFileSync(join(out, 'favicon-32.png'), render(32));

const hex = (cx, cy, r) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  }).join(' ');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="11.5" fill="#141518"/>
<polygon points="${hex(32, 32, 23)}" fill="#e09a3e"/>
<g fill="#141518"><ellipse cx="32" cy="21.1" rx="3.5" ry="3.2"/><ellipse cx="32" cy="28.8" rx="2.9" ry="3.8"/><ellipse cx="32" cy="39.7" rx="5.4" ry="7"/></g>
</svg>
`;
writeFileSync(join(out, 'favicon.svg'), svg);
console.log('Icons written to', out);
