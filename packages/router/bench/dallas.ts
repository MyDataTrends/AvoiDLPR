// Benchmark the router on the Dallas pack with the spike's 300 trips.
// Run: npm run bench   (needs data/ - see test/dallas.test.ts)
import { gzipSync } from "node:zlib";

import type { CameraRecord } from "../src/geo.ts";
import { decodePack } from "../src/pack.ts";
import { type Route, Router } from "../src/router.ts";
import { DATA, readArrayBuffer, readJson } from "../test/helpers.ts";

const ms = (t0: number) => performance.now() - t0;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const fmt = (x: number, d = 1) => x.toFixed(d);

const raw = readArrayBuffer(`${DATA}packs/dallas.fwr`);
const records = readJson<{ cameras: CameraRecord[] }>(`${DATA}packs/dallas.cameras.json`).cameras;
const trips = readJson<{ trips: number[][] }>(`${DATA}fixtures/dallas_trips.json`).trips;

let t = performance.now();
const pack = decodePack(raw);
const tDecode = ms(t);
t = performance.now();
const router = new Router(pack, records);
const tRouter = ms(t);
t = performance.now();
router.setCameras(records);
const tExposure = ms(t);
const sites = router.cameras.siteCameras.length;
console.log(`pack: ${fmt(raw.byteLength / 1e6)} MB raw, ${fmt(gzipSync(new Uint8Array(raw), { level: 9 }).length / 1e6)} MB gzip; `
  + `${pack.nNodes.toLocaleString()} nodes, ${pack.nEdges.toLocaleString()} edges, ${pack.banned.size} banned turns`);
console.log(`load: decode ${fmt(tDecode, 0)} ms, + grid/cameras/exposure ${fmt(tRouter, 0)} ms; `
  + `re-run exposure for ${records.length} cameras / ${sites} sites: ${fmt(tExposure, 0)} ms`);

const ends = trips.map(([a, b, c, d]) => [router.snap(a, b)!, router.snap(c, d)!] as const);

function sweep(lambda: number) {
  const times: number[] = [], expanded: number[] = [], routes: Route[] = [];
  for (const [a, b] of ends) {
    const t0 = performance.now();
    routes.push(router.route(a, b, { lambda })!);
    times.push(ms(t0));
    expanded.push(router.lastExpanded);
  }
  return { times, expanded, routes };
}

const base = sweep(0);
console.log("\nlambda  query ms (p50 / p90)  expanded p50   minutes  km     turns  sites  capture-free  extra time");
for (const lambda of [0, 30, 60, 120, 300, 900]) {
  const s = lambda === 0 ? base : sweep(lambda);
  const extra = s.routes.map((r, i) => r.timeS / base.routes[i].timeS - 1);
  console.log(`${String(lambda).padStart(6)}  ${fmt(pct(s.times, 0.5)).padStart(8)} / ${fmt(pct(s.times, 0.9)).padEnd(10)}`
    + `${String(pct(s.expanded, 0.5)).padStart(10)}     ${fmt(mean(s.routes.map((r) => r.timeS / 60))).padStart(6)}  `
    + `${fmt(mean(s.routes.map((r) => r.distanceM / 1000))).padStart(5)}  ${fmt(mean(s.routes.map((r) => r.turns))).padStart(5)}  `
    + `${fmt(mean(s.routes.map((r) => r.sites.length)), 2).padStart(5)}  ${fmt(100 * mean(s.routes.map((r) => +(r.sites.length === 0))), 0).padStart(8)}%   `
    + `${fmt(100 * mean(extra))}%`);
}

console.log("\nbudget  query ms (p50 / p90)  probes  sites  cut vs fastest  capture-free  extra time");
const fastestSites = mean(base.routes.map((r) => r.sites.length));
for (const maxExtra of [0.05, 0.1, 0.2]) {
  const times: number[] = [], probes: number[] = [], chosen: Route[] = [], extra: number[] = [];
  for (const [a, b] of ends) {
    const t0 = performance.now();
    const res = router.routeWithinBudget(a, b, { maxExtra })!;
    times.push(ms(t0));
    probes.push(res.probes);
    chosen.push(res.chosen);
    extra.push(res.chosen.timeS / res.fastest.timeS - 1);
  }
  const s = mean(chosen.map((r) => r.sites.length));
  console.log(`  +${String(100 * maxExtra).padEnd(3)}%  ${fmt(pct(times, 0.5)).padStart(8)} / ${fmt(pct(times, 0.9)).padEnd(10)}`
    + `${fmt(mean(probes)).padStart(6)}  ${fmt(s, 2).padStart(5)}  ${fmt(100 * (1 - s / fastestSites), 0).padStart(10)}%  `
    + `${fmt(100 * mean(chosen.map((r) => +(r.sites.length === 0))), 0).padStart(10)}%  ${fmt(100 * mean(extra)).padStart(8)}%`);
}

{
  const times: number[] = [], probes: number[] = [], counts: number[] = [], rec: number[] = [], budget: number[] = [];
  const histogram = new Map<number, number>();
  let worse = 0;
  for (const [a, b] of ends) {
    const t0 = performance.now();
    const alt = router.routeAlternatives(a, b)!;
    times.push(ms(t0));
    probes.push(alt.probes);
    counts.push(alt.routes.length);
    histogram.set(alt.routes.length, (histogram.get(alt.routes.length) ?? 0) + 1);
    rec.push(alt.routes[alt.recommended].sites.length);
    const best = router.routeWithinBudget(a, b, { maxExtra: 0.1 })!.chosen.sites.length;
    budget.push(best);
    if (alt.routes[alt.recommended].sites.length > best) worse++;
  }
  console.log(`\nalternatives: query ms p50 ${fmt(pct(times, 0.5))} / p90 ${fmt(pct(times, 0.9))}, `
    + `${fmt(mean(probes))} searches on average; options per trip: `
    + [...histogram].sort((x, y) => x[0] - y[0]).map(([n, c]) => `${n}: ${c}`).join(", "));
  console.log(`  recommended option: ${fmt(mean(rec), 2)} sites per trip vs ${fmt(mean(budget), 2)} for routeWithinBudget(+10%); `
    + `worse on ${worse} of ${ends.length} trips`);
}

const dij: number[] = [], ast: number[] = [];
for (const [a, b] of ends.slice(0, 50)) {
  let t0 = performance.now();
  router.route(a, b, { lambda: 60, heuristic: false });
  dij.push(ms(t0));
  t0 = performance.now();
  router.route(a, b, { lambda: 60 });
  ast.push(ms(t0));
}
console.log(`\nA* vs Dijkstra (lambda 60, 50 trips): p50 ${fmt(pct(ast, 0.5))} vs ${fmt(pct(dij, 0.5))} ms`);
const mem = process.memoryUsage();
console.log(`memory: heap ${fmt(mem.heapUsed / 1e6, 0)} MB, array buffers ${fmt(mem.arrayBuffers / 1e6, 0)} MB`);
