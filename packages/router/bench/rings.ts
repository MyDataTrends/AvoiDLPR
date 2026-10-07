// Route options across Dallas with and without rings: what the ring costs in search time.
//   node --experimental-strip-types packages/router/bench/rings.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PROFILES, RINGS } from "../src/geo.ts";
import { Router } from "../src/router.ts";

const DATA = fileURLToPath(new URL("../../../data/packs/", import.meta.url));
const buf = readFileSync(`${DATA}dallas.fwr`);
const pack = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
const records = JSON.parse(readFileSync(`${DATA}dallas.cameras.json`, "utf8")).cameras;

const TRIPS: [[number, number], [number, number]][] = [
  [[-96.85692, 32.73077], [-96.66394, 32.85072]], // the app's example: Oak Cliff to Lake Highlands
  [[-96.797, 32.7767], [-96.7698, 32.7787]], // downtown, short
  [[-96.95, 32.9], [-96.62, 32.68]], // diagonal across the area
];

for (const ring of [null, RINGS.default]) {
  let t0 = performance.now();
  const router = Router.fromBuffer(pack, records, { params: PROFILES.default, ring });
  const loadMs = performance.now() - t0;
  const out: string[] = [];
  for (const [a, b] of TRIPS) {
    const from = router.snap(...a)!, to = router.snap(...b)!;
    router.routeAlternatives(from, to); // warm up
    t0 = performance.now();
    const res = router.routeAlternatives(from, to)!;
    out.push(`${(performance.now() - t0).toFixed(0)} ms (${res.probes} probes, ${res.routes.map((r) => `${Math.round(r.timeS / 60)}m/${r.sites.length}z/${r.near.length}n`).join(" ")})`);
  }
  console.log(`${ring ? "ring   " : "no ring"}  load ${loadMs.toFixed(0)} ms  |  ${out.join("  |  ")}`);
}
