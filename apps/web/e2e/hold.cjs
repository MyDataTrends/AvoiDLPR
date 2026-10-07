// End-to-end check of holding the map: a tap or a pan no longer changes the trip; holding a spot
// (a real touch hold, a mouse hold, or a right-click) opens its menu: directions to or from it,
// and reports that open OpenStreetMap there. "Choose on the map" still takes a tap. It needs the
// dev server on :5173 with Dallas staged (its search index too), and Playwright with Chromium.
// With the playwright skill:
//   node ~/.claude/skills/playwright-skill/run.js apps/web/e2e/hold.cjs
const { chromium, devices } = require('playwright');

const URL = 'http://localhost:5173/#r=dallas';
const CITY_HALL = [-96.797, 32.7764];
const EAST = [-96.7938, 32.7764]; // some 300 m east

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const ready = (page) => page.waitForFunction(() => document.documentElement.dataset.ready === 'true'
  && window.__fw?.map.loaded() && window.__fw.search.ready, null, { timeout: 90_000 });
const settled = (page) => page.waitForFunction(() => !window.__fw.map.isMoving(), null, { timeout: 15_000 });
const trip = (page) => page.evaluate(() => ({ from: window.__fw.state.from, to: window.__fw.state.to }));
const menuOpen = (page) => page.locator('.spot-menu').isVisible();
const at = (page, lonLat) => page.evaluate((c) => window.__fw.map.project(c), lonLat);
const near = (a, b) => Boolean(a && b) && Math.abs(a[0] - b[0]) < 2e-4 && Math.abs(a[1] - b[1]) < 2e-4;
/** Centre the map on a spot (so it's on screen whatever covers the rest), and where it is on screen. */
async function centre(page, lonLat, zoom = 16) {
  await page.evaluate(([c, z]) => window.__fw.map.jumpTo({ center: c, zoom: z }), [lonLat, zoom]);
  await page.waitForFunction(() => !window.__fw.map.isMoving(), null, { timeout: 15_000 });
  return page.evaluate((c) => window.__fw.map.project(c), lonLat);
}

/** A finger, through the browser's own touch input: held still, or dragged. */
async function touch(page, cdp, { x, y }, { holdMs = 700, dragTo = null } = {}) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  if (dragTo) {
    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x: x + ((dragTo.x - x) * i) / 6, y: y + ((dragTo.y - y) * i) / 6 }],
      });
      await page.waitForTimeout(30);
    }
  }
  await page.waitForTimeout(holdMs);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(150);
}

(async () => {
  const errors = [];
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/failed to fetch|aborted/i.test(m.text()) && errors.push(m.text()));
    const cdp = await ctx.newCDPSession(page);
    await page.goto(URL);
    await ready(page);
    await page.evaluate((c) => window.__fw.map.jumpTo({ center: c, zoom: 16 }), CITY_HALL);
    await settled(page);

    // ---------- taps and pans leave the trip alone ----------
    const hall = await at(page, CITY_HALL);
    await page.touchscreen.tap(hall.x, hall.y);
    await page.waitForTimeout(400);
    check('a tap on the map doesn\'t set a stop', JSON.stringify(await trip(page)) === '{"from":null,"to":null}');
    await touch(page, cdp, hall, { dragTo: { x: hall.x + 60, y: hall.y + 40 }, holdMs: 800 });
    await settled(page);
    check('a pan that pauses opens nothing and sets nothing', !(await menuOpen(page))
      && JSON.stringify(await trip(page)) === '{"from":null,"to":null}');

    // ---------- holding a spot ----------
    await page.evaluate((c) => window.__fw.map.jumpTo({ center: c, zoom: 16 }), CITY_HALL);
    await settled(page);
    await touch(page, cdp, await at(page, CITY_HALL));
    check('holding a spot opens its menu', await menuOpen(page));
    const items = await page.locator('.spot-menu .spot-item > span:not(.spot-detail)').allInnerTexts();
    check('with directions there and from there, and the two reports',
      items.join('|') === 'Directions to here|Start from here|Add a camera here|Report a map problem here', items.join(', '));
    await page.waitForFunction(() => !/^\d/.test(document.querySelector('.spot-title')?.textContent ?? '1'), null, { timeout: 5_000 }).catch(() => {});
    const title = await page.locator('.spot-title').innerText();
    check('titled with what\'s there', /City Hall/.test(title), title);
    check('the end of the hold isn\'t taken for a tap', JSON.stringify(await trip(page)) === '{"from":null,"to":null}');
    const camera = await page.locator('.spot-menu a', { hasText: 'Add a camera here' });
    const note = await page.locator('.spot-menu a', { hasText: 'Report a map problem here' });
    const want = `19/${CITY_HALL[1].toFixed(4)}`;
    const cameraHref = await camera.getAttribute('href'), noteHref = await note.getAttribute('href');
    check('"Add a camera here" opens OpenStreetMap\'s editor at the spot, in a new tab',
      cameraHref.startsWith('https://www.openstreetmap.org/edit#map=19/') && cameraHref.includes(want.slice(0, 10))
      && (await camera.getAttribute('target')) === '_blank' && /noopener/.test(await camera.getAttribute('rel'))
      && /noreferrer/.test(await camera.getAttribute('rel')), cameraHref);
    check('"Report a map problem" opens a new note there', noteHref.startsWith('https://www.openstreetmap.org/note/new#map=19/')
      && noteHref.includes(want.slice(0, 10)), noteHref);
    check('with DeFlock\'s guide to adding cameras a tap away',
      (await page.locator('.spot-guide a').getAttribute('href')) === 'https://deflock.org/report/id');
    await page.locator('.spot-menu button', { hasText: 'Directions to here' }).tap();
    const t1 = await trip(page);
    check('"Directions to here" sets the destination at the spot', near(t1.to, CITY_HALL) && !(await menuOpen(page)), JSON.stringify(t1.to));

    await page.evaluate((c) => window.__fw.map.jumpTo({ center: c, zoom: 16 }), EAST);
    await settled(page);
    await touch(page, cdp, await at(page, EAST));
    await page.locator('.spot-menu button', { hasText: 'Start from here' }).tap();
    await page.locator('.option').first().waitFor({ timeout: 20_000 });
    check('"Start from here" sets the start, and the trip routes', near((await trip(page)).from, EAST));

    // ---------- a tap elsewhere, or Escape, closes it ----------
    const before = JSON.stringify(await trip(page));
    const spot = await centre(page, [-96.80, 32.78], 15);
    await touch(page, cdp, spot);
    check('(the menu is open again)', await menuOpen(page));
    await page.touchscreen.tap(spot.x + 90, spot.y + 70); // below the menu, which opens above its spot
    await page.waitForTimeout(300);
    check('a tap elsewhere closes the menu and changes nothing', !(await menuOpen(page)) && JSON.stringify(await trip(page)) === before);
    await touch(page, cdp, spot);
    await page.keyboard.press('Escape');
    check('Escape closes it too', !(await menuOpen(page)));

    // ---------- "Choose on the map" still takes a tap ----------
    await page.locator('#toInput').tap();
    await page.locator('#suggestions .suggest-map').tap();
    await page.locator('#banner').waitFor({ state: 'visible', timeout: 5_000 });
    check('"Choose on the map" says to tap', /Tap where you're going/.test(await page.locator('#banner').innerText()));
    const pick = [-96.792, 32.7745];
    const p = await centre(page, pick, 15);
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForTimeout(300);
    check('and the next tap sets that end', near((await trip(page)).to, pick) && await page.locator('#banner').isHidden(),
      JSON.stringify((await trip(page)).to));
    await page.touchscreen.tap(p.x - 80, p.y - 60);
    await page.waitForTimeout(300);
    check('only that one tap', near((await trip(page)).to, pick));
    await ctx.close();

    // ---------- a computer: right-click, or a held mouse button ----------
    const desk = await browser.newContext({ viewport: { width: 1280, height: 760 } });
    const dp = await desk.newPage();
    dp.on('pageerror', (e) => errors.push(e.message));
    await dp.goto(URL);
    await ready(dp);
    await dp.evaluate((c) => window.__fw.map.jumpTo({ center: c, zoom: 15 }), CITY_HALL);
    await settled(dp);
    const d = await at(dp, CITY_HALL);
    await dp.mouse.click(d.x, d.y, { button: 'right' });
    check('a right-click opens the same menu', await menuOpen(dp));
    await dp.keyboard.press('Escape');
    await dp.mouse.move(d.x, d.y);
    await dp.mouse.down();
    await dp.waitForTimeout(700);
    await dp.mouse.up();
    check('so does holding the mouse button', await menuOpen(dp)
      && JSON.stringify(await trip(dp)) === '{"from":null,"to":null}');
    await desk.close();
  } finally {
    await browser.close();
  }
  console.log(`\nconsole/page errors: ${errors.length ? `\n  ${errors.join('\n  ')}` : 'none'}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
