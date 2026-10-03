// Position and heading along a route polyline, measured in the road pack's own projection so
// "metres along the route" agrees with the router's alert distances.
import { compassBearing, type LocalProjection } from "@flockwatch/router";

import type { LonLat } from "./protocol.ts";

export interface Fix {
  lon: number;
  lat: number;
  heading: number;
  distM: number;
}

export class Polyline {
  readonly lengthM: number;
  private readonly proj: LocalProjection;
  private readonly x: Float64Array;
  private readonly y: Float64Array;
  private readonly cum: Float64Array;

  constructor(coords: readonly LonLat[], proj: LocalProjection) {
    this.proj = proj;
    this.x = Float64Array.from(coords, ([lon]) => proj.x(lon));
    this.y = Float64Array.from(coords, ([, lat]) => proj.y(lat));
    this.cum = new Float64Array(coords.length);
    for (let i = 1; i < coords.length; i++) {
      this.cum[i] = this.cum[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.y[i] - this.y[i - 1]);
    }
    this.lengthM = this.cum[coords.length - 1] ?? 0;
  }

  at(distM: number): Fix {
    const d = Math.min(Math.max(distM, 0), this.lengthM);
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const seg = this.cum[hi] - this.cum[lo];
    const t = seg > 0 ? (d - this.cum[lo]) / seg : 0;
    const x = this.x[lo] + t * (this.x[hi] - this.x[lo]);
    const y = this.y[lo] + t * (this.y[hi] - this.y[lo]);
    return {
      lon: this.proj.lon(x), lat: this.proj.lat(y), distM: d,
      heading: compassBearing(this.x[hi] - this.x[lo], this.y[hi] - this.y[lo]),
    };
  }
}
