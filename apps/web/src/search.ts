// The trip's two fields, From and To, are also search boxes. What's typed is matched against the
// area's place index by the search worker, on this device: it never leaves the page. Picking a
// result sets that end of the trip; the map still takes taps, for the field used last.

import { parseCoordinates, type PlaceResult } from "@flockwatch/router";

import { distance } from "./format.ts";
import type { LonLat, SearchRequest, SearchResponse } from "./protocol.ts";

export type Stop = "from" | "to";

export interface PlacesFile {
  url: string;
  bytes: number;
  sha256?: string;
}

export interface SearchHooks {
  /** Where results should be near: the start if there is one, else the middle of the map. */
  near(): LonLat | null;
  /** The area's box, to read coordinates typed in either order. */
  bbox(): readonly [number, number, number, number];
  /** What a field shows when nobody's typing in it ("Bean There", "Your location · ±25 m"). */
  label(stop: Stop): string;
  placeholder(stop: Stop): string;
  /** A field took focus: map taps set its stop now. */
  focused(stop: Stop): void;
  picked(stop: Stop, result: PlaceResult): void;
  /** "Choose on the map": get the map in view to tap. */
  chooseOnMap(stop: Stop): void;
  /** Typing ended (the field lost focus). */
  closed(stop: Stop): void;
  loaded(url: string): void;
  failed(url: string, message: string): void;
}

/** How long typing has to pause before a search runs, in ms. */
const DEBOUNCE_MS = 100;

const ICONS: Record<PlaceResult["kind"] | "map", string> = {
  address: '<path d="M4 11l8-7 8 7M6 9.5V20h12V9.5"/>',
  street: '<path d="M8 3L5 21M16 3l3 18M12 4v3M12 10.5v3M12 17v3"/>',
  place: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0113 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  coordinates: '<circle cx="12" cy="12" r="6"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  map: '<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>',
};

export class StopSearch {
  private readonly worker = new Worker(new URL("./search-worker.ts", import.meta.url), { type: "module" });
  private readonly inputs: Record<Stop, HTMLInputElement>;
  private readonly list: HTMLElement;
  private readonly hooks: SearchHooks;
  private file: PlacesFile | null = null;
  private status: "idle" | "loading" | "ready" | "failed" = "idle";
  private progress = "";
  private failure = "";
  private editing: Stop | null = null;
  /** What was typed: the field's text once it's been edited, until it closes. */
  private query = "";
  private results: PlaceResult[] = [];
  /** Options shown (results, then "Choose on the map"), and which one the arrow keys are on. */
  private options: (PlaceResult | "map")[] = [];
  private active = -1;
  private queryId = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly nearestWaiting = new Map<number, (r: PlaceResult | null) => void>();
  private nearestId = 0;

  constructor(inputs: Record<Stop, HTMLInputElement>, list: HTMLElement, hooks: SearchHooks) {
    this.inputs = inputs;
    this.list = list;
    this.hooks = hooks;
    this.worker.onmessage = (ev: MessageEvent<SearchResponse>) => this.receive(ev.data);
    for (const stop of ["from", "to"] as const) {
      const input = inputs[stop];
      input.addEventListener("focus", () => this.open(stop));
      input.addEventListener("input", () => {
        this.query = input.value;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.run(), DEBOUNCE_MS);
      });
      input.addEventListener("keydown", (e) => this.key(e));
      input.addEventListener("blur", () => this.close());
    }
    // Keep the field focused through a tap on an option (blur would close the list first).
    list.addEventListener("pointerdown", (e) => e.preventDefault());
    list.addEventListener("click", (e) => {
      const li = (e.target as Element).closest<HTMLElement>("[data-option]");
      if (li) this.choose(Number(li.dataset.option));
    });
    this.refresh();
  }

  /** The area's place index, or null when it has none. Nothing downloads until `load()`. */
  setFile(file: PlacesFile | null): void {
    this.file = file;
    this.status = "idle";
  }

  /** Start the download, once (on first focus, or when the road map is in). */
  load(): void {
    if (!this.file || this.status === "loading" || this.status === "ready") return;
    this.status = "loading";
    this.progress = "";
    this.post({ type: "load", ...this.file });
    this.render();
  }

  get ready(): boolean {
    return this.status === "ready";
  }

  /** The address or place at a point (null without an index, or with nothing there). */
  nearest(at: LonLat): Promise<PlaceResult | null> {
    if (this.status !== "ready") return Promise.resolve(null);
    const id = ++this.nearestId;
    return new Promise((resolve) => {
      this.nearestWaiting.set(id, resolve);
      this.post({ type: "nearest", id, at });
    });
  }

  /** Show what the stops are again: they changed while nobody was typing. */
  refresh(): void {
    for (const stop of ["from", "to"] as const) {
      const input = this.inputs[stop];
      input.placeholder = this.hooks.placeholder(stop);
      if (stop !== this.editing) input.value = this.hooks.label(stop);
    }
  }

  /** Stop editing (a map tap, a route chosen): blur the field, which closes the list. */
  dismiss(): void {
    if (this.editing) this.inputs[this.editing].blur();
  }

  private post(msg: SearchRequest): void {
    this.worker.postMessage(msg);
  }

  private open(stop: Stop): void {
    this.editing = stop;
    this.query = "";
    this.results = [];
    this.active = -1;
    this.hooks.focused(stop);
    this.inputs[stop].select(); // typing replaces what's there
    this.load();
    this.render();
  }

  private close(): void {
    const stop = this.editing;
    if (!stop) return;
    clearTimeout(this.timer);
    this.editing = null;
    this.query = "";
    this.results = [];
    this.render();
    this.refresh();
    this.hooks.closed(stop);
  }

  private run(): void {
    const q = this.query.trim();
    if (!q || this.status !== "ready") {
      this.results = [];
      this.render();
      return;
    }
    this.post({ type: "search", id: ++this.queryId, query: q, near: this.hooks.near() ?? undefined });
  }

  private receive(msg: SearchResponse): void {
    if (msg.type === "progress") {
      if (msg.url !== this.file?.url) return;
      this.progress = msg.unpacking ? "Unpacking…" : msg.total ? `${Math.round((100 * msg.loaded) / msg.total)}%` : "";
      this.render();
    } else if (msg.type === "loaded") {
      if (msg.url !== this.file?.url) return;
      this.status = "ready";
      this.hooks.loaded(msg.url);
      this.run();
    } else if (msg.type === "results") {
      if (msg.id !== this.queryId || !this.editing) return;
      this.results = msg.results;
      this.active = -1;
      this.render();
    } else if (msg.type === "nearest") {
      this.nearestWaiting.get(msg.id)?.(msg.result);
      this.nearestWaiting.delete(msg.id);
    } else if (msg.type === "error") {
      this.status = "failed";
      this.failure = msg.message;
      if (msg.url) this.hooks.failed(msg.url, msg.message);
      this.render();
    }
  }

  private key(e: KeyboardEvent): void {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!this.options.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      this.active = (this.active + step + this.options.length + 1) % (this.options.length + 1);
      if (this.active === this.options.length) this.active = -1; // back to the text
      this.render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = this.active >= 0 ? this.active : this.options.findIndex((o) => o !== "map");
      if (pick >= 0) this.choose(pick);
    } else if (e.key === "Escape") {
      e.preventDefault(); // a search field would clear itself as well
      this.dismiss();
    }
  }

  private choose(i: number): void {
    const stop = this.editing, option = this.options[i];
    if (!stop || option === undefined) return;
    if (option === "map") {
      this.dismiss();
      this.hooks.chooseOnMap(stop);
      return;
    }
    this.hooks.picked(stop, option);
    this.dismiss();
  }

  /** What's typed, as a point, when it's coordinates: no index needed for those. */
  private coordinates(): PlaceResult | null {
    const p = parseCoordinates(this.query, this.hooks.bbox());
    return p ? { kind: "coordinates", name: `${p[1].toFixed(5)}, ${p[0].toFixed(5)}`, detail: "Coordinates", lon: p[0], lat: p[1] } : null;
  }

  private render(): void {
    const stop = this.editing;
    for (const s of ["from", "to"] as const) {
      this.inputs[s].setAttribute("aria-expanded", String(s === stop));
      this.inputs[s].removeAttribute("aria-activedescendant");
    }
    this.list.hidden = !stop;
    if (!stop) {
      this.list.replaceChildren();
      this.options = [];
      return;
    }
    const q = this.query.trim();
    const found = this.status === "ready" ? this.results : [this.coordinates()].filter((r): r is PlaceResult => r !== null);
    this.options = q ? [...found, "map"] : ["map"];
    const items: HTMLElement[] = [];
    let note = "";
    if (q && this.status !== "ready") {
      note = !this.file ? "Search isn't ready for this area yet: tap the map instead."
        : this.status === "failed" ? `Search couldn't load (${this.failure}). Tap the map instead.`
          : `Loading the search for this area…${this.progress ? ` ${this.progress}` : ""}`;
    } else if (q && !found.length) {
      note = `Nothing called “${q}” in this area.`;
    }
    if (note) {
      const li = document.createElement("li");
      li.className = "suggest-note";
      li.setAttribute("role", "presentation");
      li.textContent = note;
      items.push(li);
    }
    this.options.forEach((option, i) => items.push(this.option(option, i)));
    this.list.replaceChildren(...items);
    if (this.active >= 0) {
      this.inputs[stop].setAttribute("aria-activedescendant", `suggest-${this.active}`);
      this.list.querySelector(`#suggest-${this.active}`)?.scrollIntoView({ block: "nearest" });
    }
  }

  private option(option: PlaceResult | "map", i: number): HTMLElement {
    const li = document.createElement("li");
    li.id = `suggest-${i}`;
    li.className = "suggestion";
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === this.active));
    li.dataset.option = String(i);
    const kind = option === "map" ? "map" : option.kind;
    const icon = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind]}</svg>`;
    const name = document.createElement("span");
    name.className = "suggest-name";
    const detail = document.createElement("span");
    detail.className = "suggest-detail";
    if (option === "map") {
      li.classList.add("suggest-map");
      name.textContent = "Choose on the map";
      detail.textContent = this.editing === "from" ? "Tap where you're starting" : "Tap where you're going";
    } else {
      name.textContent = option.name;
      detail.textContent = [option.detail, option.distanceM !== undefined ? distance(option.distanceM) : ""]
        .filter(Boolean).join(" · ");
    }
    const text = document.createElement("span");
    text.className = "suggest-text";
    text.append(name, detail);
    li.innerHTML = icon;
    li.append(text);
    return li;
  }
}
