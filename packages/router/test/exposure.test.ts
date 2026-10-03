import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RoadPack } from "../src/pack.ts";
import type { Router } from "../src/router.ts";
import { GRID_NODES, gridCamera, gridRouter } from "./helpers.ts";

/** Directed edge from grid node a to grid node b. */
function edge(pack: RoadPack, a: number, b: number): number {
  const near = (k: number, node: number) => {
    const [lon, lat] = GRID_NODES[node];
    return Math.hypot(pack.vx[k] - pack.proj.x(lon), pack.vy[k] - pack.proj.y(lat)) < 0.5;
  };
  for (let e = 0; e < pack.nEdges; e++) {
    const g = pack.edgeGeom[e], first = pack.geomPtr[g], last = pack.geomPtr[g + 1] - 1;
    const [s, t] = pack.edgeRev[e] ? [last, first] : [first, last];
    if (near(s, a) && near(t, b)) return e;
  }
  throw new Error(`no edge ${a} -> ${b}`);
}

function sitesOn(router: Router, e: number) {
  const ex = router.exposure;
  return Array.from({ length: ex.ptr[e + 1] - ex.ptr[e] }, (_, i) => {
    const k = ex.ptr[e] + i;
    return { site: ex.site[k], entry: ex.entry[k], exit: ex.exit[k], units: ex.units[k], atEnd: ex.atEnd[k] };
  });
}

describe("exposure", () => {
  // A Flock camera 5 m east of node 6, facing north. Along the column's centreline the
  // buffered zone runs from 10.9 m south of node 6 (the eps disc round the pole) to 61.8 m
  // north of it (R + eps): 72.7 m of a 74 m reference pass, split across two edges.
  const router = gridRouter([gridCamera(1, 6, "0")]);
  const { pack } = router;

  it("splits one pass across the intersection and carries it over", () => {
    const [before] = sitesOn(router, edge(pack, 1, 6));
    const [after] = sitesOn(router, edge(pack, 6, 11));
    assert.ok(Math.abs(before.entry - (200 - 10.9)) < 5.5); // 5 m sampling
    assert.ok(Math.abs(before.units - 10.9 / 74) < 0.08);
    assert.equal(before.atEnd, 1); // still in the zone at node 6...
    assert.ok(after.entry < 1e-6); // ...and from the start of the next edge
    assert.ok(Math.abs(after.units - 61.8 / 74) < 0.08);
    assert.ok(Math.abs(before.units + after.units - 72.7 / 74) < 0.08);
  });

  it("logs only the direction the camera faces", () => {
    assert.equal(sitesOn(router, edge(pack, 11, 6)).length, 0);
    assert.equal(sitesOn(router, edge(pack, 6, 1)).length, 0);
    assert.equal(sitesOn(router, edge(pack, 6, 7)).length, 0); // crossing traffic
  });

  it("logs both directions for a brand of unknown plate side", () => {
    const axis = gridRouter([gridCamera(2, 6, "0", "Motorola Solutions")]);
    assert.equal(sitesOn(axis, edge(axis.pack, 6, 1)).length, 1);
    assert.equal(sitesOn(axis, edge(axis.pack, 11, 6)).length, 1);
  });

  it("merges a two-lane gantry into one site that counts once", () => {
    const lane2 = gridCamera(3, 6, "0");
    lane2.lon += 3.7 / (111_194.93 * Math.cos((lane2.lat * Math.PI) / 180));
    const gantry = gridRouter([gridCamera(1, 6, "0"), lane2]);
    assert.equal(gantry.cameras.siteCameras.length, 1);
    const units = [edge(gantry.pack, 1, 6), edge(gantry.pack, 6, 11)]
      .flatMap((e) => sitesOn(gantry, e)).reduce((sum, r) => sum + r.units, 0);
    assert.ok(units <= 1.0001); // the union of both zones, not double
  });

  it("recomputes when the camera feed changes", () => {
    const r = gridRouter([gridCamera(1, 6, "0")]);
    r.setCameras([]);
    assert.equal(r.exposure.site.length, 0);
  });
});
