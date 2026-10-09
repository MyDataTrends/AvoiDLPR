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
router.routeAlternatives(a, b);                    // the trade-off options, fastest first (see below)
router.sitesCapturingAt(lon, lat, headingDeg);     // live: which zones hold the car right now
router.setCameras(updatedRecords);                 // hourly feed, or the user's own report
```

A `Route` carries `timeS`, `distanceM`, `turns`, `coordinates` ([lon, lat]) and `sites`: the
capture sites in the order you reach them. Each has `atM` and `untilM`, metres along the route
where its zone starts and ends; they drive the "camera ahead" and "in a camera zone" alerts. And
`steps`, its turn-by-turn directions (below).

`routeAlternatives` returns `{ routes, recommended, probes }`: up to four routes along the trip's
time-vs-cameras frontier, fastest first, each passing strictly fewer capture sites than the one
before and at most 50% slower than the fastest. `recommended` indexes the fewest-camera route
within 10% more time. A trip whose fastest route passes no cameras returns that route alone. It
sweeps the camera price (route time only rises with it), then bisects the price inside the
recommendation window so the recommended route is as good as `routeWithinBudget`'s. On the 300
Dallas trips it takes 91 ms typically (357 ms for the slowest tenth), 5.9 searches on average; the
recommended route has 0.71 camera zones per trip against 0.70 for the budget search. 66 trips get
one option, 115 two, 80 three and 39 four.

## Turn-by-turn directions

`route.steps` lists a route's maneuvers, from `depart` to `arrive`, each with `atM` (metres along
the route), `at` ([lon, lat]), a `direction` (`left`, `slight right`, …), the `road` it puts you on
and, for a ramp or an exit, where it's signposted `toward`. `describeStep(step)` says it as a
sentence: "Turn left onto Oak Avenue", "Keep right toward Downtown", "Merge onto I-35E", "At the
roundabout, take the second exit onto Back Road".

[`guidance.ts`](src/guidance.ts) only speaks up where there's a choice to get wrong. At each
intersection it compares the turn the route takes with the other ways out (not back the way it
came, not a banned turn): a turn of more than 35° is a turn; a nearly straight one with another
nearly straight way out is a fork ("Keep left"), unless the road you're on plainly carries on;
straight on onto a road with another name is "Continue onto". A road that bends with nowhere else
to go gets nothing. Highway ramps are always announced where they start, merge, leave and end; a
slip lane between streets is one turn, said where it starts; and a roundabout counts its exits. Highways go by their number ("I-35E"), streets by name, and a
road with no name (a median crossing) takes the next one's within 60 m.

Names come from the pack's road labels; a pack built before them gives the same maneuvers,
unnamed. Tests: `test/guidance.test.ts`, on made-up streets (`test/fixtures/guide.*`), 12 of them.

## Place search

The package also searches an area's place index (`.fwp`, built by `pipeline/places.py`), on the
device like routing, so nothing typed is sent anywhere:

```ts
import { decodePlaces, PlaceSearch } from "@flockwatch/router";

const search = new PlaceSearch(decodePlaces(placesBytes));
search.search("104 main st", { near: [lon, lat] }); // addresses, streets, places, coordinates
search.nearest(lon, lat);                           // what's here: the nearest address or place
```

A query is words in any order, each a whole word or the start of one, with street abbreviations
read either way ("e belt line rd" finds East Belt Line Road). A leading number is a house number on
the streets the rest names; one the map lacks is placed between its neighbours on the same side
and marked `approximate`. A word can also match a place's kind ("airport") or town. Results rank
by match, the place's rank (an airport above a shop) and distance from `near`, with less weight on
distance for notable places. Dallas's index (19,800 streets, 243,000 addresses, 15,400 places)
decodes in about 25 ms, takes 95 ms to prepare, and answers a query in 12 to 22 ms in Node.

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
- **Search** (`test/fixtures/town.*`, a made-up town built by the real pipeline): streets, house
  numbers written every which way, places by name, other name, brand and kind, the same name in
  two towns, approximate numbers, coordinates, and naming a tapped spot.

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
