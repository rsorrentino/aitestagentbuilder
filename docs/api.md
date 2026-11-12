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
| POST | `/runs` | `{ agentId, testIds?, baseUrl?, metadata? }` → run (`201`); `baseUrl` tests another address than the agent's (preview deployments). `400` if no test matches the selection |
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

## Unattended runs and digest

Run metadata for unattended runs:
- `preflight` (`{ ok, attempts, checks: [{ name, ok, detail, blocking }] }`)
- `resumedFrom` / `resumedAs` (runs started again after a restart)
- `testIds` (when given)

Re-run results carry `metadata.rerun: true`.

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/notifications/:id/digest` | project admin | Send the daily digest of a channel now |

Notification events:
- `run.completed`, `run.failed`, `run.cancelled`
- `auth.session_expiring`
- `digest.daily`, with channel config `digest_time` (HH:MM) and `digest_timezone`; the webhook payload's `run.digest`
  has the per-agent details

## Library

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/blocks` | viewer | Step blocks: `{ id, name, description, params: [{ name, default?, description? }], steps }` |
| GET | `/blocks/:id` | viewer | A block with `usage: { tests, blocks }` |
| POST | `/blocks` | editor | Create (`409` if the name exists, any case) |
| PUT | `/blocks/:id` | editor | Update; a new name is followed by every test and block using it |
| DELETE | `/blocks/:id[?force=true]` | editor | `409 { usage }` while used, unless forced |
| GET | `/elements` | viewer | Elements: `{ id, name, locator, alternatives, description, pageUrl, source, healedAt }` |
| GET | `/elements/:id` | viewer | An element with `usage` |
| POST / PUT / DELETE | `/elements[/:id]` | editor | As for blocks |

| POST | `/steps/from-text` | editor | `{ text, agentId?, path? }` → `{ steps, lines: [{ text, steps, via: rules \| ai \| none, note? }], usedAi, pageOutline }`: plain English to steps |

Steps: `{ "action": "use_block", "target": "<block>", "data": { "params": { … } } }`; `{{el.Name}}` in any target or value.

## App map (discovery)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/agents/:id/discover` | editor | `{ maxPages (25, ≤200), maxDepth (3, ≤6), loginAs?, startPaths?, exclude? }` → `202` discovery (`409` while one runs in the project) |
| GET | `/discoveries[?agentId=]` | viewer | Recent discoveries (counts) |
| GET | `/discoveries/:id` | viewer | `{ status, progress, pages: [{ url, pattern, title, heading, name, elements: [{ name, role, label, locator, alternatives? }], covered }], proposals: [{ title, module, steps, data?, source, elements }], skipped, signedInAs }` |
| POST | `/discoveries/:id/cancel` | editor | Stop a running discovery |
| POST | `/discoveries/:id/elements` | editor | `{ names? }`: add elements to the library (existing names kept) → `{ created, skipped }` |
| POST | `/discoveries/:id/tests` | editor | `{ indexes? }`: create proposed tests (and the elements they use) → `{ tests, elements }` |

## Integrations

See [integrations.md](integrations.md). Secrets (`api_token`, `token`, `pat`, `webhook_secret`) are encrypted and returned as `••••••••`.

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/integrations` | viewer | List integrations (with `lastCheck`) |
| POST | `/integrations` | project admin | Add one: `{ type: "jira", name, config }` |
| PUT | `/integrations/:id` | project admin | Update `name`, `enabled`, `config` (merged; omitted secrets kept) |
| DELETE | `/integrations/:id` | project admin | Delete (links and bug tracking; the issues stay in Jira) |
| POST | `/integrations/:id/check` | editor | Check the connection → `{ ok, account, details }` or `{ ok: false, error }` |
| GET | `/integrations/:id/issues?q=` | viewer | Search: keys (`SHOP-1, SHOP-2`), JQL, or words |
| POST | `/integrations/:id/import` | editor | `{ keys: [..] }` or `{ query }`, `module?`, `agentId?`: the AI writes tests from each story and links them (needs an AI provider) |
| GET | `/testcases/:id/links` | viewer | Issues a test covers |
| POST | `/testcases/:id/links` | editor | `{ integrationId, key }` (the issue must exist) |
| DELETE | `/testcases/:id/links/:integrationId/:key` | editor | Unlink |
| GET | `/requirements/coverage` | viewer | `{ summary, requirements: [{ key, title, url, state, tests: [{ id, title, status, at, runId }] }] }`, state = passing / failing / partial / not_run |
| GET | `/defects?status=open\|resolved&agentId=` | viewer | Bugs filed by the platform: key, url, status, tests, occurrences, first/last run |
| GET | `/integrations/:id/workflow?agentId=&branch=&apiUrl=` | viewer | `{ path, secret, secretWhere, yaml }`: a GitHub Actions workflow, GitLab CI job or Azure Pipelines pipeline running the agent's tests |
| POST | `/hooks/gitlab/:integrationId` | none (`X-Gitlab-Token`) | GitLab webhook: Push Hook, Merge Request Hook, Deployment Hook; same answers as GitHub's |
| POST | `/hooks/azure/:integrationId` | none (`X-ATAB-Token` or basic auth password) | Azure DevOps service hook: `git.push`, `git.pullrequest.created`, `git.pullrequest.updated` (source branch updated) |
| POST | `/hooks/github/:integrationId` | none (HMAC) | GitHub webhook: `X-Hub-Signature-256` with the integration's `webhook_secret`; `push`, `pull_request`, `deployment_status` start the runs of matching `config.triggers` → `202 { runs: [{ agentId, runId }] }` or `202 { ignored: reason }` |

GitHub config: `{ repository, token, api_url?, webhook_secret?, commit_status (default true), pr_comment (default true),
triggers: [{ event: push | pull_request | deployment_status, agent_id, branches?, environments?, use_deployment_url?, include_drafts?, test_ids? }], defects }`.

GitLab config: `{ project, token, base_url?, webhook_secret?, commit_status, pr_comment, triggers, defects }`.
Azure DevOps config: `{ organization_url, project, pat, repository?, work_item_type? (Bug), webhook_secret?, commit_status, pr_comment, triggers (push, pull_request), defects: { …, resolve_transition? } }`.

Runs carrying `metadata.git` (`{ provider: "github" | "gitlab" | "azure_devops", repository, sha, pr?, ref? }`, set by webhooks or sent by CI to
`POST /runs`) get a commit status and, with `pr`, a pull request comment; `run.metadata.integrations[].status` and
`.comment` say what was reported.

After each run, `run.metadata.integrations` lists per integration what happened: `filed` (`[{ key, url, title }]`),
`commented`, `resolved`, `linked` (stories updated) and `errors`. Integration errors never fail a run.

## Sign-in & MFA

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/auth/health` | viewer | Sign-in health of the project: `{ identities: [{ agentId, agentName, kind, identity, unattended: yes\|maybe\|no, how, session: ok\|expiring\|expired\|none, expiresAt, attention, hint }], attention }` |
| POST | `/auth/health/warn` | editor | Send the expiry warnings now (normally hourly) → `{ warned }` |
| GET | `/agents/:id/auth/sessions` | viewer | Saved sessions of the agent's login profiles and Salesforce personas: `[{ kind: app\|salesforce, identity, capturedAt, expiresAt, expired, lastUsedAt, capturedBy, cookies }]` (never their contents) |
| DELETE | `/agents/:id/auth/sessions?kind=&identity=` | editor | Forget saved sessions (all, or one) → `{ forgotten }` |
| POST | `/agents/:id/auth/profiles/:name/verify` | editor | Sign in as a login profile now (`{ fresh: true }` ignores the saved session) and save the session → `{ ok, message, reused, usedMfa, landedUrl, session }` or `{ ok: false, error }` |

| POST | `/agents/:id/code-sources/:name/check` | editor | Connect to a mailbox / phone number → `{ ok, recent, newest: { at, from, subject } }` (never message content) or `{ ok: false, error }` |
| GET | `/agents/:id/auth/totp?kind=app\|salesforce&identity=` | editor | Current code of a saved authenticator key `{ code, secondsLeft, digits, issuer, account }` (the key is never returned) |
| POST | `/agents/:id/auth/interactive` | editor | *Sign in once*: `{ kind: app\|salesforce, identity }` opens the sign-in page in a server browser → `{ id, url, title, viewport, canFill }` |
| GET | `/auth/interactive/:sid`, `/auth/interactive/:sid/screenshot` | editor | State / current screen (JPEG) |
| POST | `/auth/interactive/:sid/input` | editor | `{ type: click, x, y }`, `{ type: text, text }`, `{ type: key, key: Enter\|Tab\|Escape\|… }`, `{ type: scroll, dy }`, `{ type: navigate, url }`, `{ type: fill, what: username\|password\|code }` (stored values, never returned) |
| POST | `/auth/interactive/:sid/finish` | editor | Save the session (409 when the page does not look signed in; `{ force: true }` saves anyway) → `{ signedIn, session }` and closes the browser |
| DELETE | `/auth/interactive/:sid` | editor | Close without saving |

Login profiles are part of the agent config (`config.auth`), with `password` and `totp_secret` encrypted and returned
as `••••••••`. Code sources are in `config.code_sources` (`password` / `auth_token` encrypted the same way).

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
