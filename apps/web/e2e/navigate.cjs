// End-to-end check of live navigation: GPS fixes are fed along the example trip's fastest route
// (which passes camera zones), then off it, then to the end. It needs the dev server on :5173
// with the Dallas release staged, and Playwright with Chromium. With the playwright skill:
//   node ~/.claude/skills/playwright-skill/run.js apps/web/e2e/navigate.cjs
const { chromium, devices } = require('playwright');

const URL = 'http://localhost:5173/';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const ready = async (page) => {
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__fw?.map.loaded(), null, { timeout: 90_000 });
};

/** Points every `stepM` metres along a polyline of [lon, lat]. */
function resample(coords, stepM) {
  const out = [coords[0]];
  const kx = 111320 * Math.cos((coords[0][1] * Math.PI) / 180), ky = 110540;
  let carry = 0;
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = coords[i - 1], [x1, y1] = coords[i];
    const seg = Math.hypot((x1 - x0) * kx, (y1 - y0) * ky);
    let d = stepM - carry;
    while (d <= seg) {
      out.push([x0 + ((x1 - x0) * d) / seg, y0 + ((y1 - y0) * d) / seg]);
      d += stepM;
    }
    carry = seg - (d - stepM);
  }
  out.push(coords[coords.length - 1]);
  return out;
}

(async () => {
  const errors = [];
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const ctx = await browser.newContext({
      ...devices['Pixel 7'], geolocation: { latitude: 32.7767, longitude: -96.797, accuracy: 10 }, permissions: ['geolocation'],
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/failed to fetch|aborted/i.test(m.text()) && errors.push(m.text()));
    await page.goto(URL);
    await ready(page);
    await page.locator('#example').tap();
    await page.locator('.option').first().waitFor();
    await page.locator('.option').first().tap(); // the fastest: the one with camera zones
    const route = await page.evaluate(() => {
      const r = window.__fw.state.routes[0];
      return { coords: r.coordinates, sites: r.sites.length };
    });
    check('the fastest example route passes camera zones', route.sites > 0, `${route.sites} zones`);

    const points = resample(route.coords, 25);
    const fix = async ([lon, lat], waitMs = 40) => {
      await ctx.setGeolocation({ longitude: lon, latitude: lat, accuracy: 10 });
      await page.waitForTimeout(waitMs);
    };
    await fix(points[0]);
    const hashBefore = await page.evaluate(() => location.hash);
    check('Start sits next to the summary, in reach at any sheet height', await page.locator('#headNav').isVisible());
    await page.locator('#headNav').tap();
    check('Start turns into Stop', (await page.locator('#headNav').innerText()) === 'Stop'
      && (await page.locator('#navigate').innerText()) === 'Stop');
    check('the sheet drops out of the way', (await page.evaluate(() => document.documentElement.dataset.sheet)) === 'peek');

    const seen = new Set();
    const watch = async () => {
      const t = await page.locator('#banner strong').innerText().catch(() => '');
      if (/Camera ahead/.test(t)) seen.add('ahead');
      if (/In a camera zone/.test(t)) seen.add('zone');
    };
    // The first stretch, with fixes every 25 m.
    const half = Math.floor(points.length / 2);
    for (const p of points.slice(0, half)) {
      await fix(p);
      await watch();
    }
    check('a camera ahead is announced before reaching it', seen.has('ahead'));
    check('the banner says when the car is in a zone', seen.has('zone'));
    const summary = await page.locator('#summary').innerText();
    check('the summary counts down time, distance and zones', /min · .* · \d+ camera zones? ahead/.test(summary), summary);
    check('following GPS fixes never touches the URL', (await page.evaluate(() => location.hash)) === hashBefore);

    // Off the route: 400 m north of where the car is, for a few fixes.
    const [lon, lat] = points[half];
    const before = await page.evaluate(() => window.__fw.state.routeId);
    for (let i = 0; i < 4; i++) await fix([lon, lat + 0.0036 + i * 0.0001], 120);
    await page.waitForFunction((id) => window.__fw.state.routeId > id && window.__fw.state.routes, before, { timeout: 20_000 });
    const after = await page.evaluate(() => ({ fromGps: Boolean(window.__fw.state.fromGps), nav: Boolean(window.__fw.state.nav) }));
    check('leaving the route plans a new one from where the car is', after.fromGps && after.nav, JSON.stringify(after));
    check('a GPS start still stays out of the URL', !/from=/.test(await page.evaluate(() => location.hash)));

    // Follow the new route to its end.
    const fresh = await page.evaluate(() => window.__fw.state.routes[window.__fw.state.selected].coordinates);
    for (const p of resample(fresh, 60)) await fix(p, 25);
    await page.waitForFunction(() => !window.__fw.state.nav, null, { timeout: 10_000 });
    check('reaching the destination ends navigation', /Arrived/.test(await page.locator('#banner').innerText()),
      await page.locator('#banner').innerText());
    check('and Stop turns back into Start', (await page.locator('#headNav').innerText()) === 'Start');

    // Stop by hand, from the sheet's head while it's collapsed. Back at the start first, and long
    // enough for the browser's cached fix (the app accepts one up to a second old) to expire:
    // Start at the destination arrives at once, which is right.
    await fix(fresh[0], 1200);
    await page.locator('#headNav').tap();
    await fix(fresh[1], 300);
    check('navigation can start again', (await page.locator('#headNav').innerText()) === 'Stop');
    check('the sheet is collapsed while driving', (await page.evaluate(() => document.documentElement.dataset.sheet)) === 'peek');
    await page.locator('#headNav').tap();
    check('Stop ends it', (await page.evaluate(() => window.__fw.state.nav)) === null);
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(`\nconsole/page errors: ${errors.length ? `\n  ${errors.join('\n  ')}` : 'none'}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
