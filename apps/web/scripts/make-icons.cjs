// Render public/icon.svg into the PNG icons the install flow needs. Run only when the artwork
// changes; the PNGs are committed.
//
//   node ~/.claude/skills/playwright-skill/run.js apps/web/scripts/make-icons.cjs
//
// (any Playwright + Chromium install works; the script uses it only as an SVG rasteriser)
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const PUBLIC = path.join(__dirname, '..', 'public');
const OUT = path.join(PUBLIC, 'icons');
const svg = fs.readFileSync(path.join(PUBLIC, 'icon.svg'), 'utf8');

// "any" icons keep the artwork's rounded corners on a transparent background.
const rounded = svg;
// Maskable and Apple icons are full-bleed squares (the OS applies its own mask or rounding).
// A maskable icon's artwork must stay inside the central 80% safe zone; iOS only rounds the
// corners, so its artwork can be larger.
const fullBleed = (scale) => svg
  .replace('<rect width="512" height="512" rx="112" fill="url(#bg)"/>', '<rect width="512" height="512" fill="url(#bg)"/>')
  .replace(/(<!-- a camera's capture zone[\s\S]*<\/svg>)/, `<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">$1`)
  .replace('</svg>', '</g></svg>');

const icons = [
  ['icon-192.png', 192, rounded, true],
  ['icon-512.png', 512, rounded, true],
  ['maskable-512.png', 512, fullBleed(0.74), false],
  ['apple-touch-icon.png', 180, fullBleed(0.9), false],
  ['favicon-32.png', 32, rounded, true],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [name, size, source, transparent] of icons) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`);
      await page.screenshot({ path: path.join(OUT, name), omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
      await page.close();
      console.log(`wrote icons/${name} (${size}px)`);
    }
  } finally {
    await browser.close();
  }
})();
