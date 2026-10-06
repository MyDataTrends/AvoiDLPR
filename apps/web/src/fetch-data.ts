// Downloading an area's data files in a worker: the road pack and the search index. Both are
// published gzipped and content-hashed, with a SHA-256 in the manifest.

export async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Progress {
  loaded: number;
  total: number;
  unpacking?: boolean;
}

/**
 * Download a data file, reporting progress, check it against the manifest's checksum, and un-gzip
 * it. A host or proxy that already decoded it hands over the plain file, so the gzip magic bytes
 * decide, not the file name. `what` names it in errors ("road map").
 */
export async function fetchData(url: string, expectedBytes: number, sha256: string | undefined, what: string,
  onProgress: (p: Progress) => void): Promise<ArrayBuffer> {
  const res = await fetchOk(url);
  const total = expectedBytes || Number(res.headers.get("content-length")) || 0;
  const chunks: Uint8Array[] = [];
  let loaded = 0, lastReport = 0;
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const now = performance.now();
    if (now - lastReport > 150) {
      lastReport = now;
      onProgress({ loaded, total });
    }
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  // The manifest's checksum is of the file as published. (crypto.subtle exists on secure pages
  // only; an insecure dev page skips the check.)
  if (sha256 && globalThis.crypto?.subtle && (await hex(bytes)) !== sha256) {
    throw new Error(`the ${what} arrived damaged (its checksum doesn't match)`);
  }
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes.buffer;
  onProgress({ loaded, total: loaded, unpacking: true });
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}
