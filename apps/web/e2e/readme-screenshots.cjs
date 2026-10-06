// Takes the screenshots in the README (docs/images/) from the dev server on :5173, using a search
// and the example trip. With the playwright skill, from the repository root:
//   node ~/.claude/skills/playwright-skill/run.js apps/web/e2e/readme-screenshots.cjs
const path = require('node:path');
const { chromium, devices } = require('playwright');

const URL = 'http://localhost:5173/';
const OUT = path.resolve(process.env.README_SHOTS_DIR || 'docs/images');
const DALLAS_DOWNTOWN = { latitude: 32.7767, longitude: -96.797, accuracy: 25 };

async function ready(page) {
  await page.getByText('network loaded').waitFor({ timeout: 90_000 });
  // The search index too: tapped stops are named after it.
  await page.waitForFunction(() => window.__fw?.map.loaded() && window.__fw.search.ready, null, { timeout: 90_000 });
}
const settled = (page) => page.waitForFunction(() => !window.__fw.map.isMoving() && window.__fw.map.areTilesLoaded(), null, { timeout: 30_000 });

async function shot(page, name) {
  await settled(page);
  await page.waitForTimeout(600); // labels and line casings fade in after the tiles load
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, type: 'jpeg', quality: 82 });
  console.log('wrote', file);
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    // A phone at 2x rather than the Pixel's 2.6x keeps the files small.
    const phone = await browser.newContext({
      ...devices['Pixel 7'], deviceScaleFactor: 2, geolocation: DALLAS_DOWNTOWN, permissions: ['geolocation'],
    });
    const page = await phone.newPage();
    await page.goto(URL);
    await ready(page);

    // Searching for a destination, from where you are.
    await page.locator('#mapLocate').tap();
    await page.waitForFunction(() => document.getElementById('fromInput').value.startsWith('Your location'));
    await page.locator('#toInput').tap();
    await page.locator('#toInput').fill('fair park');
    await page.locator('#suggestions .suggest-name', { hasText: 'Music Hall' }).waitFor();
    await shot(page, 'phone-search.jpg');
    await page.keyboard.press('Escape');

    // Route options for the example trip, with the fewest-cameras option selected.
    await page.getByRole('button', { name: 'Try an example trip' }).tap();
    await page.locator('.option').first().waitFor();
    await page.locator('.option').last().tap();
    // Selecting scrolls the sheet to the option; show the list from the top (fastest first).
    await page.evaluate(() => { for (const el of document.querySelectorAll('#panel, #panel *')) el.scrollTop = 0; });
    await shot(page, 'phone-routes.jpg');

    // Driving the recommended route: the alert banner as it enters a camera's zone.
    await page.locator('button.option').filter({ has: page.locator('.chip') }).tap();
    await page.locator('#speed').selectOption('32');
    await page.locator('#drive').scrollIntoViewIfNeeded();
    await page.locator('#drive').tap();
    await page.locator('#banner').filter({ hasText: 'In a camera zone' }).waitFor({ timeout: 90_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'phone-drive.jpg'), type: 'jpeg', quality: 82 });
    console.log('wrote', path.join(OUT, 'phone-drive.jpg'));
    await phone.close();

    // Desktop: the sidebar with the options and the map.
    const desk = await browser.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1.5 });
    const dk = await desk.newPage();
    await dk.goto(URL);
    await ready(dk);
    await dk.getByRole('button', { name: 'Try an example trip' }).click();
    await dk.locator('.option').first().waitFor();
    await shot(dk, 'desktop.jpg');
    await desk.close();
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
