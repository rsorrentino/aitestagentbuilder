# 🚀 Running AI Test Agent Builder

Everything you need to install, configure and run the platform locally.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | **20.19+** (22 recommended) | [nodejs.org](https://nodejs.org) |
| PostgreSQL | 14+ | Docker works: `docker compose up -d postgres`. pgvector is optional. |
| Chromium for Playwright | downloaded by `npm run setup` | |
| Docker | optional | only to run PostgreSQL (`npm run docker:db`) |
| Python | optional | only for the legacy executor (`EXECUTOR=python`) |

## 1. Install

All commands run from the repository root, on Windows (PowerShell or cmd), Linux and macOS:

```bash
git clone https://github.com/rsorrentino/aitestagentbuilder.git
cd aitestagentbuilder
npm run setup
```

`npm run setup` checks Node.js, creates `.env` from `.env.example` (if missing), installs the API and UI
dependencies, downloads Chromium and migrates the database. Options:

| Option | |
|---|---|
| `--production` | `.env` for a server: `NODE_ENV=production`, login on, generated `JWT_SECRET` / `SECRETS_ENCRYPTION_KEY` and administrator password (printed once), browsers kept inside the installation; also builds |
| `--host <name>` · `--api-port` · `--ui-port` | address users type in the browser (compiled into the UI) |
| `--public-url https://…` · `--public-ui-url https://…` | when a reverse proxy serves the API / UI |
| `--db postgresql://user:pass@host:5432/db` | database (default: local PostgreSQL, user `postgres`) |
| `--admin-email <email>` · `--no-auth` | first administrator · no login (single user) |
| `--with-e2e` · `--with-deps` | also install the end-to-end tests · Linux: install Chromium's system libraries |
| `--skip-build` | production install without building |

PostgreSQL: create an empty database (`createdb aitestagentbuilder`, or in psql `CREATE DATABASE aitestagentbuilder;`),
or run `npm run docker:db` to start one with Docker.

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

```bash
npm run dev        # API (http://localhost:3000) + UI (http://localhost:4000) with live reload
```

Both run in one terminal with `[api]` / `[ui]` prefixes; Ctrl+C stops both. `npm run status` checks they answer.
The database schema is created/migrated automatically when the API starts.

## 4. First run in 60 seconds

1. On the dashboard click **🎮 Try the demo**. This creates the *Demo Shop* agent with 3 tests targeting the built-in demo app at `http://localhost:3000/demo/`.
2. Click **▶ Start Run**. The live view shows the browser and the step log.
3. Open **Details** to see every step, screenshots, and the HTML/JUnit/JSON reports.

From the command line, `npm run demo:seed` creates the same demo.

## 5. Test your own application

1. **Agents → New Agent**: enter the base URL. Optionally restrict which tests run (modules, priorities, tags).
2. Add test cases with any of these:
   - **Documents**: upload a test specification, then **Extract Tests** (needs an AI provider).
   - **Agent → 🤖 Generate Tests**: the AI reads the live page and writes tests (needs an AI provider).
   - **Test Cases → New Test Case**: write steps yourself.
3. The agent page lists the **tests in the next run**. Click **▶ Start Run**.

## Production

```bash
npm run setup -- --production --host myserver --db "postgresql://postgres:PASSWORD@localhost:5432/aitestagentbuilder"
npm start                      # or, to start at boot:
npm run service:install        # Windows: service (NSSM) or Scheduled Task; Linux: systemd unit (sudo)
```

`npm start` runs the production build of the API and the UI under one supervisor: if either stops, both stop
and the command exits with an error, so the service manager restarts them. After `git pull`, run
`npm run setup -- --production` again (your `.env` is kept) and restart the service.

## Windows Server (no Docker)

The same commands work on Windows; run `npm run service:install` from an elevated prompt.
Details (prerequisites, NSSM, service accounts, IIS/HTTPS, troubleshooting): [docs/windows.md](docs/windows.md).

## Docker (whole stack)

```bash
cat > .env <<'ENV'
JWT_SECRET=change-me-to-a-long-random-string
SECRETS_ENCRYPTION_KEY=change-me-openssl-rand-base64-32
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=Choose-A-Str0ng-Passw0rd
ENV
docker compose --profile full up -d --build
```

The UI is on http://localhost:4000, the API on http://localhost:3000 (`/api/docs` for the
interactive API reference). The backend image is based on the official Playwright image (Chromium
included), runs migrations at start-up and keeps screenshots and the data directory in the
`appdata` volume. For another host name, set `PUBLIC_API_URL`, `PUBLIC_WS_URL` (compiled into the
UI at build time) and `PUBLIC_UI_URL` (CORS). Back up the database **and** keep
`SECRETS_ENCRYPTION_KEY`: without it stored credentials cannot be decrypted.

## Authentication

Local mode (default) has no login. For a shared deployment:

```env
AUTH_ENABLED=true
JWT_SECRET=a-long-random-string
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=choose-a-strong-password
```

The admin user is created on start. The UI then shows a login page. API clients use `Authorization: Bearer <jwt>` (from `POST /api/v1/auth/login`) or `Authorization: ApiKey <key>` (from `POST /api/v1/auth/api-keys`).

With authentication on you also get:

- **Projects** with members and roles (viewer < editor < admin < owner); every agent, test case, document, run, schedule and notification belongs to a project. API keys are scoped to one project and a maximum role.
- **User administration** (system admins): create users with a temporary password that must be changed at first login, deactivate, reset passwords. Password policy (`PASSWORD_MIN_LENGTH`, 3 of 4 character classes) and lockout after `MAX_FAILED_LOGINS` attempts for `LOCKOUT_MINUTES`.
- **Audit log** of every change and sign-in, filterable and exportable as CSV.
- **Encrypted secrets** (agent secrets, Salesforce persona credentials): AES-256-GCM with `SECRETS_ENCRYPTION_KEY`, write-only in the API, masked in logs.
- **Signed screenshot URLs** and authenticated WebSockets.


## CLI / CI usage

```bash
npm run cli -- run -c ../configs/login-agent.yml.example -o ./reports
```

The CLI creates or updates the agent from the YAML, runs its tests, prints results, writes reports and exits with code 1 if any test failed.

## Tests

```bash
npm test                    # unit tests (no DB needed)
npm run test:integration    # API + PostgreSQL + real browser; resets the schema of TEST_DATABASE_URL
                            # (default postgresql://postgres:postgres@localhost:5432/aitestagentbuilder_test)
npm run test:e2e            # UI end-to-end: "npm run setup -- --with-e2e" once, then start the app
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
| `SECRETS_ENCRYPTION_KEY` | dev: key file in `DATA_DIR` | Encryption key for stored secrets — **required in production** |
| `DATA_DIR` | `backend/.data` | Local data (development secrets key) |
| `PASSWORD_MIN_LENGTH` / `MAX_FAILED_LOGINS` / `LOCKOUT_MINUTES` | `12` / `5` / `15` | Password policy and lockout |
| `ARTIFACT_SIGNING_KEY` / `ARTIFACT_URL_TTL_SECONDS` | derived / `86400` | Signed screenshot URLs (auth mode) |
| `SCHEDULER_ENABLED` / `SCHEDULER_INTERVAL_SECONDS` / `MIN_SCHEDULE_INTERVAL_MINUTES` | `true` / `30` / `5` | Scheduled runs |
| `SMTP_URL` / `SMTP_FROM` | — | Email notifications (`smtp://user:pass@host:587`) |
| `NOTIFICATIONS_ALLOW_PRIVATE_URLS` | `false` | Allow webhooks to private/internal addresses |
| `RUN_RETENTION_DAYS` / `AUDIT_RETENTION_DAYS` | `90` / `365` | Data retention (0 = keep forever) |
| `STEP_ENV_ALLOWLIST` | — | Environment variables steps may read as `{{env.NAME}}` |
| `EVIDENCE_TRACE` / `EVIDENCE_VIDEO` | `on_failure` | Default trace / video capture when an agent does not set `evidence` (`off`, `on_failure`, `always`) |
| `SALESFORCE_SIMULATOR` | on outside production | Serve the Salesforce simulator at `/demo/salesforce` |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot connect to PostgreSQL` on start | Start the DB (`docker compose up -d postgres`) and check `DATABASE_URL`. |
| `Port 3000 is already in use` | Set `PORT` in `.env`, and `NEXT_PUBLIC_API_URL` for the frontend to match. |
| UI shows "Cannot reach the backend" | Start the backend; check `NEXT_PUBLIC_API_URL`. |
| `Could not start chromium` | Run `npm run setup` again (on Linux add `-- --with-deps` for the system libraries). |
| "No AI provider is configured" | Add a provider key to `.env` and restart the backend. Check **AI Providers → Test connections**. |
| "No test cases match this agent's test selection" | Add tests or widen the agent's module/priority/tag filters; the agent page shows what will run. |
| Copilot errors | See [docs/copilot.md](docs/copilot.md#troubleshooting). |
| Steps fail with "Element … was not found" | Check the selector in the run details screenshot; enable self-healing with an AI provider. |
