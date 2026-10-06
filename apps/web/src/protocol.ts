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
  /** When the road data was current in OpenStreetMap, if the pack says. */
  osmAt?: string;
  /** When the camera feed was made. */
  camerasAt?: string;
}

export type Request =
  /** `packBytes` is the download's size from the manifest, for the progress bar. */
  | {
    type: "load"; packUrl: string; packBytes: number; packSha256?: string; camerasUrl: string; profile: ProfileName;
    /** The last pack that loaded, used if this one fails (download, checksum or decode). */
    fallback?: { url: string; sha256?: string } | null;
  }
  /** Fetch the camera feed again (the app came back on screen) and recompute the zones. */
  | { type: "cameras"; camerasUrl: string }
  | { type: "profile"; profile: ProfileName }
  | { type: "route"; id: number; from: LonLat; to: LonLat }
  | { type: "capturing"; id: number; lon: number; lat: number; heading: number };

export type Response =
  /** The road pack downloading (bytes so far of `total`), then being unzipped. */
  | { type: "progress"; loaded: number; total: number; unpacking?: boolean }
  /** `pack.fellBack`: the new pack failed and the previous one is in use. */
  | { type: "ready"; stats: Stats; cameras: CameraDTO[]; zone: ZoneParams; pack: { url: string; fellBack: boolean; failed?: string } }
  /** `routes` run fastest first, each with strictly fewer camera zones than the last. */
  | { type: "route"; id: number; routes: RouteDTO[]; recommended: number; probes: number; ms: number }
  | { type: "noroute"; id: number; reason: string }
  | { type: "capturing"; id: number; sites: number[] }
  /** `badPack`: a road pack that failed its checks, so the cached copy should go. */
  | { type: "error"; message: string; badPack?: string };
