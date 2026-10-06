/**
 * Place index (FWP1) decoder and search. Format, and what goes in it: pipeline/places.py.
 *
 * Search runs where routing does, on the device: an area's index is downloaded once and nothing
 * typed into the search box leaves the page. A query is words, in any order, each a whole word or
 * the start of one ("mai st" finds Main Street), with the usual street abbreviations read either
 * way ("E Belt Line Rd" finds East Belt Line Road). A query that starts with a number looks for a
 * house number on the streets the rest of it names. Results rank by how well they match, how
 * notable the place is (an airport above a shop), and how near it is.
 */

type DType = "uint8" | "uint16" | "int32" | "uint32";

interface SectionInfo {
  name: string;
  dtype: DType;
  offset: number;
  length: number;
}

export interface PlacesMeta {
  format: string;
  version: number;
  built_at: string;
  osm_at?: string;
  fingerprint: string;
  coord_scale: number;
  bbox: [number, number, number, number];
  kinds: { label: string; rank: number }[];
  counts: { streets: number; addresses: number; places: number };
  stats?: Record<string, number>;
  sections: SectionInfo[];
}

export interface PlaceIndex {
  meta: PlacesMeta;
  strings: string[];
  streetName: Uint32Array;
  streetTown: Uint32Array;
  /** Points along street s are streetPtPtr[s] .. streetPtPtr[s + 1] - 1. */
  streetPtPtr: Uint32Array;
  streetPtLon: Float64Array;
  streetPtLat: Float64Array;
  /** Addresses of street s are streetAddrPtr[s] .. streetAddrPtr[s + 1] - 1, by number. */
  streetAddrPtr: Uint32Array;
  /** The number each address starts with ("12" for "12B"); 0 for none. */
  addrLead: Int32Array;
  /** Addresses whose number is more than digits ("12B", "4-6"): address -> string id. */
  addrText: Map<number, number>;
  addrLon: Float64Array;
  addrLat: Float64Array;
  placeName: Uint32Array;
  placeAlt: Uint32Array;
  placeKind: Uint16Array;
  placeTown: Uint32Array;
  placeLon: Float64Array;
  placeLat: Float64Array;
}

const MAGIC = "FWP1";
const VERSION = 1;
/** "No string" in a string column. */
export const NONE = 0xffffffff;
const CTORS = { uint8: Uint8Array, uint16: Uint16Array, int32: Int32Array, uint32: Uint32Array } as const;

/** `buf` must be a whole ArrayBuffer (offset 0), so 8-aligned sections stay aligned. */
export function decodePlaces(buf: ArrayBuffer): PlaceIndex {
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== MAGIC) throw new Error(`not a place index (magic ${JSON.stringify(magic)})`);
  const view = new DataView(buf);
  const version = view.getUint32(4, true);
  if (version !== VERSION) throw new Error(`place index version ${version}, expected ${VERSION}`);
  const headerLen = view.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, headerLen))) as PlacesMeta;
  const base = 12 + headerLen;
  const byName = new Map(meta.sections.map((s) => [s.name, s]));
  const section = <K extends DType>(name: string, dtype: K): InstanceType<(typeof CTORS)[K]> => {
    const s = byName.get(name);
    if (!s || s.dtype !== dtype) throw new Error(`place index: missing ${dtype} section ${name}`);
    return new CTORS[dtype](buf, base + s.offset, s.length) as InstanceType<(typeof CTORS)[K]>;
  };

  const textPtr = section("text_ptr", "uint32");
  const text = section("text", "uint8");
  const decoder = new TextDecoder();
  const strings = new Array<string>(textPtr.length - 1);
  for (let i = 0; i < strings.length; i++) strings[i] = decoder.decode(text.subarray(textPtr[i], textPtr[i + 1]));

  const scale = meta.coord_scale;
  const degrees = (a: Int32Array, cumulative = false): Float64Array => {
    const out = new Float64Array(a.length);
    let v = 0;
    for (let i = 0; i < a.length; i++) {
      v = cumulative ? v + a[i] : a[i];
      out[i] = v / scale;
    }
    return out;
  };

  // House numbers are stored as steps along each street; add them back up.
  const streetAddrPtr = section("street_addr_ptr", "uint32");
  const steps = section("addr_num", "int32");
  const addrLead = new Int32Array(steps.length);
  for (let s = 0; s + 1 < streetAddrPtr.length; s++) {
    let v = 0;
    for (let k = streetAddrPtr[s]; k < streetAddrPtr[s + 1]; k++) {
      v += steps[k];
      addrLead[k] = v;
    }
  }
  const textAt = section("addr_text_at", "uint32");
  const textId = section("addr_text", "uint32");
  const addrText = new Map<number, number>();
  for (let i = 0; i < textAt.length; i++) addrText.set(textAt[i], textId[i]);

  return {
    meta, strings,
    streetName: section("street_name", "uint32"), streetTown: section("street_town", "uint32"),
    streetPtPtr: section("street_pt_ptr", "uint32"),
    streetPtLon: degrees(section("street_pt_lon", "int32")), streetPtLat: degrees(section("street_pt_lat", "int32")),
    streetAddrPtr, addrLead, addrText,
    addrLon: degrees(section("addr_dlon", "int32"), true), addrLat: degrees(section("addr_dlat", "int32"), true),
    placeName: section("place_name", "uint32"), placeAlt: section("place_alt", "uint32"),
    placeKind: section("place_kind", "uint16"), placeTown: section("place_town", "uint32"),
    placeLon: degrees(section("place_lon", "int32")), placeLat: degrees(section("place_lat", "int32")),
  };
}

// ---------- words ----------

/** Lower case, no accents or apostrophes, split on anything that isn't a letter or digit. */
export function words(text: string): string[] {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/['’`]/g, "").replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// One spelling for each common abbreviation, as pipeline/places.py has it ("street" and "st" are
// both "st"), so either matches the other.
const SHORT: Record<string, string> = {
  street: "st", saint: "st", avenue: "ave", av: "ave", road: "rd", drive: "dr", boulevard: "blvd", lane: "ln",
  court: "ct", place: "pl", parkway: "pkwy", pky: "pkwy", highway: "hwy", freeway: "fwy", expressway: "expy",
  circle: "cir", terrace: "ter", trail: "trl", square: "sq", cove: "cv", crossing: "xing", point: "pt",
  mount: "mt", fort: "ft", heights: "hts", junction: "jct", loop: "lp", plaza: "plz", alley: "aly", bypass: "byp",
  creek: "crk", estates: "ests", grove: "grv", harbor: "hbr", hollow: "holw", meadow: "mdw", meadows: "mdws",
  ridge: "rdg", springs: "spgs", spring: "spg", turnpike: "tpke", trace: "trce", valley: "vly", view: "vw",
  vista: "vis", north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se",
  southwest: "sw", center: "ctr", centre: "ctr", international: "intl", university: "univ",
};

export function canonical(word: string): string {
  return SHORT[word] ?? word;
}

/** " w1 w2 … " so that `includes(" " + q)` finds a word starting with q, `" " + q + " "` a whole one. */
function hay(ws: string[]): string {
  return ` ${ws.join(" ")} `;
}

// ---------- search ----------

export type PlaceResultKind = "address" | "street" | "place" | "coordinates";

export interface PlaceResult {
  kind: PlaceResultKind;
  /** "104 Main Street", "Bean There", "Main Street", "35.22710, -80.84310" */
  name: string;
  /** What tells it apart: "Café · Gridville", "Street · Eastville". */
  detail: string;
  lon: number;
  lat: number;
  /** An address the map doesn't have, placed between the nearest numbers it does. */
  approximate?: boolean;
  /** Metres from the point the search was near. */
  distanceM?: number;
}

export interface SearchOptions {
  /** Rank nearer results higher: the map's centre, or where you are. */
  near?: [number, number];
  limit?: number;
}

interface Entry {
  words: string;
  canon: string;
  /** The whole name and each other name, canonical words joined: "the query is the whole name". */
  whole: string[];
}

interface Scored extends PlaceResult {
  score: number;
}

const EXACT = 3;
const PREFIX = 2;
const KIND = 1.5;
const TOWN = 1;
/**
 * A result loses this much score per doubling of its distance in km; a notable place less (an
 * airport across town is still the airport you mean), by a quarter per rank.
 */
const DISTANCE_WEIGHT = 1.5;
/** Saying a place's whole name (or one of its other names: "DFW") is worth this. */
const WHOLE_NAME = 3;
const HOUSE_NUMBER = /^\d{1,6}[a-z]?$/;
/** How far apart two house numbers may be to place one between them. */
const INTERPOLATE_MAX_M = 1000;

function entry(text: string, alt?: string): Entry {
  const ws = words(alt ? `${text} ${alt}` : text);
  const whole = [text, ...(alt ? alt.split(" · ") : [])].map((n) => words(n).map(canonical).join(" "));
  return { words: hay(ws), canon: hay(ws.map(canonical)), whole };
}

/** How a query word matches an entry: EXACT (a whole word), PREFIX (the start of one), or 0. */
function match(e: Entry, q: string, cq: string): number {
  if (e.canon.includes(` ${cq} `)) return EXACT;
  return e.words.includes(` ${q}`) || e.canon.includes(` ${cq}`) ? PREFIX : 0;
}

export function metresBetween(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const kx = 111_320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * 111_320);
}

/**
 * "35.2271, -80.8431" as a point [lon, lat], when it is one. Latitude comes first, as map apps
 * copy it, unless only the other order is a place on Earth, or only the other order is inside
 * `bbox` ("-80.8431 35.2271" in Charlotte).
 */
export function parseCoordinates(text: string, bbox?: readonly [number, number, number, number]): [number, number] | null {
  const m = text.trim().match(/^(-?\d{1,3}(?:\.\d+)?)°?\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)°?$/);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  const latFirst: [number, number] | null = Math.abs(a) <= 90 && Math.abs(b) <= 180 ? [b, a] : null;
  const lonFirst: [number, number] | null = Math.abs(b) <= 90 && Math.abs(a) <= 180 ? [a, b] : null;
  const inside = (p: [number, number]) => bbox !== undefined && p[0] >= bbox[0] && p[0] <= bbox[2] && p[1] >= bbox[1] && p[1] <= bbox[3];
  if (latFirst && lonFirst && !inside(latFirst) && inside(lonFirst)) return lonFirst;
  return latFirst ?? lonFirst;
}

export class PlaceSearch {
  readonly index: PlaceIndex;
  private readonly streets: Entry[];
  private readonly places: Entry[];
  private readonly kinds: Entry[];
  private readonly towns = new Map<number, Entry>();
  private grid: Map<number, number[]> | null = null;

  constructor(index: PlaceIndex) {
    this.index = index;
    const s = index.strings;
    this.streets = Array.from(index.streetName, (n) => entry(s[n]));
    this.places = Array.from(index.placeName, (n, i) => entry(s[n], index.placeAlt[i] === NONE ? undefined : s[index.placeAlt[i]]));
    this.kinds = index.meta.kinds.map((k) => entry(k.label));
  }

  private town(id: number): Entry | null {
    if (id === NONE) return null;
    let e = this.towns.get(id);
    if (!e) this.towns.set(id, (e = entry(this.index.strings[id])));
    return e;
  }

  private text(id: number): string {
    return id === NONE ? "" : this.index.strings[id];
  }

  search(query: string, opts: SearchOptions = {}): PlaceResult[] {
    const limit = opts.limit ?? 8;
    const out: Scored[] = [];
    const point = parseCoordinates(query, this.index.meta.bbox);
    if (point) {
      out.push({
        kind: "coordinates", name: `${point[1].toFixed(5)}, ${point[0].toFixed(5)}`, detail: "Coordinates",
        lon: point[0], lat: point[1], score: Infinity,
      });
    }
    const qs = words(query);
    if (qs.length === 0 || (qs.length === 1 && qs[0].length < 2 && !/\d/.test(qs[0]))) return out.slice(0, limit);
    const near = opts.near;
    const away = (lon: number, lat: number) => (near ? metresBetween(near[0], near[1], lon, lat) : undefined);
    const penalty = (m: number | undefined, rank = 1) =>
      (m === undefined ? 0 : DISTANCE_WEIGHT * (1 - rank / 4) * Math.log2(1 + m / 1000));

    // A leading number is a house number when the rest names a street.
    if (qs.length > 1 && HOUSE_NUMBER.test(qs[0])) out.push(...this.addresses(qs[0], qs.slice(1), near, away, penalty));

    const cqs = qs.map(canonical);
    const s = this.index;
    for (let i = 0; i < this.streets.length; i++) {
      const score = this.score(this.streets[i], null, this.town(s.streetTown[i]), qs, cqs);
      if (score <= 0) continue;
      const [lon, lat] = this.streetPoint(i, near);
      const d = away(lon, lat);
      out.push({
        kind: "street", name: s.strings[s.streetName[i]], detail: ["Street", this.text(s.streetTown[i])].filter(Boolean).join(" · "),
        lon, lat, distanceM: d, score: score + 1 - penalty(d),
      });
    }
    for (let i = 0; i < this.places.length; i++) {
      const kind = s.meta.kinds[s.placeKind[i]];
      const score = this.score(this.places[i], this.kinds[s.placeKind[i]], this.town(s.placeTown[i]), qs, cqs);
      if (score <= 0) continue;
      const d = away(s.placeLon[i], s.placeLat[i]);
      out.push({
        kind: "place", name: s.strings[s.placeName[i]], detail: [kind.label, this.text(s.placeTown[i])].filter(Boolean).join(" · "),
        lon: s.placeLon[i], lat: s.placeLat[i], distanceM: d, score: score + kind.rank - penalty(d, kind.rank),
      });
    }

    // Best first, without repeats: a street listed twice in one town (its name lapses for a
    // stretch), or one place mapped twice (a station's platforms; the town line between them).
    out.sort((a, b) => b.score - a.score);
    const kept: Scored[] = [];
    const kindOf = (r: Scored) => r.detail.split(" · ")[0];
    for (const r of out) {
      if (kept.some((k) => k.name === r.name && (r.kind === "place"
        ? kindOf(k) === kindOf(r) && metresBetween(k.lon, k.lat, r.lon, r.lat) < 500
        : k.detail === r.detail && metresBetween(k.lon, k.lat, r.lon, r.lat) < 3000))) continue;
      kept.push(r);
      if (kept.length === limit) break;
    }
    return kept.map(({ score: _, ...r }) => r);
  }

  /**
   * How well an entry matches: every query word must match its name, its kind ("airport") or its
   * town ("gridville"), and at least one must match the name, unless all of them name the kind.
   */
  private score(e: Entry, kind: Entry | null, town: Entry | null, qs: string[], cqs: string[]): number {
    let score = 0, named = 0, exact = 0, kinds = 0;
    for (let k = 0; k < qs.length; k++) {
      const m = match(e, qs[k], cqs[k]);
      if (m) {
        score += m;
        named++;
        if (m === EXACT) exact++;
        continue;
      }
      if (kind && match(kind, qs[k], cqs[k])) {
        score += KIND;
        kinds++;
        continue;
      }
      if (town && match(town, qs[k], cqs[k])) {
        score += TOWN;
        continue;
      }
      return 0;
    }
    if (named === 0 && kinds < qs.length) return 0;
    if (exact === qs.length && e.whole.includes(cqs.join(" "))) score += WHOLE_NAME;
    return score;
  }

  /** The point along a street nearest `near` (its middle one without). */
  private streetPoint(i: number, near?: [number, number]): [number, number] {
    const s = this.index;
    const from = s.streetPtPtr[i], to = s.streetPtPtr[i + 1];
    let best = from + ((to - from) >> 1);
    if (near) {
      let bestD = Infinity;
      for (let k = from; k < to; k++) {
        const d = metresBetween(near[0], near[1], s.streetPtLon[k], s.streetPtLat[k]);
        if (d < bestD) [best, bestD] = [k, d];
      }
    }
    return [s.streetPtLon[best], s.streetPtLat[best]];
  }

  private numberText(k: number): string {
    const t = this.index.addrText.get(k);
    return t === undefined ? String(this.index.addrLead[k]) : this.index.strings[t];
  }

  /** "104 main": number 104 on each street that "main" names, or placed between its neighbours. */
  private addresses(number: string, rest: string[], near: [number, number] | undefined,
    away: (lon: number, lat: number) => number | undefined, penalty: (m: number | undefined) => number): Scored[] {
    const s = this.index;
    const crest = rest.map(canonical);
    const lead = parseInt(number, 10);
    const out: Scored[] = [];
    for (let i = 0; i < this.streets.length; i++) {
      const score = this.score(this.streets[i], null, this.town(s.streetTown[i]), rest, crest);
      if (score <= 0) continue;
      const street = s.strings[s.streetName[i]];
      const town = this.text(s.streetTown[i]);
      const from = s.streetAddrPtr[i], to = s.streetAddrPtr[i + 1];
      // The first address numbered `lead` or higher (numbers rise along the street).
      let lo = from, hi = to;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (s.addrLead[mid] < lead) lo = mid + 1;
        else hi = mid;
      }
      let found = -1;
      for (let k = lo; k < to && s.addrLead[k] === lead; k++) {
        const t = this.numberText(k).toLowerCase();
        if (t === number) {
          found = k;
          break;
        }
        if (found < 0 && t.startsWith(number)) found = k; // "12" finds "12B" when there's no plain 12
      }
      if (found >= 0) {
        const d = away(s.addrLon[found], s.addrLat[found]);
        out.push({
          kind: "address", name: `${this.numberText(found)} ${street}`, detail: town,
          lon: s.addrLon[found], lat: s.addrLat[found], distanceM: d, score: score + 6 - penalty(d),
        });
        continue;
      }
      const guess = this.between(from, to, lo, lead);
      if (guess) {
        const d = away(guess[0], guess[1]);
        out.push({
          kind: "address", name: `${number.toUpperCase()} ${street}`, detail: ["Approximate", town].filter(Boolean).join(" · "),
          lon: guess[0], lat: guess[1], approximate: true, distanceM: d, score: score + 4 - penalty(d),
        });
        continue;
      }
      // The map has no number to go on here: offer the street itself.
      const [lon, lat] = this.streetPoint(i, near);
      const d = away(lon, lat);
      out.push({
        kind: "street", name: street, detail: ["Street", town].filter(Boolean).join(" · "),
        lon, lat, distanceM: d, score: score + 1 - penalty(d),
      });
    }
    return out;
  }

  /**
   * Where number `lead` would be on a street, from the nearest numbers below and above it on the
   * same side (same parity, as US streets number their sides), if they're close enough to trust.
   */
  private between(from: number, to: number, at: number, lead: number): [number, number] | null {
    const s = this.index;
    let below = -1, above = -1;
    for (let k = at - 1; k >= from; k--) {
      if (s.addrLead[k] > 0 && s.addrLead[k] % 2 === lead % 2) {
        below = k;
        break;
      }
    }
    for (let k = at; k < to; k++) {
      if (s.addrLead[k] > lead && s.addrLead[k] % 2 === lead % 2) {
        above = k;
        break;
      }
    }
    if (below < 0 || above < 0) return null;
    if (metresBetween(s.addrLon[below], s.addrLat[below], s.addrLon[above], s.addrLat[above]) > INTERPOLATE_MAX_M) return null;
    const t = (lead - s.addrLead[below]) / (s.addrLead[above] - s.addrLead[below]);
    return [s.addrLon[below] + t * (s.addrLon[above] - s.addrLon[below]), s.addrLat[below] + t * (s.addrLat[above] - s.addrLat[below])];
  }

  // ---------- what's here ----------

  /** The address or place nearest a point, within `maxM` (for naming a spot tapped on the map). */
  nearest(lon: number, lat: number, maxM = 100): PlaceResult | null {
    const grid = this.grid ?? (this.grid = this.buildGrid());
    const s = this.index;
    const cx = Math.floor(lon / CELL), cy = Math.floor(lat / CELL);
    // Cells to look through each way: a cell is narrower east-west the further from the equator.
    const reach = Math.ceil(maxM / (CELL * 111_320 * Math.cos((lat * Math.PI) / 180)));
    let best: PlaceResult | null = null, bestD = maxM;
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (const item of grid.get(cellKey(cx + dx, cy + dy)) ?? []) {
          const isPlace = item < 0;
          const k = isPlace ? -item - 1 : item;
          const plon = isPlace ? s.placeLon[k] : s.addrLon[k], plat = isPlace ? s.placeLat[k] : s.addrLat[k];
          // A named place wins over a house number a few metres nearer.
          const d = metresBetween(lon, lat, plon, plat) - (isPlace ? 15 : 0);
          if (d >= bestD) continue;
          bestD = d;
          best = isPlace
            ? { kind: "place", name: s.strings[s.placeName[k]], detail: s.meta.kinds[s.placeKind[k]].label, lon: plon, lat: plat }
            : this.address(k, plon, plat);
        }
      }
    }
    if (best) best.distanceM = Math.max(0, metresBetween(lon, lat, best.lon, best.lat));
    return best;
  }

  private address(k: number, lon: number, lat: number): PlaceResult {
    const s = this.index;
    // The address's street: the one whose range holds k.
    let lo = 0, hi = s.streetAddrPtr.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s.streetAddrPtr[mid] <= k) lo = mid;
      else hi = mid - 1;
    }
    return { kind: "address", name: `${this.numberText(k)} ${s.strings[s.streetName[lo]]}`, detail: this.text(s.streetTown[lo]), lon, lat };
  }

  private buildGrid(): Map<number, number[]> {
    const s = this.index;
    const grid = new Map<number, number[]>();
    const add = (lon: number, lat: number, item: number) => {
      const key = cellKey(Math.floor(lon / CELL), Math.floor(lat / CELL));
      const cell = grid.get(key);
      if (cell) cell.push(item);
      else grid.set(key, [item]);
    };
    for (let k = 0; k < s.addrLon.length; k++) add(s.addrLon[k], s.addrLat[k], k);
    for (let k = 0; k < s.placeLon.length; k++) add(s.placeLon[k], s.placeLat[k], -k - 1);
    return grid;
  }
}

/** Grid cells for `nearest`, in degrees: about 110 m north-south. */
const CELL = 0.001;
const cellKey = (cx: number, cy: number) => cx * 400_000 + cy;
