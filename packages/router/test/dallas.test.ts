// Integration against the real Dallas pack. Needs the local data/ directory:
//   python -m pipeline.build_pack spike/routing/data/Dallas.osm.pbf data/packs/dallas.fwr
//   python -m pipeline.fixtures --dallas
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CameraRecord } from "../src/geo.ts";
import { Router } from "../src/router.ts";
import { DATA, hasDallas, readArrayBuffer, readJson } from "./helpers.ts";

describe("Dallas", { skip: !hasDallas && "no data/packs/dallas.fwr" }, () => {
  const records = hasDallas ? readJson<{ cameras: CameraRecord[] }>(`${DATA}packs/dallas.cameras.json`).cameras : [];
  const router = hasDallas ? Router.fromBuffer(readArrayBuffer(`${DATA}packs/dallas.fwr`), records) : null!;
  const trips = hasDallas ? readJson<{ trips: number[][] }>(`${DATA}fixtures/dallas_trips.json`).trips : [];

  it("computes the same exposure as the Python reference", () => {
    const ref = readJson<{ rows: [number, number, number, number][] }>(`${DATA}fixtures/dallas_exposure.json`).rows;
    const { cameras, siteCameras } = router.cameras;
    const siteKey = siteCameras.map((members) => Math.min(...members.map((c) => cameras[c].osmId)));
    const ours = new Map<string, [number, number]>();
    const ex = router.exposure;
    for (let e = 0; e < router.pack.nEdges; e++) {
      for (let k = ex.ptr[e]; k < ex.ptr[e + 1]; k++) ours.set(`${e}:${siteKey[ex.site[k]]}`, [ex.entry[k], ex.units[k]]);
    }
    let missing = 0, valueDiffs = 0;
    for (const [edge, site, entry, units] of ref) {
      const got = ours.get(`${edge}:${site}`);
      if (!got) missing++;
      else if (Math.abs(got[0] - entry) > 1e-3 * Math.max(1, entry) || Math.abs(got[1] - units) > 1e-4) valueDiffs++;
    }
    assert.equal(ours.size, ref.length, "same number of (edge, site) pairs");
    assert.equal(missing, 0);
    assert.equal(valueDiffs, 0);
  });

  it("routes every benchmark trip", () => {
    for (const [lon0, lat0, lon1, lat1] of trips) {
      const a = router.snap(lon0, lat0), b = router.snap(lon1, lat1);
      assert.ok(a && b, "trip endpoints snap");
      assert.ok(router.route(a, b), "trip routes");
    }
  });

  it("alternatives form an ordered frontier within the cap", () => {
    let withChoice = 0;
    for (const [lon0, lat0, lon1, lat1] of trips.slice(0, 60)) {
      const a = router.snap(lon0, lat0)!, b = router.snap(lon1, lat1)!;
      const alt = router.routeAlternatives(a, b)!;
      const fastest = router.route(a, b)!;
      assert.ok(alt.routes.length >= 1 && alt.routes.length <= 4);
      assert.equal(alt.routes[0].timeS, fastest.timeS);
      assert.ok(alt.recommended >= 0 && alt.recommended < alt.routes.length);
      alt.routes.forEach((r, i) => {
        assert.ok(r.timeS <= fastest.timeS * 1.5 + 1e-6, "within the +50% cap");
        if (i > 0) {
          assert.ok(r.timeS >= alt.routes[i - 1].timeS, "slower as cameras fall");
          assert.ok(r.sites.length < alt.routes[i - 1].sites.length, "strictly fewer sites");
        }
      });
      if (alt.routes.length > 1) withChoice++;
    }
    assert.ok(withChoice >= 20, `only ${withChoice} of 60 trips had a real choice`);
  });

  it("A* matches plain Dijkstra on real trips", () => {
    for (const [lon0, lat0, lon1, lat1] of trips.slice(0, 20)) {
      const a = router.snap(lon0, lat0)!, b = router.snap(lon1, lat1)!;
      for (const lambda of [0, 60]) {
        const astar = router.route(a, b, { lambda })!.cost;
        const dijkstra = router.route(a, b, { lambda, heuristic: false })!.cost;
        assert.ok(Math.abs(astar - dijkstra) <= 1e-9 * dijkstra, `${astar} vs ${dijkstra}`);
      }
    }
  });
});
