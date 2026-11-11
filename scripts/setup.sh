#!/usr/bin/env bash
# Kept for compatibility: the setup now lives in the root package.json ("npm run setup"),
# which works the same on Windows, Linux and macOS.
set -euo pipefail
cd "$(dirname "$0")/.."
if command -v docker >/dev/null && docker info >/dev/null 2>&1 && ! [ -f .env ]; then
  echo "Starting PostgreSQL with Docker (npm run docker:db)..."
  docker compose up -d postgres
fi
exec npm run setup -- "$@"
