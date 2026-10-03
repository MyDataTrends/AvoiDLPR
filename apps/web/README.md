# @flockwatch/web

A browser demo of camera-aware routing in Dallas. Click a start and a destination to see:
- the fastest route
- the route with the fewest camera zones within your time budget
- an alert list of every zone on the route

**Drive this route** plays the trip back with live "camera ahead" and "in a camera zone"
alerts.

Nothing leaves the tab. The road network, camera feed, basemap tiles, fonts and icons are all
served from this origin, and routing runs in a Web Worker
([`@flockwatch/router`](../../packages/router)). The only state is the URL hash, which browsers
never send to a server.

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

## How it fits together

| Piece | Role |
|---|---|
| `src/worker.ts` | Loads the road pack and camera feed, runs `Router.routeWithinBudget` and the live `sitesCapturingAt` check |
| `src/map.ts` | MapLibre with the Protomaps `light` style via the `pmtiles://` protocol; overlays for routes, camera arrows (rotated to where each camera looks), capture zones, and the car |
| `src/main.ts` | Panel, markers, URL-hash state, drive playback |
| `src/drive.ts` | Position and heading along a route, measured in the pack's projection so distances match the router's alerts |

- **Zone alerts during playback** use the zone intervals the router reports (`atM`–`untilM`).
  Each frame is tested against the whole stretch driven since the previous one, so slow frames
  or high playback speeds can't step over a zone. The worker's live position-and-heading check
  backs this up: it's the same predicate a phone would run on each GPS fix.
- **MapLibre's tile worker** is built by Vite (`?worker&url`) and passed to `setWorkerUrl`.
  MapLibre v6 otherwise looks for it next to its own module, which bundlers move.

## Known limits

- **Size.** The demo loads the full 19 MB road pack, about 0.5–1 s locally, plus 54 MB of
  basemap on demand.
- **Budget searches.** A route request runs up to 9 budget searches: ~150–650 ms on a long trip.
- **Fixed playback speed.** The drive plays back at the route's average speed, not per-road
  speeds.
- **Light theme only.** No dark basemap yet.
- **Extra files in the build.** `vite build` copies all of `data/` into `dist/`, including test
  fixtures.
