// Map setup: a self-hosted Protomaps basemap (tiles, fonts and icons all from this origin)
// plus overlays for routes, cameras, capture zones, the GPS accuracy circle and the car.
import { layers, namedFlavor } from "@protomaps/basemaps";
import type { Feature, FeatureCollection, Point } from "geojson";
import {
  addProtocol, type GeoJSONSource, type LineLayerSpecification, Map as MapLibreMap, type PointLike, setWorkerUrl,
  type StyleSpecification,
} from "maplibre-gl";
// MapLibre locates its tile worker relative to its own module URL, which bundlers relocate;
// let Vite build the worker and hand MapLibre the result.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { Protocol } from "pmtiles";

import type { Fix } from "./drive.ts";
import type { CameraDTO } from "./protocol.ts";

export const COLORS = {
  camera: "#495057",
  /** A camera on the selected route. */
  route: "#e03131",
  /** A camera on the fastest route that the selected route avoids. */
  avoided: "#2f9e44",
  zone: "#e03131",
  car: "#212529",
  gps: "#1c64f2",
} as const;

/** Where a camera stands relative to the selected route. */
export type CameraState = "route" | "avoided" | "";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const CAMERA_LAYERS = ["fw-cameras", "fw-cameras-any"];
let protocolRegistered = false;

/** Absolute URLs of the basemap's pieces (see data.ts): the tile archive, label fonts and icon sprites. */
export interface BasemapUrls {
  pmtiles: string;
  glyphs: string;
  sprite: string;
}

export function createMap(container: HTMLElement, bbox: [number, number, number, number], urls: BasemapUrls): MapLibreMap {
  if (!protocolRegistered) {
    setWorkerUrl(maplibreWorkerUrl);
    addProtocol("pmtiles", new Protocol().tile);
    protocolRegistered = true;
  }
  const style: StyleSpecification = {
    version: 8,
    glyphs: urls.glyphs,
    sprite: urls.sprite,
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${urls.pmtiles}`,
        attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · cameras via <a href="https://deflock.org">DeFlock</a>',
      },
    },
    layers: layers("protomaps", namedFlavor("light"), { lang: "en" }),
  };
  const [w, s, e, n] = bbox;
  return new MapLibreMap({
    container,
    style,
    bounds: [[w, s], [e, n]],
    maxBounds: [[w - 0.2, s - 0.15], [e + 0.2, n + 0.15]],
    attributionControl: { compact: true },
  });
}

/** An arrowhead pointing up (north); the map rotates it to each camera's bearing. */
function arrow(fill: string): ImageData {
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
  g.strokeStyle = "#ffffff";
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
  color: string;
  selected: boolean;
  /** Index into the route list, so a tap on the line can select it. */
  index: number;
}

export class Overlays {
  private readonly map: MapLibreMap;

  constructor(map: MapLibreMap) {
    this.map = map;
    for (const [name, color] of [["fw-cam", COLORS.camera], ["fw-cam-route", COLORS.route],
      ["fw-cam-avoided", COLORS.avoided], ["fw-car", COLORS.car]] as const) {
      map.addImage(name, arrow(color), { pixelRatio: 2 });
    }
    for (const id of ["fw-accuracy", "fw-zones", "fw-routes", "fw-cameras", "fw-car"]) {
      map.addSource(id, { type: "geojson", data: EMPTY });
    }

    map.addLayer({
      id: "fw-accuracy", type: "fill", source: "fw-accuracy",
      paint: { "fill-color": COLORS.gps, "fill-opacity": 0.12, "fill-outline-color": COLORS.gps },
    });
    map.addLayer({
      id: "fw-zones", type: "fill", source: "fw-zones", minzoom: 13,
      paint: { "fill-color": COLORS.zone, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.08, 16, 0.2] },
    });
    // Selected routes draw last (on top); `order` is 1 for them, 0 for the rest.
    const layout: LineLayerSpecification["layout"] = {
      "line-join": "round", "line-cap": "round", "line-sort-key": ["get", "order"],
    };
    map.addLayer({
      id: "fw-routes-casing", type: "line", source: "fw-routes", layout,
      paint: {
        "line-color": "#ffffff",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, ["case", ["get", "selected"], 7, 5], 16,
          ["case", ["get", "selected"], 14, 10]],
        "line-opacity": ["case", ["get", "selected"], 1, 0.7],
      },
    });
    map.addLayer({
      id: "fw-routes", type: "line", source: "fw-routes", layout,
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, ["case", ["get", "selected"], 4.5, 3], 16,
          ["case", ["get", "selected"], 8, 6]],
        "line-opacity": ["case", ["get", "selected"], 0.95, 0.55],
      },
    });
    map.addLayer({
      id: "fw-cameras-any", type: "circle", source: "fw-cameras", filter: ["==", ["get", "mode"], "any"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.5, 13, 3, 16, 6],
        "circle-color": ["match", ["get", "on"], "route", COLORS.route, "avoided", COLORS.avoided, COLORS.camera],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
      },
    });
    map.addLayer({
      id: "fw-cameras", type: "symbol", source: "fw-cameras", filter: ["!=", ["get", "mode"], "any"],
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
        "icon-opacity": ["interpolate", ["linear"], ["zoom"], 9, ["case", ["==", ["get", "on"], ""], 0.55, 1], 14, 1],
      },
    });
    map.addLayer({
      id: "fw-car", type: "symbol", source: "fw-car",
      layout: {
        "icon-image": "fw-car", "icon-rotate": ["get", "heading"], "icon-rotation-alignment": "map",
        "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-size": 1.4,
      },
    });
  }

  setCameras(cameras: readonly CameraDTO[], zone: { rangeM: number }, stateOf: (site: number) => CameraState): void {
    const points: Feature<Point>[] = [];
    const zones: Feature[] = [];
    cameras.forEach((c, index) => {
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
  }

  /** Draw the route options; the selected one sits on top, the rest stay tappable behind it. */
  setRoutes(lines: readonly RouteLine[]): void {
    this.source("fw-routes").setData({
      type: "FeatureCollection",
      features: lines.map((l): Feature => ({
        type: "Feature",
        properties: { color: l.color, selected: l.selected, order: l.selected ? 1 : 0, index: l.index },
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

  setCar(fix: Fix | null): void {
    this.source("fw-car").setData(fix ? {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { heading: fix.heading }, geometry: { type: "Point", coordinates: [fix.lon, fix.lat] } }],
    } : EMPTY);
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
