// Every camera in the country, positions only: cameras/us.json.gz, written hourly by
// pipeline/refresh_cameras.py. The map draws it zoomed out (a heat map of where cameras cluster)
// and, closer in, as dots outside the loaded area, whose own cameras draw in full.

import { fetchOk } from "./fetch-data.ts";

/** Where every camera is, as the hourly job last saw it. */
export interface NationCameras {
  count: number;
  builtAt: string;
  /** lon, lat, lon, lat, ... */
  points: Float64Array;
}

/** The file as published (see encode_national in pipeline/refresh_cameras.py). */
export interface NationalFile {
  built_at: string;
  count: number;
  /** Positions are whole numbers of 1/scale degrees. */
  scale: number;
  /** dlon, dlat, dlon, dlat, ...: each pair a step from the camera before, the first from 0, 0. */
  points: number[];
}

export function decodeNation(file: NationalFile): NationCameras {
  const steps = file.points;
  const points = new Float64Array(steps.length - (steps.length % 2));
  let x = 0, y = 0;
  for (let i = 0; i < points.length; i += 2) {
    x += steps[i];
    y += steps[i + 1];
    points[i] = x / file.scale;
    points[i + 1] = y / file.scale;
  }
  return { count: points.length / 2, builtAt: file.built_at, points };
}

export async function loadNation(url: string): Promise<NationCameras> {
  const bytes = new Uint8Array(await (await fetchOk(url)).arrayBuffer());
  // Published gzipped. A host or proxy that already decoded it hands over the JSON itself.
  const text = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
    : new TextDecoder().decode(bytes);
  return decodeNation(JSON.parse(text) as NationalFile);
}
