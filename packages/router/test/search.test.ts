import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { at, between, GRID_NODES, gridCamera, gridRouter, passes } from "./helpers.ts";

// Residential at 30 km/h: a 200 m block is 24 s. Turns: right 4 s, left 9 s. The grid has a
// one-way row 1 (eastbound), a signal at node 14 (+8 s arriving), and no right turn from
// northbound column 1 onto row 3 at node 17.
const near = (got: number, want: number, tol = 0.5) =>
  assert.ok(Math.abs(got - want) <= tol, `expected ${want} +/- ${tol}, got ${got}`);

describe("routing on the grid", () => {
  const plain = gridRouter();

  it("prefers one right turn to one left on an L-shaped trip", () => {
    const r = plain.route(at(plain, 1), at(plain, 25))!;
    near(r.timeS, 8 * 24 + 4);
    near(r.distanceM, 1600, 1);
    assert.equal(r.turns, 1);
    assert.ok(passes(r.coordinates, 21, plain.pack)); // north first, then a right turn east
  });

  it("honours the turn restriction", () => {
    const banned = plain.route(at(plain, 12), at(plain, 18))!;
    near(banned.timeS, 24 + 9 + 24); // east then left, not north then the banned right
    assert.ok(passes(banned.coordinates, 13, plain.pack));
    const control = plain.route(at(plain, 13), at(plain, 19))!;
    near(control.timeS, 24 + 4 + 24); // the same shape one block over takes the right turn
    assert.ok(passes(control.coordinates, 18, plain.pack));
  });

  it("never drives a one-way street backwards", () => {
    const r = plain.route(at(plain, 10), at(plain, 6))!;
    near(r.timeS, 24 + 4 + 96 + 4 + 24); // round by row 0, all right turns
    near(r.distanceM, 1200, 1);
  });

  it("adds signal delay", () => {
    near(plain.route(at(plain, 13), at(plain, 14))!.timeS, 24 + 8, 0.05);
  });

  it("routes between points in the middle of a block", () => {
    const a = at(plain, between(1, 6, 50)), b = at(plain, between(1, 6, 150));
    near(plain.route(a, b)!.timeS, 12, 0.05);
    near(plain.route(b, a)!.timeS, 12, 0.05); // two-way: straight back
    const c = at(plain, between(6, 7, 150)), d = at(plain, between(6, 7, 50));
    // One-way and the destination is behind: loop the block on right turns.
    near(plain.route(c, d)!.timeS, 6 + 4 + 24 + 4 + 24 + 4 + 24 + 4 + 6);
  });
});

describe("avoiding cameras", () => {
  const flock = gridRouter([gridCamera(1, 6, "0")]); // north-facing, 5 m east of node 6

  it("detours northbound once captures are priced", () => {
    const fastest = flock.route(at(flock, 1), at(flock, 21))!;
    near(fastest.timeS, 96);
    assert.equal(fastest.sites.length, 1);
    near(fastest.sites[0].atM, 200 - 10.9, 5.5);
    const avoid = flock.route(at(flock, 1), at(flock, 21), { lambda: 300 })!;
    assert.equal(avoid.sites.length, 0);
    near(avoid.timeS, 24 + 9 + 96 + 9 + 24); // up column 1 and back
  });

  it("ignores the camera southbound: it reads rear plates one way only", () => {
    const r = flock.route(at(flock, 21), at(flock, 1), { lambda: 300 })!;
    near(r.timeS, 96);
    assert.equal(r.sites.length, 0);
  });

  it("detours southbound too when the brand may read either way", () => {
    const axis = gridRouter([gridCamera(1, 6, "0", "Motorola Solutions")]);
    const r = axis.route(at(axis, 21), at(axis, 1), { lambda: 300 })!;
    assert.equal(r.sites.length, 0);
    near(r.timeS, 24 + 4 + 96 + 4 + 24);
  });

  it("picks the fewest captures that fit a time budget", () => {
    const tight = flock.routeWithinBudget(at(flock, 1), at(flock, 21), { maxExtra: 0.1 })!;
    assert.equal(tight.chosen.sites.length, 1); // the detour costs +69%: doesn't fit
    assert.equal(tight.chosen, tight.fastest);
    const loose = flock.routeWithinBudget(at(flock, 1), at(flock, 21), { maxExtra: 1 })!;
    assert.equal(loose.chosen.sites.length, 0);
    near(loose.chosen.timeS, 162);
  });

  it("answers the live question: is this car in a zone right now?", () => {
    const [lon, lat] = between(6, 11, 20);
    assert.deepEqual(flock.sitesCapturingAt(lon, lat, 0), [0]);
    assert.deepEqual(flock.sitesCapturingAt(lon, lat, 180), []);
  });

  it("finds the same optimum as plain Dijkstra for every pair of grid nodes", () => {
    const ids = Object.keys(GRID_NODES).map(Number).filter((n) => n <= 25);
    for (const lambda of [0, 60]) {
      for (const a of ids) {
        for (const b of ids) {
          if (a === b) continue;
          const astar = flock.route(at(flock, a), at(flock, b), { lambda })!;
          const dijkstra = flock.route(at(flock, a), at(flock, b), { lambda, heuristic: false })!;
          assert.ok(Math.abs(astar.cost - dijkstra.cost) < 1e-9, `${a}->${b} at lambda ${lambda}`);
        }
      }
    }
  });
});
