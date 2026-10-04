# Deploying FlockWatch

FlockWatch is a static site plus static data files. There is no server, database or API, so
hosting is free-tier friendly and there's nothing to keep running.

```
                  GitHub (this repo)
                 /        |         \
   push to main /         |hourly    \monthly
               v          v           v
   Cloudflare Pages   refresh-cameras  build-data      GitHub Actions
   (the app, ~2 MB)        |            |
          |                +-----+------+
          |                      v
          |         Cloudflare R2 bucket (the data)
          |         regions.json  packs/  basemap/  cameras/
          |                      ^
          +------ fetches -------+          your phone: the app + data come from the two hosts,
                                            routing happens on the phone
```

| Piece | Where | What it is |
|---|---|---|
| The app | Cloudflare Pages | `apps/web`, built by Vite: about 2 MB of HTML, JS and CSS, plus the service worker and the headers file |
| The data | Cloudflare R2 bucket | Road packs (19 MB each), Protomaps basemap extracts (54 MB each), fonts, and the hourly camera feeds. Described by `regions.json` |
| Data refresh | GitHub Actions | `refresh-cameras` (hourly) and `build-data` (monthly) |

The app fetches `regions.json` first, and everything else is named in it, so adding a city is a
data change. Big files have content-hashed names and are cached forever; the camera feeds and
`regions.json` are revalidated on every load. See `pipeline/release.py` for the layout.

## The checklist for when you're at your computer

Roughly 45 minutes, most of it clicking through dashboards. Do these in order.

### 1. Put the repository on GitHub

- Create an empty repository (public is recommended: Actions minutes are free for public repos,
  and an open project is an easier pitch). Don't add a README or license in the GitHub form.
- From `C:\Projects\flockwatch`:
  ```bash
  git remote add origin https://github.com/<you>/<repo>.git
  git push -u origin main
  ```
- **Choose a license for the code.** There isn't one yet, which means nobody may legally reuse it.
  MIT or Apache-2.0 for maximum adoption (what a Waze or DeFlock integration would want), or
  AGPL-3.0 if you'd rather keep forks open. The data has its own license (see "Licensing" below).
- CI (`.github/workflows/ci.yml`) starts running on the first push. Check it goes green.

### 2. Create the data bucket (Cloudflare R2)

1. Create a free Cloudflare account, then **R2 Object Storage** and **Create bucket**
   (for example `flockwatch-data`). R2 asks for a payment method but the free tier is generous:
   10 GB storage, 1M writes and 10M reads a month, and no download charges.
2. **Public access.** Bucket **Settings > Public access**. For getting started, enable the
   `r2.dev` URL (looks like `https://pub-<hash>.r2.dev`). Cloudflare rate-limits it and says it's
   not for production, which is fine for a demo and a pitch. For launch, connect a custom domain
   to the bucket instead (about $10 a year for a domain on Cloudflare DNS), which also gets
   Cloudflare's cache in front of the files.
3. **CORS.** Bucket **Settings > CORS policy**, add (replace the first origin once you know your
   Pages address in step 5; keep localhost for development):
   ```json
   [
     {
       "AllowedOrigins": ["https://<your-project>.pages.dev", "http://localhost:5173"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["range", "if-match", "if-none-match"],
       "ExposeHeaders": ["etag", "content-range", "content-length", "accept-ranges"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```
   The map is one big file read in byte ranges, so `range` must be allowed. Without this the
   app loads but the map stays blank. If the dashboard wants a different shape, Cloudflare's
   R2 CORS docs are the reference.
4. **API token.** R2 overview > **Manage API tokens** > **Create API token**, permission
   *Object Read & Write*, limited to your bucket. Copy the **Access Key ID**, **Secret Access
   Key** and your **Account ID** (shown on the R2 overview page). You only see the secret once.

### 3. Give GitHub the keys

Repository **Settings > Secrets and variables > Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `R2_ACCOUNT_ID` | your Cloudflare account ID |
| Secret | `R2_ACCESS_KEY_ID` | from the API token |
| Secret | `R2_SECRET_ACCESS_KEY` | from the API token |
| Variable | `R2_BUCKET` | the bucket name |

### 4. Publish the data

**Fastest: upload what you already have.** This machine has a staged `release/` directory (the
exact tree the app expects). Upload it with the AWS CLI (or rclone, or the dashboard's uploader
for the big files):

```bash
export AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...  AWS_DEFAULT_REGION=auto
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
EP=https://<account-id>.r2.cloudflarestorage.com  B=<bucket>
aws s3 cp release/packs    s3://$B/packs    --recursive --endpoint-url $EP --content-type application/octet-stream --cache-control "public, max-age=31536000, immutable"
aws s3 cp release/basemap  s3://$B/basemap  --recursive --endpoint-url $EP --cache-control "public, max-age=31536000, immutable"
aws s3 cp release/cameras  s3://$B/cameras  --recursive --endpoint-url $EP --content-type application/json --cache-control "public, max-age=0, must-revalidate"
aws s3 cp release/regions.json s3://$B/regions.json     --endpoint-url $EP --content-type application/json --cache-control "public, max-age=0, must-revalidate"
```

(Re-run `python -m pipeline.refresh_cameras --out release` first if you want today's cameras.)

**Or let GitHub build it.** **Actions > Build map data > Run workflow.** It downloads Texas from
Geofabrik, clips Dallas, builds the road pack and basemap, and publishes (about 15 to 30
minutes). **This workflow has not been run yet**, so expect to fix a typo or two; the pieces it
runs are each tested locally (`pipeline/build_region.py` with a fake downloader, the release
stager, the camera refresh against the live DeFlock feed). Its first log prints the pmtiles
download's SHA-256: save it as the repository variable `PMTILES_SHA256` and the job will refuse
any other file in future.

Check it worked: open `https://<public-url>/regions.json`. You should see the manifest.

### 5. Deploy the app (Cloudflare Pages)

**Workers & Pages > Create > Pages > Connect to Git**, choose the repository, then:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Build command | `npm ci && npm run build` |
| Build output directory | `apps/web/dist` |
| Environment variable | `NODE_VERSION` = `22` |
| Environment variable | `VITE_DATA_BASE` = your bucket's public URL, no trailing slash |

(If the dashboard steers you toward Workers static assets instead of Pages, the same build
command, output directory and variables apply.)

`VITE_DATA_BASE` is baked in at build time, and also becomes the data host in the
Content-Security-Policy, so the browser will refuse to talk to anything else. After the first
deploy, copy your `https://<project>.pages.dev` address into the R2 CORS policy from step 2.
Every push to `main` redeploys.

### 6. Try it on your phone

1. Open the Pages address. The map should load and "Try an example trip" should work.
2. **iPhone:** Safari > Share > **Add to Home Screen**. **Android:** Chrome menu > **Install
   app** (the Settings panel in the app also shows an install button there).
3. Open it from the home screen: it runs full-screen with no browser bar.
4. Turn on **airplane mode** and open it again. The app, road network and cameras are cached, so
   routing still works; only new map tiles need a connection.
5. Allow location when asked and tap the target button.

### 7. Before you tell anyone

- Add the app's address to the CORS policy and decide on the custom domain.
- **Rename?** "Flock" is another company's trademark. Fine for a hobby project; worth deciding
  before a public launch or a pitch.
- Skim "Licensing" and "Known gaps" below.

## What runs automatically afterwards

| What | When | Where it runs |
|---|---|---|
| Tests, type-check, build | every push and pull request | `ci.yml` |
| App redeploy | every push to `main` | Cloudflare Pages |
| Camera feeds refreshed from DeFlock | hourly | `refresh-cameras.yml` |
| Road packs and basemaps rebuilt | monthly, or on demand | `build-data.yml` |

Notes:
- GitHub disables scheduled workflows in a public repository after 60 days with no repository
  activity. If the hourly refresh goes quiet, re-enable it in the Actions tab.
- The camera refresh won't publish a feed that shrank by more than half, and fails loudly
  instead, so a DeFlock outage can't blank your map.
- Old pack and basemap versions stay in the bucket, valid for pages that are still open. Add an
  R2 lifecycle rule to delete objects under `packs/` and `basemap/` after 90 days.

## Adding a city

1. Add an entry to `pipeline/regions.json` (`id`, `name`, `clip_bbox` as west, south, east,
   north, and the `geofabrik` path of the state or country extract that contains it; optionally
   an `example` trip).
2. Run **Build map data** with that region (or locally: `python -m pipeline.build_region <id>`,
   then `npm run fetch-basemap -w @flockwatch/web -- --region <id>`,
   `python -m pipeline.refresh_cameras --out release`, `python -m pipeline.release`).
3. The app picks it up from `regions.json` with no redeploy. Keep a region to metro size: the
   road pack lives in memory (about 150 MB for Dallas), and the basemap is about 50 MB.

The app currently opens the first region in the manifest (or the one in the URL, `#r=<id>`). A
region picker, and switching automatically from a GPS fix, are the next piece of work.

## Costs and limits (free tier, October 2026)

| | Limit | Why it's comfortable |
|---|---|---|
| Pages | 25 MiB per file, 20,000 files, no hard bandwidth cap (fair use) | The app is about 2 MB; big files live in R2 |
| R2 | 10 GB stored, 1M writes and 10M reads a month, **no egress fees** | One metro is about 75 MB. A map tile read is one read; rough guess a few hundred per session, so tens of thousands of sessions a month before reads cost anything (about $0.36 per million after) |
| GitHub Actions | Free for public repositories | An hourly job of about a minute, and a monthly build of about 30 minutes |

These are from public pricing pages in October 2026 and change; check before relying on them.

## Security and privacy posture

- **Nothing about a trip leaves the device.** Routing happens in the browser. The app's
  Content-Security-Policy (`apps/web/vite.config.ts`, emitted as `_headers`) lets the page connect
  only to itself and the data host; the production end-to-end test proves a request to any
  other origin is blocked.
- A GPS fix is used in memory and never written to the URL or storage.
- `Permissions-Policy` limits geolocation to the app's own origin and disables camera, mic and
  payment APIs.
- The data host only serves public files. The R2 API token lives in GitHub secrets, scoped to the
  one bucket.
- No analytics. If you add some later, choose a cookieless service that never sees coordinates.

## Licensing and attribution

- **Camera locations and roads** come from OpenStreetMap (ODbL). The basemap is a Protomaps
  build of OpenStreetMap (also ODbL). The app shows the required attribution on the map. If you
  publish derived data (the road packs and camera feeds are derived databases), the ODbL's
  attribution and share-alike terms apply to it: keep them public and credited. Read the license
  before you commercialise; this is not legal advice.
- **Fonts** (Noto Sans, from Protomaps' basemap assets) are SIL OFL.
- **Code:** no license chosen yet (see step 1).
- **Camera data** is crowdsourced and sometimes wrong. The UI says what each zone assumes, and
  every camera links to OpenStreetMap so errors can be fixed at the source.

## Known gaps

- The two data workflows have never run on GitHub.
- Only Dallas is built, and there's no region picker yet.
- Offline use covers the app, the road network and the cameras, but not map tiles. An opt-in
  "download this area" for tiles is the next step for a fully offline map.
- Installed-app behaviour (home screen on iOS and Android) hasn't been checked on real devices:
  it was tested in an emulator, including offline starts.
- The road pack is not compressed in transit: gzip would take 19 MB to about 12 MB. R2 doesn't
  compress on the fly, so this wants a build-time `.br` file or an in-app decompress.
- No uptime monitoring or error reporting, deliberately: both would need to see something.
- Reporting a camera still sends people to openstreetmap.org to edit; in-app OSM sign-in is
  planned, and works without a server.
