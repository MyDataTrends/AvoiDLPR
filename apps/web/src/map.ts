// Map setup: a self-hosted Protomaps basemap (tiles, fonts and icons all from this origin)
// plus overlays for routes, cameras, capture zones and the simulated car.
import { layers, namedFlavor } from "@protomaps/basemaps";
import type { Feature, FeatureCollection, Point } from "geojson";
import {
  addProtocol, type GeoJSONSource, Map as MapLibreMap, type PointLike, setWorkerUrl, type StyleSpecification,
} from "maplibre-gl";
// MapLibre locates its tile worker relative to its own module URL, which bundlers relocate;
// let Vite build the worker and hand MapLibre the result.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { Protocol } from "pmtiles";

import type { Fix } from "./drive.ts";
import type { CameraDTO, RouteDTO } from "./protocol.ts";

export const COLORS = {
  fastest: "#d9480f",
  chosen: "#1c64f2",
  both: "#7048e8",
  camera: "#495057",
  zone: "#e03131",
  car: "#212529",
} as const;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const CAMERA_LAYERS = ["fw-cameras", "fw-cameras-any"];
let protocolRegistered = false;

export function createMap(container: HTMLElement, bbox: [number, number, number, number]): MapLibreMap {
  if (!protocolRegistered) {
    setWorkerUrl(maplibreWorkerUrl);
    addProtocol("pmtiles", new Protocol().tile);
    protocolRegistered = true;
  }
  const origin = location.origin;
  const style: StyleSpecification = {
    version: 8,
    glyphs: `${origin}/basemap/assets/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}/basemap/assets/sprites/v4/light`,
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${origin}/basemap/dallas.pmtiles`,
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

export class Overlays {
  private readonly map: MapLibreMap;

  constructor(map: MapLibreMap) {
    this.map = map;
    for (const [name, color] of [["fw-cam", COLORS.camera], ["fw-cam-fastest", COLORS.fastest],
      ["fw-cam-chosen", COLORS.chosen], ["fw-cam-both", COLORS.both], ["fw-car", COLORS.car]] as const) {
      map.addImage(name, arrow(color), { pixelRatio: 2 });
    }
    for (const id of ["fw-zones", "fw-routes", "fw-cameras", "fw-car"]) map.addSource(id, { type: "geojson", data: EMPTY });

    map.addLayer({
      id: "fw-zones", type: "fill", source: "fw-zones", minzoom: 13,
      paint: { "fill-color": COLORS.zone, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.08, 16, 0.2] },
    });
    map.addLayer({
      id: "fw-routes-casing", type: "line", source: "fw-routes",
      layout: { "line-join": "round", "line-cap": "round", "line-sort-key": ["get", "order"] },
      paint: {
        "line-color": "#ffffff",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 6, 16, 13],
        "line-opacity": ["case", ["get", "selected"], 1, 0.7],
      },
    });
    map.addLayer({
      id: "fw-routes", type: "line", source: "fw-routes",
      layout: { "line-join": "round", "line-cap": "round", "line-sort-key": ["get", "order"] },
      paint: {
        "line-color": ["match", ["get", "kind"], "fastest", COLORS.fastest, "chosen", COLORS.chosen, COLORS.both],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, ["case", ["get", "selected"], 4, 3], 16,
          ["case", ["get", "selected"], 8, 6]],
        "line-opacity": ["case", ["get", "selected"], 0.95, 0.5],
      },
    });
    map.addLayer({
      id: "fw-cameras-any", type: "circle", source: "fw-cameras", filter: ["==", ["get", "mode"], "any"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.5, 13, 3, 16, 6],
        "circle-color": ["match", ["get", "on"], "fastest", COLORS.fastest, "chosen", COLORS.chosen, "both",
          COLORS.both, COLORS.camera],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
      },
    });
    map.addLayer({
      id: "fw-cameras", type: "symbol", source: "fw-cameras", filter: ["!=", ["get", "mode"], "any"],
      layout: {
        "icon-image": ["match", ["get", "on"], "fastest", "fw-cam-fastest", "chosen", "fw-cam-chosen", "both",
          "fw-cam-both", "fw-cam"],
        "icon-rotate": ["get", "bearing"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        // Small at city scale so routes stay readable; cameras on a route draw larger.
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

  setCameras(cameras: readonly CameraDTO[], zone: { rangeM: number }, onFastest: Set<number>,
    onChosen: Set<number>): void {
    const on = (site: number) =>
      onFastest.has(site) && onChosen.has(site) ? "both" : onFastest.has(site) ? "fastest" : onChosen.has(site) ? "chosen" : "";
    const points: Feature<Point>[] = [];
    const zones: Feature[] = [];
    cameras.forEach((c, index) => {
      for (const [bearing, halfAngle] of c.sectors) {
        const properties = { index, site: c.site, mode: c.mode, bearing, on: on(c.site) };
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

  setRoutes(fastest: RouteDTO | null, chosen: RouteDTO | null, same: boolean, selected: "fastest" | "chosen"): void {
    const line = (r: RouteDTO, kind: string, isSelected: boolean): Feature => ({
      type: "Feature", properties: { kind, selected: isSelected, order: isSelected ? 1 : 0 },
      geometry: { type: "LineString", coordinates: r.coordinates },
    });
    const features: Feature[] = [];
    if (fastest && chosen && same) features.push(line(chosen, "both", true));
    else {
      if (fastest) features.push(line(fastest, "fastest", selected === "fastest"));
      if (chosen) features.push(line(chosen, "chosen", selected === "chosen"));
    }
    this.source("fw-routes").setData({ type: "FeatureCollection", features });
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
