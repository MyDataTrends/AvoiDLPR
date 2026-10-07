import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

import { LocalProjection, type PlaceResult } from "@flockwatch/router";
import { type LngLat, LngLatBounds, Marker, Popup } from "maplibre-gl";

import { Chooser, type PickHow } from "./chooser.ts";
import {
  dataUrl, inBbox, initialRegion, loadManifest, type RegionEntry, regionLabel, regionsContaining, rememberRegion,
} from "./data.ts";
import { type Fix, Polyline } from "./drive.ts";
import { accuracy, cameraZones, distance, duration, extraTime, nearCameras, siteTitle, watches } from "./format.ts";
import { insideBox, LocateError, locate } from "./location.ts";
import { type BasemapUrls, type CameraState, createMap, mapStyle, Overlays } from "./map.ts";
import { type Ride, RIDES, rideSvg, savedRide, saveRide } from "./personas.ts";
import type { CameraDTO, LonLat, ProfileName, Request, Response, RouteDTO, SiteDTO, Stats } from "./protocol.ts";
import { type PlacesFile, type Stop, StopSearch } from "./search.ts";
import { Sheet } from "./sheet.ts";

const PROFILE_NAMES: ProfileName[] = ["strict", "default", "loose"];
const ALERT_AHEAD_M = 400;
/** A zone takes ~5 s to cross at city speed but a blink at 32x playback: keep the alert up. */
const MIN_ZONE_BANNER_MS = 1500;
/** Tap tolerance (px) for picking another route off the map. */
const ROUTE_TAP_SLOP_PX = 12;
/** A drive preview plays the whole route back in about this many seconds. */
const PREVIEW_S = 30;
/** And zooms out until the map scrolls under your ride no faster than this (px a second). */
const PREVIEW_PX_S = 200;
/** It glides to the start first, then sets off. */
const PREVIEW_EASE_MS = 700;
/**
 * How far from a place found by search to look for a road, in metres. A park's or an airport's
 * middle can be well back from any road; a tap on the map gets the router's usual distance.
 */
const SEARCH_SNAP_M = 2500;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------- appearance: light, dark, or the device's ----------
//
// "Auto" follows the device (the stylesheet's prefers-color-scheme rules), "Light" and "Dark" are
// set on the root element. The map follows too: it gets the matching basemap style.

type ThemeChoice = "auto" | "light" | "dark";
const THEME_KEY = "avoidlpr.theme";
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

function savedTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "light" || t === "dark") return t;
  } catch {
    /* storage blocked: follow the device */
  }
  return "auto";
}

let theme: ThemeChoice = savedTheme();
const isDark = () => theme === "dark" || (theme === "auto" && darkQuery.matches);

/** The browser's own bars, per scheme (index.html's theme-color tags). */
const THEME_COLORS = { light: "#ffffff", dark: "#1f2023" } as const;

function applyTheme(): void {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  // A chosen theme colours the browser's bars whatever the device's scheme; Auto leaves it to the tags.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = meta.media.includes("dark") ? "dark" : "light";
    meta.content = THEME_COLORS[theme === "auto" ? scheme : theme];
  }
}
applyTheme(); // first thing: the page shouldn't flash the wrong colours

// ---------- boot: what data exists, and which region to show ----------

function showBootFailure(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const text = `AvoiDLPR couldn't load its map data. ${message}`;
  $("summary").textContent = "Couldn't load map data";
  $("status").textContent = text;
  $("notice").textContent = text;
  $("notice").hidden = false;
  throw err;
}

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

/** Set when the area was picked from the device's location: find it again once the new area loads. */
const LOCATE_AFTER_SWITCH = "avoidlpr.locate";

const manifest = await loadManifest().catch(showBootFailure);
const chooser = new Chooser(manifest, (r: RegionEntry, how: PickHow) => {
  if (r.id === picked?.id) {
    chooser.close();
    if (how === "location") void useMyLocation();
    return;
  }
  switchRegion(r, { locate: how === "location" });
});
const picked = initialRegion(manifest);
if (!picked) {
  // First visit: nothing to show until an area is picked, and picking one reloads the page.
  setStatus("Choose an area to start.");
  $("summary").textContent = "Choose your area";
  chooser.open({ required: true });
  await new Promise<never>(() => {});
}
const region: RegionEntry = picked!;
rememberRegion(region.id);
document.title = `AvoiDLPR · ${region.name}`;
$("example").hidden = !region.example;
$("regionName").textContent = regionLabel(region);
$("areaSection").hidden = manifest.regions.length < 2;
setStatus(`Loading the ${region.name} road network…`);

/** What a stop is called, when it's more than a point. */
interface Named {
  /** "Bean There", "104 Main Street", "Near 106 Main Street". */
  text: string;
  /** Found by search: routing looks further for a road near it (SEARCH_SNAP_M). */
  searched: boolean;
}

/** What a drive preview and live navigation both keep while following a route. */
interface Following {
  line: Polyline;
  route: RouteDTO;
  lastQuery: number;
  queryId: number;
  /** Sites the worker's live check says hold the car (position + heading)... */
  inZone: number[];
  /** ...and those whose ring alone does. */
  nearLive: number[];
  /** What the zone banner shows, and until when (performance.now()); the same for a ring. */
  zone: string;
  zoneUntil: number;
  near: string;
  nearUntil: number;
  /** Route distance at the previous frame or fix: zones are tested against the whole stretch since. */
  lastDistM: number;
}

/** A drive preview: the route played back at `speed` times real time. */
interface Drive extends Following {
  t0: number;
  speed: number;
  raf: number;
}

/** Live navigation: the device's GPS fixes, matched to the route. */
interface Nav extends Following {
  watchId: number;
  /** Fixes in a row that were off the route. */
  offCount: number;
  lastReroute: number;
  /** Sites already announced with a chime. */
  announced: Set<number>;
  /** What the banner showed for the previous fix, so a chime sounds on a change only. */
  shown: string;
  wake: WakeLockSentinel | null;
  /** Metres per second, from the last fix that had one. */
  speedMps: number;
  /** The last fix, for re-centring the map on the car. */
  at: LonLat | null;
}

const state = {
  stats: null as Stats | null,
  cameras: [] as CameraDTO[],
  zoneRangeM: 50,
  /** The rings' reach, where a camera may still see you (0: none). */
  ringRangeM: 0,
  from: null as LonLat | null,
  /** Set when `from` came from the device's GPS (it then has an accuracy and no URL entry). */
  fromGps: null as { accuracyM: number } | null,
  to: null as LonLat | null,
  /** The stops' names, from search or from what's nearest a tap. */
  names: { from: null as Named | null, to: null as Named | null },
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
  /** A button under the notice ("Switch to Charlotte"). */
  noticeAction: null as { label: string; run: () => void } | null,
  /** The road pack's download, until the worker says it's ready. */
  progress: null as { loaded: number; total: number; unpacking?: boolean } | null,
  drive: null as Drive | null,
  nav: null as Nav | null,
  sheetBeforeDrive: null as "peek" | "half" | "full" | null,
  /** Where the drive or the GPS has you while following a route (your ride is drawn there). */
  car: null as Fix | null,
};

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const send = (msg: Request) => worker.postMessage(msg);
const basemap: BasemapUrls = {
  pmtiles: dataUrl(region.basemap.path),
  glyphs: dataUrl(manifest.assets.glyphs),
  sprite: dataUrl(manifest.assets.sprite),
  spriteDark: manifest.assets.sprite_dark ? dataUrl(manifest.assets.sprite_dark) : undefined,
};
/** Whether the map's current style is the dark one. */
let mapDark = isDark();
const map = createMap($("mapwrap").querySelector("#map")!, region.bbox, basemap, mapDark);
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
if (import.meta.env.DEV) Object.assign(window, { __fw: { map, state, sheet, checkForUpdates } });

let ride: Ride = savedRide();
const markers = {
  from: pinMarker("#2f9e44", "from"),
  to: pinMarker("#222222", "to"),
  you: new Marker({ element: youElement(), rotationAlignment: "map", pitchAlignment: "map" }),
};

function pinMarker(color: string, which: Stop): Marker {
  const m = new Marker({ color, draggable: true });
  m.on("dragend", () => {
    const { lng, lat } = m.getLngLat();
    setStops({ [which]: [lng, lat] });
  });
  return m;
}

/** You, on the map: your ride (personas.ts). */
function youElement(): HTMLElement {
  const el = document.createElement("div");
  el.className = "persona gps-dot";
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", "Your location");
  el.innerHTML = rideSvg(ride); // trusted markup, built from constants
  return el;
}

/** Your ride goes where the drive or the GPS has you while following a route, else to a GPS start. */
function placeYou(): void {
  const el = markers.you.getElement();
  if (state.car) {
    markers.you.setLngLat([state.car.lon, state.car.lat]).setRotation(state.car.heading).addTo(map);
    el.classList.toggle("live", Boolean(state.nav));
  } else if (state.from && state.fromGps) {
    markers.you.setLngLat(state.from).setRotation(0).addTo(map);
    el.classList.add("live");
  } else {
    markers.you.remove();
  }
}

function showCar(fix: Fix | null): void {
  state.car = fix;
  placeYou();
}

// ---------- state changes ----------

/**
 * Change either or both ends of the trip. Locations from GPS carry their accuracy, and places
 * from search their names; a stop without a name gets one from what's nearest it, if anything.
 */
function setStops(p: {
  from?: LonLat | null; to?: LonLat | null; gps?: { accuracyM: number } | null; names?: Partial<Record<Stop, Named | null>>;
}): void {
  stopNav();
  if ("from" in p) {
    state.from = p.from ?? null;
    state.fromGps = p.from ? (p.gps ?? null) : null;
    state.names.from = p.names?.from ?? null;
  }
  if ("to" in p) {
    state.to = p.to ?? null;
    state.names.to = p.names?.to ?? null;
  }
  nameStops();
  state.target = state.from ? "to" : "from";
  state.fitNext = Boolean(state.from && state.to);
  state.notice = null;
  state.noticeAction = null;
  writeHash();
  if (offerAreaForTrip()) {
    stopDrive();
    state.routes = null;
    render();
    return;
  }
  requestRoute();
}

/**
 * A pin outside this area can't be routed to: say so, and offer an area that holds the whole trip
 * if there is one (neighbouring areas overlap). Returns whether the trip is out of bounds.
 */
function offerAreaForTrip(): boolean {
  const pins = [state.from, state.to].filter((p): p is LonLat => p !== null);
  if (pins.every(([lon, lat]) => inBbox(region.bbox, lon, lat))) return false;
  const there = regionsContaining(manifest, ...pins)[0];
  if (there) {
    offer(`That's outside the ${region.name} area, but the whole trip fits in ${there.name}.`, `Open ${there.name}`,
      () => switchRegion(there, { from: state.fromGps ? null : state.from, to: state.to, locate: Boolean(state.fromGps) }));
  } else {
    offer(`That's outside the ${region.name} area. AvoiDLPR plans trips inside one area at a time.`, "See the areas",
      () => chooser.open({ current: region.id }));
  }
  return true;
}

/** A notice with a button that does something about it, raised into view on a phone. */
function offer(text: string, label: string, run: () => void): void {
  state.notice = text;
  state.noticeAction = { label, run };
  render();
  if (sheet.isSheet && sheet.state === "peek") sheet.set("half");
  $("notice").scrollIntoView({ block: "nearest" });
}

/**
 * Open another area. It's remembered on this device and the page reloads into it. Pins that
 * came from taps travel in the link; a GPS start never does: it's looked up again after the load.
 */
function switchRegion(r: RegionEntry, opts: { from?: LonLat | null; to?: LonLat | null; locate?: boolean } = {}): void {
  rememberRegion(r.id);
  const p = new URLSearchParams();
  if (opts.from) p.set("from", opts.from.map((v) => v.toFixed(5)).join(","));
  if (opts.to) p.set("to", opts.to.map((v) => v.toFixed(5)).join(","));
  p.set("r", r.id); // in case this browser can't remember: the reload still knows where to go
  if (opts.locate) setFlag(LOCATE_AFTER_SWITCH);
  history.replaceState(null, "", `${location.pathname}${location.search}#${p}`);
  location.reload();
}

function setFlag(key: string): void {
  try {
    sessionStorage.setItem(key, "1");
  } catch {
    /* storage blocked: the user taps the location button themselves */
  }
}

function takeFlag(key: string): boolean {
  try {
    const set = sessionStorage.getItem(key) === "1";
    sessionStorage.removeItem(key);
    return set;
  } catch {
    return false;
  }
}

function requestRoute(): void {
  stopDrive();
  state.routes = null;
  state.info = null;
  state.routing = Boolean(state.from && state.to && state.stats);
  const reach = (stop: Stop) => (state.names[stop]?.searched ? SEARCH_SNAP_M : 0);
  if (state.routing) send({ type: "route", id: ++state.routeId, from: state.from!, to: state.to!, snapM: [reach("from"), reach("to")] });
  render();
}

worker.onmessage = (ev: MessageEvent<Response>) => {
  const msg = ev.data;
  if (msg.type === "progress") {
    state.progress = msg;
    $("summary").textContent = summary();
  } else if (msg.type === "ready") {
    state.progress = null;
    state.stats = msg.stats;
    state.cameras = msg.cameras;
    state.zoneRangeM = msg.zone.rangeM;
    state.ringRangeM = msg.ring?.rangeM ?? 0;
    const s = msg.stats;
    document.documentElement.dataset.ready = "true";
    setStatus(`${s.nodes.toLocaleString()} intersections · ${s.cameras.toLocaleString()} cameras · `
      + `${s.packMB.toFixed(0)} MB network loaded in ${(s.loadMs / 1000).toFixed(1)} s`);
    renderFreshness(s);
    packLoaded(msg.pack);
    search.load(); // the search index next, now the road map is in
    // New cameras mid-drive update the live zone checks, but don't re-plan the trip under you.
    if (state.nav) render();
    else requestRoute();
  } else if (msg.type === "route") {
    if (msg.id !== state.routeId) return;
    state.routes = msg.routes;
    state.recommended = msg.recommended;
    state.selected = msg.recommended;
    state.info = { ms: msg.ms, probes: msg.probes };
    state.routing = false;
    followSelectedRoute();
    render();
    if (state.fitNext) fitRoutes();
  } else if (msg.type === "noroute") {
    if (msg.id !== state.routeId) return;
    state.routing = false;
    state.notice = msg.reason;
    render();
  } else if (msg.type === "capturing") {
    const following = state.drive ?? state.nav;
    if (following && msg.id === following.queryId) {
      following.inZone = msg.sites;
      following.nearLive = msg.near;
    }
  } else {
    state.routing = false;
    if (msg.badPack) forgetPack(msg.badPack);
    setStatus(`Error: ${msg.message}`);
  }
};

// ---------- rendering ----------

function selectedRoute(): RouteDTO | null {
  return state.routes?.[state.selected] ?? null;
}

function labelFor(i: number, n: number): string {
  if (i === 0) return "Fastest";
  if (i === n - 1) return "Fewest cameras";
  return n === 3 || i === 1 ? "Balanced" : "Fewer cameras";
}

function render(): void {
  const routes = state.routes;
  const route = selectedRoute();
  syncMode();
  renderStops();
  renderOverlays();

  const notice = $("notice");
  notice.hidden = !state.notice;
  notice.textContent = state.notice;
  const action = $("noticeAction");
  action.hidden = !(state.notice && state.noticeAction);
  action.textContent = state.noticeAction?.label ?? "";

  $("summary").textContent = summary();
  const loading = !state.stats;
  $("loadStatus").hidden = !loading;
  $("loadStatus").textContent = loading ? summary() : "";
  $("results").hidden = !(state.from && state.to);
  $<HTMLButtonElement>("drive").disabled = !route;
  syncNavButtons(Boolean(route));
  if (!routes || !route) {
    $("options").replaceChildren(...(state.routing ? [placeholderCard("Finding routes…")] : []));
    $("zones").hidden = true;
    $("alerts").replaceChildren();
    return;
  }

  const fastest = routes[0];
  $("options").replaceChildren(...routes.map((r, i) => optionCard(r, i, routes.length, fastest)));
  const n = route.sites.length, m = route.near.length;
  $("zones").hidden = n + m === 0;
  $("zonesSummary").textContent = n
    ? `${cameraZones(n)} on this route${m ? `, ${nearCameras(m, true)}` : ""}`
    : `Passes ${nearCameras(m)}`;
  const items = [...route.sites.map((s) => ({ s, near: false })), ...route.near.map((s) => ({ s, near: true }))];
  $("alerts").replaceChildren(...items.sort((a, b) => a.s.atM - b.s.atM).map(({ s, near }) => alertItem(s, near)));
}

/** Idle (nothing planned: the "Where to?" pill) or trip (a destination: the route sheet or card). */
function syncMode(): void {
  const root = document.documentElement;
  const mode = state.to ? "trip" : "idle";
  if (root.dataset.mode === mode) return;
  root.dataset.mode = mode;
  // The sheet's heights depend on its head, which only shows in trip mode.
  if (mode === "trip" && sheet.isSheet) sheet.set(sheet.state === "full" ? "half" : sheet.state);
  else syncMapPadding(true);
}

function summary(): string {
  if (state.nav) {
    const nav = state.nav;
    const left = Math.max(0, nav.line.lengthM - nav.lastDistM);
    const zones = nav.route.sites.filter((s) => s.untilM > nav.lastDistM).length;
    return `${duration(nav.route.timeS * (left / Math.max(1, nav.line.lengthM)))} · ${distance(left)} · ${cameraZones(zones)} ahead`;
  }
  if (!state.stats) {
    const p = state.progress;
    if (p?.unpacking) return `Unpacking the ${region.name} road map…`;
    if (p && p.total > 0) {
      return `Downloading the ${region.name} road map… ${(p.loaded / 1e6).toFixed(1)} of ${(p.total / 1e6).toFixed(1)} MB`;
    }
    return `Loading the ${region.name} road map…`;
  }
  if (!state.to) return "Where to?";
  if (!state.from) return "Choose a start: search, or tap the map";
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
  place(markers.to, state.to);
  placeYou();
  overlays?.setAccuracy(state.from && state.fromGps ? { lon: state.from[0], lat: state.from[1], ...state.fromGps } : null);

  $("targetFrom").dataset.target = String(state.target === "from");
  $("targetTo").dataset.target = String(state.target === "to");
  search.refresh();
}

/** What a stop's field shows: its name, "Your location", or its coordinates. */
function stopLabel(stop: Stop): string {
  if (stop === "from" && state.from && state.fromGps) return `Your location · ${accuracy(state.fromGps.accuracyM)}`;
  const p = state[stop];
  return state.names[stop]?.text ?? (p ? `${p[1].toFixed(4)}, ${p[0].toFixed(4)}` : "");
}

function renderOverlays(): void {
  const routes = state.routes;
  const fastest = new Set(routes?.[0].sites.map((s) => s.site));
  const chosen = new Set(selectedRoute()?.sites.map((s) => s.site));
  const stateOf = (site: number): CameraState => (chosen.has(site) ? "route" : fastest.has(site) ? "avoided" : "");
  overlays?.setCameras(state.cameras, { rangeM: state.zoneRangeM }, stateOf, state.ringRangeM);
  overlays?.setRoutes((routes ?? []).map((r, i) => ({ coordinates: r.coordinates, selected: i === state.selected, index: i })));
}

/**
 * A route option: its time and what it's for, what it costs against the fastest, and its camera
 * zones in a badge (green when there are none).
 */
function optionCard(r: RouteDTO, i: number, n: number, fastest: RouteDTO): HTMLButtonElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "option";
  card.setAttribute("aria-pressed", String(i === state.selected));
  const span = (cls: string, text: string) => {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  };
  const time = span("time", duration(r.timeS));
  time.append(span("label", n > 1 ? labelFor(i, n) : "Fastest"));
  if (n > 1 && i === state.recommended) {
    const chip = span("chip", "Recommended");
    chip.title = "Fewest cameras within 10% more time";
    time.append(chip);
  }
  const zones = r.sites.length;
  // Each part wraps as a whole ("near 4 cameras" never splits).
  const meta = span("meta", "");
  const parts = [i > 0 ? extraTime(r.timeS - fastest.timeS) : "", distance(r.distanceM), r.near.length ? nearCameras(r.near.length) : ""];
  parts.filter(Boolean).forEach((text, k) => meta.append(...(k ? [" · "] : []), span("", text)));
  card.append(
    time,
    meta,
    span(zones ? "cams" : "cams none", zones ? cameraZones(zones) : "No camera zones"),
  );
  card.addEventListener("click", () => selectRoute(i));
  return card;
}

/** Where the route options will be, while they're worked out. */
function placeholderCard(text: string): HTMLElement {
  const el = document.createElement("p");
  el.className = "option-wait";
  el.textContent = text;
  return el;
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
  followSelectedRoute();
  render();
}

/** A camera zone on the route, or (`near`) a camera whose ring alone it passes through. */
function alertItem(site: SiteDTO, near = false): HTMLLIElement {
  const li = document.createElement("li");
  if (near) li.className = "near";
  const button = document.createElement("button");
  button.type = "button";
  const how = near ? "may see you passing" : watches(site.cameras[0]);
  const parts: [string, string][] = [["dist", distance(site.atM)], ["what", siteTitle(site)], ["how", how]];
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

function setBanner(kind: "zone" | "ahead" | "near" | "clear" | null, title = "", detail = ""): void {
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
  const trip = document.documentElement.dataset.mode === "trip";
  // (Asked while the sheet is being made, too: so the screen's width, not `sheet`.)
  if (!matchMedia("(max-width: 760px)").matches) return { top: 24, left: trip ? 432 : 0, right: 72, bottom: 24 }; // the card, the menu orb
  // The pill and its quick searches at the top, or the route sheet at the bottom.
  return { top: trip ? 72 : 136, left: 0, right: 0, bottom: trip ? Math.min(sheetPx, window.innerHeight * 0.55) : 0 };
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

function routeLine(route: RouteDTO): Polyline {
  return new Polyline(route.coordinates, new LocalProjection(state.stats!.lat0, state.stats!.lon0));
}

function startDrive(): void {
  const route = selectedRoute();
  if (!route || !state.stats) return;
  stopNav();
  const line = routeLine(route);
  const speed = Math.min(64, Math.max(4, route.timeS / PREVIEW_S));
  state.drive = {
    line, route, t0: performance.now() + PREVIEW_EASE_MS, speed, raf: 0,
    lastQuery: 0, queryId: 0, inZone: [], nearLive: [], zone: "", zoneUntil: 0, near: "", nearUntil: 0, lastDistM: 0,
  };
  document.documentElement.dataset.following = "drive";
  $("drive").textContent = "Stop preview";
  if (sheet.isSheet) {
    state.sheetBeforeDrive = sheet.state;
    sheet.set("peek");
  }
  // The padding too: this cancels the sheet's own padding ease, just started.
  map.easeTo({ center: route.coordinates[0], zoom: previewZoom(route, speed), padding: viewPadding(), duration: PREVIEW_EASE_MS });
  state.drive.raf = requestAnimationFrame(tick);
}

/** Close in for a short or slow trip, further out for a fast one, so the map can keep up. */
function previewZoom(route: RouteDTO, speed: number): number {
  const metresPerSecond = (route.distanceM / route.timeS) * speed;
  const lat = route.coordinates[0][1];
  const metresPerPxAtZoom0 = (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / 512;
  return Math.min(15.5, Math.max(13, Math.log2((metresPerPxAtZoom0 * PREVIEW_PX_S) / metresPerSecond)));
}

function tick(now: number): void {
  const d = state.drive;
  if (!d) return;
  const metresPerSecond = d.route.distanceM / d.route.timeS;
  const fix = d.line.at((Math.max(0, now - d.t0) / 1000) * d.speed * metresPerSecond);
  showCar(fix);
  if (now - d.lastQuery > 120) {
    d.lastQuery = now;
    send({ type: "capturing", id: ++d.queryId, lon: fix.lon, lat: fix.lat, heading: fix.heading });
  }
  // The map glides under your ride, which a playback is too quick to chase in steps the way live
  // navigation does. While you move the map yourself it waits, then brings your ride back.
  if (!map.isMoving()) map.jumpTo({ center: [fix.lon, fix.lat] });
  showDriveBanner(fix, d, now);
  if (fix.distM >= d.line.lengthM - 0.5) {
    const n = d.route.sites.length;
    stopDrive(`Arrived · passed ${cameraZones(n)}`);
    return;
  }
  d.raf = requestAnimationFrame(tick);
}

/**
 * Banner for a position along the route; returns what it showed (and for "ahead", which site).
 * `aheadM` is how early a camera ahead is announced.
 */
function showDriveBanner(fix: Fix, d: Following, now: number, aheadM = ALERT_AHEAD_M): { kind: string; site: number } {
  // Test each zone interval against the whole stretch driven since the last frame, so a slow
  // frame (or a sparse GPS fix) can't step over a zone. The worker's live check, the same
  // predicate a phone runs on each fix, backs it up. Rings the same way, below.
  const passed = (s: SiteDTO) => s.atM <= fix.distM && s.untilM >= d.lastDistM;
  const onRoute = d.route.sites.find(passed);
  const nearRoute = d.route.near.find(passed);
  d.lastDistM = fix.distM;
  const live = state.cameras.filter((c) => d.inZone.includes(c.site));
  if (onRoute || live.length) {
    const cameras = onRoute ? onRoute.cameras : live;
    d.zone = `${siteTitle({ site: -1, atM: 0, untilM: 0, cameras })} · ${watches(cameras[0])}`;
    d.zoneUntil = now + MIN_ZONE_BANNER_MS;
  }
  if (now < d.zoneUntil) {
    setBanner("zone", "In a camera zone", d.zone);
    return { kind: "zone", site: -1 };
  }
  // In a camera's ring: what's happening now comes before a zone ahead. A camera whose zone the
  // route enters gets "ahead" and "in a zone" instead, not a "near" for the edge of its ring.
  const zoned = new Set(d.route.sites.map((s) => s.site));
  const nearLive = state.cameras.filter((c) => d.nearLive.includes(c.site) && !zoned.has(c.site));
  if (nearRoute || nearLive.length) {
    d.near = siteTitle({ site: -1, atM: 0, untilM: 0, cameras: nearRoute ? nearRoute.cameras : nearLive });
    d.nearUntil = now + MIN_ZONE_BANNER_MS;
  }
  if (now < d.nearUntil) {
    setBanner("near", "Near a camera", `${d.near} · it may see you`);
    return { kind: "near", site: -1 };
  }
  const next = d.route.sites.find((s) => s.atM > fix.distM);
  if (next && next.atM - fix.distM <= aheadM) {
    setBanner("ahead", `Camera ahead in ${distance(next.atM - fix.distM)}`, siteTitle(next));
    return { kind: "ahead", site: next.site };
  }
  setBanner("clear", next ? "No cameras nearby" : "No more cameras on this route", `${distance(d.line.lengthM - fix.distM)} to go`);
  return { kind: "clear", site: -1 };
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
  delete document.documentElement.dataset.following;
  showCar(null);
  queueMicrotask(applyUpdates);
  $("drive").textContent = "Preview";
  if (state.sheetBeforeDrive && sheet.isSheet) sheet.set(state.sheetBeforeDrive);
  state.sheetBeforeDrive = null;
  if (!message) {
    setBanner(null);
    return;
  }
  setBanner("clear", message);
  setTimeout(() => {
    if (!state.drive && !state.nav) setBanner(null);
  }, 5000);
}

// ---------- live navigation ----------
//
// Follows the device's GPS along the selected route: a warning before each camera zone, a banner
// (and a chime) while in one, a new route if you leave this one, and the screen kept awake. Fixes
// are used in memory only, like every other location in the app. Phones pause web pages that
// aren't on screen, so this works with the app open and the screen on, which is why it asks the
// browser to keep the screen awake.

/** Further than this from the route (or 1.5x the fix's accuracy, if worse) counts as off it... */
const OFF_ROUTE_M = 45;
/** ...for this many fixes in a row. */
const OFF_ROUTE_FIXES = 3;
const REROUTE_GAP_MS = 12_000;
/** This close to the end of the route is arriving. */
const ARRIVED_M = 35;
/** A camera ahead is announced this many seconds out at the current speed (or ALERT_AHEAD_M). */
const AHEAD_S = 25;

let audio: AudioContext | null = null;

function startNav(): void {
  const route = selectedRoute();
  if (!route || !state.stats) return;
  if (!("geolocation" in navigator) || !window.isSecureContext) {
    offer("Driving with alerts needs your location, and this browser can't share it here.", "OK", () => {
      state.notice = null;
      render();
    });
    return;
  }
  stopDrive();
  try {
    audio ??= new AudioContext(); // created in the tap's handler, so the browser allows sound
    void audio.resume();
  } catch {
    audio = null;
  }
  const nav: Nav = {
    line: routeLine(route), route, lastQuery: 0, queryId: 0, inZone: [], nearLive: [], zone: "", zoneUntil: 0, near: "",
    nearUntil: 0, lastDistM: 0,
    watchId: 0, offCount: 0, lastReroute: 0, announced: new Set(), shown: "", wake: null, speedMps: 0, at: null,
  };
  state.nav = nav;
  nav.watchId = navigator.geolocation.watchPosition(onNavFix, onNavError, {
    enableHighAccuracy: true, maximumAge: 1000, timeout: 20_000,
  });
  void keepAwake(nav);
  document.documentElement.dataset.following = "nav";
  syncNavButtons(true);
  if (sheet.isSheet) {
    state.sheetBeforeDrive = sheet.state;
    sheet.set("peek");
  }
  setBanner("clear", "Waiting for GPS…", "Keep the app open with the screen on");
  render();
}

async function keepAwake(nav: Nav): Promise<void> {
  try {
    nav.wake = (await navigator.wakeLock?.request("screen")) ?? null;
    nav.wake?.addEventListener("release", () => {
      if (state.nav === nav) nav.wake = null;
    });
  } catch {
    nav.wake = null; // not supported, or refused (battery saver): navigation still works
  }
}

function onNavFix(p: GeolocationPosition): void {
  const nav = state.nav;
  if (!nav) return;
  const { longitude: lon, latitude: lat, accuracy: acc, heading, speed } = p.coords;
  if (speed !== null && Number.isFinite(speed)) nav.speedMps = speed;
  const m = nav.line.match(lon, lat, nav.lastDistM);
  const along = nav.line.at(m.distM);
  const moving = nav.speedMps > 2 && heading !== null && Number.isFinite(heading);
  const fix: Fix = { lon, lat, heading: moving ? heading! : along.heading, distM: Math.max(m.distM, nav.lastDistM) };
  nav.at = [lon, lat];
  showCar(fix);
  follow(fix);
  send({ type: "capturing", id: ++nav.queryId, lon, lat, heading: fix.heading });

  // A weak fix (in a garage, under a bridge) mustn't count against the route.
  nav.offCount = m.offM > Math.max(OFF_ROUTE_M, acc * 1.5) && acc < 150 ? nav.offCount + 1 : 0;
  if (nav.offCount >= OFF_ROUTE_FIXES) {
    reroute(nav, lon, lat, acc);
    return;
  }
  if (nav.line.lengthM - m.distM < ARRIVED_M && m.offM < OFF_ROUTE_M * 2) {
    stopNav(`Arrived · ${cameraZones(nav.route.sites.length)} on the way`);
    return;
  }
  const shown = showDriveBanner(fix, nav, performance.now(), Math.max(ALERT_AHEAD_M, nav.speedMps * AHEAD_S));
  if (shown.kind === "zone" && nav.shown !== "zone") chime("zone");
  if (shown.kind === "ahead" && !nav.announced.has(shown.site)) {
    nav.announced.add(shown.site);
    chime("ahead");
  }
  nav.shown = shown.kind;
  $("summary").textContent = summary();
}

function onNavError(err: GeolocationPositionError): void {
  if (!state.nav) return;
  if (err.code === err.PERMISSION_DENIED) {
    stopNav();
    offer("Location access is blocked, so AvoiDLPR can't follow you. Allow it for this site in your browser's settings.",
      "OK", () => {
        state.notice = null;
        render();
      });
    return;
  }
  setBanner("ahead", "Waiting for GPS…", "The signal is weak here");
}

/** Off the route: plan again from where you are, to the same destination, and follow that. */
function reroute(nav: Nav, lon: number, lat: number, acc: number): void {
  setBanner("ahead", "Off route", "Finding a new route from here…");
  nav.offCount = 0;
  const now = performance.now();
  if (now - nav.lastReroute < REROUTE_GAP_MS || state.routing || !state.to) return;
  nav.lastReroute = now;
  state.from = [lon, lat];
  state.fromGps = { accuracyM: acc };
  writeHash();
  requestRoute();
}

/** The selected route changed under navigation (a reroute, or a tap on another option). */
function followSelectedRoute(): void {
  const nav = state.nav;
  const route = selectedRoute();
  if (!nav || !route) return;
  nav.route = route;
  nav.line = routeLine(route);
  nav.lastDistM = 0;
  nav.zoneUntil = 0;
}

function chime(kind: "zone" | "ahead"): void {
  navigator.vibrate?.(kind === "zone" ? [150, 90, 150] : 90);
  if (!audio || !$<HTMLInputElement>("sound").checked) return;
  let t = audio.currentTime + 0.01;
  for (const hz of kind === "zone" ? [880, 660] : [660]) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.25);
    t += 0.28;
  }
}

function stopNav(message?: string): void {
  const nav = state.nav;
  if (!nav) return;
  navigator.geolocation.clearWatch(nav.watchId);
  void nav.wake?.release().catch(() => {});
  state.nav = null;
  delete document.documentElement.dataset.following;
  showCar(null);
  queueMicrotask(applyUpdates);
  if (state.sheetBeforeDrive && sheet.isSheet) sheet.set(state.sheetBeforeDrive);
  state.sheetBeforeDrive = null;
  render();
  if (!message) {
    setBanner(null);
    return;
  }
  setBanner("clear", message);
  setTimeout(() => {
    if (!state.drive && !state.nav) setBanner(null);
  }, 5000);
}

/** Start / Stop, in the panel and (on a phone) next to the summary, where it's always in reach. */
function syncNavButtons(haveRoute: boolean): void {
  for (const id of ["navigate", "headNav"]) {
    const b = $<HTMLButtonElement>(id);
    b.textContent = state.nav ? "Stop" : "Start";
    b.setAttribute("aria-pressed", String(Boolean(state.nav)));
    b.disabled = !haveRoute && !state.nav;
  }
  $("headNav").hidden = !haveRoute && !state.nav;
}

// The screen lock is dropped whenever the page is hidden; take it back on return.
document.addEventListener("visibilitychange", () => {
  if (state.nav && document.visibilityState === "visible" && !state.nav.wake) void keepAwake(state.nav);
});

// ---------- keeping the data current ----------
//
// Road packs are replaced now and then (pipeline/decide.py), basemaps and search indexes monthly
// and camera feeds hourly. An app left open, or kept in memory as an installed app, looks for
// news whenever it comes back on screen (and every half hour while it's on): new cameras apply at
// once; a new pack, search index or basemap waits until no trip is being driven or previewed.
//
// A new pack only becomes the one to keep once it has downloaded, matched its checksum and
// decoded. Until then the service worker holds on to the last one that did, and the worker falls
// back to it, so a bad download never leaves an area without a map.

/** The area's manifest entry as loaded now (it changes when a new pack is swapped in). */
let current: RegionEntry = region;
/** Updates found during a trip wait for it to end. */
const pending = { pack: null as RegionEntry | null, reload: false };
const CHECK_EVERY_MS = 30 * 60_000;
let checkedAt = Date.now();
let lastPackUrl = "";

const packKey = (id: string) => `avoidlpr.pack.${id}`;

function lastGoodPack(id: string): { path: string; sha256?: string } | null {
  try {
    return JSON.parse(localStorage.getItem(packKey(id)) ?? "null");
  } catch {
    return null;
  }
}

function loadPack(entry: RegionEntry): void {
  const good = lastGoodPack(entry.id);
  send({
    type: "load", packUrl: dataUrl(entry.pack.path), packBytes: entry.pack.bytes, packSha256: entry.pack.sha256,
    camerasUrl: dataUrl(entry.cameras.path), profile: state.profile,
    fallback: good && good.path !== entry.pack.path ? { url: dataUrl(good.path), sha256: good.sha256 } : null,
  });
}

/** A pack loaded: remember it as the one to fall back on, and let the service worker drop older ones. */
function packLoaded(pack: { url: string; fellBack: boolean; failed?: string }): void {
  if (pack.url === lastPackUrl) return; // a camera refresh or a zone-model change, not a new pack
  lastPackUrl = pack.url;
  if (pack.failed) forgetPack(pack.failed);
  if (pack.fellBack) {
    state.notice = "The updated road map for this area didn't load, so this is the previous one. It'll try again later.";
    return;
  }
  try {
    localStorage.setItem(packKey(current.id), JSON.stringify({ path: current.pack.path, sha256: current.pack.sha256 }));
  } catch {
    /* storage blocked: there's just no fallback next time */
  }
  navigator.serviceWorker?.controller?.postMessage({ type: "pack-ok", url: pack.url });
}

/** A pack that failed its checks: out of the service worker's cache, so the next try downloads it again. */
function forgetPack(url: string): void {
  navigator.serviceWorker?.controller?.postMessage({ type: "pack-bad", url });
}

async function checkForUpdates(force = false): Promise<void> {
  if (!force && Date.now() - checkedAt < CHECK_EVERY_MS) return;
  checkedAt = Date.now();
  let latest;
  try {
    latest = await loadManifest();
  } catch {
    return; // offline, or the host is down: try again next time
  }
  const entry = latest.regions.find((r) => r.id === current.id);
  if (entry && entry.basemap.path !== current.basemap.path) pending.reload = true;
  else if (entry && (entry.pack.path !== current.pack.path || entry.places?.path !== current.places?.path)) pending.pack = entry;
  if (state.stats) send({ type: "cameras", camerasUrl: dataUrl(current.cameras.path) });
  applyUpdates();
}

/** Swap in what checkForUpdates found, if no trip is being driven or previewed. */
function applyUpdates(): void {
  if (state.nav || state.drive) return;
  if (pending.reload) {
    location.reload(); // a new basemap: the map's tile source is set at start-up
    return;
  }
  if (pending.pack) {
    const next = pending.pack;
    pending.pack = null;
    const newPack = next.pack.path !== current.pack.path, newPlaces = next.places?.path !== current.places?.path;
    current = next;
    if (newPlaces) {
      search.setFile(placesFile(current));
      search.load();
    }
    if (newPack) {
      state.stats = null;
      delete document.documentElement.dataset.ready;
      state.routes = null;
      loadPack(current);
      render();
    }
  }
}

function renderFreshness(s: Stats): void {
  const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const parts = [s.osmAt && `roads as of ${day(s.osmAt)}`, s.camerasAt && `cameras as of ${time(s.camerasAt)}`].filter(Boolean);
  $("freshness").hidden = !parts.length;
  $("freshness").textContent = parts.length ? `Map data: ${parts.join(", ")}.` : "";
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void checkForUpdates();
});
setInterval(() => {
  if (document.visibilityState === "visible") void checkForUpdates();
}, CHECK_EVERY_MS);

// ---------- current location ----------

let locating = false;

async function useMyLocation(): Promise<void> {
  if (state.nav) {
    // Mid-drive the button means "where am I", not "start here".
    if (state.nav.at) map.easeTo({ center: state.nav.at, zoom: Math.max(map.getZoom(), 15.5), duration: 500 });
    return;
  }
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
      const there = regionsContaining(manifest, [fix.lon, fix.lat])[0];
      if (there) {
        offer(`You're in the ${there.name} area, not ${region.name}.`, `Switch to ${there.name}`,
          () => switchRegion(there, { locate: true, to: state.to && inBbox(there.bbox, ...state.to) ? state.to : null }));
      } else {
        offer(`You're outside the ${region.name} area, and outside every area AvoiDLPR covers so far.`,
          "See the areas", () => chooser.open({ current: region.id }));
      }
      return;
    }
    setStops({ from: [fix.lon, fix.lat], gps: { accuracyM: fix.accuracyM } });
    if (fix.accuracyM > 200) state.notice = `Your location is approximate (${accuracy(fix.accuracyM)}).`;
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

// ---------- search ----------
//
// On a phone, typing in a stop field turns the panel into a full-screen search: the fields at the
// top and the results under them, in what the keyboard leaves of the screen (the visual viewport),
// so no result hides behind the keyboard. Leaving the field (a result, Back, Escape, the keyboard's
// Done) puts the sheet back.

/** Keep --vv-top and --vv-h on the visible part of the screen, which the keyboard shrinks. */
function trackVisibleArea(): void {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  const apply = () => {
    root.setProperty("--vv-top", `${Math.round(vv?.offsetTop ?? 0)}px`);
    root.setProperty("--vv-h", `${Math.round(vv?.height ?? window.innerHeight)}px`);
  };
  apply();
  vv?.addEventListener("resize", apply);
  vv?.addEventListener("scroll", apply);
  window.addEventListener("resize", apply);
}
trackVisibleArea();

/** Enter the phone search view for a stop, or leave it (null). */
function searchView(stop: Stop | null): void {
  const root = document.documentElement;
  if (stop && sheet.isSheet) {
    $("searchTitle").textContent = stop === "from" ? "Where are you starting?" : "Where to?";
    root.dataset.searching = "true";
    document.querySelector(".sheet-body")!.scrollTop = 0; // the fields at the top
  } else {
    delete root.dataset.searching;
  }
}

const placesFile = (r: RegionEntry): PlacesFile | null =>
  r.places ? { url: dataUrl(r.places.path), bytes: r.places.bytes, sha256: r.places.sha256 } : null;

const search = new StopSearch({ from: $<HTMLInputElement>("fromInput"), to: $<HTMLInputElement>("toInput") }, $("suggestions"), {
  near: () => {
    const c = map.getCenter();
    return [c.lng, c.lat];
  },
  bbox: () => region.bbox,
  label: stopLabel,
  placeholder: (stop) => (!state.to && stop === "to" ? "Where to?" : state.target === stop ? "Search, or tap the map" : "Search for a place"),
  here: () => void useMyLocation(),
  focused: (stop) => {
    state.target = stop;
    renderStops();
    searchView(stop);
  },
  picked: (stop, r: PlaceResult) => {
    setStops({ [stop]: [r.lon, r.lat], names: { [stop]: { text: r.name, searched: r.kind === "place" || r.kind === "address" } } });
    if (sheet.isSheet) sheet.set("half"); // the routes are next
  },
  chooseOnMap: (stop) => {
    state.target = stop;
    renderStops();
    if (sheet.isSheet) sheet.set("peek"); // so the map is there to tap
  },
  closed: () => searchView(null),
  loaded: (url) => {
    navigator.serviceWorker?.controller?.postMessage({ type: "pack-ok", url });
    nameStops();
  },
  failed: (url, message) => {
    console.warn(`search index ${url}: ${message}`);
    navigator.serviceWorker?.controller?.postMessage({ type: "pack-bad", url });
  },
});
search.setFile(placesFile(region));
// Back, in the phone search view. The press mustn't take focus from the field first: that would
// close the view and leave the finger on whatever is under it.
$("searchClose").addEventListener("pointerdown", (e) => e.preventDefault());
$("searchClose").addEventListener("click", () => search.dismiss());
if (import.meta.env.DEV) Object.assign((window as unknown as { __fw: object }).__fw, { search });

/** Name stops set by tapping the map after what's at that spot ("Near 104 Main Street"). */
function nameStops(): void {
  for (const stop of ["from", "to"] as const) {
    const at = state[stop];
    if (!at || state.names[stop] || (stop === "from" && state.fromGps)) continue;
    void search.nearest(at).then((r) => {
      if (!r || state[stop] !== at || state.names[stop]) return; // the stop moved on meanwhile
      state.names[stop] = { text: (r.distanceM ?? 0) < 25 ? r.name : `Near ${r.name}`, searched: false };
      renderStops();
    });
  }
}

// ---------- URL hash (never sent to a server) ----------

/** Pins and the zone model, never a GPS location: a shared link must not reveal where you are. */
function writeHash(): void {
  const p = new URLSearchParams();
  if (state.from && !state.fromGps) p.set("from", state.from.map((v) => v.toFixed(5)).join(","));
  if (state.to) p.set("to", state.to.map((v) => v.toFixed(5)).join(","));
  if (state.profile !== "default") p.set("model", state.profile);
  // The area goes in only with pins, which say more than the area does: a link without them
  // shouldn't tell anyone which city you opened.
  if (manifest.regions.length > 1 && (p.has("from") || p.has("to"))) p.set("r", region.id);
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

map.on("style.load", () => {
  overlays = new Overlays(map, mapDark);
  render();
});
map.on("load", () => syncMapPadding(false));

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
  if (state.nav) return; // a stray tap mid-drive mustn't end the trip
  search.dismiss();
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
$("locate").addEventListener("click", () => void useMyLocation());
$("mapLocate").addEventListener("click", () => void useMyLocation());
$("swap").addEventListener("click", () => {
  if (state.from || state.to) setStops({ from: state.to, to: state.from, names: { from: state.names.to, to: state.names.from } });
});
$("example").addEventListener("click", () => {
  if (region.example) setStops({ from: region.example.from, to: region.example.to });
});
$("clear").addEventListener("click", () => {
  setStops(state.fromGps ? { to: null } : { from: null, to: null }); // where you are stays where you are
  state.fitNext = false;
});
for (const chip of document.querySelectorAll<HTMLButtonElement>("[data-query]")) {
  chip.addEventListener("click", () => search.openFor("to", chip.dataset.query!));
}
$("drive").addEventListener("click", () => (state.drive ? stopDrive() : startDrive()));
for (const id of ["navigate", "headNav"]) $(id).addEventListener("click", () => (state.nav ? stopNav() : startNav()));
$("regionBtn").addEventListener("click", () => {
  menu.close();
  chooser.open({ current: region.id });
});
$("noticeAction").addEventListener("click", () => state.noticeAction?.run());

// ---------- the menu: area, your ride, appearance, settings, about ----------

const menu = $<HTMLDialogElement>("menu");
$("menuBtn").addEventListener("click", () => {
  renderRides();
  syncThemeButtons();
  menu.showModal();
});
$("menuClose").addEventListener("click", () => menu.close());
menu.addEventListener("click", (e) => {
  if (e.target === menu) menu.close(); // a tap on the backdrop
});

function renderRides(): void {
  $("rides").replaceChildren(...RIDES.map((r) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ride";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(r.id === ride));
    b.innerHTML = rideSvg(r.id, 40); // trusted markup, built from constants
    const name = document.createElement("span");
    name.textContent = r.name;
    b.append(name);
    b.addEventListener("click", () => {
      ride = r.id;
      saveRide(ride);
      markers.you.getElement().innerHTML = rideSvg(ride);
      renderRides();
    });
    return b;
  }));
}

function syncThemeButtons(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")) {
    b.setAttribute("aria-checked", String(b.dataset.themeChoice === theme));
  }
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")) {
  b.addEventListener("click", () => {
    theme = b.dataset.themeChoice as ThemeChoice;
    try {
      if (theme === "auto") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage blocked: it lasts until the page closes */
    }
    applyTheme();
    syncThemeButtons();
    syncMapTheme();
  });
}
darkQuery.addEventListener("change", syncMapTheme);

/** Give the map the basemap that matches the app's colours; the overlays go back on with it. */
function syncMapTheme(): void {
  if (isDark() === mapDark) return;
  mapDark = isDark();
  map.setStyle(mapStyle(basemap, mapDark), { diff: false });
}

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

readHash();
writeHash(); // tidies the link: an area id with no pins in it isn't worth keeping in the URL
loadPack(current);
render();
if (takeFlag(LOCATE_AFTER_SWITCH)) void useMyLocation();
