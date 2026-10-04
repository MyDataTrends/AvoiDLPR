import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

import { LocalProjection } from "@flockwatch/router";
import { type LngLat, LngLatBounds, Marker, Popup } from "maplibre-gl";

import { dataUrl, loadManifest, pickRegion } from "./data.ts";
import { type Fix, Polyline } from "./drive.ts";
import { cameraZones, distance, duration, extraTime, gapTime, siteTitle, watches } from "./format.ts";
import { insideBox, LocateError, locate } from "./location.ts";
import { type CameraState, createMap, Overlays } from "./map.ts";
import type { CameraDTO, LonLat, ProfileName, Request, Response, RouteDTO, SiteDTO, Stats } from "./protocol.ts";
import { Sheet } from "./sheet.ts";

const PROFILE_NAMES: ProfileName[] = ["strict", "default", "loose"];
const ALERT_AHEAD_M = 400;
/** A zone takes ~5 s to cross at city speed but a blink at 32x playback: keep the alert up. */
const MIN_ZONE_BANNER_MS = 1500;
/** Tap tolerance (px) for picking another route off the map. */
const ROUTE_TAP_SLOP_PX = 12;
/** The router's cap on how much slower than the fastest an option may be. */
const MAX_EXTRA_PERCENT = 50;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------- boot: what data exists, and which region to show ----------

function showBootFailure(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const text = `FlockWatch couldn't load its map data. ${message}`;
  $("summary").textContent = "Couldn't load map data";
  $("status").textContent = text;
  $("notice").textContent = text;
  $("notice").hidden = false;
  throw err;
}

const manifest = await loadManifest().catch(showBootFailure);
const region = pickRegion(manifest, new URLSearchParams(location.hash.slice(1)).get("r"));
/** Names of every region covered, for messages ("Dallas and Austin"). */
const coveredAreas = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(manifest.regions.map((r) => r.name));
document.title = `FlockWatch · ${region.name}`;
$("lede").textContent = `Routes around license-plate cameras in ${region.name}. Everything is computed in this tab: your start and destination never leave it.`;
$("example").hidden = !region.example;

type Stop = "from" | "to";

interface Drive {
  line: Polyline;
  route: RouteDTO;
  t0: number;
  speed: number;
  raf: number;
  lastQuery: number;
  queryId: number;
  /** Sites the worker's live check says hold the car (position + heading). */
  inZone: number[];
  /** What the zone banner shows, and until when (performance.now()). */
  zone: string;
  zoneUntil: number;
  /** Route distance at the previous frame: zones are tested against the whole stretch since. */
  lastDistM: number;
}

const state = {
  stats: null as Stats | null,
  cameras: [] as CameraDTO[],
  zoneRangeM: 50,
  from: null as LonLat | null,
  /** Set when `from` came from the device's GPS (it then has an accuracy and no URL entry). */
  fromGps: null as { accuracyM: number } | null,
  to: null as LonLat | null,
  /** Which end the next map tap sets. */
  target: "from" as Stop,
  profile: "default" as ProfileName,
  routes: null as RouteDTO[] | null,
  recommended: 0,
  selected: 0,
  info: null as { ms: number; probes: number } | null,
  routing: false,
  routeId: 0,
  /** Zoom to the next set of routes (a new trip), not to a recomputation of the same one. */
  fitNext: false,
  notice: null as string | null,
  drive: null as Drive | null,
  sheetBeforeDrive: null as "peek" | "half" | "full" | null,
};

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const send = (msg: Request) => worker.postMessage(msg);
const map = createMap($("mapwrap").querySelector("#map")!, region.bbox, {
  pmtiles: dataUrl(region.basemap.path),
  glyphs: dataUrl(manifest.assets.glyphs),
  sprite: dataUrl(manifest.assets.sprite),
});
let overlays: Overlays | null = null;
// When the camera moves on, MapLibre cancels the tile requests it no longer needs, and some browsers
// report a cancelled fetch as "Failed to fetch". Those aren't failures: ignore errors that arrive
// while the map is moving or just after it stopped, and report everything else.
let lastMoveMs = 0;
map.on("movestart", () => void (lastMoveMs = Infinity));
map.on("moveend", () => void (lastMoveMs = performance.now()));
map.on("error", (e) => {
  const error = e.error as Error | undefined;
  const cancelled = error?.name === "AbortError" || /failed to fetch|aborted/i.test(error?.message ?? "");
  if (cancelled && (lastMoveMs === Infinity || performance.now() - lastMoveMs < 2000)) return;
  console.error(error ?? e);
});

/** Height of the bottom sheet in pixels once settled (0 when the panel is a sidebar). */
let sheetPx = 0;
const sheet = new Sheet($("panel"), $("sheetHead"), $("handle"), (px) => {
  sheetPx = px;
  syncMapPadding(true);
});
// Dev-only handle for poking at the page from the console and browser tests.
if (import.meta.env.DEV) Object.assign(window, { __fw: { map, state, sheet } });

const markers = {
  from: pinMarker("#2f9e44", "from"),
  to: pinMarker("#212529", "to"),
  gps: new Marker({ element: gpsDot() }),
};

function pinMarker(color: string, which: Stop): Marker {
  const m = new Marker({ color, draggable: true });
  m.on("dragend", () => {
    const { lng, lat } = m.getLngLat();
    setStops({ [which]: [lng, lat] });
  });
  return m;
}

function gpsDot(): HTMLElement {
  const el = document.createElement("div");
  el.className = "gps-dot";
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", "Your location");
  return el;
}

// ---------- state changes ----------

/** Change either or both ends of the trip. Locations from GPS carry their accuracy. */
function setStops(p: { from?: LonLat | null; to?: LonLat | null; gps?: { accuracyM: number } | null }): void {
  if ("from" in p) {
    state.from = p.from ?? null;
    state.fromGps = p.from ? (p.gps ?? null) : null;
  }
  if ("to" in p) state.to = p.to ?? null;
  state.target = state.from ? "to" : "from";
  state.fitNext = Boolean(state.from && state.to);
  state.notice = null;
  writeHash();
  requestRoute();
}

function requestRoute(): void {
  stopDrive();
  state.routes = null;
  state.info = null;
  state.routing = Boolean(state.from && state.to && state.stats);
  if (state.routing) send({ type: "route", id: ++state.routeId, from: state.from!, to: state.to! });
  render();
}

worker.onmessage = (ev: MessageEvent<Response>) => {
  const msg = ev.data;
  if (msg.type === "ready") {
    state.stats = msg.stats;
    state.cameras = msg.cameras;
    state.zoneRangeM = msg.zone.rangeM;
    const s = msg.stats;
    setStatus(`${s.nodes.toLocaleString()} intersections · ${s.cameras.toLocaleString()} cameras · `
      + `${s.packMB.toFixed(0)} MB network loaded in ${(s.loadMs / 1000).toFixed(1)} s`);
    requestRoute();
  } else if (msg.type === "route") {
    if (msg.id !== state.routeId) return;
    state.routes = msg.routes;
    state.recommended = msg.recommended;
    state.selected = msg.recommended;
    state.info = { ms: msg.ms, probes: msg.probes };
    state.routing = false;
    render();
    if (state.fitNext) fitRoutes();
  } else if (msg.type === "noroute") {
    if (msg.id !== state.routeId) return;
    state.routing = false;
    state.notice = msg.reason;
    render();
  } else if (msg.type === "capturing") {
    if (state.drive && msg.id === state.drive.queryId) state.drive.inZone = msg.sites;
  } else {
    state.routing = false;
    setStatus(`Error: ${msg.message}`);
  }
};

// ---------- rendering ----------

function selectedRoute(): RouteDTO | null {
  return state.routes?.[state.selected] ?? null;
}

const MID_COLORS = ["#7048e8", "#0c8599"];

/** Fastest is orange and fewest-cameras blue; options in between take other hues. */
function colorFor(i: number, n: number): string {
  if (i === 0) return "#d9480f";
  if (i === n - 1) return "#1c64f2";
  return MID_COLORS[(i - 1) % MID_COLORS.length];
}

function labelFor(i: number, n: number): string {
  if (i === 0) return "Fastest";
  if (i === n - 1) return "Fewest cameras";
  return n === 3 || i === 1 ? "Balanced" : "Fewer cameras";
}

function render(): void {
  const routes = state.routes;
  const route = selectedRoute();
  renderStops();
  renderOverlays();

  const notice = $("notice");
  notice.hidden = !state.notice;
  notice.textContent = state.notice;

  $("summary").textContent = summary();
  $("results").hidden = !(state.from && state.to);
  $<HTMLButtonElement>("drive").disabled = !route;
  if (!routes || !route) {
    $("options").replaceChildren();
    $("routeNote").textContent = state.routing ? "Finding routes…" : "";
    $("routeMeta").textContent = "";
    $("alerts").replaceChildren();
    return;
  }

  const fastest = routes[0];
  $("options").replaceChildren(...routes.map((r, i) => optionCard(r, i, routes.length, fastest)));
  const fs = fastest.sites.length, cs = route.sites.length;
  $("routeNote").textContent = routes.length === 1
    ? fs === 0
      ? "The fastest route already passes no camera zones."
      : `No route within ${MAX_EXTRA_PERCENT}% more time passes fewer than ${fs} camera zone${fs === 1 ? "" : "s"}.`
    : state.selected === 0
      ? "The quickest route. The other options trade time for fewer camera zones."
      : `Avoids ${fs - cs} of the fastest route's ${fs} camera zone${fs === 1 ? "" : "s"} for ${gapTime(route.timeS - fastest.timeS)} more.`;
  $("routeMeta").textContent = state.info
    ? `Routed on this device in ${state.info.ms.toFixed(0)} ms (${state.info.probes} search${state.info.probes === 1 ? "" : "es"}).`
    : "";

  const items = route.sites.map((s) => alertItem(s));
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No camera zones on this route.";
    items.push(li);
  }
  $("alerts").replaceChildren(...items);
}

function summary(): string {
  if (!state.stats) return "Loading the road network…";
  if (!state.from && !state.to) return "Tap the map to set a start, or use your location";
  if (!state.to) return "Tap the map to set your destination";
  if (!state.from) return "Tap the map to set your start";
  if (state.routing) return "Finding routes…";
  const route = selectedRoute();
  if (route && state.routes) {
    return `${duration(route.timeS)} · ${cameraZones(route.sites.length)} · ${labelFor(state.selected, state.routes.length)}`;
  }
  return "No route found";
}

function renderStops(): void {
  const place = (m: Marker, p: LonLat | null) => (p ? m.setLngLat(p).addTo(map) : m.remove());
  place(markers.from, state.from && !state.fromGps ? state.from : null);
  place(markers.gps, state.from && state.fromGps ? state.from : null);
  place(markers.to, state.to);
  overlays?.setAccuracy(state.from && state.fromGps ? { lon: state.from[0], lat: state.from[1], ...state.fromGps } : null);

  const text = (p: LonLat | null, empty: string) => (p ? `${p[1].toFixed(4)}, ${p[0].toFixed(4)}` : empty);
  $("fromText").textContent = state.fromGps
    ? `Your location · ±${Math.round(state.fromGps.accuracyM)} m`
    : text(state.from, state.target === "from" ? "Tap the map…" : "Choose a start");
  $("toText").textContent = text(state.to, state.target === "to" ? "Tap the map…" : "Choose a destination");
  $("targetFrom").setAttribute("aria-pressed", String(state.target === "from"));
  $("targetTo").setAttribute("aria-pressed", String(state.target === "to"));
}

function renderOverlays(): void {
  const routes = state.routes;
  const fastest = new Set(routes?.[0].sites.map((s) => s.site));
  const chosen = new Set(selectedRoute()?.sites.map((s) => s.site));
  const stateOf = (site: number): CameraState => (chosen.has(site) ? "route" : fastest.has(site) ? "avoided" : "");
  overlays?.setCameras(state.cameras, { rangeM: state.zoneRangeM }, stateOf);
  overlays?.setRoutes((routes ?? []).map((r, i) => ({
    coordinates: r.coordinates, color: colorFor(i, routes!.length), selected: i === state.selected, index: i,
  })));
}

function optionCard(r: RouteDTO, i: number, n: number, fastest: RouteDTO): HTMLButtonElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "option";
  card.setAttribute("aria-pressed", String(i === state.selected));
  card.style.setProperty("--route", colorFor(i, n));
  const parts: [string, string][] = [
    ["label", labelFor(i, n)],
    ["big", duration(r.timeS)],
    ["small", [i > 0 ? extraTime(r.timeS - fastest.timeS) : "", distance(r.distanceM), cameraZones(r.sites.length)]
      .filter(Boolean).join(" · ")],
  ];
  for (const [cls, text] of parts) {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    card.append(span);
  }
  if (n > 1 && i === state.recommended) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = "Recommended";
    chip.title = "Fewest cameras within 10% more time";
    card.querySelector(".label")!.append(chip);
  }
  card.addEventListener("click", () => selectRoute(i));
  return card;
}

/**
 * The unselected route whose line passes closest to a tap, if within the tap tolerance. Measured
 * in screen pixels against every segment, so where options share a road the nearest one wins.
 */
function nearestOtherRoute(tap: { x: number; y: number }): number | null {
  let bestIndex: number | null = null;
  let bestPx = ROUTE_TAP_SLOP_PX;
  for (const [index, r] of (state.routes ?? []).entries()) {
    if (index === state.selected) continue;
    let prev = map.project(r.coordinates[0]);
    for (let k = 1; k < r.coordinates.length; k++) {
      const p = map.project(r.coordinates[k]);
      const dx = p.x - prev.x, dy = p.y - prev.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((tap.x - prev.x) * dx + (tap.y - prev.y) * dy) / len2)) : 0;
      const px = Math.hypot(prev.x + t * dx - tap.x, prev.y + t * dy - tap.y);
      if (px <= bestPx) [bestIndex, bestPx] = [index, px];
      prev = p;
    }
  }
  return bestIndex;
}

function selectRoute(i: number): void {
  if (!state.routes || i === state.selected) return;
  stopDrive();
  state.selected = i;
  render();
}

function alertItem(site: SiteDTO): HTMLLIElement {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  const parts: [string, string][] = [["dist", distance(site.atM)], ["what", siteTitle(site)], ["how", watches(site.cameras[0])]];
  for (const [cls, text] of parts) {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    button.append(span);
  }
  button.addEventListener("click", () => {
    const c = site.cameras[0];
    if (sheet.isSheet) sheet.set("peek"); // get the sheet out of the way of what was asked for
    map.flyTo({ center: [c.lon, c.lat], zoom: 16.5 });
  });
  li.append(button);
  return li;
}

function setStatus(text: string): void {
  $("status").textContent = text;
}

function setBanner(kind: "zone" | "ahead" | "clear" | null, title = "", detail = ""): void {
  const b = $("banner");
  b.hidden = kind === null;
  if (!kind) return;
  b.className = `banner ${kind}`;
  b.querySelector("strong")!.textContent = title;
  b.querySelector("span")!.textContent = detail;
}

// ---------- camera framing ----------

/**
 * Pixels of the map that are covered (the bottom sheet, the alert banner). This is set as the
 * map's own padding, so every camera move (centre, zoom, fit) targets the visible part. Pass it
 * nowhere else: MapLibre keeps `padding` on the map, and padding handed to `fitBounds` stacks on
 * top of it.
 */
function viewPadding(): { top: number; left: number; right: number; bottom: number } {
  return { top: 56, left: 0, right: 0, bottom: Math.min(sheetPx, window.innerHeight * 0.55) };
}

function syncMapPadding(animate: boolean): void {
  if (animate) map.easeTo({ padding: viewPadding(), duration: 220 });
  else map.setPadding(viewPadding());
}

function fitRoutes(): void {
  state.fitNext = false;
  const all = state.routes?.flatMap((r) => r.coordinates);
  if (!all?.length) return;
  const bounds = all.reduce((b, c) => b.extend(c), new LngLatBounds(all[0], all[0]));
  map.fitBounds(bounds, { padding: 28, duration: 700, maxZoom: 16 });
}

// ---------- drive simulation ----------

function startDrive(): void {
  const route = selectedRoute();
  if (!route || !state.stats) return;
  const line = new Polyline(route.coordinates, new LocalProjection(state.stats.lat0, state.stats.lon0));
  state.drive = {
    line, route, t0: performance.now(), speed: Number($<HTMLSelectElement>("speed").value), raf: 0, lastQuery: 0,
    queryId: 0, inZone: [], zone: "", zoneUntil: 0, lastDistM: 0,
  };
  $("drive").textContent = "Stop";
  if (sheet.isSheet) {
    state.sheetBeforeDrive = sheet.state;
    sheet.set("peek");
  }
  map.easeTo({ center: route.coordinates[0], zoom: 15.5, duration: 700 });
  state.drive.raf = requestAnimationFrame(tick);
}

function tick(now: number): void {
  const d = state.drive;
  if (!d) return;
  const metresPerSecond = d.route.distanceM / d.route.timeS;
  const fix = d.line.at(((now - d.t0) / 1000) * d.speed * metresPerSecond);
  overlays?.setCar(fix);
  if (now - d.lastQuery > 120) {
    d.lastQuery = now;
    send({ type: "capturing", id: ++d.queryId, lon: fix.lon, lat: fix.lat, heading: fix.heading });
  }
  follow(fix);
  showDriveBanner(fix, d, now);
  if (fix.distM >= d.line.lengthM - 0.5) {
    const n = d.route.sites.length;
    stopDrive(`Arrived · passed ${cameraZones(n)}`);
    return;
  }
  d.raf = requestAnimationFrame(tick);
}

function showDriveBanner(fix: Fix, d: Drive, now: number): void {
  // Test each zone interval against the whole stretch driven since the last frame, so a slow
  // frame (or a sparse GPS fix) can't step over a zone. The worker's live check, the same
  // predicate a phone runs on each fix, backs it up.
  const onRoute = d.route.sites.find((s) => s.atM <= fix.distM && s.untilM >= d.lastDistM);
  d.lastDistM = fix.distM;
  const live = state.cameras.filter((c) => d.inZone.includes(c.site));
  if (onRoute || live.length) {
    const cameras = onRoute ? onRoute.cameras : live;
    d.zone = `${siteTitle({ site: -1, atM: 0, untilM: 0, cameras })} · ${watches(cameras[0])}`;
    d.zoneUntil = now + MIN_ZONE_BANNER_MS;
  }
  if (now < d.zoneUntil) {
    setBanner("zone", "In a camera zone", d.zone);
    return;
  }
  const next = d.route.sites.find((s) => s.atM > fix.distM);
  if (next && next.atM - fix.distM <= ALERT_AHEAD_M) {
    setBanner("ahead", `Camera ahead in ${distance(next.atM - fix.distM)}`, siteTitle(next));
  } else {
    setBanner("clear", "No cameras nearby", `${distance(d.line.lengthM - fix.distM)} to go`);
  }
}

function follow(fix: Fix): void {
  if (map.isMoving()) return;
  const p = map.project([fix.lon, fix.lat]);
  const pad = viewPadding();
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  const left = pad.left + (w - pad.left - pad.right) * 0.2, right = w - pad.right - (w - pad.left - pad.right) * 0.2;
  const top = pad.top + (h - pad.top - pad.bottom) * 0.2, bottom = h - pad.bottom - (h - pad.top - pad.bottom) * 0.2;
  if (p.x < left || p.x > right || p.y < top || p.y > bottom) {
    map.easeTo({ center: [fix.lon, fix.lat], duration: 600 });
  }
}

function stopDrive(message?: string): void {
  const d = state.drive;
  if (!d) return;
  cancelAnimationFrame(d.raf);
  state.drive = null;
  overlays?.setCar(null);
  $("drive").textContent = "Preview drive";
  if (state.sheetBeforeDrive && sheet.isSheet) sheet.set(state.sheetBeforeDrive);
  state.sheetBeforeDrive = null;
  if (!message) {
    setBanner(null);
    return;
  }
  setBanner("clear", message);
  setTimeout(() => {
    if (!state.drive) setBanner(null);
  }, 5000);
}

// ---------- current location ----------

let locating = false;

async function useMyLocation(): Promise<void> {
  if (locating) return;
  locating = true;
  for (const id of ["locate", "mapLocate"]) {
    $<HTMLButtonElement>(id).classList.add("busy");
    $(id).setAttribute("aria-busy", "true");
  }
  state.notice = "Finding your location…";
  render();
  try {
    const fix = await locate();
    if (state.stats && !insideBox(state.stats.bbox, fix.lon, fix.lat)) {
      state.notice = `You're outside the area FlockWatch covers (${coveredAreas}). Tap the map to pick a start inside it.`;
      render();
      return;
    }
    setStops({ from: [fix.lon, fix.lat], gps: { accuracyM: fix.accuracyM } });
    if (fix.accuracyM > 200) state.notice = `Your location is approximate (±${Math.round(fix.accuracyM)} m).`;
    render();
    if (!state.to) map.easeTo({ center: [fix.lon, fix.lat], zoom: Math.max(map.getZoom(), 14) });
  } catch (err) {
    state.notice = err instanceof LocateError ? err.message : "Couldn't get your location.";
    render();
  } finally {
    locating = false;
    for (const id of ["locate", "mapLocate"]) {
      $(id).classList.remove("busy");
      $(id).removeAttribute("aria-busy");
    }
  }
}

// ---------- camera popups ----------

function showCamera(c: CameraDTO, at: LngLat): void {
  const box = document.createElement("div");
  box.className = "camera-popup";
  const siteSize = state.cameras.filter((x) => x.site === c.site).length;
  const lines: [string, string][] = [["strong", c.brand || "Unknown brand"], ["span", watches(c)]];
  if (siteSize > 1) lines.push(["span", `Part of a ${siteSize}-camera site`]);
  for (const [tag, text] of lines) {
    const el = document.createElement(tag);
    el.textContent = text;
    box.append(el);
  }
  const link = document.createElement("a");
  link.href = `https://www.openstreetmap.org/node/${c.osmId}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "View or correct on OpenStreetMap";
  box.append(link);
  new Popup({ closeButton: true, maxWidth: "260px" }).setLngLat(at).setDOMContent(box).addTo(map);
}

// ---------- URL hash (never sent to a server) ----------

/** Pins and the zone model, never a GPS location: a shared link must not reveal where you are. */
function writeHash(): void {
  const p = new URLSearchParams();
  if (state.from && !state.fromGps) p.set("from", state.from.map((v) => v.toFixed(5)).join(","));
  if (state.to) p.set("to", state.to.map((v) => v.toFixed(5)).join(","));
  if (state.profile !== "default") p.set("model", state.profile);
  if (manifest.regions.length > 1) p.set("r", region.id);
  history.replaceState(null, "", p.size ? `#${p}` : location.pathname + location.search);
}

function readHash(): void {
  const p = new URLSearchParams(location.hash.slice(1));
  const point = (key: string): LonLat | null => {
    const v = p.get(key)?.split(",").map(Number);
    return v && v.length === 2 && v.every(Number.isFinite) ? [v[0], v[1]] : null;
  };
  const model = p.get("model") as ProfileName | null;
  if (model && PROFILE_NAMES.includes(model)) state.profile = model;
  $<HTMLSelectElement>("profile").value = state.profile;
  const from = point("from"), to = point("to");
  state.from = from;
  state.to = to;
  state.target = from ? "to" : "from";
  state.fitNext = Boolean(from && to);
}

// ---------- wiring ----------

map.on("load", () => {
  overlays = new Overlays(map);
  syncMapPadding(false);
  render();
});

map.on("click", (e) => {
  const camera = overlays?.cameraAt(e.point) ?? null;
  if (camera !== null) {
    showCamera(state.cameras[camera], e.lngLat);
    return;
  }
  const other = nearestOtherRoute(e.point);
  if (other !== null) {
    selectRoute(other);
    return;
  }
  setStops({ [state.target]: [e.lngLat.lng, e.lngLat.lat] });
});
for (const layer of ["fw-cameras", "fw-cameras-any", "fw-routes"]) {
  map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
}

$<HTMLSelectElement>("profile").addEventListener("change", (e) => {
  state.profile = (e.target as HTMLSelectElement).value as ProfileName;
  state.fitNext = false;
  writeHash();
  setStatus("Recomputing camera zones…");
  send({ type: "profile", profile: state.profile });
});
for (const stop of ["from", "to"] as const) {
  $(stop === "from" ? "targetFrom" : "targetTo").addEventListener("click", () => {
    state.target = stop;
    render();
    if (sheet.isSheet) sheet.set("peek"); // so the map is there to tap
  });
}
$("locate").addEventListener("click", () => void useMyLocation());
$("mapLocate").addEventListener("click", () => void useMyLocation());
$("swap").addEventListener("click", () => {
  if (state.from || state.to) setStops({ from: state.to, to: state.from });
});
$("example").addEventListener("click", () => {
  if (region.example) setStops({ from: region.example.from, to: region.example.to });
});
$("clear").addEventListener("click", () => {
  setStops({ from: null, to: null });
  state.fitNext = false;
});
$("drive").addEventListener("click", () => (state.drive ? stopDrive() : startDrive()));

// ---------- install to the home screen ----------

type InstallPromptEvent = Event & { prompt(): Promise<void> };
let installPrompt: InstallPromptEvent | null = null;
const installed = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
$("install").hidden = installed;
$("installHelp").textContent = /iphone|ipad|ipod/i.test(navigator.userAgent)
  ? "In Safari, tap the Share button, then Add to Home Screen."
  : "Use your browser's menu and choose Install app (or Add to Home screen).";
// Chrome and Edge on Android offer a real install button instead.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e as InstallPromptEvent;
  $("installBtn").hidden = false;
});
$("installBtn").addEventListener("click", async () => {
  await installPrompt?.prompt();
  installPrompt = null;
  $("installBtn").hidden = true;
});
window.addEventListener("appinstalled", () => void ($("install").hidden = true));

// ---------- offline and instant start ----------

if (import.meta.env.PROD && "serviceWorker" in navigator && window.isSecureContext) {
  // When a new version takes over, reload once so this tab doesn't keep running files the new
  // service worker has retired. (The first install isn't a takeover: there's nothing stale.)
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) location.reload();
  });
  navigator.serviceWorker.register("/sw.js").catch(() => {
    /* No service worker (e.g. an untrusted certificate): the app still works, just without offline. */
  });
}

readHash();
send({ type: "load", packUrl: dataUrl(region.pack.path), camerasUrl: dataUrl(region.cameras.path), profile: state.profile });
render();
