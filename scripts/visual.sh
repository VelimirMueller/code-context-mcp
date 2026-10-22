#!/bin/sh
# Visual regression gate (#293): run playwright.visual.config.ts inside the
# pinned Playwright image, as linux/amd64 like the CI runners.
# Screenshots are only comparable when they come from the same image.
#   pnpm run test:visual                       compare against the baselines
#   pnpm run test:visual -- --update-snapshots write new baselines (never in a refactor PR)
# Linux node_modules live in docker volumes, so the host's macOS binaries
# (better-sqlite3, esbuild) are never mixed with the container's.
set -eu
IMAGE=mcr.microsoft.com/playwright:v1.59.1-noble
ROOT=$(cd "$(dirname "$0")/.." && pwd)
exec docker run --rm --init --ipc=host --platform linux/amd64 \
  -v "$ROOT":/work -w /work \
  -v cc-visual-nm:/work/node_modules \
  -v cc-visual-nm-frontend:/work/src/dashboard/frontend/node_modules \
  -v cc-visual-pnpm-store:/pnpm-store \
  -e CI="${CI:-}" -e npm_config_store_dir=/pnpm-store \
  "$IMAGE" sh -c '
    set -e
    corepack enable >/dev/null 2>&1
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --reporter=silent
    pnpm run -s build >/dev/null
    pnpm exec playwright test -c playwright.visual.config.ts "$@"
  ' visual "$@"
