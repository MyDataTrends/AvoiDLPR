# FlockWatch

Camera-aware navigation. It warns when you're entering an ALPR (Flock and others) capture zone,
and finds routes that avoid them. Everything runs on your device.

Camera locations come from [DeFlock](https://deflock.org)'s crowdsourced OpenStreetMap data,
and roads come from OpenStreetMap. Both are © OpenStreetMap contributors, ODbL.

## Layout

| Path | What |
|---|---|
| [spike/FINDINGS.md](spike/FINDINGS.md) | Data spike: where the camera data comes from, coverage, direction quality |
| [spike/routing/ROUTING.md](spike/routing/ROUTING.md) | Routing spike: capture-zone math, Dallas trade-offs, engine comparison |
| [pipeline/](pipeline) | Python: OSM extract → road pack (`.fwr`) + camera feed |
| [packages/router](packages/router) | TypeScript on-device router (zone predicate, exposure, edge-based A\*, budgets) |
| `data/` | Local build outputs (gitignored) |

## Build and test

```bash
python -m venv --system-site-packages .venv
.venv/Scripts/pip install osmium shapely
npm install

# Dallas road pack + camera feed (extract: see spike/routing/ROUTING.md "Reproduce")
.venv/Scripts/python -m pipeline.build_pack spike/routing/data/Dallas.osm.pbf data/packs/dallas.fwr
.venv/Scripts/python -m pipeline.fixtures --dallas   # test fixtures; grid ones are committed

npm test && npm run typecheck                         # TypeScript
.venv/Scripts/python -m pytest -q pipeline spike/routing
npm run bench -w @flockwatch/router                   # Dallas benchmark
```
