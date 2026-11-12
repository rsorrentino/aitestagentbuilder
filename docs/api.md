# API Reference

Base URL: `http://localhost:3000/api/v1`. All bodies are JSON unless noted. Errors return `{ "error": "message" }` with a 4xx/5xx status.

## Authentication

With `AUTH_ENABLED=false` (default) no credentials are needed. With `AUTH_ENABLED=true`, send one of:

```
Authorization: Bearer <accessToken>     # from POST /auth/login
Authorization: ApiKey <apiKey>          # from POST /auth/api-keys
```

| Method | Path | Description |
|---|---|---|
| GET | `/auth/config` | `{ authEnabled }` (public) |
| POST | `/auth/login` | `{ email, password }` → `{ accessToken, refreshToken, user }` |
| POST | `/auth/refresh` | `{ refreshToken }` → new token pair |
| GET | `/auth/me` | Current user |
| POST | `/auth/api-keys` | `{ name?, permissions?, expiresInDays? }` → `{ id, apiKey }` (shown once) |
| GET | `/auth/api-keys` | List keys |
| DELETE | `/auth/api-keys/:id` | Revoke |

## Agents

| Method | Path | Description |
|---|---|---|
| POST | `/agents` | Create. `400` invalid config, `409` duplicate name |
| GET | `/agents` | List (`?limit&offset`) |
| GET | `/agents/:id` | Get |
| PUT | `/agents/:id` | Update `{ name?, config?, status? }` (config is merged and re-validated) |
| DELETE | `/agents/:id` | Delete (also deletes its runs) |
| GET | `/visual/baselines?agentId=` | Visual baselines of the project (signed `image` URL) |
| DELETE | `/visual/baselines/:id` | Delete a baseline (editor); the next run records a new one |
| POST | `/runs/:runId/results/:resultId/visual/approve` | `{ name, persona?, viewport? }`: the screenshot of a failed visual check becomes the baseline (editor) |
| POST | `/agents/:id/generate-api-tests` | `{ specUrl? \| spec?, operations?, ai?, count?, save? }`: test cases from an OpenAPI / Swagger description → `{ operations, created, tests, skipped[], servers }` (editor) |
| GET | `/quarantine` | Quarantined test cases of the project (`reason`, `auto`, `stats`) |
| POST | `/testcases/:id/quarantine` | `{ reason }`: quarantine a test by hand (editor) |
| DELETE | `/testcases/:id/quarantine` | Release it (editor) |
| POST | `/runs/:runId/triage` | `{ ai? }`: (re)triage the run's failures, optionally explained by the AI (editor) → `{ groups[], summary, ai }`; also stored as `run.metadata.triage` |
| POST | `/runs/:runId/results/:resultId/apply-healing` | `{ stepIds? }`: write AI-repaired selectors of this result into the test case (editor) → `{ applied, skipped }` |
| POST | `/agents/:id/salesforce/personas/:name/verify` | Log in as the persona and return `{ ok, message, identity: { username, profile, permissionSets, via }, mismatches[] }` (editor) |
| GET | `/agents/:id/plan` | Tests the next run would execute: `{ strategy, count, testCases[] }` |
| POST | `/agents/:id/generate-tests` | `{ description?, count?, modules?, save? = true }`: AI reads the live page and writes tests (tagged `agent:<id>`, `ai-generated`). `503` without an AI provider |

```json
POST /agents
{
  "name": "Checkout tester",
  "config": {
    "base_url": "https://staging.example.com",
    "environment": "staging",
    "test_selection": { "module": ["Checkout"], "priority": ["High", "Critical"], "tags": [], "testIds": [] },
    "ai": { "provider": "copilot", "self_healing": true },
    "retries": 1
  }
}
```

Empty selection lists mean "no filter". `ai.provider` is one of `anthropic`, `openai`, `azure`, `copilot` (aliases `claude`, `github`), or empty for automatic.

## Test cases

| Method | Path | Description |
|---|---|---|
| POST | `/testcases` | Create (`title`, `module` required) |
| GET | `/testcases` | List with filters: `q`, `module`, `priority`, `type`, `tags` (comma separated), `documentId`, `limit`, `offset` |
| GET | `/testcases/modules` | `[ { module, count } ]` |
| GET | `/testcases/:id` | Get |
| PUT | `/testcases/:id` | Partial update |
| DELETE | `/testcases/:id` | Delete |

```json
POST /testcases
{
  "title": "Valid login opens the dashboard",
  "module": "Authentication",
  "priority": "Critical",
  "type": "Smoke",
  "tags": ["smoke"],
  "steps": [
    { "action": "navigate", "target": "/login" },
    { "action": "fill", "target": "#username", "data": { "value": "demo" } },
    { "action": "fill", "target": "Password", "data": { "value": "demo123" } },
    { "action": "click", "target": "Sign in button" },
    { "action": "assert_url", "data": { "value": "/dashboard" } },
    { "action": "assert_text", "target": "#welcome", "data": { "value": "Welcome" } }
  ],
  "expectedResults": ["The dashboard greets the user"]
}
```

The step actions are listed in the [README](../README.md#-writing-tests).

## Documents

| Method | Path | Description |
|---|---|---|
| POST | `/ingestion/upload` | `multipart/form-data`, field `file` (≤ 50 MB). PDF, DOCX, XLSX/XLS, CSV, MD, HTML, TXT |
| GET | `/ingestion/documents` | List (without content), with `status` and `testCaseCount` |
| GET | `/ingestion/documents/:id/preview` | Parsed plain text (first 20,000 characters) |
| POST | `/ingestion/documents/:id/extract` | `{ module?, priority?, baseUrl? }`: AI extraction, saves the test cases. `503` without an AI provider |
| DELETE | `/ingestion/documents/:id` | Delete (extracted tests are kept) |

## Runs

| Method | Path | Description |
|---|---|---|
| POST | `/runs` | `{ agentId, testIds?, metadata? }` → run (`201`). `400` if no test matches the selection |
| GET | `/runs` | Run summaries (`?agentId&limit`), newest first, with `agentName` |
| GET | `/runs/:id` | Run with `results[]` (each has `metadata.title`, `metadata.steps[]`, `evidence.screenshots[]`) |
| POST | `/runs/:id/cancel` | Cancel a pending/running run (`409` otherwise) |
| GET | `/runs/:id/report?format=html\|json\|junit[&download=1]` | Rendered report |
| GET | `/runs/stats` | `{ running, queued, maxConcurrent }` |
| POST | `/reports/runs/:runId/generate` | Write report files to `REPORT_STORAGE_PATH` |

Run status: `pending` → `running` → `completed` (all passed or skipped), `failed` (at least one failure or an executor error) or `cancelled`. Test result status: `running`, `passed`, `failed`, `error`, `skipped`.

Screenshots are served at `GET /artifacts/<path from evidence.screenshots>`.

## AI

| Method | Path | Description |
|---|---|---|
| POST | `/chat` | `{ messages: [{role, content}], task?, context?, provider? }` → `{ content, provider, usage }` |
| GET | `/llm/providers` | Provider status (`?check=true` sends a live test request), Copilot `mode`, routing order, `anyConfigured` |

## Demo

| Method | Path | Description |
|---|---|---|
| POST | `/demo/seed` | Creates/updates the *Demo Shop* agent and its 3 tests → `{ agentId, created }` |
| GET | `/demo/` (outside `/api/v1`) | The demo web app itself (login `demo` / `demo123`) |

## Sign-in & MFA

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/agents/:id/auth/sessions` | viewer | Saved sessions of the agent's login profiles and Salesforce personas: `[{ kind: app\|salesforce, identity, capturedAt, expiresAt, expired, lastUsedAt, capturedBy, cookies }]` (never their contents) |
| DELETE | `/agents/:id/auth/sessions?kind=&identity=` | editor | Forget saved sessions (all, or one) → `{ forgotten }` |
| POST | `/agents/:id/auth/profiles/:name/verify` | editor | Sign in as a login profile now (`{ fresh: true }` ignores the saved session) and save the session → `{ ok, message, reused, usedMfa, landedUrl, session }` or `{ ok: false, error }` |

| GET | `/agents/:id/auth/totp?kind=app\|salesforce&identity=` | editor | Current code of a saved authenticator key `{ code, secondsLeft, digits, issuer, account }` (the key is never returned) |
| POST | `/agents/:id/auth/interactive` | editor | *Sign in once*: `{ kind: app\|salesforce, identity }` opens the sign-in page in a server browser → `{ id, url, title, viewport, canFill }` |
| GET | `/auth/interactive/:sid`, `/auth/interactive/:sid/screenshot` | editor | State / current screen (JPEG) |
| POST | `/auth/interactive/:sid/input` | editor | `{ type: click, x, y }`, `{ type: text, text }`, `{ type: key, key: Enter\|Tab\|Escape\|… }`, `{ type: scroll, dy }`, `{ type: navigate, url }`, `{ type: fill, what: username\|password\|code }` (stored values, never returned) |
| POST | `/auth/interactive/:sid/finish` | editor | Save the session (409 when the page does not look signed in; `{ force: true }` saves anyway) → `{ signedIn, session }` and closes the browser |
| DELETE | `/auth/interactive/:sid` | editor | Close without saving |

Login profiles are part of the agent config (`config.auth`), with `password` and `totp_secret` encrypted and returned
as `••••••••`.

## Recorder

Editors only; a session belongs to the user and project that started it.

| Method | Path | Description |
|---|---|---|
| POST | `/recordings` | `{ agentId, startPath?, persona? }` → session state `{ id, url, title, steps, viewport }` (429 when all `RECORDER_MAX_SESSIONS` are in use) |
| GET | `/recordings`, `/recordings/:id` | Open sessions / one session's state |
| GET | `/recordings/:id/screenshot` | Current screen, JPEG |
| POST | `/recordings/:id/inspect` | `{ x, y }` → `{ selector, alternatives, tag, type, text, value, options, checked, suggested, isPassword }` |
| POST | `/recordings/:id/steps` | `{ action, target?, value?, secret? }`: performed, then recorded (422 with the error when it fails); `secret: "NAME"` records `{{secrets.NAME}}` |
| DELETE | `/recordings/:id/steps/:index` | Remove a recorded step |
| POST | `/recordings/:id/scroll` | `{ dy }` (not recorded) |
| POST | `/recordings/:id/save` | `{ title, module?, priority?, tags? }` → the new test case (tags `recorded`, `agent:<id>`) |
| DELETE | `/recordings/:id` | Close the session |
| POST | `/recordings/import` | `{ script, agentId?, save?, title?, module?, priority? }` → `{ steps, skipped, warnings, language, testCase? }` |

## AI action steps

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/runs/:runId/results/:resultId/ai-actions/apply` | editor | `{ stepId }`: replace that AI step of the test case with the ordinary steps the AI performed (409 when the test case changed since) |
| DELETE | `/agents/:id/ai-action-cache?testCaseId=` | editor | Forget remembered AI action sequences → `{ cleared }` |

Results carry the actions in `metadata.aiActions` (`stepId`, `instruction`, `actions[]` with `ok`/`error`/`cached`,
`done`, `reason`, `rounds`, `replayed`, `provider`).

## Page speed

`GET /agents/:id/performance?days=30` (viewer) → `{ pages: [{ page, samples: [{ runId, at, metrics }], latest, median }] }`:
the page speed measured by `assert_performance` steps and the agent-wide `checks.performance`, per page (origin and path),
oldest sample first. Results carry the measurements in `metadata.performance`.

## Test data

`POST/GET /testdata`, `GET/PUT/DELETE /testdata/:id`: named JSON data sets `{ name, data, description?, tags?, environment? }`.
A data set with `data.rows` (or `data` given as an array, stored as `{ rows }`) drives data-driven tests: a test case
with `data.dataset` set to its name or id runs once per row. `GET /testdata/:id` adds `rowCount`.

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/testdata/generate` | editor | `{ fields?: { column: kind }, prompt?, count? (≤100), locale?, seed?, save?, name?, environment?, provider? }` → `{ rows, source: faker\|ai, saved? }`. `fields` alone uses Faker; `prompt` uses the AI (fields become column hints). 400 for unknown kinds or locales, or when no AI provider is configured for a prompt. |
| GET | `/testdata/fake-kinds?locale=it` | viewer | Kinds usable as `{{fake.kind}}`, with a description and an example |

## Health & metrics (outside `/api/v1`)

| Path | Description |
|---|---|
| `GET /health/ready` | `{ ready }`: database reachable |
| `GET /health/live` | Liveness |
| `GET /health/health` | Detailed health |
| `GET /health/metrics` | Prometheus metrics |

## WebSocket events

Socket.IO on the API origin, path `/socket.io`. Subscribe to a run's room:

```js
const socket = io('http://localhost:3000');
socket.emit('subscribe_run', { runId });
socket.on('run_log', (e) => console.log(e.message));
```

Every payload includes `runId` and `timestamp`.

| Event | Payload |
|---|---|
| `run_started` | `{ total, agentId, agentName }` |
| `test_started` | `{ testId, title, index, total }` |
| `run_log` | `{ level, message, testId?, stepId? }` |
| `run_screenshot` | `{ testId, image }` (base64 JPEG after each step) |
| `test_result` | `{ testId, resultId, title, status, error?, duration }` |
| `run_progress` | `{ status, completed, total, passed, failed, skipped }` |
| `run_completed` | `{ status, total, passed, failed, skipped, error? }` |
| `runs_changed` | Broadcast to all clients when any run starts, finishes or records a result |

## Rate limits

1000 requests / 15 min per client by default (`RATE_LIMIT_POINTS`), 60 uploads / hour (`RATE_LIMIT_UPLOADS`), 20 login attempts / minute. Responses over the limit are `429` with `Retry-After`.
