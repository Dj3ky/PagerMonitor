/**
 * Run once on the RPi after npm install:
 *   node scripts/generate-icons.mjs
 *
 * Generates icon-192.png and icon-512.png in public/ from favicon.svg.
 * Requires: sharp (listed in devDependencies)
 */
import sharp from 'sharp';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root   = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg    = readFileSync(join(root, 'public/favicon.svg'));
const badge  = readFileSync(join(root, 'public/badge.svg'));

// favicon.svg/badge.svg declare only a viewBox, no width/height — sharp's SVG backend
// then treats their *natural* render size as those viewBox units (100x100) at the
// default 72 DPI, rasterizes at that tiny size first, and only then resize() upscales
// that already-rasterized 100px image to the requested output — producing soft/blurry
// icons regardless of how bold the artwork is. A high enough `density` makes it
// rasterize directly at the target size instead of upscaling into it.
const NATURAL = 100; // both SVGs' viewBox units
const densityFor = (px) => Math.ceil(72 * (px / NATURAL));

await sharp(svg, { density: densityFor(192) }).resize(192, 192).png().toFile(join(root, 'public/icon-192.png'));
console.log('  icon-192.png');

await sharp(svg, { density: densityFor(512) }).resize(512, 512).png().toFile(join(root, 'public/icon-512.png'));
console.log('  icon-512.png');

await sharp(badge, { density: densityFor(96) }).resize(96, 96).png().toFile(join(root, 'public/badge-96.png'));
console.log('  badge-96.png');

console.log('Done.');
