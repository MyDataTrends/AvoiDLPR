// End-to-end check of choosing an area: the first-visit chooser, search, picking by list and by
// location, remembering the choice, and trips that leave the area. It needs the dev server on
// :5173 with a staged release, and Playwright with Chromium. With the playwright skill:
//   node ~/.claude/skills/playwright-skill/run.js apps/web/e2e/areas.cjs
// The release only has to hold Dallas: the test serves a manifest that adds two more areas
// (reusing Dallas's files), so it runs on any machine that can run the app.
const { chromium, devices } = require('playwright');

const URL = 'http://localhost:5173/';
const DALLAS_DOWNTOWN = { latitude: 32.7767, longitude: -96.797, accuracy: 25 };
const NEW_YORK = { latitude: 40.7128, longitude: -74.006, accuracy: 20 };

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** The staged manifest plus a neighbouring area that overlaps Dallas, and one far away. */
async function withThreeAreas(context) {
  const real = await (await fetch(`${URL}regions.json`)).json();
  const dallas = real.regions.find((r) => r.id === 'dallas');
  const [w, s, e, n] = dallas.bbox;
  // Overlaps Dallas as far east as downtown (-96.797), so a downtown fix is in both: Dallas,
  // which it sits deeper inside, should win. (It reuses Dallas's road pack and basemap.)
  const fortWorth = {
    ...dallas, id: 'fort-worth', name: 'Fort Worth–Arlington', example: undefined,
    bbox: [w - 0.3, s, -96.75, n], center: [(w - 0.3 - 96.75) / 2, (s + n) / 2],
  };
  const charlotte = {
    ...dallas, id: 'charlotte', name: 'Charlotte', group: 'North Carolina', states: ['NC', 'SC'], example: undefined,
    bbox: [-81.27, 34.87, -80.5, 35.62], center: [-80.885, 35.245],
  };
  const manifest = { ...real, regions: [charlotte, dallas, fortWorth] };
  await context.route('**/regions.json', (route) => route.fulfill({ json: manifest }));
  return manifest;
}

const ready = async (page) => {
  await page.getByText('network loaded').waitFor({ timeout: 90_000 });
  await page.waitForFunction(() => window.__fw?.map.loaded(), null, { timeout: 90_000 });
};
const chooserOpen = (page) => page.evaluate(() => document.getElementById('chooser').open);

(async () => {
  const errors = [];
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    // ---------- first visit: nothing remembered, so the chooser asks ----------
    const ctx = await browser.newContext({ ...devices['Pixel 7'], geolocation: DALLAS_DOWNTOWN, permissions: ['geolocation'] });
    await withThreeAreas(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/failed to fetch|aborted/i.test(m.text()) && errors.push(m.text()));
    await page.goto(URL);
    await page.locator('#chooser[open]').waitFor({ timeout: 30_000 });
    check('first visit: the chooser opens by itself', await chooserOpen(page));
    check('first visit: it can\'t be dismissed', await page.locator('#chooserClose').isHidden());
    await page.keyboard.press('Escape');
    check('first visit: Escape leaves it open', await chooserOpen(page));
    const groups = await page.locator('#chooserList h3').allInnerTexts();
    check('the list is grouped by state', groups.join('|') === 'NORTH CAROLINA|TEXAS' || groups.join('|') === 'North Carolina|Texas', groups.join(', '));
    const listed = await page.locator('#chooserList .area-name').allInnerTexts();
    check('areas are listed by name within a state', listed.join('|') === 'Charlotte|Dallas|Fort Worth–Arlington', listed.join(', '));
    await page.locator('#chooserSearch').fill('worth');
    const shown = await page.locator('#chooserList li:not([hidden]) .area-name').allInnerTexts();
    check('search narrows the list', shown.join('|') === 'Fort Worth–Arlington', shown.join(', '));
    await page.locator('#chooserSearch').fill('sc');
    check('search matches state codes', (await page.locator('#chooserList li:not([hidden]) .area-name').allInnerTexts()).join('|') === 'Charlotte');
    await page.locator('#chooserSearch').fill('zzz');
    check('no match says so', await page.locator('#chooserEmpty').isVisible());
    await page.locator('#chooserSearch').fill('');
    check('nothing is in the URL before an area is chosen', !(await page.evaluate(() => location.hash)));

    // ---------- pick by location: Dallas downtown is in both Dallas and Fort Worth; Dallas holds it best ----------
    await Promise.all([page.waitForEvent('load'), page.locator('#chooserLocate').tap()]);
    await ready(page);
    check('locating picks the area you are in (the one you sit deepest inside)',
      (await page.locator('#regionName').innerText()) === 'Dallas, TX', await page.locator('#regionName').innerText());
    await page.locator('#fromText', { hasText: 'Your location' }).waitFor({ timeout: 15_000 });
    check('after a pick by location, the start is your location', true);
    check('the URL keeps neither the area nor the location', !/r=|from=/.test(await page.evaluate(() => location.hash)),
      await page.evaluate(() => location.hash));
    const progressSeen = await page.evaluate(() => window.__fw.state.progress === null && window.__fw.state.stats !== null);
    check('the download finished and the progress cleared', progressSeen);

    // ---------- remembered ----------
    await page.reload();
    await ready(page);
    check('a reload opens the remembered area without asking', !(await chooserOpen(page)) && (await page.locator('#regionName').innerText()) === 'Dallas, TX');

    // ---------- the switcher, and closing it ----------
    await page.locator('#regionBtn').tap();
    check('the area button opens the chooser', await chooserOpen(page));
    check('the open area is marked', (await page.locator('.area[aria-current="true"] .area-name').innerText()) === 'Dallas');
    check('this time it can be closed', await page.locator('#chooserClose').isVisible());
    await page.locator('#chooserClose').tap();
    check('closing returns to the map', !(await chooserOpen(page)));

    // ---------- a trip that leaves the area ----------
    // A reload forgets a GPS start (it's never stored), so find it again first.
    await page.locator('#mapLocate').tap();
    await page.locator('#fromText', { hasText: 'Your location' }).waitFor({ timeout: 15_000 });
    const tap = async (lon, lat) => {
      const p = await page.evaluate(([x, y]) => window.__fw.map.project([x, y]), [lon, lat]);
      await page.touchscreen.tap(p.x, p.y);
    };
    await page.locator('#targetTo').tap();
    const [w, s, , n] = await page.evaluate(() => window.__fw.state.stats.bbox);
    await page.evaluate(([lon, lat]) => window.__fw.map.jumpTo({ center: [lon, lat], zoom: 9 }), [w, (s + n) / 2]);
    await page.waitForTimeout(400);
    await tap(w - 0.1, (s + n) / 2); // west of Dallas: inside the made-up Fort Worth area
    await page.locator('#noticeAction').waitFor({ timeout: 10_000 });
    check('a trip leaving the area offers the area that holds it',
      /fits in Fort Worth/.test(await page.locator('#notice').innerText()) && /Fort Worth/.test(await page.locator('#noticeAction').innerText()),
      `${await page.locator('#notice').innerText()} / ${await page.locator('#noticeAction').innerText()}`);
    check('no route is attempted outside the area', (await page.evaluate(() => window.__fw.state.routes)) === null);
    await Promise.all([page.waitForEvent('load'), page.locator('#noticeAction').tap()]);
    await ready(page);
    check('switching opens the other area', (await page.locator('#regionName').innerText()) === 'Fort Worth–Arlington, TX');
    const hash = await page.evaluate(() => location.hash);
    check('the destination came along; the GPS start did not', /to=/.test(hash) && !/from=/.test(hash), hash);
    await page.locator('#fromText', { hasText: 'Your location' }).waitFor({ timeout: 15_000 });
    check('and the start was found again from the device', true);
    await ctx.close();

    // ---------- outside every area ----------
    const far = await browser.newContext({ ...devices['Pixel 7'], geolocation: NEW_YORK, permissions: ['geolocation'] });
    await withThreeAreas(far);
    const fp = await far.newPage();
    fp.on('pageerror', (e) => errors.push(e.message));
    await fp.goto(URL);
    await fp.locator('#chooser[open]').waitFor({ timeout: 30_000 });
    await fp.locator('#chooserLocate').tap();
    await fp.locator('#chooserNotice', { hasText: 'doesn\'t cover' }).waitFor({ timeout: 15_000 });
    const nearby = await fp.locator('#chooserNearby .area-name').allInnerTexts();
    check('outside coverage, the nearest areas are offered, closest first', nearby[0] === 'Charlotte' && nearby.length === 3, nearby.join(', '));
    check('with their distance', /km away/.test(await fp.locator('#chooserNearby .area-meta').first().innerText()));
    await Promise.all([fp.waitForEvent('load'), fp.locator('#chooserList .area', { hasText: 'Dallas' }).tap()]);
    await ready(fp);
    check('picking from the list opens that area', (await fp.locator('#regionName').innerText()) === 'Dallas, TX');
    await far.close();

    // ---------- storage blocked: the pick still lands, through the URL ----------
    const blocked = await browser.newContext({ ...devices['Pixel 7'] });
    await withThreeAreas(blocked);
    await blocked.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
    });
    const bp = await blocked.newPage();
    bp.on('pageerror', (e) => errors.push(e.message));
    await bp.goto(URL);
    await bp.locator('#chooser[open]').waitFor({ timeout: 30_000 });
    await Promise.all([bp.waitForEvent('load'), bp.locator('#chooserList .area', { hasText: 'Charlotte' }).tap()]);
    await bp.locator('#regionName', { hasText: 'Charlotte' }).waitFor({ timeout: 30_000 });
    check('with storage blocked, picking an area still opens it', true);
    await blocked.close();
  } finally {
    await browser.close();
  }
  console.log(`\nconsole/page errors: ${errors.length ? `\n  ${errors.join('\n  ')}` : 'none'}`);
  const failed = results.filter((r) => !r.ok).length + (errors.length ? 1 : 0);
  console.log(`\n${results.length - results.filter((r) => !r.ok).length}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
