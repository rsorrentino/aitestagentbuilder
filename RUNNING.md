# 🚀 Running AI Test Agent Builder

Everything you need to install, configure and run the platform locally.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | **20.19+** (22 recommended) | [nodejs.org](https://nodejs.org) |
| PostgreSQL | 14+ | Docker works: `docker compose up -d postgres`. pgvector is optional. |
| Chromium for Playwright | installed by `npx playwright install chromium` | done by `scripts/setup.sh` |
| Docker | optional | only to run PostgreSQL |
| Python | optional | only for the legacy executor (`EXECUTOR=python`) |

## 1. Install

```bash
git clone https://github.com/rsorrentino/aitestagentbuilder.git
cd aitestagentbuilder
./scripts/setup.sh
```

The script installs the backend and frontend dependencies, downloads Chromium, creates `.env` from `.env.example`, and starts PostgreSQL with Docker if Docker is available.

<details>
<summary>Manual installation</summary>

```bash
cp .env.example .env
(cd backend && npm install && npx playwright install chromium)
(cd frontend && npm install)
docker compose up -d postgres     # or use your own PostgreSQL and edit DATABASE_URL
```

Without Docker, create the database yourself:

```bash
createdb aitestagentbuilder
```

</details>

## 2. Configure

`.env` lives in the **repository root** (a `backend/.env` also works). The only required setting is the database:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/aitestagentbuilder
```

To enable the AI features (document extraction, test generation, chat, self-healing), add at least one provider:

```env
ANTHROPIC_API_KEY=sk-ant-...        # Claude (default model: claude-opus-5-5, override with ANTHROPIC_MODEL)
OPENAI_API_KEY=sk-...               # OpenAI or compatible (OPENAI_BASE_URL)
AZURE_OPENAI_API_KEY=... + AZURE_OPENAI_ENDPOINT=...
COPILOT_MODE=api|sdk|cli + COPILOT_GITHUB_TOKEN=...   # GitHub Copilot, see docs/copilot.md
```

See [.env.example](.env.example) for every option.

## 3. Start

Terminal 1, the API (the database schema is created/migrated automatically on start):

```bash
cd backend
npm run dev
```

Check it with `curl http://localhost:3000/health/ready`; it should return `{"ready":true}`.

Terminal 2, the UI:

```bash
cd frontend
npm run dev
```

Open **http://localhost:4000**.

## 4. First run in 60 seconds

1. On the dashboard click **🎮 Try the demo**. This creates the *Demo Shop* agent with 3 tests targeting the built-in demo app at `http://localhost:3000/demo/`.
2. Click **▶ Start Run**. The live view shows the browser and the step log.
3. Open **Details** to see every step, screenshots, and the HTML/JUnit/JSON reports.

From the command line, `cd backend && npm run seed:demo` creates the same demo.

## 5. Test your own application

1. **Agents → New Agent**: enter the base URL. Optionally restrict which tests run (modules, priorities, tags).
2. Add test cases with any of these:
   - **Documents**: upload a test specification, then **Extract Tests** (needs an AI provider).
   - **Agent → 🤖 Generate Tests**: the AI reads the live page and writes tests (needs an AI provider).
   - **Test Cases → New Test Case**: write steps yourself.
3. The agent page lists the **tests in the next run**. Click **▶ Start Run**.

## Production build

```bash
cd backend && npm run build && npm start          # node dist/index.js
cd frontend && npm run build && npm start         # next start -p 4000
```

Set `NEXT_PUBLIC_API_URL` at frontend build time when the API is not at `http://localhost:3000/api/v1`.

## Authentication

Local mode (default) has no login. For a shared deployment:

```env
AUTH_ENABLED=true
JWT_SECRET=a-long-random-string
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=choose-a-strong-password
```

The admin user is created on start. The UI then shows a login page. API clients use `Authorization: Bearer <jwt>` (from `POST /api/v1/auth/login`) or `Authorization: ApiKey <key>` (from `POST /api/v1/auth/api-keys`).

## CLI / CI usage

```bash
cd backend
npm run cli -- run -c ../configs/login-agent.yml.example -o ./reports
```

The CLI creates or updates the agent from the YAML, runs its tests, prints results, writes reports and exits with code 1 if any test failed.

## Tests

```bash
cd backend && npm test                    # unit tests (no DB needed)
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test \
  npm run test:integration                # API + PostgreSQL + real browser; the test DB schema is reset
cd e2e && npm install && npm test         # UI end-to-end (start backend + frontend first)
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string (or `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`) |
| `PORT` | `3000` | API port |
| `AUTH_ENABLED` | `false` | Require login / API keys |
| `JWT_SECRET` | random per process | Signing secret (set it when auth is on) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Bootstrap admin account |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | — / `claude-opus-5-5` | Claude |
| `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_BASE_URL` | — / `gpt-4o` | OpenAI or compatible |
| `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_DEPLOYMENT` | — | Azure OpenAI |
| `COPILOT_MODE` | `api` | `api`, `sdk` or `cli` |
| `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` | — | GitHub token for Copilot |
| `COPILOT_MODEL` / `COPILOT_BASE_URL` / `COPILOT_CLI_PATH` | — | Copilot options |
| `LLM_PROVIDER` | — | Force a provider first for every task |
| `EXECUTOR` | `node` | `node` (Playwright, built in) or `python` (legacy) |
| `PLAYWRIGHT_BROWSER` / `PLAYWRIGHT_HEADLESS` / `PLAYWRIGHT_EXECUTABLE_PATH` | `chromium` / `true` / — | Browser options |
| `STEP_TIMEOUT_MS` | `10000` | Timeout per step |
| `MAX_CONCURRENT_RUNS` | `2` | Runs executing at the same time (others queue) |
| `ARTIFACTS_PATH` | `backend/artifacts` | Screenshot storage, served at `/artifacts` |
| `DEMO_ENABLED` | `true` | Serve the demo app at `/demo` |
| `CORS_ORIGIN` | any | Allowed UI origins (comma separated) |
| `REDIS_URL` | — | Distributed rate limiting (falls back to memory) |
| `LOG_LEVEL` / `LOG_FORMAT` / `LOG_TO_FILE` | `info` / `pretty` / `true` | Logging |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot connect to PostgreSQL` on start | Start the DB (`docker compose up -d postgres`) and check `DATABASE_URL`. |
| `Port 3000 is already in use` | Set `PORT` in `.env`, and `NEXT_PUBLIC_API_URL` for the frontend to match. |
| UI shows "Cannot reach the backend" | Start the backend; check `NEXT_PUBLIC_API_URL`. |
| `Could not start chromium` | `cd backend && npx playwright install chromium` (on Linux add `--with-deps`). |
| "No AI provider is configured" | Add a provider key to `.env` and restart the backend. Check **AI Providers → Test connections**. |
| "No test cases match this agent's test selection" | Add tests or widen the agent's module/priority/tag filters; the agent page shows what will run. |
| Copilot errors | See [docs/copilot.md](docs/copilot.md#troubleshooting). |
| Steps fail with "Element … was not found" | Check the selector in the run details screenshot; enable self-healing with an AI provider. |
