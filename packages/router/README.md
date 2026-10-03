# @flockwatch/router

On-device routing that knows where ALPR cameras look. It runs in a browser or in React
Native, so no server ever sees an origin or destination.

```ts
import { Router } from "@flockwatch/router";

const router = Router.fromBuffer(packBytes, cameraRecords); // road pack + DeFlock-format camera records
const a = router.snap(-96.80, 32.78)!, b = router.snap(-96.70, 32.85)!;

router.route(a, b);                                // fastest
router.route(a, b, { lambda: 60 });                // worth 60 s of driving to skip one capture
router.routeWithinBudget(a, b, { maxExtra: 0.1 }); // fewest captures within +10% time
router.sitesCapturingAt(lon, lat, headingDeg);     // live: which zones hold the car right now
router.setCameras(updatedRecords);                 // hourly feed, or the user's own report
```

A `Route` carries `timeS`, `distanceM`, `turns`, `coordinates` ([lon, lat]) and `sites`: the
capture sites in the order you reach them, with `atM` (metres along the route), which drives
"camera ahead" alerts.

## How it works

- **Roads and cameras ship separately.** The road pack (`.fwr`, built by `pipeline/`) changes
  when OSM does. Cameras change hourly, and whenever a user reports one, so the device computes
  exposure itself. That takes ~100 ms for Dallas's 1,612 cameras. A report reroutes instantly,
  and the zone model (strict, default or loose) can be a user setting.
- **One capture predicate.** [`geo.ts`](src/geo.ts) ports the spike's zone geometry
  (`spike/routing/geometry.py`); see [ROUTING.md](../../spike/routing/ROUTING.md) for the math.
  Routing and live alerts call the same `captures()`.
- **Edge-based A\*.** Search states are directed edges, not intersections. Moving from edge e
  onto f costs `turn(e, f) + time(f) + λ · (sites logging f that weren't already holding the
  vehicle at the end of e)`.
  - Turns: right 4 s, left 9 s, slight 2 s, sharp 15 s.
  - U-turns are allowed only at dead ends.
  - OSM via-node turn restrictions are honoured, and traffic signals add 8 s.
  - Charging per site *entry*, carried across intersections, matches what the driver is told
    ("2 cameras on this route"). The spike's node graph could only charge length-weighted exposure.
- **Admissible for every λ.** The heuristic is straight-line distance at the pack's top speed.
  Penalties only ever add cost, so the same heuristic stays exact. It's 3.5× faster than Dijkstra
  in Dallas.
- **Endpoints.** Points snap to the nearest segment. A point mid-block uses a partial edge; a
  point on an intersection may leave or arrive by any road.
- **Time budgets.** "Fewest captures within +N%" is a constrained shortest path. It's solved by
  Lagrangian relaxation: bisect λ geometrically over ≤ 9 searches for the dearest price whose
  route still fits, keeping the fewest-capture route seen.

## Dallas benchmark

`npm run bench` on the 300 spike trips (Node 22, one desktop core):

| | |
|---|---|
| Pack | 19.3 MB raw / 11.9 MB gzip; 208k nodes, 507k edges, 1,004 banned turns |
| Load | 107 ms decode + 205 ms grid, cameras and exposure |
| Query (fastest) | 13 ms p50, 38 ms p90 |
| Query (λ = 300) | 18 ms p50, 50 ms p90 |
| Budget query (+10%) | 70 ms p50, 364 ms p90, 5.2 searches on average |
| Memory | ~65 MB heap + 86 MB typed arrays |

| Mode | Extra time | Sites per trip | Capture-free |
|---|---|---|---|
| fastest | – | 1.73 | 21% |
| λ = 60 s | +2.8% | 0.73 | 47% |
| λ = 300 s | +11.9% | 0.05 | 96% |
| budget +10% | +3.2% | 0.70 (−60%) | 50% |
| budget +20% | +6.9% | 0.28 (−84%) | 75% |

With real turn costs, signal delays and restrictions, the spike's Dallas result holds: a +10%
budget cuts captures by 60% here, against 64% in the spike.

## Tests

`npm test` (Node's built-in runner; TypeScript runs through Node's type stripping):

- **Parity with the Python reference.** 3,000 sector distances, 3,000 capture decisions and
  429 real-world `direction` strings.
- **Grid scenarios** (`test/fixtures/grid.*`, built by the real pipeline). Covered: turn
  restriction, one-way, signal delay, mid-block endpoints, one-direction vs. two-direction
  camera avoidance, budgets, and the live zone check. A\* is checked against Dijkstra for all
  600 node pairs.
- **Dallas** (skipped without `data/`). Exposure is identical to `spike/routing/exposure.py` on
  all 4,571 (edge, site) pairs, all 300 trips route, and A\* matches Dijkstra on real trips.

## Known limits

- **Phone memory.** Geometry is held as Float64 with per-vertex distances, about 150 MB for
  Dallas in Node. Float32 local coordinates would roughly halve it.
- **Pack size.** Varint deltas, brotli, or splitting display geometry from the routing core
  should cut it well below 12 MB.
- **Unsupported restrictions.** Via-way restrictions aren't supported (e.g. "no U-turn across
  this median"). 1,238 Dallas restriction relations have unsupported forms, and 208 more name
  ways or nodes outside the drivable graph.
- **Simple timing.** Free-flow speeds, flat turn costs, no live traffic.
- **Budget p90 (364 ms).** Warm-starting the bisection would help.
- **Live tracking.** Snapping ignores heading; it needs map matching.
- **Metro scale.** For state-scale trips, add contraction hierarchies or chain region packs.
