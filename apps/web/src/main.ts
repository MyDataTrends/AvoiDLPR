import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

import { LocalProjection } from "@flockwatch/router";
import { type LngLat, Marker, Popup } from "maplibre-gl";

import { type Fix, Polyline } from "./drive.ts";
import { distance, duration, signedPercent, siteTitle, watches } from "./format.ts";
import { createMap, Overlays } from "./map.ts";
import type { CameraDTO, LonLat, ProfileName, Request, Response, RouteDTO, SiteDTO, Stats } from "./protocol.ts";

/** The spike's showcase trip: west Dallas to the northeast. */
const EXAMPLE: { from: LonLat; to: LonLat } = { from: [-96.85692, 32.73077], to: [-96.66394, 32.85072] };
const DALLAS: [number, number, number, number] = [-97.09, 32.608, -96.518, 32.951];
const BUDGETS = [0, 5, 10, 20, 50];
const PROFILE_NAMES: ProfileName[] = ["strict", "default", "loose"];
const ALERT_AHEAD_M = 400;
/** A zone takes ~5 s to cross at city speed but a blink at 32x playback: keep the alert up. */
const MIN_ZONE_BANNER_MS = 1500;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

interface Result { fastest: RouteDTO; chosen: RouteDTO; sameRoute: boolean; ms: number; probes: number }
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
  to: null as LonLat | null,
  budget: 10,
  profile: "default" as ProfileName,
  result: null as Result | null,
  selected: "chosen" as "fastest" | "chosen",
  routeId: 0,
  drive: null as Drive | null,
};

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const send = (msg: Request) => worker.postMessage(msg);
const map = createMap($("map"), DALLAS);
let overlays: Overlays | null = null;
const markers = { from: makeMarker("#2f9e44", "from"), to: makeMarker("#212529", "to") };

function makeMarker(color: string, which: "from" | "to"): Marker {
  const m = new Marker({ color, draggable: true });
  m.on("dragend", () => {
    const { lng, lat } = m.getLngLat();
    setPoints({ [which]: [lng, lat] });
  });
  return m;
}

// ---------- state changes ----------

function setPoints(p: { from?: LonLat | null; to?: LonLat | null }): void {
  for (const which of ["from", "to"] as const) {
    if (!(which in p)) continue;
    const v = p[which] ?? null;
    state[which] = v;
    if (v) markers[which].setLngLat(v).addTo(map);
    else markers[which].remove();
  }
  writeHash();
  requestRoute();
}

function requestRoute(): void {
  stopDrive();
  state.result = null;
  if (state.from && state.to && state.stats) {
    $("routeMeta").textContent = "Routing…";
    send({ type: "route", id: ++state.routeId, from: state.from, to: state.to, maxExtra: state.budget / 100 });
  }
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
    state.result = { fastest: msg.fastest, chosen: msg.chosen, sameRoute: msg.sameRoute, ms: msg.ms, probes: msg.probes };
    state.selected = "chosen";
    render();
  } else if (msg.type === "noroute") {
    if (msg.id !== state.routeId) return;
    render(msg.reason);
  } else if (msg.type === "capturing") {
    if (state.drive && msg.id === state.drive.queryId) state.drive.inZone = msg.sites;
  } else {
    setStatus(`Error: ${msg.message}`);
  }
};

// ---------- rendering ----------

function selectedRoute(): RouteDTO | null {
  const r = state.result;
  return r ? (r.sameRoute ? r.chosen : r[state.selected]) : null;
}

function sitesOf(r: RouteDTO | undefined): Set<number> {
  return new Set(r?.sites.map((s) => s.site));
}

function render(note?: string): void {
  const r = state.result;
  overlays?.setRoutes(r?.fastest ?? null, r?.chosen ?? null, r?.sameRoute ?? false, state.selected);
  overlays?.setCameras(state.cameras, { rangeM: state.zoneRangeM }, sitesOf(r?.fastest), sitesOf(r?.chosen));

  const hint = $("hint");
  hint.hidden = Boolean(state.from && state.to);
  hint.textContent = state.from ? "Now click your destination." : "Click the map to set a start.";
  $("results").hidden = !(state.from && state.to);
  $("cards").hidden = !r;
  $<HTMLButtonElement>("drive").disabled = !r;
  if (!r) {
    $("routeNote").textContent = note ?? (state.stats ? "" : "Loading the road network…");
    $("alerts").replaceChildren();
    if (note) $("routeMeta").textContent = "";
    return;
  }

  const fastest = r.fastest, chosen = r.chosen;
  fillCard($("cardFastest"), "Fastest", fastest, null);
  fillCard($("cardChosen"), r.sameRoute ? `Best route within +${state.budget}%` : `Fewest cameras within +${state.budget}%`,
    chosen, r.sameRoute ? null : fastest);
  $("cardFastest").hidden = r.sameRoute;
  $("cardChosen").classList.toggle("both", r.sameRoute);
  $("cardFastest").setAttribute("aria-pressed", String(!r.sameRoute && state.selected === "fastest"));
  $("cardChosen").setAttribute("aria-pressed", String(r.sameRoute || state.selected === "chosen"));

  const fs = fastest.sites.length, cs = chosen.sites.length;
  $("routeNote").textContent = fs === 0
    ? "The fastest route already passes no camera zones."
    : r.sameRoute
      ? `No route within +${state.budget}% passes fewer than ${fs} camera zone${fs === 1 ? "" : "s"}. Allow more time to see alternatives.`
      : `Avoids ${fs - cs} of ${fs} camera zone${fs === 1 ? "" : "s"} for ${duration(Math.max(0, chosen.timeS - fastest.timeS))} more.`;
  $("routeMeta").textContent = `Routed on this device in ${r.ms.toFixed(0)} ms (${r.probes} search${r.probes === 1 ? "" : "es"}).`;

  const route = selectedRoute()!;
  const items = route.sites.map((s) => alertItem(s));
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No camera zones on this route.";
    items.push(li);
  }
  $("alerts").replaceChildren(...items);
}

function fillCard(card: HTMLElement, label: string, route: RouteDTO, vs: RouteDTO | null): void {
  const n = route.sites.length;
  card.querySelector(".label")!.textContent = label;
  card.querySelector(".big")!.textContent = duration(route.timeS);
  card.querySelector(".small")!.textContent = `${distance(route.distanceM)} · ${n} camera zone${n === 1 ? "" : "s"}`
    + (vs ? ` · ${signedPercent(route.timeS / vs.timeS - 1)} time` : "");
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
    stopDrive(`Arrived · passed ${n} camera zone${n === 1 ? "" : "s"}`);
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
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  if (p.x < w * 0.25 || p.x > w * 0.75 || p.y < h * 0.25 || p.y > h * 0.75) {
    map.easeTo({ center: [fix.lon, fix.lat], duration: 600 });
  }
}

function stopDrive(message?: string): void {
  const d = state.drive;
  if (!d) return;
  cancelAnimationFrame(d.raf);
  state.drive = null;
  overlays?.setCar(null);
  $("drive").textContent = "Drive this route";
  if (!message) {
    setBanner(null);
    return;
  }
  setBanner("clear", message);
  setTimeout(() => {
    if (!state.drive) setBanner(null);
  }, 5000);
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

function writeHash(): void {
  const p = new URLSearchParams();
  if (state.from) p.set("from", state.from.map((v) => v.toFixed(5)).join(","));
  if (state.to) p.set("to", state.to.map((v) => v.toFixed(5)).join(","));
  p.set("budget", String(state.budget));
  if (state.profile !== "default") p.set("model", state.profile);
  history.replaceState(null, "", `#${p}`);
}

function readHash(): void {
  const p = new URLSearchParams(location.hash.slice(1));
  const point = (key: string): LonLat | null => {
    const v = p.get(key)?.split(",").map(Number);
    return v && v.length === 2 && v.every(Number.isFinite) ? [v[0], v[1]] : null;
  };
  const budget = p.has("budget") ? Number(p.get("budget")) : NaN;
  if (BUDGETS.includes(budget)) state.budget = budget;
  const model = p.get("model") as ProfileName | null;
  if (model && PROFILE_NAMES.includes(model)) state.profile = model;
  $<HTMLInputElement>(`budget-${state.budget}`).checked = true;
  $<HTMLSelectElement>("profile").value = state.profile;
  const from = point("from"), to = point("to");
  if (from || to) {
    setPoints({ from, to });
    if (from && to) map.fitBounds([from, to], { padding: 80, duration: 0 });
  }
}

// ---------- wiring ----------

map.on("load", () => {
  overlays = new Overlays(map);
  render();
});

map.on("click", (e) => {
  const index = overlays?.cameraAt(e.point) ?? null;
  if (index !== null) {
    showCamera(state.cameras[index], e.lngLat);
    return;
  }
  setPoints(state.from ? { to: [e.lngLat.lng, e.lngLat.lat] } : { from: [e.lngLat.lng, e.lngLat.lat] });
});
for (const layer of ["fw-cameras", "fw-cameras-any"]) {
  map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
}

for (const input of document.querySelectorAll<HTMLInputElement>('input[name="budget"]')) {
  input.addEventListener("change", () => {
    state.budget = Number(input.value);
    writeHash();
    requestRoute();
  });
}
$<HTMLSelectElement>("profile").addEventListener("change", (e) => {
  state.profile = (e.target as HTMLSelectElement).value as ProfileName;
  writeHash();
  setStatus("Recomputing camera zones…");
  send({ type: "profile", profile: state.profile });
});
$("example").addEventListener("click", () => {
  setPoints({ from: EXAMPLE.from, to: EXAMPLE.to });
  map.fitBounds([EXAMPLE.from, EXAMPLE.to], { padding: 80 });
});
$("clear").addEventListener("click", () => setPoints({ from: null, to: null }));
for (const kind of ["fastest", "chosen"] as const) {
  $(kind === "fastest" ? "cardFastest" : "cardChosen").addEventListener("click", () => {
    if (state.selected === kind) return;
    stopDrive();
    state.selected = kind;
    render();
  });
}
$("drive").addEventListener("click", () => (state.drive ? stopDrive() : startDrive()));

readHash();
send({ type: "load", packUrl: "/packs/dallas.fwr", camerasUrl: "/packs/dallas.cameras.json", profile: state.profile });
render();
