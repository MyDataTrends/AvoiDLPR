// Summarise coverage + direction quality across downloaded DeFlock region tiles.
// Usage: node analyze.mjs   (reads regions/*.json)
import { readFile, readdir } from "node:fs/promises";

const byId = new Map();
for (const f of await readdir("regions")) {
  const arr = JSON.parse(await readFile(`regions/${f}`, "utf8"));
  if (!Array.isArray(arr)) continue;
  for (const e of arr) byId.set(e.id, e);
}
// Contiguous US + AK/HI rough bounds, to drop Canada/Mexico spill-over from 20° tiles.
const inUS = (e) =>
  (e.lat >= 24.4 && e.lat <= 49.5 && e.lon >= -125 && e.lon <= -66.9) ||
  (e.lat >= 51 && e.lat <= 72 && e.lon >= -170 && e.lon <= -129) ||
  (e.lat >= 18.8 && e.lat <= 22.3 && e.lon >= -160.5 && e.lon <= -154.7);
const all = [...byId.values()].filter(inUS);
const n = all.length;
const pct = (x) => `${String(x).padStart(7)} (${((100 * x) / n).toFixed(1)}%)`;

const COMPASS = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };

// Parse an OSM direction value into list of bearings (degrees), or a reason it's unusable.
function parseDirection(raw) {
  if (raw == null || raw === "") return { kind: "missing" };
  const v = String(raw).trim();
  if (/^(fixed|ptz|dome|panning|unknown|yes|no)$/i.test(v)) return { kind: "non-bearing", v };
  const parts = v.split(";").map((s) => s.trim());
  const bearings = [];
  for (const p of parts) {
    if (/^-?\d+(\.\d+)?$/.test(p)) {
      const d = Number(p);
      if (d < 0 || d > 360) return { kind: "out-of-range", v };
      bearings.push(d % 360);
    } else if (/^\d+(\.\d+)?-\d+(\.\d+)?$/.test(p)) {
      const [a, b] = p.split("-").map(Number);
      if (a > 360 || b > 360) return { kind: "out-of-range", v };
      bearings.push(a % 360); // range start; cone handling is a later concern
    } else if (COMPASS[p.toUpperCase()] != null) {
      bearings.push(COMPASS[p.toUpperCase()]);
    } else return { kind: "unparseable", v };
  }
  return { kind: bearings.length > 1 ? "multi" : "ok", bearings };
}

const tally = (fn) => {
  const m = new Map();
  for (const e of all) m.set(fn(e), (m.get(fn(e)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

console.log(`US nodes (deduped): ${n}   [raw merged: ${byId.size}]\n`);

console.log("direction quality:");
const dq = tally((e) => parseDirection(e.tags?.direction).kind);
for (const [k, v] of dq) console.log(`  ${k.padEnd(14)}${pct(v)}`);
const usable = dq.filter(([k]) => k === "ok" || k === "multi").reduce((a, [, v]) => a + v, 0);
console.log(`  => usable bearing  ${pct(usable)}`);

console.log("\nunusable direction samples:");
const bad = new Map();
for (const e of all) {
  const p = parseDirection(e.tags?.direction);
  if (!["ok", "multi", "missing"].includes(p.kind)) bad.set(p.v, (bad.get(p.v) ?? 0) + 1);
}
for (const [k, v] of [...bad.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(v).padStart(5)}  ${k}`);

const brandOf = (e) => e.tags?.manufacturer ?? e.tags?.brand ?? "(none)";
console.log("\nmanufacturer/brand top 10:");
for (const [k, v] of tally(brandOf).slice(0, 10)) console.log(`  ${String(v).padStart(6)}  ${k}`);

console.log("\ntop operators:");
for (const [k, v] of tally((e) => e.tags?.operator ?? "(none)").slice(0, 8)) console.log(`  ${String(v).padStart(6)}  ${k}`);

// Density: nodes within 1° x 1° cells — shows where coverage is dense/thin.
const cells = new Map();
for (const e of all) {
  const k = `${Math.floor(e.lat)},${Math.floor(e.lon)}`;
  cells.set(k, (cells.get(k) ?? 0) + 1);
}
const topCells = [...cells.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(`\n1°x1° cells with data: ${cells.size}; densest:`);
for (const [k, v] of topCells) console.log(`  ${String(v).padStart(6)}  cell ${k}`);

// Near-duplicates: nodes within ~15 m of each other (probable double-mapping or multi-camera poles).
const grid = new Map();
const key = (la, lo) => `${Math.round(la * 5000)},${Math.round(lo * 5000)}`; // ~22 m cells
for (const e of all) {
  const k = key(e.lat, e.lon);
  (grid.get(k) ?? grid.set(k, []).get(k)).push(e);
}
let clusters = 0, inClusters = 0;
for (const v of grid.values()) if (v.length > 1) { clusters++; inClusters += v.length; }
console.log(`\n~22 m cells holding >1 node: ${clusters} (${inClusters} nodes) — poles with multiple cameras or dupes`);
