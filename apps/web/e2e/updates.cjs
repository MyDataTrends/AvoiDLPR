// End-to-end check of how the app takes data updates: a damaged new road pack gives way to the last
// good one; a new pack found when the app comes back on screen is swapped in between trips, never
// mid-drive; new cameras apply at once. It needs the dev server on :5173 with the Dallas release
// staged, and Playwright with Chromium. With the playwright skill:
//   node ~/.claude/skills/playwright-skill/run.js apps/web/e2e/updates.cjs
const { chromium, devices } = require('playwright');

const URL = 'http://localhost:5173/';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const ready = async (page) => {
  await page.getByText('network loaded').waitFor({ timeout: 90_000 });
  await page.waitForFunction(() => window.__fw?.map.loaded() && window.__fw.state.stats, null, { timeout: 90_000 });
};
const goodPack = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('avoidlpr.pack.dallas') ?? 'null')?.path ?? null);

(async () => {
  const errors = [];
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const real = await (await fetch(`${URL}regions.json`)).json();
    const dallas = real.regions.find((r) => r.id === 'dallas');
    const bytes = Buffer.from(await (await fetch(URL + dallas.pack.path)).arrayBuffer());
    const feed = await (await fetch(URL + dallas.cameras.path)).json();
    const NEW = 'packs/dallas.0123456789.fwr.gz', BAD = 'packs/dallas.badbadbad0.fwr.gz';
    const withPack = (path) => ({ ...real, regions: real.regions.map((r) => (r.id === 'dallas' ? { ...r, pack: { ...r.pack, path } } : r)) });

    let served = real, extraCamera = false;
    const ctx = await browser.newContext({
      ...devices['Pixel 7'], geolocation: { latitude: 32.7767, longitude: -96.797, accuracy: 10 }, permissions: ['geolocation'],
    });
    await ctx.route('**/regions.json', (r) => r.fulfill({ json: served }));
    await ctx.route(`**/${NEW}`, (r) => r.fulfill({ body: bytes, contentType: 'application/gzip' }));
    await ctx.route(`**/${BAD}`, (r) => r.fulfill({ body: Buffer.from('a truncated download'), contentType: 'application/gzip' }));
    await ctx.route('**/cameras/dallas.json', (r) => {
      const cams = extraCamera ? [...feed.cameras, { ...feed.cameras[0], id: 999999999999, lat: feed.cameras[0].lat + 0.01 }] : feed.cameras;
      r.fulfill({ json: { ...feed, cameras: cams, built_at: extraCamera ? '2026-10-06T15:17:00+00:00' : feed.built_at } });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/failed to fetch|aborted/i.test(m.text()) && errors.push(m.text()));

    // ---------- first load: the pack becomes the one to fall back on ----------
    await page.goto(URL);
    await ready(page);
    check('a pack that loads becomes the one to fall back on', (await goodPack(page)) === dallas.pack.path, await goodPack(page));
    check('the footer says how fresh the data is', /^Map data: (roads as of .+, )?cameras as of /.test(await page.locator('#freshness').innerText()),
      await page.locator('#freshness').innerText());

    // ---------- a damaged new pack ----------
    served = withPack(BAD);
    await page.reload();
    await ready(page);
    check('a damaged new pack gives way to the last good one', /didn't load, so this is the previous one/.test(await page.locator('#notice').innerText()),
      await page.locator('#notice').innerText());
    check('and the last good one stays the fallback', (await goodPack(page)) === dallas.pack.path);
    await page.getByRole('button', { name: 'Try an example trip' }).tap();
    await page.locator('.option').first().waitFor({ timeout: 30_000 });
    check('routing works on the fallback', (await page.locator('.option').count()) >= 2);

    // ---------- an update, found when the app comes back ----------
    served = real;
    await page.reload();
    await ready(page);
    served = withPack(NEW);
    await page.evaluate(() => window.__fw.checkForUpdates(true));
    await page.waitForFunction((p) => JSON.parse(localStorage.getItem('avoidlpr.pack.dallas') ?? 'null')?.path === p, NEW, { timeout: 30_000 });
    check('a new pack is swapped in when no trip is running', true);
    await ready(page);
    check('and the app is ready on it', (await page.locator('#status').innerText()).includes('network loaded'));

    // ---------- an update found mid-drive waits for the drive to end ----------
    await page.getByRole('button', { name: 'Try an example trip' }).tap();
    await page.locator('.option').first().waitFor({ timeout: 30_000 });
    await page.locator('#headNav').tap();
    check('navigation started', (await page.locator('#headNav').innerText()) === 'Stop');
    served = real;
    await page.evaluate(() => window.__fw.checkForUpdates(true));
    await page.waitForTimeout(1500);
    check('mid-drive, the pack is left alone', (await goodPack(page)) === NEW && (await page.evaluate(() => window.__fw.state.stats !== null)));
    await page.locator('#headNav').tap(); // stop
    await page.waitForFunction((p) => JSON.parse(localStorage.getItem('avoidlpr.pack.dallas') ?? 'null')?.path === p, dallas.pack.path, { timeout: 30_000 });
    check('once the drive ends, the update goes in', true);
    await ready(page);

    // ---------- new cameras apply at once ----------
    const before = await page.evaluate(() => window.__fw.state.cameras.length);
    extraCamera = true;
    await page.evaluate(() => window.__fw.checkForUpdates(true));
    await page.waitForFunction((n) => window.__fw.state.cameras.length === n + 1, before, { timeout: 20_000 });
    check('new cameras arrive with the check', true, `${before} -> ${before + 1}`);
    check('and the footer shows the feed\'s new time', /Oct 6/.test(await page.locator('#freshness').innerText()),
      await page.locator('#freshness').innerText());
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(`\nconsole/page errors: ${errors.length ? `\n  ${errors.join('\n  ')}` : 'none'}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
