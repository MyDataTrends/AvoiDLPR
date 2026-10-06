# AvoiDLPR
Map routes to take you across as few ALPRs as possible

Camera-aware navigation. It warns when you're entering an ALPR (Flock and others) capture zone,
and finds routes that avoid them. Everything runs on your device, and it installs to a phone's
home screen like an app (no app store). The code still uses the project's working name,
FlockWatch.

Camera locations come from [DeFlock](https://deflock.org)'s crowdsourced OpenStreetMap data,
and roads come from OpenStreetMap. Both are © OpenStreetMap contributors, ODbL.

**Hosting it:** [docs/DEPLOY.md](docs/DEPLOY.md) is the guide, and a checklist, for putting it
online on free tiers (Cloudflare Pages and R2, GitHub Actions).

## Layout

| Path | What |
|---|---|
| [docs/DEPLOY.md](docs/DEPLOY.md) | Deploying: architecture, the setup checklist, costs, licensing, known gaps |
| [spike/FINDINGS.md](spike/FINDINGS.md) | Data spike: where the camera data comes from, coverage, direction quality |
| [spike/routing/ROUTING.md](spike/routing/ROUTING.md) | Routing spike: capture-zone math, Dallas trade-offs, engine comparison |
| [pipeline/](pipeline) | Python: OSM extract → road pack, DeFlock → camera feed, staging a release (`regions.json` lists the regions) |
| [packages/router](packages/router) | TypeScript on-device router (zone predicate, exposure, edge-based A\*, options) |
| [apps/web](apps/web) | The app: MapLibre + self-hosted Protomaps basemap, routing in a Web Worker, installable and offline-capable |
| [.github/workflows](.github/workflows) | CI, the hourly camera refresh, the monthly data build |
| `data/`, `release/` | Local build outputs (gitignored): `data/` holds the built inputs, `release/` the staged files the app loads |

## Build and test

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
npm install

# Data for one region (Dallas): road pack, basemap, cameras, then stage the release the app loads
.venv/Scripts/python -m pipeline.build_pack spike/routing/data/Dallas.osm.pbf data/packs/dallas.fwr
npm run fetch-basemap -w @flockwatch/web             # needs the pmtiles CLI (github.com/protomaps/go-pmtiles)
.venv/Scripts/python -m pipeline.refresh_cameras --out release
.venv/Scripts/python -m pipeline.release             # writes release/ (regions.json, packs/, basemap/, cameras/)
.venv/Scripts/python -m pipeline.fixtures --dallas   # test fixtures; the grid ones are committed

npm test && npm run typecheck                         # TypeScript
.venv/Scripts/python -m pytest -q pipeline spike/routing
npm run bench -w @flockwatch/router                   # Dallas benchmark

npm run dev -w @flockwatch/web                        # http://localhost:5173
npm run phone -w @flockwatch/web                      # serve to your phone over HTTPS (see apps/web/README.md)
```

Any other region: add it to `pipeline/regions.json` and run
`python -m pipeline.build_region <id>` (it downloads, clips and builds; needs
[osmium-tool](https://osmcode.org/osmium-tool/)), then the same basemap, cameras and release steps.

## License

The code is licensed under the [Apache License 2.0](LICENSE).

The map data is not. Roads and camera locations come from OpenStreetMap under the
[Open Database License](https://opendatacommons.org/licenses/odbl/) (© OpenStreetMap
contributors), and the road packs and camera feeds this project builds from them carry the same
license. The basemap tiles are a Protomaps build of OpenStreetMap (also ODbL), the label fonts
are Noto Sans (SIL Open Font License), and MapLibre GL JS, PMTiles and the Protomaps style are
BSD-3-Clause.
