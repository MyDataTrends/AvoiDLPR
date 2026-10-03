import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type Camera, type HeadingMode, captures, headingMatches, LocalProjection, PROFILES, parseDirection,
  sectorDistance, wrap180,
} from "../src/geo.ts";
import { FIXTURES, readJson } from "./helpers.ts";

interface Reference {
  sector: [number, number, number, number, number, number][];
  captures: [keyof typeof PROFILES, HeadingMode, [number, number][], number, number, number, boolean][];
  directions: [string, [number, number][] | null][];
  profiles: Record<string, { range_m: number; half_angle: number; eps_m: number; heading_tol: number }>;
}
const ref = readJson<Reference>(`${FIXTURES}reference_cases.json`);

describe("parity with the Python reference (spike/routing/geometry.py)", () => {
  it("profiles match", () => {
    for (const [name, p] of Object.entries(PROFILES)) {
      const py = ref.profiles[name];
      assert.deepEqual([p.rangeM, p.halfAngle, p.epsM, p.headingTol],
        [py.range_m, py.half_angle, py.eps_m, py.heading_tol]);
    }
  });

  it(`parses all ${ref.directions.length} direction values identically`, () => {
    for (const [raw, expected] of ref.directions) assert.deepEqual(parseDirection(raw), expected, raw);
  });

  it(`sector distance matches on ${ref.sector.length} random points`, () => {
    for (const [px, py, bearing, half, range, expected] of ref.sector) {
      const got = sectorDistance(px, py, bearing, half, range);
      assert.ok(Math.abs(got - expected) <= 1e-9 * Math.max(1, expected), `${[px, py, bearing, half, range]}: ${got} vs ${expected}`);
    }
  });

  it(`captures matches on ${ref.captures.length} random cameras`, () => {
    for (const c of ref.captures) {
      const [profile, mode, sectors, x, y, heading, expected] = c;
      const cam: Camera = { osmId: 1, lon: 0, lat: 0, x: 0, y: 0, mode, sectors, brand: "" };
      assert.equal(captures(cam, x, y, heading, PROFILES[profile]), expected, JSON.stringify(c));
    }
  });
});

describe("geometry", () => {
  it("measures a north-facing sector by hand", () => {
    const d = (x: number, y: number) => sectorDistance(x, y, 0, 30, 50);
    assert.equal(d(0, 0), 0);
    assert.equal(d(0, 40), 0);
    assert.ok(Math.abs(d(0, 70) - 20) < 1e-12);
    assert.ok(Math.abs(d(0, -25) - 25) < 1e-12); // behind: the apex is nearest
    assert.ok(Math.abs(d(40, 0) - 40 * Math.sin(Math.PI / 3)) < 1e-12);
  });

  it("wraps angles like Python's modulo", () => {
    assert.equal(wrap180(190), -170);
    assert.equal(wrap180(-190), 170);
    assert.equal(wrap180(180), -180);
  });

  it("models Flock as one-directional and other brands along the axis", () => {
    assert.ok(headingMatches(10, 0, "rear", 45));
    assert.ok(!headingMatches(180, 0, "rear", 45));
    assert.ok(headingMatches(190, 0, "axis", 45));
    assert.ok(!headingMatches(90, 0, "axis", 45));
  });

  it("projects and inverts", () => {
    const p = new LocalProjection(32.78, -96.8);
    const lon = -96.7891, lat = 32.7712;
    assert.ok(Math.abs(p.lon(p.x(lon)) - lon) < 1e-12);
    assert.ok(Math.abs(p.lat(p.y(lat)) - lat) < 1e-12);
  });
});
