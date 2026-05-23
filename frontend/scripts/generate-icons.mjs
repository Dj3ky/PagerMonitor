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

await sharp(svg).resize(192, 192).png().toFile(join(root, 'public/icon-192.png'));
console.log('  icon-192.png');

await sharp(svg).resize(512, 512).png().toFile(join(root, 'public/icon-512.png'));
console.log('  icon-512.png');

await sharp(badge).resize(96, 96).png().toFile(join(root, 'public/badge-96.png'));
console.log('  badge-96.png');

console.log('Done.');
