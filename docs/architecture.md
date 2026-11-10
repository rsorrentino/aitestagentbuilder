# Architecture

```
┌──────────────────────┐   REST + Socket.IO   ┌─────────────────────────────────────────────────────────┐
│  Next.js UI (:4000)  │ ───────────────────▶ │  Express API (:3000)                                     │
│  dashboard, agents,  │ ◀─────────────────── │  controllers → services → repositories → PostgreSQL      │
│  runs, live view,    │   run events,        │                                                          │
│  test cases, docs    │   screenshots        │  Orchestrator ─ queue/concurrency ─▶ RunExecutor          │
└──────────────────────┘                      │        │                              │ Playwright        │
                                              │        ▼                              ▼ (Chromium)        │
┌──────────────────────┐                      │  Planner (selects tests)      application under test     │
│ CLI / CI / MCP server│ ───────────────────▶ │                                                          │
└──────────────────────┘                      │  LLM Router ─▶ Claude · OpenAI · Azure · Copilot         │
                                              │                (api | sdk | cli)                          │
                                              └─────────────────────────────────────────────────────────┘
```

## Backend (`backend/src`)

| Layer | Location | Responsibility |
|---|---|---|
| Entry | `index.ts`, `app.ts` | Connects to the DB, runs migrations, seeds the admin, marks interrupted runs, starts HTTP + Socket.IO. `createApp()` builds the Express app (also used by tests). |
| API | `api/routes`, `api/controllers` | Validation, HTTP status codes, wiring to services |
| Domain | `core/domain` | Types plus normalization/validation of test cases (`normalize.ts`) |
| Persistence | `core/repositories`, `infra/db` | SQL via `pg`. The idempotent schema (`schema.ts`) is applied on every start; pgvector is optional |
| Ingestion | `modules/ingestion` | Parse PDF/DOCX/XLSX/CSV/MD/HTML/TXT to text (text formats stored as UTF-8, binary as base64); the LLM extracts test cases |
| Planning | `modules/agents/services/planner-agent.service.ts` | Select tests from the agent's `test_selection` (ids, module, priority, type, tags) and order them by priority |
| Generation | `modules/agents/services/ai-test-generator.service.ts` | Opens the target page, outlines its interactive elements with real selectors, and asks the LLM for tests |
| Orchestration | `modules/orchestration` | Run lifecycle, FIFO queue with `MAX_CONCURRENT_RUNS`, cancellation, graceful shutdown |
| Execution | `modules/execution` | `RunExecutor` (one browser per run, one context per test, retries, screenshots), `step-runner` (action classification, locator resolution, assertions), self-healing |
| Reporting | `modules/reporting` | HTML / JUnit / JSON rendered on demand from the latest attempt of each test |
| AI | `infra/llm` | `LLMRouter` picks providers per task and falls back on errors; `LLMClient` for Anthropic/OpenAI/Azure; `copilot.ts` for the three Copilot transports |
| Realtime | `infra/websocket` | Socket.IO rooms per run (`subscribe_run`) |
| Auth | `infra/auth` | Local mode (default) or JWT + API keys + roles |
| Demo | `demo/` | Demo web app at `/demo` and the seed for its agent and tests |

### Run lifecycle

1. `POST /runs`: the planner resolves the agent's tests. If none match, the request fails with `400` before any run is created.
2. The run is stored as `pending` with `total_tests` and queued.
3. When a slot is free, the run becomes `running`. The executor launches Chromium and runs each test in a fresh browser context:
   - a `results` row is created (`running`), then the steps execute in order,
   - after each step a JPEG is streamed (`run_screenshot`) and a log line emitted (`run_log`),
   - on a selector failure with self-healing on, the LLM gets the page outline and proposes a new selector; the step is retried once,
   - the final or failure screenshot is saved to `ARTIFACTS_PATH`,
   - the result row is updated with status, per-step details (`metadata.steps`), logs and evidence, and the run counters are recomputed from the latest attempt of each test.
4. Failed tests are retried up to `config.retries` times (max 3).
5. The run ends as `completed`, `failed` or `cancelled`, and `run_completed` is emitted.
6. If the server restarts mid-run, the run is marked `failed` with an explanatory error on the next start.

### AI routing

| Task | Order (configured providers only) |
|---|---|
| extraction | Claude → OpenAI → Azure → Copilot |
| chat, healing | Claude → OpenAI → Azure → Copilot |
| codegen | Copilot → OpenAI → Claude → Azure |

`LLM_PROVIDER` or an agent's preferred provider moves that provider to the front. A refusal or error from one provider falls through to the next. When none is configured, AI endpoints return `503` with setup instructions; test runs are unaffected.

## Frontend (`frontend/src`)

Next.js pages router. `lib/api.ts` is the axios client (auth header, 401 → login redirect, error messages); `lib/useRunEvents.ts` handles the Socket.IO subscriptions. Pages: dashboard, agents (list/new/detail), runs (list/detail), live view, test cases (with editor), documents, AI providers, Salesforce wizard, login.

## Data model

`agents` (config JSONB) · `test_cases` (steps/expected results JSONB, `document_id`) · `documents` (content, status) · `runs` (counters, metadata) · `results` (status, logs, evidence, `metadata.steps`) · `reports` · `test_data` · `users` · `api_keys`.

## Other components

- **CLI** (`backend/src/cli`): `run` (create/update the agent from YAML, run, wait, write reports, exit code) and `report`.
- **MCP server** (`mcp-server/`): exposes ingestion, planning, runs and reports as MCP tools for AI assistants.
- **Legacy Python executor** (`executor/`): the original Python/Playwright runner, selectable with `EXECUTOR=python`. The built-in Node executor is the supported path.
