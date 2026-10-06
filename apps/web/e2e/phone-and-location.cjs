// End-to-end check of the FlockWatch web demo: phone layout, route options, current location,
// drive preview and the desktop sidebar. It needs the dev server on :5173 (the page exposes
// window.__fw in dev builds only) and Playwright with Chromium. With the playwright skill:
//   node ~/.claude/skills/playwright-skill/run.js apps/web/e2e/phone-and-location.cjs
// Screenshots land in PW_ARTIFACT_DIR (default: the OS temp directory).
const os = require('node:os');
const path = require('node:path');
const { chromium, devices } = require('playwright');

const URL = 'http://localhost:5173/';
const OUT = process.env.PW_ARTIFACT_DIR || os.tmpdir();
const DALLAS_DOWNTOWN = { latitude: 32.7767, longitude: -96.797, accuracy: 25 };
const NEW_YORK = { latitude: 40.7128, longitude: -74.006, accuracy: 20 };

const results = [];
let lastCheck = '(start)';
function check(name, ok, detail = '') {
  lastCheck = name;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function watch(page, label, sink) {
  page.on('console', async (m) => {
    if (m.type() !== 'error') return;
    const when = Date.now();
    const where = m.location();
    // An Error object logs as just "Error"; pull its name, message and stack out of the page.
    const detail = await Promise.all(m.args().map((a) => a.evaluate((v) => (v instanceof Error ? `${v.name}: ${v.message} ${String(v.stack).split('\n')[1] ?? ''}` : String(v))).catch(() => '?')));
    // Navigating away cancels in-flight map requests, and MapLibre logs those as failed fetches.
    if (when < sink.quietUntil && /failed to fetch|aborted/i.test(`${m.text()} ${detail.join(' ')}`)) return;
    sink.errors.push(`${label}: ${m.text()} [${detail.join(' | ')}] @ ${where.url}:${where.lineNumber} (after check: ${lastCheck})`);
  });
  page.on('pageerror', (e) => sink.errors.push(`${label}: ${e.message}`));
  // Aborted requests are normal (the map cancels tiles it no longer needs); anything else is news.
  page.on('requestfailed', (r) => {
    const reason = r.failure()?.errorText ?? '';
    if (!/ERR_ABORTED/.test(reason)) sink.errors.push(`${label}: request failed ${r.method()} ${r.url().slice(0, 120)} ${reason} range=${r.headers().range ?? '-'} (after check: ${lastCheck})`);
  });
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('http://localhost:5173') && !u.startsWith('data:') && !u.startsWith('blob:')) sink.external.push(u);
  });
}

/** Navigate, ignoring the cancelled-request noise from the page being torn down. */
async function open(page, sink, url) {
  sink.quietUntil = Date.now() + 3000;
  await page.goto(url);
}

async function ready(page) {
  await page.getByText('network loaded').waitFor({ timeout: 90_000 });
  await page.waitForFunction(() => window.__fw?.map.loaded(), null, { timeout: 90_000 });
}

const settled = (page) => page.waitForFunction(() => !window.__fw.map.isMoving(), null, { timeout: 15_000 });

// How many route vertices fall outside the part of the map the bottom sheet leaves visible?
const hidden = (page) => page.evaluate(() => {
  const { map, state } = window.__fw;
  const { width } = map.getContainer().getBoundingClientRect();
  const sheetTop = document.getElementById('panel').getBoundingClientRect().top;
  const mobile = getComputedStyle(document.getElementById('sheetHead')).display !== 'none';
  const bottom = mobile ? sheetTop : map.getContainer().getBoundingClientRect().height;
  let outside = 0, total = 0;
  for (const r of state.routes) {
    for (const c of r.coordinates) {
      const p = map.project(c);
      total++;
      if (p.x < -2 || p.x > width + 2 || p.y < 54 || p.y > bottom + 2) outside++;
    }
  }
  return { outside, total };
});
const sheetState = (page) => page.evaluate(() => document.documentElement.dataset.sheet);
const summary = (page) => page.locator('#summary').innerText();

async function drag(page, selector, dy) {
  const box = await page.locator(selector).boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy / 2, { steps: 6 });
  await page.mouse.move(x, y + dy, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(450); // the sheet's snap animation
}

(async () => {
  const sink = { errors: [], external: [], quietUntil: 0 };
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    // ---------- phone, with a GPS fix in downtown Dallas ----------
    const phone = await browser.newContext({
      ...devices['Pixel 7'], geolocation: DALLAS_DOWNTOWN, permissions: ['geolocation'],
    });
    const page = await phone.newPage();
    watch(page, 'phone', sink);
    await page.goto(URL);
    await ready(page);
    await page.screenshot({ path: path.join(OUT, '01-phone-start.png') });
    check('phone: panel is a half-open bottom sheet', (await sheetState(page)) === 'half');
    const geometry = await page.evaluate(() => {
      const p = document.getElementById('panel').getBoundingClientRect();
      return { top: p.top, bottom: p.bottom, h: innerHeight, scrollW: document.documentElement.scrollWidth, w: innerWidth };
    });
    check('phone: sheet is anchored to the bottom', Math.abs(geometry.bottom - geometry.h) < 1 && geometry.top > geometry.h * 0.4);
    check('phone: no horizontal scroll', geometry.scrollW <= geometry.w);

    // The handle is a visual cue: the whole head (handle + summary) is the drag target.
    const tapTargets = await page.evaluate(() => [...document.querySelectorAll('button, select, summary')]
      .filter((el) => el.offsetParent !== null && el.id !== 'handle' && !el.className.toString().includes('maplibregl'))
      .map((el) => ({ id: el.id || el.textContent.trim().slice(0, 24), h: el.getBoundingClientRect().height, w: el.getBoundingClientRect().width }))
      .filter((t) => t.h < 40 && t.w > 0));
    check('phone: visible controls are at least 40 px tall', tapTargets.length === 0, JSON.stringify(tapTargets));
    const headH = await page.evaluate(() => document.getElementById('sheetHead').getBoundingClientRect().height);
    check('phone: the drag area (handle + summary) is at least 48 px tall', headH >= 48, `${headH} px`);
    const attrib = await page.evaluate(() => {
      const a = document.querySelector('.maplibregl-ctrl-attrib').getBoundingClientRect();
      const b = document.querySelector('.maplibregl-ctrl-attrib-button').getBoundingClientRect();
      return { bottom: a.bottom, sheetTop: document.getElementById('panel').getBoundingClientRect().top, button: b.width };
    });
    check('phone: map attribution sits above the sheet, not under it', attrib.bottom <= attrib.sheetTop + 1, JSON.stringify(attrib));
    check('phone: the attribution button is at least 32 px wide', attrib.button >= 32, `${attrib.button} px`);

    await page.getByRole('button', { name: 'Try an example trip' }).tap();
    await page.locator('.option').first().waitFor();
    await settled(page);
    // Known road points (the example route passes through downtown) for the GPS test below.
    const roadPoints = await page.evaluate(() => window.__fw.state.routes[0].coordinates.filter((_, i) => i % 5 === 0));
    const options = page.locator('.option');
    const n = await options.count();
    check('phone: route options appear', n >= 2 && n <= 4, `${n} options`);
    const framedExample = await hidden(page);
    check('phone: the map frames every route above the sheet', framedExample.outside === 0, JSON.stringify(framedExample));
    check('phone: exactly one option is selected', (await page.locator('.option[aria-pressed="true"]').count()) === 1);
    check('phone: one option is marked Recommended', (await page.locator('.option .chip').count()) === 1);
    await page.screenshot({ path: path.join(OUT, '02-phone-routes.png') });

    const before = await summary(page);
    await options.last().tap();
    const after = await summary(page);
    check('phone: tapping an option selects it', (await options.last().getAttribute('aria-pressed')) === 'true' && before !== after, `"${before}" -> "${after}"`);
    check('phone: fewest-cameras option has the fewest zones', /Fewest cameras/.test(after), after);

    await drag(page, '#handle', -330);
    check('phone: dragging the handle up opens the sheet fully', (await sheetState(page)) === 'full');
    await page.screenshot({ path: path.join(OUT, '03-phone-full.png') });
    await drag(page, '#handle', 700);
    check('phone: dragging down collapses it to the peek', (await sheetState(page)) === 'peek');
    check('phone: the peek still shows the route summary', /min/.test(await summary(page)), await summary(page));
    await page.screenshot({ path: path.join(OUT, '04-phone-peek.png') });
    await page.locator('#handle').focus();
    await page.keyboard.press('ArrowUp');
    check('phone: ArrowUp on the handle steps the sheet up', (await sheetState(page)) === 'half');
    await page.locator('#handle').tap();
    check('phone: tapping the handle collapses an open sheet', (await sheetState(page)) === 'peek');

    // Pick a different route by tapping its line on the map.
    await settled(page);
    const tapPoint = await page.evaluate(() => {
      const { map, state } = window.__fw;
      const other = state.selected === 0 ? state.routes.length - 1 : 0;
      // A point on `other` as far as possible from every other route, so the tap is unambiguous.
      const rest = state.routes.flatMap((r, i) => (i === other ? [] : r.coordinates.map((c) => map.project(c))));
      const cams = state.cameras.map((c) => map.project([c.lon, c.lat]));
      const { width, height } = map.getContainer().getBoundingClientRect();
      let best = null;
      for (const c of state.routes[other].coordinates) {
        const p = map.project(c);
        if (p.x < 30 || p.x > width - 30 || p.y < 100 || p.y > height - 140) continue;
        // Clear of the other routes and of any camera (a tap on a camera opens its popup instead).
        const dRoutes = Math.min(...rest.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
        const dCams = Math.min(...cams.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
        const d = Math.min(dRoutes, dCams * 1.5);
        if (!best || d > best.d) best = { x: p.x, y: p.y, d, other };
      }
      return best;
    });
    if (tapPoint && tapPoint.d > 20) {
      const was = await page.evaluate(() => window.__fw.state.selected);
      await page.touchscreen.tap(tapPoint.x, tapPoint.y);
      await page.waitForTimeout(300);
      const now = await page.evaluate(() => window.__fw.state.selected);
      check('phone: tapping another route on the map selects it', now === tapPoint.other && now !== was, `${was} -> ${now}`);
    } else {
      check('phone: tapping another route on the map selects it', false, `no clear point (${JSON.stringify(tapPoint)})`);
    }

    // ---------- drive preview on the phone ----------
    await page.locator('#handle').focus();
    await page.keyboard.press('ArrowUp'); // peek -> half
    const chosenSites = await page.evaluate(() => window.__fw.state.routes[window.__fw.state.selected].sites.length);
    await page.locator('#speed').selectOption('32');
    await page.locator('#drive').scrollIntoViewIfNeeded();
    await page.locator('#drive').tap();
    await page.waitForTimeout(500);
    check('drive: the sheet drops to its peek while driving', (await sheetState(page)) === 'peek');
    check('drive: the button turns into Stop', (await page.locator('#drive').innerText()) === 'Stop');
    if (chosenSites > 0) {
      await page.locator('#banner').filter({ hasText: 'In a camera zone' }).waitFor({ timeout: 70_000 });
      check('drive: entering a zone raises the alert banner', true, await page.locator('#banner').innerText());
    }
    await page.screenshot({ path: path.join(OUT, '07-phone-drive.png') });
    await page.locator('#handle').tap(); // open the sheet to reach Stop
    await page.locator('#drive').scrollIntoViewIfNeeded();
    await page.locator('#drive').tap();
    await page.waitForTimeout(400);
    check('drive: stopping restores the sheet and clears the banner',
      (await page.locator('#drive').innerText()) === 'Preview drive' && (await page.locator('#banner').isHidden()));

    // ---------- current location ----------
    await open(page, sink, URL);
    await ready(page);
    await page.locator('#mapLocate').tap();
    // Wait on the start field itself: the "Finding your location…" notice also contains the words.
    await page.locator('#fromText', { hasText: 'Your location' }).waitFor({ timeout: 15_000 });
    check('gps: start becomes "Your location" with its accuracy', /Your location · ±(25 m|80 ft)/.test(await page.locator('#fromText').innerText()));
    check('gps: a location dot is drawn', (await page.locator('.gps-dot').count()) === 1);
    check('gps: the location is not written to the URL', !/from/.test(await page.evaluate(() => location.hash)), await page.evaluate(() => location.hash));
    check('gps: next tap targets the destination', (await page.locator('#targetTo').getAttribute('aria-pressed')) === 'true');
    await settled(page);
    // Tap a known road 0.3-1.5 km from the fix, inside the visible map (above the sheet).
    const dest = await page.evaluate((pts) => {
      const { map, state } = window.__fw;
      const [lon0, lat0] = state.from;
      const metres = ([lon, lat]) => Math.hypot((lon - lon0) * 93_700, (lat - lat0) * 111_200);
      const { width } = map.getContainer().getBoundingClientRect();
      const visibleBottom = document.getElementById('panel').getBoundingClientRect().top - 40;
      for (const c of pts) {
        const d = metres(c), p = map.project(c);
        if (d > 300 && d < 1500 && p.x > 30 && p.x < width - 30 && p.y > 100 && p.y < visibleBottom) return { x: p.x, y: p.y, d };
      }
      return null;
    }, roadPoints);
    check('gps: found a road point to use as the destination', Boolean(dest), JSON.stringify(dest));
    await page.touchscreen.tap(dest.x, dest.y);
    await page.locator('.option').first().waitFor({ timeout: 20_000 }).catch(async () => {
      console.log('      notice:', await page.locator('#notice').innerText().catch(() => '(none)'));
    });
    await settled(page);
    const trip = await page.evaluate(() => ({ from: window.__fw.state.from, to: window.__fw.state.to, gps: window.__fw.state.fromGps, routes: window.__fw.state.routes?.length ?? 0 }));
    check('gps: a destination tap routes from the current location', trip.gps && trip.to && trip.routes >= 1, JSON.stringify({ gps: trip.gps, routes: trip.routes }));
    await page.waitForTimeout(900); // let the route line paint and the framing settle
    const framedGps = await hidden(page);
    check('gps: the map frames the whole route above the sheet', framedGps.outside === 0, JSON.stringify(framedGps));
    await page.screenshot({ path: path.join(OUT, '05-phone-gps-route.png') });
    await page.locator('#swap').tap();
    await page.locator('.option').first().waitFor({ timeout: 20_000 });
    check('gps: swapping makes the old destination the start (a plain pin)', (await page.locator('.gps-dot').count()) === 0);

    // ---------- location failures ----------
    const denied = await browser.newContext({ ...devices['Pixel 7'] });
    const dPage = await denied.newPage();
    watch(dPage, 'denied', sink);
    await dPage.goto(URL);
    await ready(dPage);
    await dPage.locator('#locate').tap();
    await dPage.locator('#notice').waitFor({ timeout: 15_000 });
    check('gps: a blocked permission explains how to continue', /blocked|Allow/.test(await dPage.locator('#notice').innerText()), await dPage.locator('#notice').innerText());
    check('gps: a blocked permission leaves the start unset', (await dPage.evaluate(() => window.__fw.state.from)) === null);
    await denied.close();

    const away = await browser.newContext({ ...devices['Pixel 7'], geolocation: NEW_YORK, permissions: ['geolocation'] });
    const aPage = await away.newPage();
    watch(aPage, 'away', sink);
    await aPage.goto(URL);
    await ready(aPage);
    await aPage.locator('#locate').tap();
    await aPage.locator('#notice').waitFor({ timeout: 15_000 });
    check('gps: a fix outside the loaded area says so', /outside/.test(await aPage.locator('#notice').innerText()), await aPage.locator('#notice').innerText());
    check('gps: and does not set the start', (await aPage.evaluate(() => window.__fw.state.from)) === null);
    await away.close();
    await phone.close();

    // ---------- desktop ----------
    const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const dk = await desk.newPage();
    watch(dk, 'desktop', sink);
    await dk.goto(URL);
    await ready(dk);
    await dk.getByRole('button', { name: 'Try an example trip' }).click();
    await dk.locator('.option').first().waitFor();
    await settled(dk);
    const sidebar = await dk.evaluate(() => {
      const p = document.getElementById('panel').getBoundingClientRect();
      return { w: p.width, left: p.left, handle: getComputedStyle(document.getElementById('sheetHead')).display };
    });
    check('desktop: the panel is a left sidebar with no sheet handle', sidebar.left === 0 && sidebar.w === 360 && sidebar.handle === 'none', JSON.stringify(sidebar));
    const dn = await dk.locator('.option').count();
    check('desktop: route options appear', dn >= 2, `${dn} options`);
    const framedDesk = await hidden(dk);
    check('desktop: the map frames every route', framedDesk.outside === 0, JSON.stringify(framedDesk));
    await dk.locator('.option').first().click();
    check('desktop: clicking an option selects it', (await dk.locator('.option').first().getAttribute('aria-pressed')) === 'true');
    await dk.screenshot({ path: path.join(OUT, '06-desktop.png') });
    await desk.close();
  } finally {
    await browser.close();
  }

  console.log('\nconsole/page errors:', sink.errors.length ? `\n  ${sink.errors.join('\n  ')}` : 'none');
  console.log('requests outside localhost:', sink.external.length ? `\n  ${[...new Set(sink.external)].join('\n  ')}` : 'none');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length || sink.errors.length || sink.external.length ? 1 : 0;
})();
