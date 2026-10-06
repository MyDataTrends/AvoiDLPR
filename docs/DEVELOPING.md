# Developing AvoiDLPR

How the code is laid out, how to build the data and the app, and how to run the tests. For
putting it online, see [DEPLOY.md](DEPLOY.md). The code still uses the project's working name,
FlockWatch (`@flockwatch/router`, `@flockwatch/web`).

## Layout

| Path | What |
|---|---|
| [pipeline/](../pipeline) | Python: OSM extract → road pack, DeFlock → camera feed, staging a release (`regions.json` lists the regions) |
| [packages/router](../packages/router) | TypeScript on-device router (zone predicate, exposure, edge-based A\*, route options) |
| [apps/web](../apps/web) | The app: MapLibre + self-hosted Protomaps basemap, routing in a Web Worker, installable and offline-capable |
| [.github/workflows](../.github/workflows) | CI, the hourly camera refresh, the monthly data build |
| [spike/FINDINGS.md](../spike/FINDINGS.md) | Data spike: where the camera data comes from, coverage, direction quality |
| [spike/routing/ROUTING.md](../spike/routing/ROUTING.md) | Routing spike: capture-zone math, Dallas trade-offs, engine comparison |
| `data/`, `release/` | Local build outputs (gitignored): `data/` holds the built inputs, `release/` the staged files the app loads |

## Build and test

You need Node 22 and Python 3.13. Building a region's data also needs
[osmium-tool](https://osmcode.org/osmium-tool/) and the
[pmtiles CLI](https://github.com/protomaps/go-pmtiles).

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

The browser tests in `apps/web/e2e/` run against the dev server with Playwright;
`readme-screenshots.cjs` retakes the screenshots in the README.

## Adding a region

Add it to `pipeline/regions.json` and run `python -m pipeline.build_region <id>` (it downloads,
clips and builds the road pack), then the same basemap, cameras and release steps as above. The
app reads the list of regions from the release's `regions.json`, so a new region needs no app
change.
