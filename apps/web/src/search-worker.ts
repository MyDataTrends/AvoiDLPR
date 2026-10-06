// Search lives in its own worker, beside the routing one: the area's place index is downloaded
// once, and every keystroke is matched here, on the device. Nothing typed is sent anywhere.
import { decodePlaces, PlaceSearch } from "@flockwatch/router";

import { fetchData } from "./fetch-data.ts";
import type { SearchRequest, SearchResponse } from "./protocol.ts";

const scope = self as unknown as {
  postMessage(msg: SearchResponse): void;
  onmessage: ((ev: MessageEvent<SearchRequest>) => void) | null;
};

let search: PlaceSearch | null = null;
/** The index being loaded or in use: a load for another area supersedes it. */
let current = "";

scope.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === "load") {
    current = msg.url;
    search = null;
    try {
      const buf = await fetchData(msg.url, msg.bytes, msg.sha256, "search index",
        (p) => scope.postMessage({ type: "progress", url: msg.url, ...p }));
      const next = new PlaceSearch(decodePlaces(buf));
      if (current !== msg.url) return;
      search = next;
      scope.postMessage({ type: "loaded", url: msg.url, counts: next.index.meta.counts });
    } catch (err) {
      if (current === msg.url) scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err), url: msg.url });
    }
    return;
  }
  if (msg.type === "search") {
    scope.postMessage({ type: "results", id: msg.id, results: search?.search(msg.query, { near: msg.near }) ?? [] });
  } else if (msg.type === "nearest") {
    scope.postMessage({ type: "nearest", id: msg.id, result: search?.nearest(msg.at[0], msg.at[1]) ?? null });
  }
};
