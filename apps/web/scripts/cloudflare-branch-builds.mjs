// Cloudflare Workers Builds builds main and deploys it with `npx wrangler deploy`: that's the live
// app, and this script leaves it alone. It also builds every other branch, then runs
// `npx wrangler versions upload` to publish a preview of it. Those uploads fail for this Worker,
// which marked every pull request with a failed "Workers Builds: map" check, and the previews
// aren't used: GitHub CI builds and tests each pull request. So on those branch builds only, this
// puts a stand-in `wrangler` in node_modules/.bin, where npx looks first, that skips the upload.
// The app is still built, so the check still says whether it builds on Cloudflare.
//
// The stand-in does nothing but skip `versions upload`. Asked to do anything else (a `deploy`, if
// this ever ran where it shouldn't), it fails the build instead of quietly not deploying.
//
// To use Cloudflare's previews again, delete this script and its call in the root package.json;
// to stop the branch builds instead, Settings > Build > Branch control in the Worker's dashboard.
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SHIM = join(ROOT, "node_modules", ".bin", "wrangler");
const MARK = "avoidlpr: branch-build stand-in";
const PRODUCTION = "main";

// Workers Builds sets these (https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).
const branch = process.env.WORKERS_CI === "1" ? process.env.WORKERS_CI_BRANCH : undefined;
const ours = () => existsSync(SHIM) && readFileSync(SHIM, "utf8").includes(MARK);

if (!branch || branch === PRODUCTION) {
  // Not a Cloudflare branch build: make sure no stand-in is left over, so the real wrangler runs.
  if (ours()) rmSync(SHIM);
  if (branch) console.log(`Workers Builds, ${branch}: the real wrangler deploys.`);
} else {
  writeFileSync(SHIM, `#!/bin/sh
# ${MARK} (apps/web/scripts/cloudflare-branch-builds.mjs)
if [ "$1" = "versions" ] && [ "$2" = "upload" ]; then
  echo "Built. Cloudflare's preview upload is skipped for branches (GitHub CI tests them)."
  exit 0
fi
echo "This wrangler only stands in for preview uploads on branch builds; refusing: wrangler $*" >&2
exit 1
`);
  chmodSync(SHIM, 0o755);
  console.log(`Workers Builds, branch ${branch}: the preview upload will be skipped.`);
}
