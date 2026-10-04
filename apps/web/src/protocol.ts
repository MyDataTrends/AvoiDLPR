// Messages between the page and the routing worker.
import type { HeadingMode, ZoneParams } from "@flockwatch/router";

export type ProfileName = "strict" | "default" | "loose";
export type LonLat = [number, number];

export interface CameraDTO {
  osmId: number;
  lon: number;
  lat: number;
  brand: string;
  mode: HeadingMode;
  /** [bearing, half-angle] per sector, degrees. */
  sectors: [number, number][];
  site: number;
}

export interface SiteDTO {
  site: number;
  /** Metres along the route where the capture zone starts and ends. */
  atM: number;
  untilM: number;
  cameras: CameraDTO[];
}

export interface RouteDTO {
  timeS: number;
  distanceM: number;
  turns: number;
  coordinates: LonLat[];
  sites: SiteDTO[];
}

export interface Stats {
  nodes: number;
  edges: number;
  cameras: number;
  sites: number;
  packMB: number;
  loadMs: number;
  source: string;
  builtAt: string;
  bbox: [number, number, number, number];
  lat0: number;
  lon0: number;
}

export type Request =
  | { type: "load"; packUrl: string; camerasUrl: string; profile: ProfileName }
  | { type: "profile"; profile: ProfileName }
  | { type: "route"; id: number; from: LonLat; to: LonLat }
  | { type: "capturing"; id: number; lon: number; lat: number; heading: number };

export type Response =
  | { type: "ready"; stats: Stats; cameras: CameraDTO[]; zone: ZoneParams }
  /** `routes` run fastest first, each with strictly fewer camera zones than the last. */
  | { type: "route"; id: number; routes: RouteDTO[]; recommended: number; probes: number; ms: number }
  | { type: "noroute"; id: number; reason: string }
  | { type: "capturing"; id: number; sites: number[] }
  | { type: "error"; message: string };
