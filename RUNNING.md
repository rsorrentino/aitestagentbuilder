# 🚀 Running AI Test Agent Builder

This guide covers everything you need to get the application running locally for development or testing.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| **Node.js** | 18+ | [nodejs.org](https://nodejs.org) |
| **npm** | 9+ | Comes with Node.js |
| **PostgreSQL** | 14+ | With [pgvector](https://github.com/pgvector/pgvector) extension |
| **Python** | 3.10+ | Optional — only needed for the executor service |
| **Redis** | 6+ | Optional — used for caching and rate limiting |

---

## Step 1 — Clone & Configure

```bash
git clone https://github.com/rsorrentino/aitestagentbuilder.git
cd aitestagentbuilder
cp .env.example .env
```

Edit `.env` and fill in at minimum:

```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/aitestagentbuilder
JWT_SECRET=replace-with-at-least-64-random-characters
AUTH_ENABLED=false
OPENAI_API_KEY=sk-...
```

---

## Step 2 — Database Setup

```bash
# macOS
brew install postgresql@14 pgvector
brew services start postgresql@14

# Ubuntu / Debian
sudo apt-get install postgresql-14 postgresql-14-pgvector
sudo systemctl start postgresql
```

```bash
createdb aitestagentbuilder
psql aitestagentbuilder -c "CREATE EXTENSION IF NOT EXISTS vector;"
cd backend && npm install && npm run db:migrate
```

---

## Step 3 — Start the Backend

```bash
cd backend
npm run dev
```

Verify: `curl http://localhost:3000/health/ready`

---

## Step 4 — Start the Frontend

Open a **new terminal**:

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:4000** in your browser.

---

## Step 5 — First Steps in the App

1. Go to **Agents** → **New Agent** and create your first agent
2. Or use the **Salesforce Wizard** for a Salesforce org
3. Go to **Documents** to upload a test spec and extract test cases
4. Go to the **Agent detail page** and click **▶ Start Run**
5. Watch execution live at `/live?runId=<id>`

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `JWT_SECRET` | ✅ | — | Secret for JWT signing |
| `AUTH_ENABLED` | ❌ | `true` | Set `false` for dev without auth |
| `OPENAI_API_KEY` | ✅* | — | OpenAI API key |
| `ANTHROPIC_API_KEY` | ✅* | — | Anthropic / Claude API key |
| `GITHUB_TOKEN` | ✅* | — | GitHub Copilot token |
| `PORT` | ❌ | `3000` | Backend port |
| `REDIS_URL` | ❌ | — | Redis URL (enables caching) |
| `EXECUTOR_URL` | ❌ | `http://localhost:8001` | Python executor service |
| `LOG_LEVEL` | ❌ | `info` | `debug` / `info` / `warn` / `error` |

*At least one AI provider key is required.

---

## Troubleshooting

### Database not running — `ECONNREFUSED`

```bash
pg_isready -h localhost -p 5432
brew services start postgresql@14   # macOS
sudo systemctl start postgresql     # Linux
```

### Port 3000 already in use — `EADDRINUSE`

```bash
# Use a different port
PORT=3001 npm run dev
```

### 401 Unauthorized errors

Set `AUTH_ENABLED=false` in your `.env` for local development.

### No AI provider configured

At least one LLM key must be set. Check `/settings/ai-providers` in the UI.

---

## Running Tests

```bash
cd backend && npm test
cd executor && pip install -r requirements.txt && pytest -v
```

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /health/ready` | Readiness check |
| `GET /api/v1/agents` | List agents |
| `POST /api/v1/agents` | Create agent |
| `POST /api/v1/runs` | Start test run |
| `GET /api/v1/runs` | List all runs |
| `POST /api/v1/ingestion/upload` | Upload document |
| `GET /api/v1/ingestion/documents` | List documents |
| `GET /api/v1/testcases` | List test cases |
| `POST /api/v1/chat` | AI chat endpoint |
| `GET /api/v1/llm/providers` | Provider health |

Full API docs: [docs/api.md](docs/api.md)
