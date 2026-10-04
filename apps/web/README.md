# @flockwatch/web

A browser demo of camera-aware routing in Dallas. It works on phones and desktops.

- **Set a trip.** Tap the map for a start and a destination, or press the target button (on the
  map and in the panel) to start from your current location. Drag a pin to adjust it, swap the
  ends, or load an example.
- **Choose a route.** You get up to four options from fastest to fewest cameras, each with its
  extra time, distance and camera-zone count. "Recommended" is the fewest cameras within 10% more
  time. Select one from its card, or by tapping its line on the map; a camera it avoids turns
  green and one it passes turns red.
- **Read the alerts.** The panel lists every camera zone on the selected route; tap one to fly
  to it. **Preview drive** plays the trip back with "camera ahead" and "in a camera zone" alerts.

Nothing leaves the tab. The road network, camera feed, basemap tiles, fonts and icons are all
served from this origin, and routing runs in a Web Worker
([`@flockwatch/router`](../../packages/router)). The only state kept is the URL hash (pins and
the zone model), which browsers never send to a server. **Your location is used in memory only:
it is never sent anywhere, and never written to the URL**, so a shared link can't reveal where
you are.

## Run it

```bash
# once: build the Dallas road pack and camera feed (see the root README), then the basemap
npm run fetch-basemap -w @flockwatch/web   # needs the pmtiles CLI on PATH or in tools/pmtiles/
npm run dev -w @flockwatch/web             # http://localhost:5173
```

The fetch script cuts a 54 MB extract (3,102 tiles, zoom 0–15) for the pack's bounding box out
of Protomaps' daily planet build, using HTTP range requests. It also downloads the label fonts
and icon sprites the style uses. Everything lands in the gitignored `data/`, which Vite serves
as its public directory.

Browsers only share a location on secure pages: `localhost` counts, but a deployed copy needs
HTTPS.

## How it fits together

| Piece | Role |
|---|---|
| `src/worker.ts` | Loads the road pack and camera feed, runs `Router.routeAlternatives` and the live `sitesCapturingAt` check |
| `src/map.ts` | MapLibre with the Protomaps `light` style via the `pmtiles://` protocol; overlays for routes, camera arrows (rotated to where each camera looks), capture zones, the GPS accuracy circle and the car |
| `src/main.ts` | Trip state, route options, markers, URL-hash state, drive playback |
| `src/sheet.ts` | The panel as a bottom sheet on phones: drag, fling or press Up/Down on the handle between peek, half and full |
| `src/location.ts` | One-shot Geolocation with plain-language failures (blocked, unavailable, timed out, insecure page) |
| `src/drive.ts` | Position and heading along a route, measured in the pack's projection so distances match the router's alerts |

- **Phone layout** (up to 760 px wide): the map fills the screen and the panel is a draggable
  bottom sheet. Controls are at least 48 px, form text is 16 px (so iOS doesn't zoom on focus),
  and safe-area insets are respected. The map's own padding tracks the sheet, so framing a
  route, centring on you, or flying to a camera always targets the part of the map you can see.
  The required map attribution floats above the sheet rather than under it.
- **Route options** come from the router's time-vs-cameras frontier (a sweep of camera prices,
  plus a bisection inside the 10% window for the recommendation), capped at +50% time.
- **Taps on the map**: a camera opens its details; another route's line selects that route (the
  nearest line wins where options share a road); anything else sets the active end of the trip.
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

[`e2e/phone-and-location.cjs`](e2e/phone-and-location.cjs) drives a Pixel 7 emulation (touch
input, a fake GPS fix) and a desktop window through 39 checks: the bottom sheet (drag, keyboard,
tap), route options, tapping routes, framing, current location (granted, blocked, outside the
area), the drive preview, and tap-target sizes. It also fails on any console error or any
request that leaves localhost. In dev builds the page exposes `window.__fw` (map, state, sheet)
for it; production builds don't.

## Known limits

- **Size.** The demo loads the full 19 MB road pack, about 0.5–1 s locally, plus 54 MB of
  basemap on demand.
- **Route options.** Computing them takes about 90 ms typically and up to ~360 ms on long
  trips, in the worker.
- **One-shot location.** "Use my location" takes a single fix. It doesn't follow you (live
  navigation, map matching and re-routing are the next step), and there's no address search:
  geocoding would need a third-party service, so you place pins on the map.
- **Fixed playback speed.** The drive plays back at the route's average speed, not per-road
  speeds.
- **Light theme only.** No dark basemap yet.
- **Extra files in the build.** `vite build` copies all of `data/` into `dist/`, including test
  fixtures.
