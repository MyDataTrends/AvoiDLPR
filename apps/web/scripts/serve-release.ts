// A stand-in for the object-storage bucket: serves release/ on its own port with CORS, so the app
// can be tested against a data host on a different origin, as in production.
//
//   node --experimental-strip-types scripts/serve-release.ts [--port 8788] [--dir ../../release]
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { serveRelease } from "./release-files.ts";

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const port = Number(arg("--port") ?? 8788);
const dir = arg("--dir") ?? fileURLToPath(new URL("../../../release", import.meta.url));

createServer((req, res) => {
  if (!serveRelease(req, res, dir, { cors: true })) {
    res.statusCode = 404;
    res.end("not found");
  }
}).listen(port, () => console.log(`serving ${dir} on http://localhost:${port}/ (CORS: any origin)`));
