/**
 * Run after `npx capacitor-assets generate --android`:
 *   node scripts/fix-adaptive-icon-density.mjs
 *
 * capacitor-assets writes ic_launcher_foreground.png / ic_launcher_background.png at the
 * *legacy* launcher-icon size per density bucket (e.g. 192x192 at xxxhdpi — 48dp x 4x).
 * But mipmap-anydpi-v26/ic_launcher.xml uses those exact same files as the *adaptive* icon's
 * layers, whose canvas is 108dp, not 48dp — so Android has to upscale a 192px source to fill
 * a 432px canvas at xxxhdpi, which blurs the icon no matter how sharp the source art is.
 * This overwrites them with correctly-sized (108dp-canvas) versions instead.
 */
import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NATURAL = 100; // favicon.svg/glyph viewBox units — see generate-capacitor-assets.mjs
const densityFor = (px) => Math.ceil(72 * (px / NATURAL));

const BG = '#0d1117';
const FG = '#00ff9d';
const glyphSvg = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none">
  <g stroke="${FG}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <rect x="20" y="26" width="6" height="14" rx="2" fill="${FG}" stroke="none"/>
    <rect x="24" y="18" width="52" height="64" rx="12"/>
    <line x1="70" y1="18" x2="78" y2="6"/>
    <circle cx="78" cy="6" r="3" fill="${FG}" stroke="none"/>
    <rect x="33" y="28" width="34" height="18" rx="3" stroke-width="4"/>
    <line x1="38" y1="34" x2="58" y2="34" stroke-width="3"/>
    <line x1="38" y1="41" x2="52" y2="41" stroke-width="3"/>
    <circle cx="40" cy="58" r="2.2" fill="${FG}" stroke="none"/>
    <circle cx="50" cy="58" r="2.2" fill="${FG}" stroke="none"/>
    <circle cx="60" cy="58" r="2.2" fill="${FG}" stroke="none"/>
  </g>
</svg>`);

// Real adaptive icon canvas is 108dp, scaled by each bucket's density multiplier.
const ADAPTIVE_DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const CANVAS_DP = 108;

for (const [density, mult] of Object.entries(ADAPTIVE_DENSITIES)) {
  const px = Math.round(CANVAS_DP * mult);
  const dir = join(root, `android/app/src/main/res/mipmap-${density}`);
  mkdirSync(dir, { recursive: true });

  // Background — flat colour, full canvas
  await sharp({ create: { width: px, height: px, channels: 4, background: BG } })
    .png().toFile(join(dir, 'ic_launcher_background.png'));

  // Foreground — glyph at ~60% of canvas (within the adaptive icon's ~66% safe zone),
  // rendered directly at that target size rather than upscaled into it.
  const glyphPx = Math.round(px * 0.6);
  const glyph = await sharp(glyphSvg, { density: densityFor(glyphPx) }).resize(glyphPx, glyphPx).png().toBuffer();
  await sharp({ create: { width: px, height: px, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: glyph, gravity: 'center' }])
    .png().toFile(join(dir, 'ic_launcher_foreground.png'));

  console.log(`  mipmap-${density}: ${px}x${px} (was legacy-sized)`);
}

console.log('Done.');
