import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { verifyPack } from "../src/verify.ts";
import { DATA, FIXTURES, hasDallas, readArrayBuffer } from "./helpers.ts";

// The grid is 5 x 5 intersections 200 m apart: sample trips have to be short.
const GRID = { trips: 20, minTripM: 150, maxTripM: 2_000, minEdges: 10 };

/** A copy of a pack with one float32 section scaled (edge_time, say). */
function scaled(buf: ArrayBuffer, section: string, factor: number): ArrayBuffer {
  const copy = buf.slice(0);
  const headerLen = new DataView(copy).getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(copy, 12, headerLen)));
  const s = meta.sections.find((x: { name: string }) => x.name === section);
  const values = new Float32Array(copy, 12 + headerLen + s.offset, s.length);
  for (let i = 0; i < values.length; i++) values[i] *= factor;
  return copy;
}

describe("verifyPack", () => {
  const grid = readArrayBuffer(`${FIXTURES}grid.fwr`);

  it("passes a pack that matches the live one, and measures no change", () => {
    const v = verifyPack(grid, grid, { limits: GRID });
    assert.equal(v.ok, true, v.reasons.join("; "));
    assert.equal(v.changed, 0);
    assert.equal(v.edgeRatio, 1);
    assert.equal(v.trips.medianRatio, 1);
    assert.ok(v.trips.tried > 0 && v.trips.routedNew === v.trips.tried && v.trips.routedOld === v.trips.tried);
  });

  it("holds back a pack whose trips suddenly take twice as long", () => {
    const v = verifyPack(scaled(grid, "edge_time", 2), grid, { limits: GRID });
    assert.equal(v.ok, false);
    // Not quite +100%: the turn costs in each trip stay the same.
    assert.match(v.reasons.join(" "), /sample trips take \+9\d% as long/);
    assert.ok(v.changed! > 0.99, `changed ${v.changed}`);
  });

  it("measures a small change as a small share", () => {
    const v = verifyPack(scaled(grid, "edge_time", 1.04), grid, { limits: GRID });
    assert.equal(v.ok, true, v.reasons.join("; ")); // 4% slower everywhere is within the limits
    assert.ok(v.changed! > 0.9); // ...but every edge's time differs
  });

  it("checks a new area on its own when there's no live pack", () => {
    const v = verifyPack(grid, null, { limits: GRID });
    assert.equal(v.ok, true, v.reasons.join("; "));
    assert.equal(v.old, null);
    assert.equal(v.changed, null);
  });

  it("fails a pack that doesn't decode", () => {
    const v = verifyPack(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer, grid, { limits: GRID });
    assert.equal(v.ok, false);
    assert.match(v.reasons[0], /doesn't load/);
  });

  it("fails a pack that lost most of its roads", () => {
    const v = verifyPack(grid, grid, { limits: { ...GRID, minEdges: 1_000 } });
    assert.equal(v.ok, false);
    assert.match(v.reasons.join(" "), /only \d+ road edges/);
  });

  it("passes Dallas against itself", { skip: !hasDallas && "needs data/packs/dallas.fwr" }, () => {
    const dallas = readArrayBuffer(`${DATA}packs/dallas.fwr`);
    const v = verifyPack(dallas, dallas);
    assert.equal(v.ok, true, v.reasons.join("; "));
    assert.equal(v.trips.tried, 40);
    assert.equal(v.changed, 0);
  });
});
