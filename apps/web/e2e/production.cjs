// Checks the production build as deployed: map data on a different origin than the app (as with
// a storage bucket), the security headers, the service worker and offline use, and the install
// manifest. It needs, running:
//   * the data host:    node --experimental-strip-types scripts/serve-release.ts            (:8788)
//   * the built app:    VITE_DATA_BASE=http://localhost:8788 vite build --outDir dist-xorigin
//                       vite preview --outDir dist-xorigin                                 (:4173)
// Run with the playwright skill:
//   node ~/.claude/skills/playwright-skill/run.js apps/web/e2e/production.cjs
const os = require('node:os');
const path = require('node:path');
const { chromium, devices } = require('playwright');

const APP = process.env.APP_URL || 'http://localhost:4173/';
const DATA = process.env.DATA_URL || 'http://localhost:8788/';
const OUT = process.env.PW_ARTIFACT_DIR || os.tmpdir();

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [], offHost = [];
  let offline = false;
  try {
    const ctx = await browser.newContext({
      ...devices['Pixel 7'], serviceWorkers: 'allow',
      geolocation: { latitude: 32.7767, longitude: -96.797, accuracy: 25 }, permissions: ['geolocation'],
    });
    const page = await ctx.newPage();
    page.on('console', async (m) => {
      if (m.type() !== 'error') return;
      const detail = await Promise.all(m.args().map((a) => a.evaluate((v) => (v instanceof Error ? `${v.name}: ${v.message}` : String(v))).catch(() => '?')));
      // The CSP check below deliberately tries to reach example.com; the browser's refusal is the point.
      if (/example\.com/.test(`${m.text()} ${detail.join(' ')}`)) return;
      // Offline, the map can't fetch tiles: that is expected and the one thing offline doesn't cover.
      if (offline && /failed to fetch|network|load failed|err_internet/i.test(`${m.text()} ${detail.join(' ')}`)) return;
      errors.push(`${m.text()} [${detail.join(' | ')}]`);
    });
    page.on('pageerror', (e) => errors.push(e.message));
    const dataRequests = [];
    page.on('request', (r) => {
      const u = r.url();
      if (u.startsWith(DATA)) dataRequests.push(u); // includes the worker's, which the page can't see itself
      if (!u.startsWith(APP.replace(/\/$/, '')) && !u.startsWith(DATA.replace(/\/$/, '')) && !/^(data|blob):/.test(u)) offHost.push(u);
    });

    // ---------- first load ----------
    const response = await page.goto(APP);
    const h = response.headers();
    await page.getByText('network loaded').waitFor({ timeout: 90_000 });
    check('headers: a Content-Security-Policy confines the app to itself and the data host',
      /default-src 'self'/.test(h['content-security-policy'] ?? '') && (h['content-security-policy'] ?? '').includes(`connect-src 'self' ${DATA.replace(/\/$/, '')}`), h['content-security-policy']);
    check('headers: nosniff, no referrer, and geolocation limited to this page',
      h['x-content-type-options'] === 'nosniff' && h['referrer-policy'] === 'no-referrer' && /geolocation=\(self\)/.test(h['permissions-policy'] ?? ''));
    check('data loads from the separate data host (CORS and ranges work)',
      dataRequests.some((u) => u.startsWith(`${DATA}packs/`)) && dataRequests.some((u) => u.includes('/basemap/') && u.endsWith('.pmtiles')) && dataRequests.some((u) => u.startsWith(`${DATA}cameras/`)),
      `${dataRequests.length} requests`);
    check('the app talks to nothing but itself and the data host', offHost.length === 0, offHost.join(' '));
    check('the app can\'t reach any other origin: the CSP blocks it',
      await page.evaluate(() => fetch('https://example.com/', { mode: 'no-cors' }).then(() => false, () => true)));

    await page.locator('#mapLocate').tap();
    await page.locator('#fromText', { hasText: 'Your location' }).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Try an example trip' }).tap();
    await page.locator('.option').first().waitFor({ timeout: 30_000 });
    check('routing works in the production build', (await page.locator('.option').count()) >= 2);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(OUT, '10-production.png') });

    // ---------- install manifest ----------
    const manifestHref = await page.locator('link[rel=manifest]').getAttribute('href');
    const manifest = await (await ctx.request.get(new URL(manifestHref, APP).href)).json();
    check('manifest: standalone app with name, start URL and colours',
      manifest.display === 'standalone' && manifest.name === 'AvoiDLPR' && manifest.start_url === '/' && Boolean(manifest.theme_color) && Boolean(manifest.background_color));
    const sizes = [];
    for (const icon of manifest.icons) {
      const r = await ctx.request.get(new URL(icon.src, APP).href);
      sizes.push(`${icon.sizes}/${icon.purpose}:${r.status()}`);
    }
    check('manifest: 192, 512 and maskable icons all load', manifest.icons.length >= 3 && sizes.every((s) => s.endsWith(':200')), sizes.join(' '));
    const apple = await ctx.request.get(new URL(await page.locator('link[rel=apple-touch-icon]').getAttribute('href'), APP).href);
    check('iOS: an apple-touch-icon is declared and loads', apple.status() === 200);

    // ---------- service worker ----------
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.getByText('network loaded').waitFor({ timeout: 90_000 });
    const sw = await page.evaluate(async () => ({
      controlled: Boolean(navigator.serviceWorker.controller),
      caches: await Promise.all((await caches.keys()).map(async (k) => [k, (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname)])),
    }));
    check('service worker: installed and controlling the page', sw.controlled);
    const shell = sw.caches.find(([k]) => k.startsWith('fw-shell-'));
    check('service worker: the app shell (page, scripts, icons) is precached',
      Boolean(shell) && shell[1].length >= 8 && shell[1].includes('/') && shell[1].some((p) => /^\/assets\/index-.*\.js$/.test(p)), shell ? `${shell[1].length} files` : 'none');
    const data = sw.caches.find(([k]) => k === 'fw-data-v1');
    check('service worker: the road pack, camera feed and manifest are cached for offline use',
      Boolean(data) && data[1].some((p) => /\/packs\/dallas\.[0-9a-f]{10}\.fwr$/.test(p)) && data[1].some((p) => p.endsWith('/cameras/dallas.json')) && data[1].some((p) => p.endsWith('/regions.json')),
      data ? data[1].join(', ') : 'none');

    // ---------- offline ----------
    offline = true;
    await ctx.setOffline(true);
    await page.reload();
    await page.getByText('network loaded').waitFor({ timeout: 60_000 });
    check('offline: the app opens with no network at all', true);
    await page.getByRole('button', { name: 'Try an example trip' }).tap();
    await page.locator('.option').first().waitFor({ timeout: 30_000 });
    const offlineOptions = await page.locator('.option').count();
    check('offline: routing still works (roads and cameras come from the cache)', offlineOptions >= 2, `${offlineOptions} options`);
    await ctx.setOffline(false);
    offline = false;
  } finally {
    await browser.close();
  }
  console.log('console/page errors:', errors.length ? `\n  ${errors.join('\n  ')}` : 'none');
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed || errors.length ? 1 : 0;
})();
