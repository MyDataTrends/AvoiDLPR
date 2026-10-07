// End-to-end check of the menu and how the app looks: dark mode (chosen, or following the device,
// with the map switching too), your ride on the map, the quick searches and "Your location". It
// needs the dev server on :5173 with Dallas staged (its search index too), and Playwright with
// Chromium. With the playwright skill:
//   node ~/.claude/skills/playwright-skill/run.js apps/web/e2e/appearance.cjs
const os = require('node:os');
const path = require('node:path');
const { chromium, devices } = require('playwright');

const URL = 'http://localhost:5173/#r=dallas';
const OUT = process.env.PW_ARTIFACT_DIR || os.tmpdir();
const DOWNTOWN = { latitude: 32.7767, longitude: -96.797, accuracy: 25 };

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const ready = (page) => page.waitForFunction(() => document.documentElement.dataset.ready === 'true' && window.__fw?.map.loaded(),
  null, { timeout: 90_000 });
/** The basemap's background colour: Protomaps' light and dark flavours differ there. */
const mapBackground = (page) => page.evaluate(() => {
  const bg = (window.__fw.map.getStyle()?.layers ?? []).find((l) => l.type === 'background');
  return bg?.paint?.['background-color'];
});
const overlaysBack = (page) => page.waitForFunction(() => Boolean(window.__fw.map.getSource('fw-routes')), null, { timeout: 20_000 });
const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme ?? 'auto');
const canvas = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

(async () => {
  const errors = [];
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'light', geolocation: DOWNTOWN, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/failed to fetch|aborted/i.test(m.text()) && errors.push(m.text()));
    await page.goto(URL);
    await ready(page);
    const light = await mapBackground(page);
    check('a light device gets the light map and colours', (await theme(page)) === 'auto' && (await canvas(page)) === 'rgb(255, 255, 255)', `map ${light}`);

    // ---------- the device goes dark: Auto follows, map and all ----------
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction((was) => {
      const bg = (window.__fw.map.getStyle()?.layers ?? []).find((l) => l.type === 'background');
      return bg && bg.paint['background-color'] !== was;
    }, light, { timeout: 20_000 });
    await overlaysBack(page);
    check('Auto follows the device into dark mode: the map switches too', (await canvas(page)) !== 'rgb(255, 255, 255)', `map ${await mapBackground(page)}`);
    await page.locator('#example').tap();
    await page.locator('.option').first().waitFor({ timeout: 30_000 });
    check('the overlays come back with the new style (routes draw)',
      await page.evaluate(() => window.__fw.map.querySourceFeatures('fw-routes').length > 0 || window.__fw.state.routes.length > 0));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, 'appearance-dark-trip.png') });

    // ---------- the menu: Light, chosen, beats the dark device ----------
    await page.locator('#menuBtn').tap();
    check('the menu opens', await page.locator('#menu').isVisible());
    await page.locator('[data-theme-choice="light"]').tap();
    await page.waitForFunction((want) => {
      const bg = (window.__fw.map.getStyle()?.layers ?? []).find((l) => l.type === 'background');
      return bg && bg.paint['background-color'] === want;
    }, light, { timeout: 20_000 });
    check('choosing Light overrides the dark device, map included',
      (await theme(page)) === 'light' && (await canvas(page)) === 'rgb(255, 255, 255)'
      && (await page.locator('[data-theme-choice="light"]').getAttribute('aria-checked')) === 'true');

    // ---------- your ride ----------
    const before = await page.evaluate(() => document.querySelector('.persona svg')?.outerHTML.length ?? 0);
    const rides = await page.locator('#rides .ride').allInnerTexts();
    check('four rides to pick from', rides.join('|') === 'Hatchback|Pickup|Van|Scooter', rides.join(', '));
    await page.locator('#rides .ride', { hasText: 'Van' }).tap();
    check('picking one marks it', (await page.locator('#rides .ride', { hasText: 'Van' }).getAttribute('aria-checked')) === 'true');
    await page.locator('#menuClose').tap();
    check('the menu closes', !(await page.locator('#menu').isVisible()));
    await page.locator('#mapLocate').tap();
    await page.waitForFunction(() => window.__fw.state.fromGps !== null, null, { timeout: 15_000 });
    const marker = await page.evaluate(() => document.querySelector('.persona')?.innerHTML ?? '');
    check('your ride stands for you on the map', marker.includes('#b197fc'), `${marker.length} chars, was ${before}`);

    // ---------- remembered on this device ----------
    await page.reload();
    await ready(page);
    check('the theme and the ride are remembered', (await theme(page)) === 'light'
      && (await page.evaluate(() => localStorage.getItem('avoidlpr.ride'))) === 'van');
    await page.locator('#menuBtn').tap();
    await page.locator('[data-theme-choice="auto"]').tap();
    check('Auto goes back to following the device', (await theme(page)) === 'auto'
      && (await page.evaluate(() => localStorage.getItem('avoidlpr.theme'))) === null);
    await page.keyboard.press('Escape');

    // ---------- quick searches ----------
    await page.waitForFunction(() => window.__fw.search.ready, null, { timeout: 60_000 });
    if (await page.locator('#chips').isHidden()) await page.locator('#clear').click(); // the chips show with nothing planned
    await page.locator('.chip-btn', { hasText: 'Coffee' }).tap();
    await page.locator('#suggestions .suggestion:not(.suggest-map)').first().waitFor({ timeout: 20_000 });
    const coffee = await page.locator('#suggestions .suggest-detail').allInnerTexts();
    check('a quick search opens the search with nearby places of that kind',
      (await page.locator('#toInput').inputValue()) === 'cafe' && coffee.filter((d) => d.startsWith('Café')).length >= 3, coffee.slice(0, 3).join(' | '));
    await page.screenshot({ path: path.join(OUT, 'appearance-quick-search.png') });
    await page.locator('#suggestions .suggestion:not(.suggest-map)').first().tap();

    // ---------- "Your location" for the start (there's none yet: the reload forgot the GPS one) ----------
    await page.locator('#fromInput').tap();
    const first = await page.locator('#suggestions .suggest-name').first().innerText();
    check('the start offers "Your location" first', first === 'Your location', first);
    await page.locator('#suggestions .suggestion').first().tap();
    await page.waitForFunction(() => document.getElementById('fromInput').value.startsWith('Your location'), null, { timeout: 15_000 });
    await page.locator('.option').first().waitFor({ timeout: 30_000 });
    check('and picking it plans the trip from where you are', true);
  } finally {
    await browser.close();
  }
  console.log(`\nconsole/page errors: ${errors.length ? `\n  ${errors.join('\n  ')}` : 'none'}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
