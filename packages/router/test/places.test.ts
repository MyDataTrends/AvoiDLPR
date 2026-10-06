import assert from "node:assert/strict";
import { test } from "node:test";

import { decodePlaces, metresBetween, parseCoordinates, PlaceSearch, words } from "../src/places.ts";
import { FIXTURES, GRID_NODES, readArrayBuffer } from "./helpers.ts";

// The town fixture (pipeline/fixtures.py, town_osm) sits on the grid: Gridville around it, with
// Main Street along row 2, and Eastville 5 km east with a Main Street of its own.
const index = decodePlaces(readArrayBuffer(`${FIXTURES}town.fwp`));
const search = new PlaceSearch(index);
const GRIDVILLE = GRID_NODES[13]; // row 2, column 2: the middle of the grid
const BLOCK_LON = GRID_NODES[14][0] - GRID_NODES[13][0];
const EASTVILLE: [number, number] = [GRIDVILLE[0] + 26 * BLOCK_LON, GRIDVILLE[1]];

const names = (q: string, near: [number, number] = GRIDVILLE) => search.search(q, { near }).map((r) => `${r.name} | ${r.detail}`);

test("the index decodes with what the pipeline put in", () => {
  assert.equal(index.meta.format, "avoidlpr-places");
  assert.deepEqual(index.meta.counts, { streets: 6, addresses: 15, places: 11 });
  assert.equal(index.addrLon.length, 15);
  assert.equal(index.strings.includes("Bean There"), true);
});

test("words drop case, accents and apostrophes", () => {
  assert.deepEqual(words("Café  Olé, McDonald's & Co."), ["cafe", "ole", "mcdonalds", "and", "co"]);
  assert.deepEqual(words("N. Oak Ave."), ["n", "oak", "ave"]);
});

test("streets: words in any order, whole or begun, abbreviations either way", () => {
  for (const q of ["main street", "Main St", "st main", "mai", "MAIN"]) {
    assert.equal(names(q)[0], "Main Street | Street · Gridville", q);
  }
  assert.equal(names("n oak ave")[0], "North Oak Avenue | Street · Gridville");
  assert.equal(names("north oak")[0], "North Oak Avenue | Street · Gridville");
});

test("the same name in two towns: the nearer first, the town tells them apart", () => {
  assert.deepEqual(names("main st").slice(0, 2), ["Main Street | Street · Gridville", "Main Street | Street · Eastville"]);
  assert.deepEqual(names("main st", EASTVILLE).slice(0, 2), ["Main Street | Street · Eastville", "Main Street | Street · Gridville"]);
  assert.deepEqual(names("bean there", EASTVILLE).slice(0, 2), ["Bean There | Restaurant · Eastville", "Bean There | Café · Gridville"]);
  assert.equal(names("main eastville")[0], "Main Street | Street · Eastville"); // a town word narrows it
});

test("a street result is the stretch of it nearest you", () => {
  const [r] = search.search("main street", { near: [GRID_NODES[15][0], GRID_NODES[15][1]] }); // east end
  const [mid] = search.search("main street", { near: [GRID_NODES[11][0], GRID_NODES[11][1]] }); // west end
  assert.ok(r.lon > mid.lon, "two points along Main Street, each at the end you're near");
});

test("house numbers: exact, with a letter, and placed between neighbours", () => {
  const [exact] = search.search("106 main st", { near: GRIDVILLE });
  assert.equal(exact.kind, "address");
  assert.equal(exact.name, "106 Main Street");
  assert.equal(exact.detail, "Gridville");
  assert.equal(exact.approximate, undefined);
  assert.equal(search.search("104b main", { near: GRIDVILLE })[0].name, "104B Main Street");
  assert.equal(search.search("104 main", { near: GRIDVILLE })[0].name, "104 Main Street"); // the plain one, not 104B

  // 108 isn't on the map: halfway between 106 and 110.
  const [guess] = search.search("108 main street", { near: GRIDVILLE });
  const [a106] = search.search("106 main street", { near: GRIDVILLE });
  const [a110] = search.search("110 main street", { near: GRIDVILLE });
  assert.equal(guess.name, "108 Main Street");
  assert.equal(guess.detail, "Approximate · Gridville");
  assert.equal(guess.approximate, true);
  assert.ok(Math.abs(guess.lon - (a106.lon + a110.lon) / 2) < 1e-6);

  // Eastville's Main Street has a 100 too: the near one comes first.
  assert.equal(search.search("100 main", { near: EASTVILLE })[0].detail, "Eastville");
  assert.equal(search.search("100 main", { near: GRIDVILLE })[0].detail, "Gridville");
  // Addresses written differently from the road are filed under it.
  assert.equal(search.search("9 north oak avenue", { near: GRIDVILLE })[0].name, "9 North Oak Avenue");
  assert.equal(search.search("1 elm", { near: GRIDVILLE })[0].name, "1 Elm Street");
  assert.equal(search.search("3 hidden ln", { near: GRIDVILLE })[0].name, "3 Hidden Lane");
});

test("a number the street has no neighbours for falls back to the street", () => {
  const [r] = search.search("999 mill road", { near: GRIDVILLE });
  assert.equal(r.kind, "street");
  assert.equal(r.name, "Mill Road");
});

test("places: by name, other names, brand, and kind", () => {
  assert.equal(names("grid grocer")[0], "Grid Grocer | Grocery store · Gridville");
  assert.equal(names("quiktrip")[0], "QT | Convenience store · Gridville"); // its brand
  assert.equal(names("grv")[0], "Gridville Regional Airport | Airport · Gridville"); // its airline code
  assert.equal(names("airport")[0], "Gridville Regional Airport | Airport · Gridville"); // the kind alone
  assert.equal(names("gas station")[0], "Shell | Gas station · Gridville");
  assert.equal(names("cafe")[0], "Bean There | Café · Gridville");
  assert.equal(names("mirror")[0], "Mirror Lake | Lake · Gridville");
  assert.equal(names("old town")[0], "Old Town | Neighborhood · Gridville");
  assert.deepEqual(names("memorial bench"), []); // not in the index
  assert.deepEqual(names("gridville").slice(0, 1), ["Gridville | Town"]); // the town, not everything in it
});

test("the whole name beats a longer one that starts the same", () => {
  assert.equal(names("gridville")[0], "Gridville | Town");
  assert.ok(names("gridville").includes("Gridville Regional Airport | Airport · Gridville"));
});

test("coordinates, either order", () => {
  const CHARLOTTE = [-81.27, 34.87, -80.5, 35.62] as const;
  assert.deepEqual(parseCoordinates("35.2271, -80.8431"), [-80.8431, 35.2271]);
  assert.deepEqual(parseCoordinates("35.2271,-80.8431", CHARLOTTE), [-80.8431, 35.2271]);
  assert.deepEqual(parseCoordinates("-80.8431 35.2271", CHARLOTTE), [-80.8431, 35.2271]); // only that order is here
  assert.deepEqual(parseCoordinates("-80.8431 35.2271"), [35.2271, -80.8431]); // latitude first, without a hint
  assert.deepEqual(parseCoordinates("-122.4 37.8"), [-122.4, 37.8]); // -122.4 can't be a latitude
  assert.equal(parseCoordinates("35.2, -80.8, 3"), null);
  assert.equal(parseCoordinates("123 main"), null);
  const [r] = search.search("32.78, -96.8");
  assert.equal(r.kind, "coordinates");
  assert.equal(r.name, "32.78000, -96.80000");
});

test("short or empty queries find nothing, and the limit holds", () => {
  assert.deepEqual(search.search(""), []);
  assert.deepEqual(search.search("m"), []);
  assert.ok(search.search("m", { limit: 3 }).length <= 3);
  assert.ok(search.search("gridville", { limit: 2 }).length === 2);
});

test("what's here: the address or place nearest a tap", () => {
  const [a106] = search.search("106 main street", { near: GRIDVILLE });
  const here = search.nearest(a106.lon + 0.00005, a106.lat);
  assert.equal(here?.name, "106 Main Street");
  assert.ok(here!.distanceM! < 10);
  const [cafe] = search.search("bean there", { near: GRIDVILLE });
  assert.equal(search.nearest(cafe.lon, cafe.lat + 0.0001)?.name, "Bean There"); // the place over a nearer number
  assert.equal(search.nearest(GRIDVILLE[0] + 0.02, GRIDVILLE[1] + 0.02), null); // nothing within 100 m
  assert.ok(metresBetween(cafe.lon, cafe.lat, cafe.lon, cafe.lat + 0.001) > 100);
});
