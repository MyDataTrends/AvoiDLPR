// Map setup: a self-hosted Protomaps basemap (tiles, fonts and icons all from this origin), in a
// light or dark flavour to match the app, plus overlays for routes, cameras, capture zones, every
// camera in the country and the GPS accuracy circle. (You, on the map, are a DOM marker: your
// ride, from personas.ts.)
import { layers, namedFlavor } from "@protomaps/basemaps";
import type { Feature, FeatureCollection, Point } from "geojson";
import {
  addProtocol, type ExpressionSpecification, type GeoJSONSource, type LineLayerSpecification, Map as MapLibreMap, type PointLike,
  setWorkerUrl, type StyleSpecification,
} from "maplibre-gl";
// MapLibre locates its tile worker relative to its own module URL, which bundlers relocate;
// let Vite build the worker and hand MapLibre the result.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { Protocol } from "pmtiles";

import type { NationCameras } from "./nation.ts";
import type { CameraDTO } from "./protocol.ts";

/** Overlay colours per theme; they match the app's tokens (style.css). */
const PALETTES = {
  light: {
    camera: "#495057",
    /** A camera on the selected route. */
    route: "#e03131",
    /** A camera on the fastest route that the selected route avoids. */
    avoided: "#2f9e44",
    zone: "#e03131",
    /** Each camera in the country, zoomed out. */
    speck: "#c92a2a",
    /** The selected route; the others are `alt`. */
    accent: "#2563eb",
    alt: "#8d96a0",
    /** Edges drawn under routes and around camera marks, to lift them off the map. */
    halo: "#ffffff",
  },
  dark: {
    camera: "#adb5bd",
    route: "#ff6b6b",
    avoided: "#51cf66",
    zone: "#ff6b6b",
    speck: "#ff8787",
    accent: "#6b9bff",
    alt: "#6c7480",
    halo: "#1f2023",
  },
} as const;

/** Where a camera stands relative to the selected route. */
export type CameraState = "route" | "avoided" | "";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const CAMERA_LAYERS = ["fw-cameras", "fw-cameras-any"];
let protocolRegistered = false;

/** A colour of the palette, see-through. */
function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Absolute URLs of the basemap's pieces (see data.ts): the tile archive, label fonts and icon
 * sprites (the dark ones when the release has them; otherwise the dark map uses the light icons).
 */
export interface BasemapUrls {
  pmtiles: string;
  glyphs: string;
  sprite: string;
  spriteDark?: string;
}

/** The basemap's style, light or dark. Changing theme sets a new one (and the overlays go back on). */
export function mapStyle(urls: BasemapUrls, dark: boolean): StyleSpecification {
  return {
    version: 8,
    glyphs: urls.glyphs,
    sprite: dark ? (urls.spriteDark ?? urls.sprite) : urls.sprite,
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${urls.pmtiles}`,
        attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · cameras via <a href="https://deflock.org">DeFlock</a>',
      },
    },
    layers: layers("protomaps", namedFlavor(dark ? "dark" : "light"), { lang: "en" }),
  };
}

export type Bbox = [number, number, number, number];

export type Fence = [[number, number], [number, number]];

/**
 * How far the map can be moved: the box with room round it, `room` of its size on each side (at
 * least a little). An area gets a tenth; the country gets a lot more, mostly so a tall phone
 * screen can show all of it at once (the map can't zoom out past what the fence holds).
 */
export function fence(bbox: Bbox, room = 0.1): Fence {
  const [w, s, e, n] = bbox;
  const dx = Math.max(0.2, (e - w) * room), dy = Math.max(0.15, (n - s) * room);
  return [[Math.max(-180, w - dx), Math.max(-85, s - dy)], [Math.min(180, e + dx), Math.min(85, n + dy)]];
}

/** A map showing `view`, kept inside `limit` (see `fence`). */
export function createMap(container: HTMLElement, view: Bbox, limit: Fence, urls: BasemapUrls, dark: boolean): MapLibreMap {
  if (!protocolRegistered) {
    setWorkerUrl(maplibreWorkerUrl);
    addProtocol("pmtiles", new Protocol().tile);
    protocolRegistered = true;
  }
  const [w, s, e, n] = view;
  return new MapLibreMap({
    container,
    style: mapStyle(urls, dark),
    bounds: [[w, s], [e, n]],
    maxBounds: limit,
    attributionControl: { compact: true },
  });
}

/** An arrowhead pointing up (north); the map rotates it to each camera's bearing. */
function arrow(fill: string, edge: string): ImageData {
  const size = 44;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.beginPath();
  g.moveTo(size / 2, 3);
  g.lineTo(size - 7, size - 5);
  g.lineTo(size / 2, size - 15);
  g.lineTo(7, size - 5);
  g.closePath();
  g.fillStyle = fill;
  g.strokeStyle = edge;
  g.lineWidth = 3;
  g.lineJoin = "round";
  g.stroke();
  g.fill();
  return g.getImageData(0, 0, size, size);
}

/** Polygon ring for a sector (or a disk when halfAngle >= 180) of `rangeM` metres. */
function sector(lon: number, lat: number, bearing: number, halfAngle: number, rangeM: number): [number, number][] {
  const kLat = 111_194.93, kLon = kLat * Math.cos((lat * Math.PI) / 180);
  const half = Math.min(halfAngle, 180);
  const steps = Math.max(6, Math.ceil(half / 5));
  const ring: [number, number][] = half < 180 ? [[lon, lat]] : [];
  for (let i = 0; i <= 2 * steps; i++) {
    const a = ((bearing - half + (i * half) / steps) * Math.PI) / 180;
    ring.push([lon + (rangeM * Math.sin(a)) / kLon, lat + (rangeM * Math.cos(a)) / kLat]);
  }
  ring.push(ring[0]);
  return ring;
}

export interface RouteLine {
  coordinates: [number, number][];
  selected: boolean;
  /** Index into the route list, so a tap on the line can select it. */
  index: number;
}

/**
 * The app's layers on the map. Made again whenever the style changes (light to dark): a new style
 * clears everything added to the old one, and render() puts the data back.
 */
export class Overlays {
  private readonly map: MapLibreMap;
  /** What `setNation` last drew. */
  private nation: NationCameras | null = null;
  private nationArea = "";

  constructor(map: MapLibreMap, dark: boolean) {
    this.map = map;
    const c = PALETTES[dark ? "dark" : "light"];
    for (const [name, color] of [["fw-cam", c.camera], ["fw-cam-route", c.route], ["fw-cam-avoided", c.avoided]] as const) {
      map.addImage(name, arrow(color, c.halo), { pixelRatio: 2 });
    }
    for (const id of ["fw-nation", "fw-accuracy", "fw-rings", "fw-zones", "fw-routes", "fw-cameras"]) {
      map.addSource(id, { type: "geojson", data: EMPTY });
    }

    // Every camera in the country. Zoomed out, a fine red speck for each and a soft glow where
    // they crowd together, both under the basemap's labels so place names stay readable. The glow
    // is wide and faint on purpose: a city's thousands light up, a town's few barely tint the map.
    const labels = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    map.addLayer({
      id: "fw-nation-heat", type: "heatmap", source: "fw-nation", maxzoom: 8,
      paint: {
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 2, 8, 4, 16, 6, 28, 8, 36],
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 2, 0.012, 4, 0.025, 6, 0.06, 8, 0.15],
        "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, rgba(c.zone, 0), 0.04, rgba(c.zone, 0.06),
          0.15, rgba(c.zone, 0.18), 0.35, rgba(c.zone, 0.3), 0.6, rgba(c.zone, 0.4), 1, rgba(c.zone, 0.5)],
        "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 6.5, 1, 8, 0],
      },
    }, labels);
    map.addLayer({
      id: "fw-nation-specks", type: "circle", source: "fw-nation", maxzoom: 7.5,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 0.6, 5, 0.9, 7.5, 1.2],
        "circle-color": c.speck,
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], 2, 0.45, 6, 0.6, 6.5, 0.6, 7.5, 0],
      },
    }, labels);
    // Closer in, where the loaded area's own cameras appear (below), the rest turn into grey dots
    // like them; none inside that area, whose cameras draw there in full.
    map.addLayer({
      id: "fw-nation-dots", type: "circle", source: "fw-nation", minzoom: 6.5, filter: ["!", ["get", "inside"]],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6.5, 1.1, 9, 1.5, 13, 3, 16, 5],
        "circle-color": c.camera,
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], 6.5, 0, 7.5, 0.85],
        "circle-stroke-color": c.halo,
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 10, 0, 12, 1],
      },
    });

    map.addLayer({
      id: "fw-accuracy", type: "fill", source: "fw-accuracy",
      paint: { "fill-color": c.accent, "fill-opacity": 0.12, "fill-outline-color": c.accent },
    });
    // Under each zone, fainter: its ring, where the camera may still see you.
    map.addLayer({
      id: "fw-rings", type: "fill", source: "fw-rings", minzoom: 13,
      paint: { "fill-color": c.zone, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.03, 16, 0.08] },
    });
    map.addLayer({
      id: "fw-zones", type: "fill", source: "fw-zones", minzoom: 13,
      paint: { "fill-color": c.zone, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.08, 16, 0.2] },
    });
    // Selected routes draw last (on top); `order` is 1 for them, 0 for the rest.
    const layout: LineLayerSpecification["layout"] = {
      "line-join": "round", "line-cap": "round", "line-sort-key": ["get", "order"],
    };
    map.addLayer({
      id: "fw-routes-casing", type: "line", source: "fw-routes", layout,
      paint: {
        "line-color": c.halo,
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, ["case", ["get", "selected"], 7, 5], 16,
          ["case", ["get", "selected"], 14, 10]],
        "line-opacity": ["case", ["get", "selected"], 1, 0.7],
      },
    });
    map.addLayer({
      id: "fw-routes", type: "line", source: "fw-routes", layout,
      // The chosen route in the accent colour and the others in grey, as map apps draw options.
      paint: {
        "line-color": ["case", ["get", "selected"], c.accent, c.alt],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, ["case", ["get", "selected"], 4.5, 3], 16,
          ["case", ["get", "selected"], 8, 6]],
        "line-opacity": ["case", ["get", "selected"], 0.95, 0.75],
      },
    });
    // The area's cameras, from as far out as a metro fits the screen. Further out (only the
    // country's map zooms out that far) they're specks like every other camera in the country.
    const fadeIn = (): ExpressionSpecification => ["interpolate", ["linear"], ["zoom"], 6.5, 0, 7.5, 1];
    map.addLayer({
      id: "fw-cameras-any", type: "circle", source: "fw-cameras", minzoom: 6.5, filter: ["==", ["get", "mode"], "any"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.5, 13, 3, 16, 6],
        "circle-color": ["match", ["get", "on"], "route", c.route, "avoided", c.avoided, c.camera],
        "circle-opacity": fadeIn(),
        "circle-stroke-color": c.halo,
        "circle-stroke-width": 1.5,
        "circle-stroke-opacity": fadeIn(),
      },
    });
    map.addLayer({
      id: "fw-cameras", type: "symbol", source: "fw-cameras", minzoom: 6.5, filter: ["!=", ["get", "mode"], "any"],
      layout: {
        "icon-image": ["match", ["get", "on"], "route", "fw-cam-route", "avoided", "fw-cam-avoided", "fw-cam"],
        "icon-rotate": ["get", "bearing"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        // Small at city scale so routes stay readable; cameras that matter draw larger.
        "icon-size": ["interpolate", ["linear"], ["zoom"],
          9, ["case", ["==", ["get", "on"], ""], 0.22, 0.45],
          13, ["case", ["==", ["get", "on"], ""], 0.5, 0.75],
          16, ["case", ["==", ["get", "on"], ""], 0.95, 1.15]],
        "symbol-sort-key": ["case", ["==", ["get", "on"], ""], 0, 1],
      },
      paint: {
        "icon-opacity": ["interpolate", ["linear"], ["zoom"], 6.5, 0, 7.5, ["case", ["==", ["get", "on"], ""], 0.55, 1],
          9, ["case", ["==", ["get", "on"], ""], 0.55, 1], 14, 1],
      },
    });
  }

  /** The cameras, their zones and (`ringRangeM` over 0) their rings. */
  setCameras(cameras: readonly CameraDTO[], zone: { rangeM: number }, stateOf: (site: number) => CameraState,
    ringRangeM = 0): void {
    const points: Feature<Point>[] = [];
    const zones: Feature[] = [];
    const rings: Feature[] = [];
    cameras.forEach((c, index) => {
      if (ringRangeM > 0) {
        for (const [bearing, halfAngle] of c.ring) {
          rings.push({ type: "Feature", properties: { site: c.site },
            geometry: { type: "Polygon", coordinates: [sector(c.lon, c.lat, bearing, halfAngle, ringRangeM)] } });
        }
      }
      for (const [bearing, halfAngle] of c.sectors) {
        const properties = { index, site: c.site, mode: c.mode, bearing, on: stateOf(c.site) };
        points.push({ type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] }, properties });
        zones.push({
          type: "Feature", properties,
          geometry: { type: "Polygon", coordinates: [sector(c.lon, c.lat, bearing, halfAngle, zone.rangeM)] },
        });
      }
    });
    this.source("fw-cameras").setData({ type: "FeatureCollection", features: points });
    this.source("fw-zones").setData({ type: "FeatureCollection", features: zones });
    this.source("fw-rings").setData({ type: "FeatureCollection", features: rings });
  }

  /**
   * Every camera in the country (`nation`, or nothing), with `area` the box the loaded area's own
   * cameras cover: the dots leave that to them. The same data and area again cost nothing.
   */
  setNation(nation: NationCameras | null, area: Bbox | null): void {
    const key = area?.join() ?? "";
    if (nation === this.nation && key === this.nationArea) return;
    this.nation = nation;
    this.nationArea = key;
    // Two features, the cameras inside the area and the rest: one point object each, not 100,000.
    const inside: [number, number][] = [], outside: [number, number][] = [];
    const p = nation?.points ?? [];
    for (let i = 0; i + 1 < p.length; i += 2) {
      const x = p[i], y = p[i + 1];
      (area && x >= area[0] && x <= area[2] && y >= area[1] && y <= area[3] ? inside : outside).push([x, y]);
    }
    const part = (isInside: boolean, coordinates: [number, number][]): Feature => ({
      type: "Feature", properties: { inside: isInside }, geometry: { type: "MultiPoint", coordinates },
    });
    this.source("fw-nation").setData({ type: "FeatureCollection", features: [part(true, inside), part(false, outside)] });
  }

  /** Draw the route options; the selected one sits on top, the rest stay tappable behind it. */
  setRoutes(lines: readonly RouteLine[]): void {
    this.source("fw-routes").setData({
      type: "FeatureCollection",
      features: lines.map((l): Feature => ({
        type: "Feature",
        properties: { selected: l.selected, order: l.selected ? 1 : 0, index: l.index },
        geometry: { type: "LineString", coordinates: l.coordinates },
      })),
    });
  }

  /** Circle of `accuracyM` metres round a GPS fix, or nothing. */
  setAccuracy(fix: { lon: number; lat: number; accuracyM: number } | null): void {
    this.source("fw-accuracy").setData(fix
      ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {},
        geometry: { type: "Polygon", coordinates: [sector(fix.lon, fix.lat, 0, 180, fix.accuracyM)] } }] }
      : EMPTY);
  }

  /** Index (into the camera list) of a camera drawn at this screen point, if any. */
  cameraAt(point: PointLike): number | null {
    const hit = this.map.queryRenderedFeatures(point, { layers: CAMERA_LAYERS })[0];
    return hit ? (hit.properties.index as number) : null;
  }

  private source(id: string): GeoJSONSource {
    return this.map.getSource(id) as GeoJSONSource;
  }
}
