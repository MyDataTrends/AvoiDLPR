/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where regions.json, packs/, cameras/ and basemap/ are served from (a URL; empty = this origin). */
  readonly VITE_DATA_BASE?: string;
}
