// End-to-end check of search: the From and To fields find places, addresses, streets and
// coordinates in the area's index, on the device. It needs the dev server on :5173 with a staged
// release that has Dallas's search index (python -m pipeline.places, then pipeline.release), and
// Playwright with Chromium. With the playwright skill:
//   node ~/.claude/skills/playwright-skill/run.js apps/web/e2e/search.cjs
const os = require('node:os');
const path = require('node:path');
const { chromium, devices } = require('playwright');

const URL = 'http://localhost:5173/#r=dallas';
const DALLAS_DOWNTOWN = { latitude: 32.7767, longitude: -96.797, accuracy: 25 };
const OUT = process.env.PW_ARTIFACT_DIR || os.tmpdir();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const ready = async (page) => {
  await page.getByText('network loaded').waitFor({ timeout: 90_000 });
  await page.waitForFunction(() => window.__fw?.map.loaded(), null, { timeout: 90_000 });
};
const searchReady = (page) => page.waitForFunction(() => window.__fw?.search?.ready, null, { timeout: 60_000 });
const options = (page) => page.locator('#suggestions .suggestion:not(.suggest-map) .suggest-name').allInnerTexts();
const value = (page, id) => page.locator(id).inputValue();
const sheetState = (page) => page.evaluate(() => document.getElementById('panel').dataset.state);

/** Type into a field and wait for results that include `expect`. */
async function type(page, field, text, expect) {
  await page.locator(field).tap();
  await page.locator(field).fill(text);
  if (expect) {
    await page.locator('#suggestions .suggest-name', { hasText: expect }).first().waitFor({ timeout: 10_000 });
  } else {
    await page.waitForTimeout(400);
  }
}

(async () => {
  const errors = [];
  const hosts = new Set();
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], geolocation: DALLAS_DOWNTOWN, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/failed to fetch|aborted/i.test(m.text()) && errors.push(m.text()));
    page.on('request', (r) => hosts.add(new globalThis.URL(r.url()).host));
    const placesRequests = [];
    page.on('request', (r) => /\/places\/dallas\.[0-9a-f]+\.fwp\.gz$/.test(r.url()) && placesRequests.push(r.url()));
    await page.goto(URL);
    await ready(page);
    await searchReady(page);
    check('the search index downloads once the road map is in', placesRequests.length === 1, placesRequests.join(' '));
    check('the fields start empty, with a hint', (await value(page, '#fromInput')) === '' && /search/i.test(await page.locator('#fromInput').getAttribute('placeholder')));

    // ---------- a destination by name ----------
    await page.locator('#toInput').tap();
    check('focusing a field opens the sheet all the way', (await sheetState(page)) === 'full');
    check('focusing a field makes map taps set its stop', (await page.locator('#targetTo').getAttribute('data-target')) === 'true');
    check('an empty field offers "Choose on the map"', await page.locator('#suggestions .suggest-map').isVisible());
    await type(page, '#toInput', 'american airlines center', 'American Airlines Center');
    const found = await options(page);
    await page.screenshot({ path: path.join(OUT, 'search-1-results.png') });
    check('a place by its name', found[0] === 'American Airlines Center', found.join(' | '));
    check('with its kind and town', /Stadium · Dallas/.test(await page.locator('#suggestions .suggest-detail').first().innerText()));
    check('the field is a combobox that says the list is open', (await page.locator('#toInput').getAttribute('aria-expanded')) === 'true');
    await page.keyboard.press('ArrowDown');
    check('arrow keys move through the results',
      (await page.locator('#toInput').getAttribute('aria-activedescendant')) === 'suggest-0'
      && (await page.locator('#suggest-0').getAttribute('aria-selected')) === 'true');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__fw.state.to !== null);
    check('picking one sets the destination', (await value(page, '#toInput')) === 'American Airlines Center');
    const to = await page.evaluate(() => window.__fw.state.to);
    check('at the right spot', Math.abs(to[0] - -96.8103) < 0.003 && Math.abs(to[1] - 32.7905) < 0.003, to.join(','));
    check('the list closes and the sheet comes back down', await page.locator('#suggestions').isHidden() && (await sheetState(page)) === 'half');
    check('names stay out of the link', !/american|airlines/i.test(await page.evaluate(() => location.hash)), await page.evaluate(() => location.hash));

    // ---------- a start by address ----------
    await type(page, '#fromInput', '1500 marilla st', '1500 Marilla Street');
    check('an address by number and street', (await options(page))[0] === '1500 Marilla Street', (await options(page)).join(' | '));
    await page.locator('#suggestions .suggestion').first().tap();
    check('picking it sets the start', (await value(page, '#fromInput')) === '1500 Marilla Street');
    await page.locator('.option').first().waitFor({ timeout: 30_000 });
    check('and a route is planned between them', (await page.locator('.option').count()) >= 1);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, 'search-2-route.png') });

    // ---------- swapping keeps the names ----------
    await page.locator('#swap').tap();
    check('swapping swaps the names', (await value(page, '#fromInput')) === 'American Airlines Center' && (await value(page, '#toInput')) === '1500 Marilla Street');

    // ---------- other kinds of query ----------
    await type(page, '#toInput', 'elm st', 'Elm Street');
    check('a street, with its town', (await page.locator('#suggestions .suggest-detail').first().innerText()).startsWith('Street · Dallas'));
    await page.locator('#toInput').fill('6000 e mockingbird ln');
    await page.locator('#suggestions .suggest-detail', { hasText: 'Approximate' }).first().waitFor({ timeout: 10_000 });
    check('a number the map lacks is placed between its neighbours, and says so', (await options(page))[0] === '6000 East Mockingbird Lane');
    await page.locator('#toInput').fill('32.7767, -96.797');
    await page.locator('#suggestions .suggest-name', { hasText: '32.77670, -96.79700' }).waitFor({ timeout: 10_000 });
    check('coordinates', true);
    await page.locator('#toInput').fill('qqzzxv');
    await page.locator('.suggest-note', { hasText: 'Nothing called' }).waitFor({ timeout: 10_000 });
    check('no match says so', true);
    await page.keyboard.press('Escape');
    check('Escape closes the list and puts the name back', await page.locator('#suggestions').isHidden() && (await value(page, '#toInput')) === '1500 Marilla Street');

    // ---------- a place set back from the road ----------
    await type(page, '#toInput', 'white rock lake', 'White Rock Lake');
    await page.locator('#suggestions .suggestion').first().tap();
    await page.waitForFunction(() => !window.__fw.state.routing, null, { timeout: 30_000 });
    check('a lake (its middle far from a road) still gets a route', (await page.locator('.option').count()) >= 1, await page.locator('#notice').innerText().catch(() => ''));

    // ---------- choose on the map: the tapped spot is named after what's there ----------
    await page.locator('#toInput').tap();
    await page.locator('#suggestions .suggest-map').tap();
    check('"Choose on the map" lowers the sheet to show the map', (await sheetState(page)) === 'peek');
    // A few metres from Dallas City Hall.
    await page.evaluate(() => window.__fw.map.jumpTo({ center: [-96.797, 32.7764], zoom: 16 }));
    await page.waitForTimeout(500);
    const p = await page.evaluate(() => window.__fw.map.project([-96.797, 32.7764]));
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForFunction(() => window.__fw.state.names.to !== null, null, { timeout: 10_000 }).catch(() => {});
    const tapped = await value(page, '#toInput');
    check('a tapped destination is named after the nearest address or place', /Dallas City Hall/.test(tapped), tapped);

    check('search talks to nothing but this site', [...hosts].every((h) => h === 'localhost:5173'), [...hosts].join(', '));
    check('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
