# Developing AvoiDLPR

How the code is laid out, how to build the data and the app, and how to run the tests. For
putting it online, see [DEPLOY.md](DEPLOY.md). The code still uses the project's working name,
FlockWatch (`@flockwatch/router`, `@flockwatch/web`).

## Layout

| Path | What |
|---|---|
| [pipeline/](../pipeline) | Python: OSM extracts → road packs, DeFlock → camera feeds, staging a release. `regions.json` lists the 135 areas |
| [packages/router](../packages/router) | TypeScript on-device router (zone predicate, exposure, edge-based A\*, route options) |
| [apps/web](../apps/web) | The app: MapLibre + self-hosted Protomaps basemap, routing in a Web Worker, installable and offline-capable |
| [.github/workflows](../.github/workflows) | CI, the hourly camera refresh, the monthly data build |
| [spike/FINDINGS.md](../spike/FINDINGS.md) | Data spike: where the camera data comes from, coverage, direction quality |
| [spike/routing/ROUTING.md](../spike/routing/ROUTING.md) | Routing spike: capture-zone math, Dallas trade-offs, engine comparison |
| `data/`, `release/` | Local build outputs (gitignored): `data/` holds the built inputs, `release/` the staged files the app loads |

## Build and test

You need Node 22 and Python 3.13. Building an area's data from scratch also needs
[osmium-tool](https://osmcode.org/osmium-tool/) and the
[pmtiles CLI](https://github.com/protomaps/go-pmtiles); the monthly workflow does that on
GitHub, so locally you only need them to build an area yourself.

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
npm install

# Data for one region (Dallas): road pack, basemap, cameras, then stage the release the app loads
.venv/Scripts/python -m pipeline.build_pack spike/routing/data/Dallas.osm.pbf data/packs/dallas.fwr
npm run fetch-basemap -w @flockwatch/web
.venv/Scripts/python -m pipeline.refresh_cameras --out release
.venv/Scripts/python -m pipeline.release             # writes release/ (regions.json, packs/, basemap/, cameras/)
.venv/Scripts/python -m pipeline.fixtures --dallas   # test fixtures; the grid ones are committed

npm test && npm run typecheck                         # TypeScript
.venv/Scripts/python -m pytest -q pipeline spike/routing
npm run bench -w @flockwatch/router                   # Dallas benchmark

npm run dev -w @flockwatch/web                        # http://localhost:5173
npm run phone -w @flockwatch/web                      # serve to your phone over HTTPS (see apps/web/README.md)
```

The browser tests in `apps/web/e2e/` run with Playwright against the dev server and the staged
release: `phone-and-location.cjs` (layout, route options, GPS start, preview), `areas.cjs` (the
area chooser and switching), `navigate.cjs` (live navigation, fed GPS fixes) and
`production.cjs` (the production build: headers, CSP, service worker, offline; it needs the two
servers named at its top). `readme-screenshots.cjs` retakes the screenshots in the README.

## The areas, and how they're built

`pipeline/regions.json` lists the areas: an id, a name, a rectangle (`clip_bbox`) and the
Geofabrik extract of every state the rectangle reaches into (`geofabrik`, home state first).
`python -m pipeline.check_regions` tests those lists against the states' real boundaries.

The monthly workflow (`.github/workflows/build-data.yml`) groups the areas into batches of
neighbouring states (`python -m pipeline.plan`). Each batch runs `pipeline.build_batch`, which
downloads each state once, keeps only the drivable roads and turn restrictions, merges them, cuts
out every area and builds its road pack and basemap; `pipeline.release --part` stages the result.
A final job refreshes the cameras, merges the batches with the live manifest
(`pipeline.release --assemble`) and publishes; `pipeline.report` writes the run summary.

To build one area here: `python -m pipeline.build_region <id> --basemap` (downloads its states;
needs osmium-tool and pmtiles), or `--pbf some.osm.pbf` to use an extract you already have. Then
refresh the cameras and stage the release as above. The app reads the areas from the release's
`regions.json`, so a new one needs no app change.

Packs leave out unnamed service roads (parking-lot lanes, apartment drives, alleys): they were
45% of Dallas's edges but almost never part of a sensible route. `build_pack --with-service`
keeps them, for comparison.
