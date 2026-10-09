import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeStep, formatRef, parseLabel, type Step } from "../src/guidance.ts";
import { Router } from "../src/router.ts";
import { FIXTURES, readArrayBuffer, readJson } from "./helpers.ts";

// pipeline/fixtures.py, guide_osm: Main Street east into Commerce Street, Oak Avenue into Curvy
// Lane, a fork, I 35E with a ramp on and one off (to Downtown), and a roundabout on Back Road.
const NODES = readJson<{ nodes: Record<string, [number, number]> }>(`${FIXTURES}guide.json`).nodes;
const PACK = readArrayBuffer(`${FIXTURES}guide.fwr`);

function router(pack = PACK): Router {
  return Router.fromBuffer(pack, []);
}

function point(p: number | [number, number, number]): [number, number] {
  if (typeof p === "number") return NODES[p];
  const [a, b, t] = p; // t of the way from node a to node b
  return [NODES[a][0] + t * (NODES[b][0] - NODES[a][0]), NODES[a][1] + t * (NODES[b][1] - NODES[a][1])];
}

function steps(from: number | [number, number, number], to: number | [number, number, number], r = router()): Step[] {
  const a = r.snap(...point(from), 5), b = r.snap(...point(to), 5);
  assert.ok(a && b);
  const route = r.route(a, b);
  assert.ok(route);
  return route.steps;
}

const said = (s: Step[]) => s.map((x) => describeStep(x));

describe("turn-by-turn directions", () => {
  it("turns at an intersection, and says nothing going straight through one on the same street", () => {
    const s = steps(1, 5);
    assert.deepEqual(said(s), ["Head east on Main Street", "Turn right onto Oak Avenue", "Arrive at your destination"]);
    assert.equal(Math.round(s[1].atM), 200);
    assert.equal(s[1].direction, "right");
    assert.deepEqual(s[1].at.map((v) => v.toFixed(6)), NODES[2].map((v) => v.toFixed(6)));
    assert.equal(Math.round(s[2].atM), 400);
  });

  it("says when the street's name changes at an intersection", () => {
    assert.deepEqual(said(steps(1, 4)), ["Head east on Main Street", "Continue onto Commerce Street", "Arrive at your destination"]);
  });

  it("takes a slip lane as one turn, and says nothing passing one", () => {
    assert.deepEqual(said(steps(1, 7)), ["Head east on Main Street", "Turn right onto Pine Street", "Arrive at your destination"]);
    assert.ok(steps(1, 7)[1].at[0] < NODES[3][0] - 0.0002); // said where the slip lane starts, short of the corner
  });

  it("says nothing where the road bends or changes name with nowhere else to go", () => {
    assert.deepEqual(said(steps(5, 12)), ["Head north on Oak Avenue", "Arrive at your destination"]);
  });

  it("keeps left or right where the road forks", () => {
    assert.deepEqual(said(steps(1, 14)).slice(1, 3), ["Continue onto Commerce Street", "Keep left onto Left Branch"]);
    assert.equal(said(steps(1, 15))[2], "Keep right onto Right Branch");
  });

  it("takes the ramp, merges, exits toward its sign and turns off the ramp", () => {
    const s = steps([13, 15, 0.5], 25);
    assert.deepEqual(said(s), [
      "Head east on Right Branch",
      "Take the ramp on the right to I-35E",
      "Merge onto I-35E",
      "Take the exit on the right toward Downtown",
      "Turn right onto Exit Street",
      "Arrive at your destination",
    ]);
    assert.deepEqual(s.map((x) => x.type), ["depart", "ramp", "merge", "exit", "turn", "arrive"]);
    assert.equal(s[3].toward, "Downtown");
  });

  it("calls a ramp's sharp join with the highway a turn, not a merge", () => {
    assert.equal(said(steps([13, 15, 0.5], 19))[2], "Turn sharp right onto I-35E");
  });

  it("counts a roundabout's exits", () => {
    assert.deepEqual(said(steps(25, 33)), [
      "Head south on Back Road", "At the roundabout, take the second exit onto Back Road", "Arrive at your destination",
    ]);
    assert.equal(said(steps(25, 32))[1], "At the roundabout, take the third exit onto Circle East");
    assert.equal(said(steps(25, 31))[1], "At the roundabout, take the first exit onto Circle West");
  });

  it("puts every step in route order, ending where the route does", () => {
    const r = router();
    const route = r.route(r.snap(...point(1), 5)!, r.snap(...point(33), 5)!)!;
    const at = route.steps.map((s) => s.atM);
    assert.deepEqual(at, [...at].sort((x, y) => x - y));
    assert.equal(route.steps.at(-1)!.atM, route.distanceM);
    assert.equal(route.steps[0].type, "depart");
  });

  it("gives the same maneuvers, unnamed, from a pack built before road labels", () => {
    const s = steps([13, 15, 0.5], 25, router(withoutSections(PACK, ["labels", "geom_label", "geom_flags"])));
    assert.deepEqual(said(s), [
      "Head east", "Take the ramp on the right", "Merge", "Take the exit on the right", "Turn right",
      "Arrive at your destination",
    ]);
  });

  it("phrases each kind of step", () => {
    const base: Step = { type: "turn", direction: "left", atM: 0, at: [0, 0], road: "", toward: "", exit: 0, stay: false, heading: 0 };
    assert.equal(describeStep({ ...base, direction: "sharp right", road: "Elm Street" }), "Turn sharp right onto Elm Street");
    assert.equal(describeStep({ ...base, direction: "slight left", road: "Main Street", stay: true }),
      "Turn slight left to stay on Main Street");
    assert.equal(describeStep({ ...base, type: "fork", direction: "slight right", road: "I-30", stay: true }),
      "Keep right to stay on I-30");
    assert.equal(describeStep({ ...base, type: "fork", direction: "slight left", toward: "Fort Worth" }), "Keep left toward Fort Worth");
    assert.equal(describeStep({ ...base, type: "uturn" }), "Make a U-turn");
    assert.equal(describeStep({ ...base, type: "roundabout" }), "Enter the roundabout");
    assert.equal(describeStep({ ...base, type: "depart", heading: 359 }), "Head north");
    assert.equal(describeStep({ ...base, type: "arrive" }, "Bean There"), "Arrive at Bean There");
  });

  it("writes route numbers the way signs do", () => {
    assert.equal(formatRef("I 35E;US 77"), "I-35E/US-77");
    assert.equal(formatRef("TX 289"), "TX 289");
    assert.deepEqual(parseLabel("Central Expressway\x1fUS 75\x1fDowntown;Plano"),
      { name: "Central Expressway", ref: "US-75", toward: "Downtown, Plano" });
    assert.deepEqual(parseLabel(""), { name: "", ref: "", toward: "" });
  });
});

/** A copy of a road pack whose header no longer lists these sections (the bytes stay, unused). */
function withoutSections(buf: ArrayBuffer, names: string[]): ArrayBuffer {
  const view = new DataView(buf);
  const headerLen = view.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, headerLen)));
  const oldBase = 12 + headerLen;
  meta.sections = meta.sections.filter((s: { name: string }) => !names.includes(s.name));
  let header = new TextEncoder().encode(JSON.stringify(meta));
  // Keep the data where it was relative to the header's end, which stays 8-aligned.
  const pad = (8 - ((12 + header.length) % 8)) % 8;
  header = new Uint8Array([...header, ...new Array(pad).fill(32)]);
  const out = new Uint8Array(12 + header.length + (buf.byteLength - oldBase));
  out.set(new Uint8Array(buf, 0, 12));
  new DataView(out.buffer).setUint32(8, header.length, true);
  out.set(header, 12);
  out.set(new Uint8Array(buf, oldBase), 12 + header.length);
  return out.buffer;
}
