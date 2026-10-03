# Data spike findings (2026-10-02)

## Source
DeFlock publishes hourly static JSON region tiles, regenerated from OpenStreetMap
(`surveillance:type=ALPR`). No Overpass load, no API key.

- Index: `https://cdn.deflock.me/regions/index.json` (lists regions + `expiration_utc`)
- Tile: `https://cdn.deflock.me/regions/{lat}/{lon}.json` on a **20° grid**
  (e.g. `20/-80` = lat 20..40, lon -80..-60). Some tiles 403 when empty/absent.
- Record: `{id, lat, lon, tags:{direction?, manufacturer?, brand?, operator?, ...}}` (9-tag whitelist,
  `id` = OSM node id, which is what the report flow needs for edits).
- US footprint is ~11 tiles / ~19 MB raw JSON. Biggest single tile (`20/-100`, TX/South) is 8 MB.
- Licence: ODbL (OSM). Need attribution; derived feeds must stay share-alike.

Direct Overpass was tried first and is not viable for bulk: `overpass-api.de` 504s / "server too busy"
on 5° tiles, `overpass.kumi.systems` serves months-stale data. Keep `fetch_alpr.mjs` only as a
fallback for small bbox refreshes.

## Results (US, deduped, 143,435 nodes)

| Metric | Value |
|---|---|
| Usable bearing (`ok` + `multi`) | **96.8%** |
| Single numeric/compass bearing | 90.3% |
| Multiple bearings (`90;270`) | 6.4% |
| No direction | 3.0% |
| Out-of-range / unparseable | 0.2% (mostly negatives like `-30`, plus `forward`/`backward`) |
| Flock Safety | 114,320 (79.7%) |
| Motorola, Genetec, Axis, Leonardo, Rekor… | ~22,000 |
| No manufacturer | 6,848 |
| Nodes with `operator` | 16.7% |
| ~22 m cells with >1 node | 6,368 cells / 13,927 nodes |

Densest 1° cells: Houston, Atlanta, LA, Chicago, Bay Area, Dallas.

## What this changes
1. **Direction is far better than assumed** (97% usable). The cone model is the primary mode, and the
   "unknown direction → circle" degrade is an edge case, not the common one.
2. **Parser is required**: normalise negatives (`-30` → 330), accept `;`-lists and `a-b` ranges,
   and reject `forward`/`backward`/garbage like `150000099`.
3. **Private-property noise**: operators include Lowe's / Home Depot (retail parking lots). Alerts
   should tier roadside vs. private-lot cameras (needs a heuristic or an OSM-tag signal; not in the 9-tag whitelist).
4. **Multi-camera poles** (~14k nodes in shared cells): dedupe alerts per location so one pole = one alert.
5. **Data size is small enough to ship offline** — whole US ≈ 143k points; compressed binary fits in a few MB.

## Caveats / not yet verified
- Quality of the *bearings* (vs. presence) is unmeasured; we only know they parse. Ground-truth spot checks needed.
- Staleness: no per-node edit timestamp in the DeFlock tiles. OSM `out meta` via Overpass would give it for
  targeted areas.
- Tile 403s on some regions weren't investigated (assumed empty).
- Ocean/Canada/Mexico spill-over from 20° tiles is clipped by a rough US bbox, not a polygon.
