// Check a freshly built road pack against the live one before it's published.
//
//   node --experimental-strip-types packages/router/bin/verify.ts NEW.fwr[.gz] [--old LIVE.fwr[.gz]]
//        [--cameras feed.json] [--seed N]
//
// Prints the verdict (src/verify.ts) as JSON, and exits 0 when the pack passes, 1 when it
// doesn't, 2 on a usage error. Gzipped packs are read as they're published.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import type { CameraRecord } from "../src/geo.ts";
import { verifyPack } from "../src/verify.ts";

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const fresh = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (!fresh) {
  console.error("usage: verify.ts NEW.fwr[.gz] [--old LIVE.fwr[.gz]] [--cameras feed.json] [--seed N]");
  process.exit(2);
}

function pack(path: string): ArrayBuffer {
  let bytes: Uint8Array = readFileSync(path);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const old = opt("--old");
const feed = opt("--cameras");
const verdict = verifyPack(pack(fresh), old ? pack(old) : null, {
  cameras: feed ? (JSON.parse(readFileSync(feed, "utf8")).cameras as CameraRecord[]) : undefined,
  seed: Number(opt("--seed") ?? 1),
});
console.log(JSON.stringify(verdict));
process.exit(verdict.ok ? 0 : 1);
