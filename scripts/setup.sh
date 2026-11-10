#!/usr/bin/env bash
# AI Test Agent Builder — one-time local setup.
#   ./scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "🚀 Setting up AI Test Agent Builder"

command -v node >/dev/null || { echo "❌ Node.js 20.19+ is required"; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { echo "❌ Node.js 20.19+ is required (found $(node -v))"; exit 1; }

[ -f .env ] || { cp .env.example .env; echo "📝 Created .env from .env.example — add an AI provider key to enable AI features"; }

echo "📦 Backend dependencies…"
(cd backend && npm install && npx playwright install chromium)

echo "📦 Frontend dependencies…"
(cd frontend && npm install)

if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  echo "🐘 Starting PostgreSQL with Docker…"
  docker compose up -d postgres
else
  echo "⚠️  Docker not available — make sure PostgreSQL is running and DATABASE_URL in .env points to it."
fi

echo ""
echo "✅ Setup complete. Next:"
echo "   1. cd backend && npm run dev      # API on http://localhost:3000 (migrates the DB automatically)"
echo "   2. cd frontend && npm run dev     # UI on http://localhost:4000"
echo "   3. Open http://localhost:4000 and click “Try the demo”."
