# Developing AvoiDLPR

How the code is laid out, how to build the data and the app, and how to run the tests. For
putting it online, see [DEPLOY.md](DEPLOY.md). The code still uses the project's working name,
FlockWatch (`@flockwatch/router`, `@flockwatch/web`).

## Layout

| Path | What |
|---|---|
| [pipeline/](../pipeline) | Python: OSM extracts → road packs and search indexes, DeFlock → camera feeds, staging a release. `regions.json` lists the 135 areas |
| [packages/router](../packages/router) | TypeScript on-device router (zone predicate, exposure, edge-based A\*, route options) and place search (`places.ts`) |
| [apps/web](../apps/web) | The app: MapLibre + self-hosted Protomaps basemap, routing and search in Web Workers, installable and offline-capable |
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

# Data for one region (Dallas): road pack, search index, basemap, cameras, then stage the release
.venv/Scripts/python -m pipeline.build_pack spike/routing/data/Dallas.osm.pbf data/packs/dallas.fwr
.venv/Scripts/python -m pipeline.places spike/routing/data/Dallas.osm.pbf data/places/dallas.fwp
npm run fetch-basemap -w @flockwatch/web
.venv/Scripts/python -m pipeline.refresh_cameras --out release
.venv/Scripts/python -m pipeline.release             # writes release/ (regions.json, packs/, places/, basemap/, cameras/)
.venv/Scripts/python -m pipeline.fixtures --dallas   # test fixtures; the grid and town ones are committed

npm test && npm run typecheck                         # TypeScript
.venv/Scripts/python -m pytest -q pipeline spike/routing
npm run bench -w @flockwatch/router                   # Dallas benchmark

npm run dev -w @flockwatch/web                        # http://localhost:5173
npm run phone -w @flockwatch/web                      # serve to your phone over HTTPS (see apps/web/README.md)
```

The browser tests in `apps/web/e2e/` run with Playwright against the dev server and the staged
release: `phone-and-location.cjs` (layout, route options, GPS start, preview), `appearance.cjs`
(the menu: dark mode, your ride, quick searches), `areas.cjs` (the area chooser and switching),
`directions.cjs` (turn by turn: the step list, the next-turn card and spoken prompts),
`nationwide.cjs` (the map of the whole country, every camera in it, and areas loading as you go), `hold.cjs`
(holding the map: the spot menu, and taps that no longer move the trip), `search.cjs` (places, addresses, streets and coordinates in the From
and To fields; it needs Dallas's search index staged), `navigate.cjs` (live navigation, fed GPS
fixes), `updates.cjs` (a damaged pack falls back to the last good one; updates go in between
trips; new cameras apply at once) and `production.cjs` (the production build: headers, CSP, the
service worker and its update handling, offline; it needs the two servers named at its top).
`readme-screenshots.cjs` retakes the screenshots in the README.

## The areas, and how they're built

`pipeline/regions.json` lists the areas: an id, a name, a rectangle (`clip_bbox`) and the
Geofabrik extract of every state the rectangle reaches into (`geofabrik`, home state first).
`python -m pipeline.check_regions` tests those lists against the states' real boundaries.

The monthly workflow (`.github/workflows/build-data.yml`) groups the areas into batches of
neighbouring states (`python -m pipeline.plan`). Each batch runs `pipeline.build_batch`, which
downloads each state once, keeps only the drivable roads and turn restrictions (and, separately,
what search needs: named places, house numbers and the outlines of named areas), merges them, cuts
out every area and builds its road pack, search index and basemap; `pipeline.release --part`
stages the result.
A final job refreshes the cameras, merges the batches with the live manifest
(`pipeline.release --assemble`) and publishes; `pipeline.report` writes the run summary.

To build one area here: `python -m pipeline.build_region <id> --basemap` (downloads its states;
needs osmium-tool and pmtiles), or `--pbf some.osm.pbf` to use an extract you already have. Then
refresh the cameras and stage the release as above. The app reads the areas from the release's
`regions.json`, so a new one needs no app change.

The nightly update (`build-data.yml` in roads mode) keeps each state's roads in the Actions
cache and rolls them forward with Geofabrik's daily changes (`pipeline/roads.py`). Every pack
carries a fingerprint of its routing content; `pipeline/decide.py` compares a rebuilt pack with
the live one (`packages/router/bin/verify.ts` loads both) and decides: unchanged, publish, defer
or hold. docs/DEPLOY.md, "Keeping the data fresh", has the rules.

Packs also carry what turn-by-turn directions say about each road: its name, its route number
and, on a ramp, where it's signposted to, plus a roundabout flag (`labels`, `geom_label` and
`geom_flags`; `pipeline/pack.py`). They don't change routing, and a reader treats them as optional,
so packs built before them still load. The router turns a route into maneuvers in
`packages/router/src/guidance.ts`, tested on `packages/router/test/fixtures/guide.*`, made-up
streets with a fork, a slip lane, a highway's ramps and a roundabout (`python -m pipeline.fixtures` rebuilds
them).

Packs leave out unnamed service roads (parking-lot lanes, apartment drives, alleys): they were
45% of Dallas's edges but almost never part of a sensible route. `build_pack --with-service`
keeps them, for comparison.

## Search

Search runs on the phone, like routing, so nothing typed leaves it. `pipeline/places.py` builds
each area's index from OpenStreetMap: streets (a street's pieces grouped into one entry per town,
with a point about every kilometre so a result can be shown where it's nearest), house numbers
filed under their street, and named places (shops, schools, parks, stations, airports,
neighbourhoods; `kind_of` decides what counts). House numbers are written every which way in the
data, so they're matched to roads on a key that spells abbreviations one way ("E Belt Line Rd" is
"East Belt Line Road"), then without the direction or the type. The file (FWP1) is laid out like a
road pack; Dallas's is 1.4 MB gzipped for 240,000 addresses.

`packages/router/src/places.ts` decodes it and searches: words in any order, each a whole word or
the start of one, with abbreviations read either way; a leading number looks for that house
number, placed between its neighbours (and marked approximate) when the map doesn't have it.
Results rank by how well they match, how notable the place is and how near. The app runs it in its
own worker (`apps/web/src/search-worker.ts`); `src/search.ts` turns the From and To fields into
search boxes. The search index is built by the monthly (full) build only; the nightly update
keeps the live one.

`python -m pipeline.places <extract> <out.fwp>` builds one from any extract; the pipeline tests use
a made-up town (`pipeline/fixtures.py`, `town_osm`) and the router's tests search its index
(`packages/router/test/fixtures/town.fwp`).
