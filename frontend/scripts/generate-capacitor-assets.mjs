/**
 * Run once (and whenever favicon.svg changes), before `npx capacitor-assets generate`:
 *   node scripts/generate-capacitor-assets.mjs
 *
 * Builds resources/icon.png, icon-foreground.png, icon-background.png and splash.png
 * from favicon.svg — source art for the Android app icon / adaptive icon / splash screen.
 * Requires: sharp (listed in devDependencies)
 */
import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out  = join(root, 'resources');
mkdirSync(out, { recursive: true });

const badgeSvg = readFileSync(join(root, 'public/badge.svg'));

// Status-bar notification icon (FCM's android.notification.icon / default_notification_icon) —
// Android masks this to a flat silhouette regardless, but starting from an already-monochrome
// source (badge.svg) gives a clean result instead of a mangled auto-silhouette of the colour icon.
const NOTIF_DENSITIES = { mdpi: 24, hdpi: 36, xhdpi: 48, 'xxhdpi': 72, 'xxxhdpi': 96 };
for (const [density, size] of Object.entries(NOTIF_DENSITIES)) {
  const dir = join(root, `android/app/src/main/res/drawable-${density}`);
  mkdirSync(dir, { recursive: true });
  await sharp(badgeSvg).resize(size, size).png().toFile(join(dir, 'ic_stat_pager.png'));
}
console.log('  android/app/.../drawable-*/ic_stat_pager.png');

const BG = '#0d1117';   // matches --bg-0 / capacitor.config.json background
const FG = '#00ff9d';

const fullSvg = readFileSync(join(root, 'public/favicon.svg'));

// Glyph only (no baked-in background rect) — used for the adaptive icon foreground
// and splash screen, so it can be composited over its own flat background layer.
// Mirrors the pager glyph in public/favicon.svg (same 0-100 coordinate space).
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

// Legacy / Play Store icon — full bleed square, background baked in
await sharp(fullSvg).resize(1024, 1024).png().toFile(join(out, 'icon.png'));
console.log('  resources/icon.png');

// Adaptive icon background — flat colour layer
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG } })
  .png().toFile(join(out, 'icon-background.png'));
console.log('  resources/icon-background.png');

// Adaptive icon foreground — glyph centred within the ~66% safe zone, transparent bg
const glyphOnBg = await sharp(glyphSvg).resize(620, 620).png().toBuffer();
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: glyphOnBg, gravity: 'center' }])
  .png().toFile(join(out, 'icon-foreground.png'));
console.log('  resources/icon-foreground.png');

// Splash screen — glyph centred on the app's dark background
const glyphForSplash = await sharp(glyphSvg).resize(760, 760).png().toBuffer();
await sharp({ create: { width: 2732, height: 2732, channels: 4, background: BG } })
  .composite([{ input: glyphForSplash, gravity: 'center' }])
  .png().toFile(join(out, 'splash.png'));
console.log('  resources/splash.png');

console.log('Done.');
