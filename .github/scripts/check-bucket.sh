#!/usr/bin/env bash
# Checks the data bucket is set up and reachable before a workflow uses it, and says exactly
# what's missing. A workflow that can't read the bucket mustn't mistake that for "nothing is
# published yet" (which is what a failed download of regions.json would otherwise look like).
#
# Reads the workflow's environment: R2_BUCKET, R2_ENDPOINT (built from the R2_ACCOUNT_ID secret),
# AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (the R2_* secrets).
set -uo pipefail

missing=()
[ -n "${R2_BUCKET:-}" ] || missing+=("the R2_BUCKET variable")
[ -n "${AWS_ACCESS_KEY_ID:-}" ] || missing+=("the R2_ACCESS_KEY_ID secret")
[ -n "${AWS_SECRET_ACCESS_KEY:-}" ] || missing+=("the R2_SECRET_ACCESS_KEY secret")
case "${R2_ENDPOINT:-}" in "" | "https://.r2.cloudflarestorage.com") missing+=("the R2_ACCOUNT_ID secret") ;; esac
if [ ${#missing[@]} -gt 0 ]; then
  printf -v list '%s, ' "${missing[@]}"
  them="them" names="those names"
  if [ ${#missing[@]} -eq 1 ]; then them="it" names="that name"; fi
  echo "::error::Missing ${list%, }. Set ${them} under Settings > Secrets and variables > Actions, with exactly ${names} (docs/DEPLOY.md, step 3)."
  exit 1
fi

if ! out="$(aws s3api list-objects-v2 --bucket "$R2_BUCKET" --max-items 1 --endpoint-url "$R2_ENDPOINT" 2>&1 >/dev/null)"; then
  echo "::error::Can't read the bucket ${R2_BUCKET}: $(echo "$out" | tail -n 1) Check the R2_ACCOUNT_ID secret, that the API token can read and write this bucket, and the bucket's name."
  exit 1
fi
echo "The bucket ${R2_BUCKET} is set up and reachable."
