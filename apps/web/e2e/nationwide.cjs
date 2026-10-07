// End-to-end check of the map of the whole country: the first visit opens on the lower 48 with
// no area to choose, the map isn't fenced into an area, and areas load as you go (settling on a
// city, searching for one, a trip that only fits in another, your location), all in place,
// without a reload. It needs the dev server on :5173 with Dallas staged, and Playwright with
// Chromium. With the playwright skill:
//   node ~/.claude/skills/playwright-skill/run.js apps/web/e2e/nationwide.cjs
// The release only has to hold Dallas: the test serves a manifest in the country-basemap form
// (one basemap named at the top and by every area), reusing Dallas's files for two more areas.
const { chromium, devices } = require('playwright');

const URL = 'http://localhost:5173/';
const LOWER48 = [-126.76, 24.18, -66.85, 49.43];
const DALLAS_DOWNTOWN = { latitude: 32.7767, longitude: -96.797, accuracy: 25 };

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** The staged manifest as the monthly build now writes it, with Fort Worth (overlapping) and Charlotte (far away). */
async function nationwide(context) {
  const real = await (await fetch(`${URL}regions.json`)).json();
  const dallas = real.regions.find((r) => r.id === 'dallas');
  const basemap = { ...dallas.basemap, bbox: LOWER48 };
  const [w, s, , n] = dallas.bbox;
  const fortWorth = {
    ...dallas, id: 'fort-worth', name: 'Fort Worth–Arlington', example: undefined,
    bbox: [w - 0.3, s, -96.75, n], center: [(w - 0.3 - 96.75) / 2, (s + n) / 2],
  };
  const charlotte = {
    ...dallas, id: 'charlotte', name: 'Charlotte', group: 'North Carolina', states: ['NC', 'SC'], example: undefined,
    bbox: [-81.27, 34.87, -80.5, 35.62], center: [-80.885, 35.245],
  };
  const regions = [charlotte, { ...dallas, basemap }, fortWorth].map((r) => ({ ...r, basemap }));
  const manifest = { ...real, basemap, regions };
  await context.route('**/regions.json', (route) => route.fulfill({ json: manifest }));
  return { dallas, fortWorth, charlotte };
}

const ready = (page) => page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 90_000 });
const areaName = (page) => page.locator('#regionName').textContent();
const waitArea = (page, name) => page.waitForFunction((n) => document.getElementById('regionName').textContent === n, name, { timeout: 30_000 });
const camera = (page) => page.evaluate(() => {
  const { map } = window.__fw;
  const c = map.getCenter();
  return { lon: c.lng, lat: c.lat, zoom: map.getZoom() };
});
const inBox = ([w, s, e, n], { lon, lat }) => lon >= w && lon <= e && lat >= s && lat <= n;
/** Hold a finger on the map at a screen point, through the browser's own touch input, then pick
 *  a line of the spot's menu. */
async function holdAndPick(page, { x, y }, item) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.locator('.spot-menu button', { hasText: item }).tap();
}

/** Set at the start: a reload would lose it. */
const stillSamePage = (page) => page.evaluate(() => window.__sameVisit === true);

(async () => {
  const errors = [];
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    const { dallas, fortWorth, charlotte } = await nationwide(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/failed to fetch|aborted/i.test(m.text()) && errors.push(m.text()));
    await page.goto(URL);
    await page.waitForFunction(() => window.__fw?.map.loaded(), null, { timeout: 60_000 });
    await page.evaluate(() => void (window.__sameVisit = true));

    // ---------- first visit: the country, no area to choose ----------
    const start = await camera(page);
    check('first visit: no chooser, just the map', !(await page.evaluate(() => document.getElementById('chooser').open)));
    check('it opens on the whole lower 48', start.zoom < 5 && inBox(LOWER48, start), JSON.stringify(start));
    check('with no area loaded yet, and a hint where the routes would be',
      (await areaName(page)) === 'None yet' && (await page.locator('#loadStatus').innerText()) === 'Zoom in on a city, or search for one'
      && (await page.locator('#chips').isHidden()), await page.locator('#loadStatus').innerText());

    // ---------- the map isn't fenced into an area ----------
    await page.evaluate(([lon, lat]) => window.__fw.map.jumpTo({ center: [lon, lat], zoom: 6 }), charlotte.center);
    const far = await camera(page);
    check('the map goes anywhere in the country', Math.abs(far.lon - charlotte.center[0]) < 0.01, JSON.stringify(far));
    await page.waitForTimeout(800);
    check('zoomed out, nothing loads by itself', (await areaName(page)) === 'None yet');

    // ---------- settle on a city and its roads load ----------
    await page.evaluate(([lon, lat]) => window.__fw.map.jumpTo({ center: [lon, lat], zoom: 11 }), dallas.center);
    await waitArea(page, 'Dallas, TX');
    await ready(page);
    check('zooming in on Dallas loads Dallas, in place', await stillSamePage(page));
    check('then the sample trip and quick searches are there', await page.locator('#chips').isVisible());
    check('and it\'s remembered', (await page.evaluate(() => localStorage.getItem('avoidlpr.region'))) === 'dallas');

    // ---------- search for another area ----------
    await page.locator('#toInput').tap();
    await page.locator('#toInput').fill('charl');
    await page.locator('#suggestions .suggest-area').first().waitFor({ timeout: 10_000 });
    const suggestion = await page.locator('#suggestions .suggestion').first().innerText();
    check('searching a city name offers the area first', /Charlotte/.test(suggestion) && /Area · NC–SC/.test(suggestion),
      suggestion.replace(/\s+/g, ' '));
    await page.locator('#suggestions .suggest-area').first().tap();
    await waitArea(page, 'Charlotte, NC–SC');
    await ready(page);
    await page.waitForFunction(() => !window.__fw.map.isMoving(), null, { timeout: 15_000 });
    check('picking it goes there and loads it, in place', inBox(charlotte.bbox, await camera(page)) && await stillSamePage(page),
      JSON.stringify(await camera(page)));

    // ---------- back to Dallas by moving the map; a planned trip stays put ----------
    await page.evaluate(([lon, lat]) => window.__fw.map.jumpTo({ center: [lon, lat], zoom: 12 }), dallas.center);
    await waitArea(page, 'Dallas, TX');
    await ready(page);
    check('moving the map to Dallas with nothing planned switches back', await stillSamePage(page));
    await page.locator('#example').tap();
    await page.locator('.option').first().waitFor({ timeout: 30_000 });
    await page.evaluate(([lon, lat]) => window.__fw.map.jumpTo({ center: [lon, lat], zoom: 12 }), charlotte.center);
    await page.waitForTimeout(1200);
    check('with a trip planned, looking elsewhere doesn\'t switch areas', (await areaName(page)) === 'Dallas, TX'
      && (await page.evaluate(() => window.__fw.state.routes?.length ?? 0)) > 0);
    await page.locator('#clear').click();

    // ---------- a destination that only fits in another area ----------
    await page.evaluate(([lon, lat]) => window.__fw.map.jumpTo({ center: [lon, lat], zoom: 11 }), dallas.center);
    await page.waitForTimeout(800);
    const westOfDallas = [dallas.bbox[0] - 0.15, (dallas.bbox[1] + dallas.bbox[3]) / 2];
    await page.evaluate(([lon, lat]) => window.__fw.map.jumpTo({ center: [lon, lat], zoom: 12 }), westOfDallas);
    // In Fort Worth only: moving there with nothing planned has already loaded it.
    await waitArea(page, 'Fort Worth–Arlington, TX');
    check('moving off one area onto another loads that one', await stillSamePage(page));
    await page.evaluate(([lon, lat]) => window.__fw.map.jumpTo({ center: [lon, lat], zoom: 12 }), dallas.center);
    await page.waitForTimeout(900);
    check('and coming back where the two overlap keeps the one loaded (no flip-flopping)', (await areaName(page)) === 'Fort Worth–Arlington, TX');
    await page.evaluate(([lon, lat]) => window.__fw.map.jumpTo({ center: [lon, lat], zoom: 12 }), [dallas.bbox[2] - 0.05, dallas.center[1]]);
    await waitArea(page, 'Dallas, TX');
    await ready(page);
    // Now a destination west of Dallas, held, with the map still on Dallas: it fits in Fort Worth only.
    const edge = [dallas.bbox[0] + 0.01, westOfDallas[1]];
    const target = [dallas.bbox[0] - 0.1, westOfDallas[1]];
    const tap = await page.evaluate(([c, t]) => {
      const { map } = window.__fw;
      map.jumpTo({ center: c, zoom: 10 });
      return map.project(t);
    }, [edge, target]);
    await page.waitForTimeout(900);
    check('a map still centred on Dallas keeps Dallas', (await areaName(page)) === 'Dallas, TX');
    await holdAndPick(page, tap, 'Directions to here');
    await page.locator('#noticeAction').waitFor({ timeout: 10_000 });
    const notice = await page.locator('#notice').innerText();
    check('a destination outside the area offers the one it fits in', /outside the Dallas area/.test(notice) && /Fort Worth/.test(notice), notice);
    await page.locator('#noticeAction').tap();
    await waitArea(page, 'Fort Worth–Arlington, TX');
    const to = await page.evaluate(() => window.__fw.state.to);
    check('opening it switches in place and keeps the destination', Boolean(to) && inBox(fortWorth.bbox, { lon: to[0], lat: to[1] })
      && await stillSamePage(page), JSON.stringify(to));
    await ctx.close();

    // ---------- first visit with "Your location" ----------
    const gpsCtx = await browser.newContext({ ...devices['Pixel 7'], geolocation: DALLAS_DOWNTOWN, permissions: ['geolocation'] });
    await nationwide(gpsCtx);
    const gps = await gpsCtx.newPage();
    gps.on('pageerror', (e) => errors.push(e.message));
    await gps.goto(URL);
    await gps.waitForFunction(() => window.__fw?.map.loaded(), null, { timeout: 60_000 });
    await gps.locator('#mapLocate').tap();
    await waitArea(gps, 'Dallas, TX');
    await gps.waitForFunction(() => document.getElementById('fromInput').value.startsWith('Your location'), null, { timeout: 15_000 });
    check('on a first visit, "your location" loads your area and starts there', true);
    check('your location stays out of the link', !/from=|-96\.79|32\.77/.test(await gps.evaluate(() => location.hash)),
      await gps.evaluate(() => location.hash));
    await gps.waitForFunction(() => window.__fw.search.ready, null, { timeout: 60_000 });
    await gps.locator('#toInput').tap();
    await gps.locator('#toInput').fill('zzzz');
    await gps.locator('#suggestions .suggest-note').waitFor({ timeout: 10_000 });
    const note = await gps.locator('#suggestions .suggest-note').innerText();
    check('with an area loaded, a search that matches nothing says so for the area', /Nothing called/.test(note), note);
    await gpsCtx.close();

    // ---------- no area loaded, and a search that matches no area ----------
    const plain = await browser.newContext({ ...devices['Pixel 7'] });
    await nationwide(plain);
    const p3 = await plain.newPage();
    p3.on('pageerror', (e) => errors.push(e.message));
    await p3.goto(URL);
    await p3.waitForFunction(() => window.__fw?.map.loaded(), null, { timeout: 60_000 });
    await p3.locator('#toInput').tap();
    await p3.locator('#toInput').fill('zzzz');
    await p3.waitForTimeout(400);
    check('with no area loaded, a search that matches no area says so', /No area AvoiDLPR covers is called/.test(await p3.locator('#suggestions').innerText()));
    await plain.close();
  } finally {
    await browser.close();
  }
  console.log(`\nconsole/page errors: ${errors.length ? `\n  ${errors.join('\n  ')}` : 'none'}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
