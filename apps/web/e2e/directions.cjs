// End-to-end check of turn-by-turn directions: the selected route's steps in the panel, the next
// turn in a card over the map while previewing and driving, and spoken prompts while driving, in
// an on-device voice only. It drives the area's example trip, so it runs against any staged
// release (Dallas, say): it needs the dev server on :5173 and Playwright with Chromium. With the
// playwright skill:
//   node ~/.claude/skills/playwright-skill/run.js apps/web/e2e/directions.cjs
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

/**
 * Stand in for the browser's speech: voices of our choosing, and what's said kept in
 * window.__spoken. `local` false offers only a voice that would send the text to a server.
 */
function fakeSpeech(local) {
  const voices = [{ name: 'Server voice', lang: 'en-US', localService: false, default: true, voiceURI: 'server' }];
  if (local) voices.push({ name: 'Device voice', lang: 'en-US', localService: true, default: false, voiceURI: 'device' });
  window.__spoken = [];
  window.__voicesUsed = new Set();
  const listeners = [];
  window.SpeechSynthesisUtterance = function (text) {
    this.text = text;
  };
  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      getVoices: () => voices,
      speak: (u) => {
        window.__spoken.push(u.text);
        window.__voicesUsed.add(u.voice?.name);
      },
      cancel: () => {},
      addEventListener: (type, fn) => listeners.push(fn),
    },
  });
}

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

async function openTrip(browser, local, viewport = devices['Pixel 7']) {
  const ctx = await browser.newContext({ ...viewport, permissions: ['geolocation'], geolocation: { latitude: 0, longitude: 0 } });
  await ctx.addInitScript(fakeSpeech, local);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/failed to fetch|aborted/i.test(m.text()) && errors.push(m.text()));
  await page.goto(URL);
  await ready(page);
  await page.locator('#example').click();
  await page.locator('.option').first().waitFor();
  await page.locator('.option').first().click();
  const route = await page.evaluate(() => window.__fw.state.routes[window.__fw.state.selected]);
  return { ctx, page, route };
}

const errors = [];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    // ---------- the steps, in the panel ----------
    const { ctx, page, route } = await openTrip(browser, true);
    const steps = route.steps;
    const turns = steps.filter((s) => s.type !== 'depart' && s.type !== 'arrive');
    check('the route comes with its steps, from depart to arrive',
      steps[0].type === 'depart' && steps.at(-1).type === 'arrive' && turns.length > 0, `${steps.length} steps`);
    check('steps run in order along the route, ending at its end',
      steps.every((s, k) => !k || s.atM >= steps[k - 1].atM) && Math.abs(steps.at(-1).atM - route.distanceM) < 1);
    await page.evaluate(() => window.__fw.sheet.set('full')); // the sheet up, so the list is in view
    await page.waitForTimeout(300);
    await page.locator('#stepsSummary').tap();
    const items = await page.locator('#stepList li').allInnerTexts();
    const texts = items.map((t) => t.split('\n')[0].trim().replace(/\u2011/g, '-'));
    const textOf = (step) => texts[steps.findIndex((s) => s.atM === step.atM && s.type === step.type)];
    check('the panel lists them, each with what to do', items.length === steps.length
      && /^Head (north|south|east|west)/.test(items[0]) && /^Arrive/.test(items.at(-1)), `${items[0]} … ${items.at(-1)}`);
    check('its heading counts the turns', (await page.locator('#stepsSummary').innerText()).includes(`${turns.length} turn`));
    check('each step but the last says how far to drive after it',
      items.slice(0, -1).every((t) => /\d/.test(t.split('\n').at(-1))));
    check('every step has an arrow', (await page.locator('#stepList svg path').count()) === steps.length);
    const k = steps.indexOf(turns[0]);
    await page.locator('#stepList li').nth(k).locator('button').evaluate((b) => b.click());
    await page.waitForTimeout(2600);
    const centre = await page.evaluate(() => window.__fw.map.getCenter().toArray());
    const kx = 111320 * Math.cos((turns[0].at[1] * Math.PI) / 180);
    const offM = Math.hypot((centre[0] - turns[0].at[0]) * kx, (centre[1] - turns[0].at[1]) * 110540);
    check('a tap on a step shows it on the map', offM < 30, `${offM.toFixed(0)} m away`);

    // ---------- the next turn, over the map, in a preview ----------
    await page.evaluate(() => window.__fw.sheet.set('half'));
    await page.waitForTimeout(300);
    await page.locator('#drive').tap();
    await page.waitForTimeout(1500);
    check('a preview shows the next turn over the map', await page.locator('#guide').isVisible());
    const card = await page.locator('#guide').innerText();
    const upcoming = await page.evaluate(() => {
      const { state } = window.__fw;
      const at = state.car.distM;
      return state.drive.route.steps.find((s) => s.type !== 'depart' && s.atM > at);
    });
    check('it shows how far and what to do', /\d/.test(await page.locator('.guide-dist').innerText())
      && (await page.locator('.guide-what').innerText()).length > 3, card.replace(/\s+/g, ' '));
    check('for the maneuver that really is next', Boolean(upcoming)
      && (await page.locator('.guide-what').innerText()).replace(/\u2011/g, '-') === textOf(upcoming), textOf(upcoming));
    const g = await page.locator('#guide').boundingBox(), b = await page.locator('#banner').boundingBox();
    check('the camera banner sits under it, not over it', Boolean(g && b) && b.y >= g.y + g.height - 1,
      g && b ? `card ends ${Math.round(g.y + g.height)}, banner starts ${Math.round(b.y)}` : 'missing');
    await page.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/preview.png` : '/dev/null' });
    const seen = new Set();
    for (let i = 0; i < 40 && (await page.evaluate(() => Boolean(window.__fw.state.drive))); i++) {
      seen.add(await page.locator('.guide-what').innerText().catch(() => ''));
      await page.waitForTimeout(500);
    }
    check('the card moves on as maneuvers pass', seen.size >= Math.min(2, turns.length + 1), [...seen].join(' | '));
    await page.waitForFunction(() => !window.__fw.state.drive, null, { timeout: 60_000 });
    check('a preview says nothing out loud', (await page.evaluate(() => window.__spoken.length)) === 0);
    check('and the card goes when the preview ends', await page.locator('#guide').isHidden());

    // ---------- driving: the card and spoken prompts ----------
    const points = resample(route.coordinates, 20);
    const fix = async ([lon, lat], waitMs = 40) => {
      await ctx.setGeolocation({ longitude: lon, latitude: lat, accuracy: 8 });
      await page.waitForTimeout(waitMs);
    };
    await fix(points[0], 1200);
    await page.locator('#headNav').tap();
    const first = await page.evaluate(() => window.__spoken[0]);
    check('Start says which way to head', /^Head /.test(first ?? ''), first);
    check('driving shows the next turn too', await page.locator('#guide').isVisible());
    for (const p of points.slice(0, -2)) await fix(p);
    const spoken = await page.evaluate(() => window.__spoken);
    const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1);
    const early = spoken.filter((t) => /^In (\d|a |half|three)[^,]*, /.test(t));
    check('turns far enough apart are announced ahead of time ("In …, …")', early.length > 0
      && early.every((t) => steps.some((s) => t.endsWith(`, ${lower(textOf(s))}`))), early.join(' | '));
    check('and every turn again as it comes up', turns.every((s) => spoken.some((t) => t.startsWith(textOf(s)))),
      spoken.join(' | '));
    check('nothing is said twice in a row', spoken.every((t, i) => !i || t !== spoken[i - 1]));
    check('only the on-device voice speaks', (await page.evaluate(() => [...window.__voicesUsed])).join() === 'Device voice');
    check('arriving is said', spoken.some((t) => t.startsWith(textOf(steps.at(-1)))), spoken.at(-1));
    await ctx.close();

    // ---------- switched off, and with no on-device voice ----------
    {
      const { ctx, page, route } = await openTrip(browser, true);
      await page.locator('#menuBtn').tap();
      await page.locator('#voice').uncheck();
      await page.locator('#menuClose').tap();
      await ctx.setGeolocation({ longitude: route.coordinates[0][0], latitude: route.coordinates[0][1], accuracy: 8 });
      await page.waitForTimeout(1200);
      await page.locator('#headNav').tap();
      for (const p of resample(route.coordinates, 40).slice(0, 15)) {
        await ctx.setGeolocation({ longitude: p[0], latitude: p[1], accuracy: 8 });
        await page.waitForTimeout(40);
      }
      check('with the menu\'s switch off, nothing is said', (await page.evaluate(() => window.__spoken.length)) === 0);
      check('but the next turn still shows', await page.locator('#guide').isVisible());
      await page.reload();
      await ready(page);
      check('the switch stays off', !(await page.locator('#voice').isChecked()));
      await ctx.close();
    }
    {
      const { ctx, page, route } = await openTrip(browser, false);
      await page.locator('#menuBtn').tap();
      check('with only a voice that would send the text away, the switch is off',
        await page.locator('#voice').isDisabled(), await page.locator('#voiceNote').innerText());
      await page.locator('#menuClose').tap();
      await ctx.setGeolocation({ longitude: route.coordinates[0][0], latitude: route.coordinates[0][1], accuracy: 8 });
      await page.waitForTimeout(1200);
      await page.locator('#headNav').tap();
      await page.waitForTimeout(300);
      check('and nothing is said', (await page.evaluate(() => window.__spoken.length)) === 0);
      await ctx.close();
    }

    // ---------- a wide screen ----------
    {
      const { ctx, page } = await openTrip(browser, true, { viewport: { width: 1280, height: 800 } });
      await page.locator('#drive').click();
      await page.waitForTimeout(1500);
      const g = await page.locator('#guide').boundingBox();
      const panel = await page.locator('#panel').boundingBox();
      check('on a wide screen the card sits at the top, beside the trip card', Boolean(g) && g.y < 60 && g.width <= 560
        && g.x >= panel.x + panel.width, JSON.stringify(g));
      await page.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/desktop.png` : '/dev/null' });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\nconsole/page errors: ${errors.length ? `\n  ${errors.join('\n  ')}` : 'none'}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
