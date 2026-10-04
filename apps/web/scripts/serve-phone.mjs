// Serve the demo to phones on the local network.
//
//   npm run phone -w @flockwatch/web [-- --port 4173] [-- --no-build]
//
// Builds the app, then serves it over HTTPS on every private address of this machine. HTTPS
// matters: browsers only share a device's location with secure pages, and plain http://192.168.x.x
// doesn't count. The certificate is self-signed (generated here with OpenSSL, kept in the
// gitignored .certs/ at the repo root, never in data/ because Vite publishes that folder), so
// the phone shows a one-time warning to click through. Nothing leaves your network.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build, preview } from "vite";

const APP = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(APP, "..", "..");
const CERTS = join(ROOT, ".certs");
const KEY = join(CERTS, "phone.key");
const CRT = join(CERTS, "phone.crt");
const META = join(CERTS, "phone.json");
const CERT_DAYS = 365;

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const port = Number(arg("--port") ?? 4173);

// ---------- data ----------

for (const f of ["data/packs/dallas.fwr", "data/packs/dallas.cameras.json", "data/basemap/dallas.pmtiles"]) {
  if (!existsSync(join(ROOT, f))) {
    console.error(`Missing ${f}. Build the road pack and run \`npm run fetch-basemap -w @flockwatch/web\` first (see the README).`);
    process.exit(1);
  }
}

// ---------- addresses ----------

/** Private IPv4 addresses, real LAN adapters first (VPN and virtual adapters last). */
function lanAddresses() {
  const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  const virtual = /vpn|mullvad|tun|tap|wg|wireguard|vethernet|virtual|vmware|docker|wsl|loopback|bluetooth/i;
  const found = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const e of entries ?? []) {
      if (e.family === "IPv4" && !e.internal && isPrivate(e.address)) found.push({ name, ip: e.address, virtual: virtual.test(name) });
    }
  }
  return found.sort((a, b) => Number(a.virtual) - Number(b.virtual));
}

// ---------- certificate ----------

function findOpenssl() {
  const candidates = [
    "openssl",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
  ];
  return candidates.find((c) => spawnSync(c, ["version"]).status === 0);
}

/** (Re)generate the certificate unless an existing one already covers exactly these addresses. */
function ensureCertificate(ips) {
  const wanted = JSON.stringify({ ips: [...ips].sort(), days: CERT_DAYS });
  if (existsSync(KEY) && existsSync(CRT) && existsSync(META) && readFileSync(META, "utf8") === wanted) {
    const expired = spawnSync(findOpenssl() ?? "openssl", ["x509", "-checkend", String(14 * 86400), "-noout", "-in", CRT]).status !== 0;
    if (!expired) return;
  }
  const openssl = findOpenssl();
  if (!openssl) {
    console.error("OpenSSL wasn't found (it ships with Git for Windows). Install it, or put a certificate at .certs/phone.crt and .certs/phone.key.");
    process.exit(1);
  }
  mkdirSync(CERTS, { recursive: true });
  const san = ["DNS:localhost", "IP:127.0.0.1", ...ips.map((ip) => `IP:${ip}`)].join(",");
  const r = spawnSync(openssl, [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", KEY, "-out", CRT, "-days", String(CERT_DAYS), "-subj", "/CN=FlockWatch local demo",
    "-addext", `subjectAltName=${san}`, "-addext", "extendedKeyUsage=serverAuth", "-addext", "basicConstraints=critical,CA:FALSE",
  ], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`OpenSSL failed:\n${r.stderr}`);
    process.exit(1);
  }
  writeFileSync(META, wanted);
  console.log(`Generated a self-signed certificate for ${san.replaceAll("IP:", "").replaceAll("DNS:", "")} (${CERT_DAYS} days).`);
}

// ---------- go ----------

const lan = lanAddresses();
if (!lan.length) console.warn("No private network address found: is this machine on Wi-Fi or Ethernet? Serving on this machine only.");
ensureCertificate(lan.map((a) => a.ip));

if (!process.argv.includes("--no-build")) {
  console.log("Building the app…");
  await build({ root: APP, logLevel: "warn" });
}

const server = await preview({
  root: APP,
  logLevel: "warn",
  preview: { host: true, port, strictPort: true, https: { key: readFileSync(KEY), cert: readFileSync(CRT) } },
});

console.log("\nFlockWatch is up (HTTPS, self-signed).\n");
console.log(`  This computer:  https://localhost:${port}/`);
for (const a of lan) console.log(`  Your phone:     https://${a.ip}:${port}/${a.virtual ? `    (${a.name}, a virtual adapter: probably not this one)` : `    (${a.name})`}`);
console.log(`
On your phone (same Wi-Fi as this computer):
  1. Open the "Your phone" address above in the browser.
  2. Its certificate is self-signed, so you'll see a warning. Choose Advanced, then proceed
     (iPhone: Show Details, then "visit this website"). This is expected, and only needed once.
  3. Tap the location button and allow location when asked.

If the page won't load: let Node through Windows Firewall on private networks, and if you use a
VPN (such as Mullvad), turn on its "local network sharing" setting.

Press Ctrl+C to stop.`);

process.on("SIGINT", () => server.httpServer.close(() => process.exit(0)));
