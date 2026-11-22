#!/usr/bin/env bash
set -euo pipefail

: "${VITE_API_ORIGIN:?Set the HTTPS origin of the Render API}"
: "${VITE_CLERK_PUBLISHABLE_KEY:?Set the Clerk production publishable key}"
: "${VITE_CLERK_PROXY_URL:?Set the Pages or custom HTTPS origin plus /api/__clerk}"

export BASE_PATH=/
export PORT="${PORT:-4173}"

pnpm install --frozen-lockfile
pnpm --filter @workspace/aman-team-shifts run build
