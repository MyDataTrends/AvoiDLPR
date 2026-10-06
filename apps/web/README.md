# @flockwatch/web

The AvoiDLPR app: camera-aware routing and navigation in the browser, for phones and desktops.

- **Pick your area.** The first visit asks where you drive: a searchable list of the metro areas
  in the manifest, grouped by state, or **Use my location**. The choice is remembered on the
  device; the area name at the top of the panel switches.
- **Set a trip.** The From and To fields are search boxes: type an address, a street, a place
  (a store, a stadium, the airport) or coordinates, and pick from the results. Or tap the map,
  which sets the field used last ("Choose on the map" from the results lowers the sheet for it),
  or press the target button (on the map and in the panel) to start from your current location.
  A tapped stop is named after the nearest address or place. Drag a pin to adjust it, swap the
  ends, or load an example.
- **Choose a route.** You get up to four options from fastest to fewest cameras, each with its
  extra time, distance and camera-zone count. "Recommended" is the fewest cameras within 10% more
  time. Select one from its card, or by tapping its line on the map; a camera it avoids turns
  green and one it passes turns red.
- **Read the alerts.** The panel lists every camera zone on the selected route; tap one to fly
  to it. **Preview drive** plays the trip back with "camera ahead" and "in a camera zone" alerts.
- **Drive.** **Start** follows the device's GPS along the route: a warning before each camera
  zone (earlier at speed), a banner, chime and vibration in one, a new route when you leave this
  one, and the screen kept awake. Start sits in the sheet's header on a phone, so it's in reach
  at any height.

Nothing leaves the device. The road network, search index, camera feed, basemap tiles, fonts and
icons all come from this origin or the data host, and routing and search run in Web Workers
([`@flockwatch/router`](../../packages/router)): **what you type into search is matched on the
device and never sent anywhere.** The state kept is the URL hash (pins and the zone model, which
browsers never send to a server; not the names of searched places) and the area you picked
(local storage). **Your location is used in memory only: it is never sent anywhere, and never
written to the URL or to storage**, including while navigating, so a shared link can't reveal
where you are.

## Where the data comes from

The app boots by fetching `regions.json`, a manifest listing each region's road pack, search
index, camera feed and basemap, and names everything else from it ([`src/data.ts`](src/data.ts)). Where that
manifest lives is `VITE_DATA_BASE` (a URL, set when the app is built):

- **Development and `npm run phone`:** unset, so the data is served from this same origin: the
  dev and preview servers serve the staged `release/` directory at the site root
  ([`scripts/release-files.ts`](scripts/release-files.ts), with byte-range support for the map).
  That's the production file layout, so what you run is what you deploy.
- **Production:** the URL of an object-storage bucket. `VITE_DATA_BASE=https://data.example.com`
  at build time, and the same value becomes the data host in the page's Content-Security-Policy.

The production build contains no map data (about 2 MB): a plain static site.

## Run it

```bash
# once: stage the data (see the root README for the four commands that produce release/)
.venv/Scripts/python -m pipeline.release
npm run dev -w @flockwatch/web             # http://localhost:5173
```

The basemap fetch (`npm run fetch-basemap -w @flockwatch/web [-- --region dallas]`) cuts an
extract covering the area's road pack (20 to 120 MB at zoom 0–15; one over `--max-mb`, default
150, drops to zoom 14) out of Protomaps' newest planet build, using HTTP range requests, and
downloads the label fonts and icon sprites the style uses. It needs the pmtiles CLI on PATH or in
`tools/pmtiles/`.

Browsers only share a location on secure pages: `localhost` counts, but a deployed copy needs
HTTPS.

## Updates

Packs are replaced now and then (docs/DEPLOY.md, "Keeping the data fresh"). A new pack is
checked against the manifest's SHA-256 and decoded before it counts; until then the service
worker keeps the last pack that loaded, and the worker falls back to it, saying so. A pack that
fails is evicted from the cache so the next try downloads it again. The app looks for a new
manifest whenever it comes back on screen (and every half hour while it's on): new cameras apply
at once; a new pack, search index or basemap waits until no trip is being driven or previewed. A
new search index swaps in on its own, without reloading the road map. The panel's footer shows how
current the roads and cameras are.

## Install it like an app, and offline

The site is a progressive web app: from a phone's browser, **Add to Home Screen** (iPhone:
Share menu; Android: menu > Install app) puts an icon on the home screen, and it then opens
full-screen with no browser bar. The app also shows install instructions in the panel.

- **Manifest and icons:** `public/manifest.webmanifest`, `public/icon.svg`, and the PNGs in
  `public/icons/` (192, 512, a maskable one for Android, and an Apple touch icon). Regenerate the
  PNGs from the SVG with `scripts/make-icons.cjs`.
- **Service worker** ([`sw/sw.template.js`](sw/sw.template.js); the build fills in the file list
  and a version): the app opens instantly and with no network, and after the first visit the road
  pack, search index, camera feed and manifest are cached, so **routing and search work
  offline**. Map tiles are the one thing that still needs a connection. A new version reloads open tabs once, so a tab never runs
  files the new worker has retired. It's registered in production builds only.
- **Headers** (`_headers`, emitted by the build for Cloudflare Workers, Pages and Netlify): the
  Content-Security-Policy, caching rules, and a permissions policy.

## Production build

```bash
VITE_DATA_BASE=https://data.example.com npm run build -w @flockwatch/web   # -> apps/web/dist
```

`dist/` is a plain static site: deploy it to any host that honours a `_headers` file (Cloudflare
Workers or Pages, Netlify). [docs/DEPLOY.md](../../docs/DEPLOY.md) has the full setup.

## Run it on your phone

```bash
npm run phone -w @flockwatch/web
```

This builds the app and serves it over **HTTPS** on your computer's private network addresses
(default port 4173), then prints the URL to open on your phone. HTTPS is what lets the browser
share your location: plain `http://192.168.x.x` isn't a secure page, so the location button
wouldn't work.

1. Put the phone on the same Wi-Fi as the computer.
2. Open the `Your phone` address the script prints, for example `https://192.168.1.187:4173/`.
3. The certificate is self-signed, so the browser warns once. Choose Advanced and proceed
   (iPhone: Show Details, then "visit this website").
4. Tap the location button and allow location when asked.

The script generates the certificate with OpenSSL (it ships with Git for Windows) into the
gitignored `.certs/` at the repo root, and regenerates it if your addresses change. Nothing
leaves your network. It needs a staged `release/` (`python -m pipeline.release`). The
service worker won't register on a self-signed certificate, so the offline features need the real
hosted site (or `localhost`); everything else works.

If the page won't load on the phone: let Node through Windows Firewall on private networks
(Windows asks the first time), and if you use a VPN such as Mullvad, enable its local network
sharing setting. The `Your phone` line names the adapter each address belongs to; the Wi-Fi one
is the one you want. `-- --port 5000` changes the port and `-- --no-build` skips the rebuild.

## How it fits together

| Piece | Role |
|---|---|
| `src/worker.ts` | Downloads the road pack (with progress) and unzips it, loads the camera feed, runs `Router.routeAlternatives` and the live `sitesCapturingAt` check |
| `src/search-worker.ts` | Downloads the area's search index once the road map is in, and answers searches and "what's here" (`PlaceSearch` in the router package) |
| `src/search.ts` | The From and To fields as search boxes: the results list, keyboard (arrows, Enter, Escape), "Choose on the map", coordinates without an index |
| `src/fetch-data.ts` | Downloading a road pack or search index: progress, the manifest's SHA-256, un-gzipping |
| `src/map.ts` | MapLibre with the Protomaps `light` style via the `pmtiles://` protocol; overlays for routes, camera arrows (rotated to where each camera looks), capture zones, the GPS accuracy circle and the car |
| `src/data.ts` | Where data lives (`VITE_DATA_BASE`), the `regions.json` manifest, which area to open, and which areas hold a point |
| `src/chooser.ts` | The "Where do you drive?" dialog: search, grouping by state, pick by location |
| `src/main.ts` | Boot from the manifest, trip state, route options, markers, URL-hash state, drive playback, live navigation, area switching, install hint, service worker registration |
| `src/sheet.ts` | The panel as a bottom sheet on phones: drag, fling or press Up/Down on the handle between peek, half and full |
| `src/location.ts` | One-shot Geolocation with plain-language failures (blocked, unavailable, timed out, insecure page) |
| `src/drive.ts` | Position and heading along a route, and matching a GPS fix to it, measured in the pack's projection so distances match the router's alerts |
| `src/format.ts` | Distances in miles and feet in the US (by the browser's locale), else kilometres |

- **Phone layout** (up to 760 px wide): the map fills the screen and the panel is a draggable
  bottom sheet. Controls are at least 48 px, form text is 16 px (so iOS doesn't zoom on focus),
  and safe-area insets are respected. The map's own padding tracks the sheet, so framing a
  route, centring on you, or flying to a camera always targets the part of the map you can see.
  The required map attribution floats above the sheet rather than under it.
- **Route options** come from the router's time-vs-cameras frontier (a sweep of camera prices,
  plus a bisection inside the 10% window for the recommendation), capped at +50% time.
- **Taps on the map**: a camera opens its details; another route's line selects that route (the
  nearest line wins where options share a road); anything else sets the active end of the trip.
  A pin outside the area offers the neighbouring area that holds the whole trip, if one does.
- **Search** ranks by how well the words match, how notable a place is (an airport above a shop)
  and how near it is to the middle of the map. A place found by search may sit back from the road
  (the middle of a park or an airport), so routing looks up to 2.5 km for a road there, against
  600 m for a tapped point.
- **Search on a phone** turns the panel into a full-screen search while a field has focus: the
  fields at the top with a back button, and the results under them, sized to what the keyboard
  leaves of the screen (the visual viewport, tracked in `--vv-top` and `--vv-h`), so no result
  hides behind the keyboard. Picking a result, Back, Escape or the keyboard's Done puts the
  sheet back.
- **Areas overlap at their edges.** Where a point is in two (Irving is in Dallas and Fort
  Worth), the app picks the one it sits deepest inside.
- **Zone alerts during playback** use the zone intervals the router reports (`atM`–`untilM`).
  Each frame is tested against the whole stretch driven since the previous one, so slow frames
  or high playback speeds can't step over a zone. The worker's live position-and-heading check
  backs this up: it's the same predicate a phone would run on each GPS fix.
- **MapLibre's tile worker** is built by Vite (`?worker&url`) and passed to `setWorkerUrl`.
  MapLibre v6 otherwise looks for it next to its own module, which bundlers move.

## Testing

```bash
npm run typecheck -w @flockwatch/web
# with the dev server running; needs Playwright + Chromium (e.g. the playwright skill):
node ~/.claude/skills/playwright-skill/run.js apps/web/e2e/phone-and-location.cjs
```

[`e2e/search.cjs`](e2e/search.cjs) (34 checks) covers search in Dallas: the phone search view
with a keyboard open (faked, as headless browsers have none), a place by name, an address, a
street, an approximate house number, coordinates, no match, the keyboard, swapping, naming a
tapped spot, a place set back from the road still getting a route, and that search talks to
nothing but the site. It needs Dallas's search index staged.

[`e2e/areas.cjs`](e2e/areas.cjs) (28 checks) covers choosing an area: the first-visit chooser,
search, picking by list and by location, remembering, trips that leave the area, and storage
being blocked. It serves its own three-area manifest, so it only needs Dallas staged.
[`e2e/navigate.cjs`](e2e/navigate.cjs) (15 checks) drives the example trip with fed GPS fixes:
the camera-ahead and in-zone alerts, going off route and rerouting, arriving, and that no
position reaches the URL.

[`e2e/updates.cjs`](e2e/updates.cjs) (14 checks) covers taking updates: a damaged new pack
falling back to the last good one, a new pack found on return swapped in between trips but not
mid-drive, new cameras arriving, and a new search index swapped in on its own.

[`e2e/phone-and-location.cjs`](e2e/phone-and-location.cjs) drives a Pixel 7 emulation (touch
input, a fake GPS fix) and a desktop window through 39 checks: the bottom sheet (drag, keyboard,
tap), route options, tapping routes, framing, current location (granted, blocked, outside the
area), the drive preview, and tap-target sizes. It also fails on any console error or any
request that leaves localhost. In dev builds the page exposes `window.__fw` (map, state, sheet,
search) for it; production builds don't.

[`e2e/production.cjs`](e2e/production.cjs) checks the build as deployed, with the data on a
different origin (as with a bucket): the security headers, that the page really can't reach any
other origin, cross-origin data and byte ranges, the install manifest and icons, the service
worker, and **routing and search with the network switched off** (21 checks). To run it, start a stand-in for the
bucket and the built app (the script's header has the commands):

```bash
cd apps/web
node --experimental-strip-types scripts/serve-release.ts &                     # :8788, CORS, serves release/
VITE_DATA_BASE=http://localhost:8788 npx vite build --outDir dist-xorigin
npx vite preview --outDir dist-xorigin &                                       # :4173, applies _headers
node ~/.claude/skills/playwright-skill/run.js e2e/production.cjs
```

## Known limits

- **Size.** The first load fetches the area's gzipped road pack (1 to 13 MB; Dallas, the
  biggest, is 12.5 MB) and then its search index (a few MB) plus map tiles on demand; both are
  cached for offline use.
- **Route options.** Computing them takes about 30 ms typically and up to ~120 ms on long trips
  in Dallas, in the worker.
- **Navigation needs the app on screen.** Phones pause web pages in the background, so it works
  with the app open and the screen on (it asks the browser to keep the screen awake). No
  turn-by-turn directions yet: the route line and the camera alerts.
- **Search knows what OpenStreetMap knows.** Addresses are thorough in some counties and sparse
  in others: a missing house number is placed between its neighbours and marked approximate, or
  the app offers the street. No typo tolerance yet, and only the open area is searched.
- **Fixed playback speed.** The drive plays back at the route's average speed, not per-road
  speeds.
- **Light theme only.** No dark basemap yet.
- **Offline tiles.** Offline covers the app, roads and cameras, not map tiles.
- **One area at a time.** A trip has to fit in one area (or the overlap of two); there's no
  routing from one metro to another.
