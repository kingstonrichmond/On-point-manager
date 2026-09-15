// Renders the home-screen icons from the tally mark — the same four strokes and
// slash as TallyMark in index.html — so the icon on a phone is the mark in the
// header, not a screenshot. Re-run when the mark changes:
//
//   cd build && npm install && node icons.mjs
//
// Writes ../icons/icon-192.png, icon-512.png and maskable-512.png. The maskable
// one keeps the mark inside the centre 80% (Android's safe zone) so a round or
// squircle mask never clips a stroke.
//
// The glow is blurred here with sharp rather than an SVG filter: librsvg draws
// a filter's region with a faint edge you can see on a dark background.
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
const CRUST = "#17191B", CREAM = "#F6F5F2";
const SVG = (size, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`);

// safe: fraction of the canvas the mark may span. 0.64 fills a plain square
// icon nicely; 0.50 keeps a maskable one clear of every mask shape.
function geometry(size, safe) {
  const w = size * safe, k = w / 34, h = 30 * k;
  return { k, x: (size - w) / 2, y: (size - h) / 2 };
}
const group = (g, inner) => `<g transform="translate(${g.x.toFixed(2)} ${g.y.toFixed(2)}) scale(${g.k.toFixed(4)})">${inner}</g>`;
const slash = (extra) => `<line x1="3" y1="24" x2="30" y2="6" stroke-linecap="round" ${extra}/>`;

function base(size) {
  return SVG(size, `
  <defs><radialGradient id="ember" cx="50%" cy="108%" r="80%">
    <stop offset="0" stop-color="#FF6A1F" stop-opacity="0.72"/>
    <stop offset="0.5" stop-color="#8A2E0A" stop-opacity="0.32"/>
    <stop offset="1" stop-color="${CRUST}" stop-opacity="0"/>
  </radialGradient></defs>
  <rect width="${size}" height="${size}" fill="${CRUST}"/>
  <rect width="${size}" height="${size}" fill="url(#ember)"/>`);
}
function glow(size, g) {
  return SVG(size, group(g, slash(`stroke="#FF7A1A" stroke-width="7" opacity="0.95"`)));
}
function mark(size, g) {
  const lines = [6, 13, 20, 27].map((v) => `<line x1="${v}" y1="7" x2="${v}" y2="23"/>`).join("");
  return SVG(size, `
  <defs><linearGradient id="flame" x1="0" y1="1" x2="1" y2="0">
    <stop offset="0" stop-color="#FF2E12"/><stop offset="0.45" stop-color="#FF8A00"/><stop offset="1" stop-color="#FFD84A"/>
  </linearGradient></defs>
  ${group(g, `<g stroke="${CREAM}" stroke-width="3" stroke-linecap="round">${lines}</g>${slash(`stroke="url(#flame)" stroke-width="3"`)}`)}`);
}

async function render(size, safe) {
  const g = geometry(size, safe);
  const glowLayer = await sharp(glow(size, g)).blur(1.9 * g.k).png().toBuffer();
  return sharp(base(size))
    .composite([{ input: glowLayer }, { input: mark(size, g) }])
    .png({ palette: true, quality: 92, compressionLevel: 9 })
    .toBuffer();
}

mkdirSync(OUT, { recursive: true });
for (const [name, size, safe] of [["icon-192.png", 192, 0.64], ["icon-512.png", 512, 0.64], ["maskable-512.png", 512, 0.50]]) {
  const buf = await render(size, safe);
  await sharp(buf).toFile(join(OUT, name));
  console.log("wrote icons/" + name + " (" + Math.round(buf.length / 1024) + " KB)");
}
