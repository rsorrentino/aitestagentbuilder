<div align="center">

# 🧠 AI Test Agent Builder

**Turn test specs into automated browser tests that actually run, with AI doing the tedious parts.**

[![Node.js](https://img.shields.io/badge/Node.js-20.19%2B-339933?logo=node.js)](https://nodejs.org)
[![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js)](https://nextjs.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.63-2EAD33?logo=playwright)](https://playwright.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

[Quick start](#-quick-start) · [Running guide](RUNNING.md) · [API](docs/api.md) · [GitHub Copilot](docs/copilot.md) · [Architecture](docs/architecture.md)

</div>

---

## What it does

1. **Describe your app as an agent**: a base URL plus which tests to run (modules, priorities, tags).
2. **Get test cases** in any of three ways:
   - upload a test book (PDF, Word, Excel, CSV, Markdown, HTML, TXT) and let the AI extract executable tests,
   - let the AI open your app, read its interactive elements and generate tests,
   - write them yourself in the step editor.
3. **Run them in a real browser** (Playwright/Chromium) and watch live: screenshots and step logs stream to the UI.
4. **Inspect results**: per-step status, timings, failure screenshots, plus HTML, JUnit and JSON reports.

**No AI key? Runs still work.** AI is only needed for extraction, generation, chat and self-healing.

## ✨ MVP 1 features

| Area | What works |
|---|---|
| **Agents** | Create/list/delete, test selection by module, priority, tags or explicit IDs, plan preview ("tests in the next run"), active/inactive |
| **Test cases** | Create/edit/delete with a step editor, search and filter, validation, natural-language or canonical actions |
| **Documents** | Upload (50 MB max), text preview, AI extraction into test cases, per-document status and counts |
| **Execution** | Built-in Playwright executor, isolated browser context per test, retries, cancellation, concurrency limit, run-interruption recovery |
| **Self-healing** | When a selector breaks, the AI proposes a replacement from the live page and the step is retried |
| **Live view** | Socket.IO stream of screenshots, step logs and progress, with a polling fallback |
| **Reports** | HTML (with screenshots), JUnit XML, JSON, downloadable from the UI or API |
| **AI providers** | Anthropic Claude, OpenAI (and compatible), Azure OpenAI, **GitHub Copilot via API, SDK or CLI**, with task routing and automatic fallback |
| **Chat assistant** | Write tests conversationally and save the JSON it returns as test cases |
| **Auth** | Off by default for local use; with `AUTH_ENABLED=true`: login page, JWT, API keys, roles |
| **CLI / CI** | `npm run cli -- run -c agent.yml` waits for the run, writes reports and exits non-zero on failure |
| **Salesforce personas** | Test as administrators, sales reps and read-only users: UI password, password + authenticator code (TOTP), OAuth JWT bearer → frontdoor, OAuth password, or "Log in as". Identity checks (profile, permission sets), one test run as many personas with per-persona expectations, object/field/record access and access-denied assertions. Built-in Salesforce simulator at `/demo/salesforce` |
| **Quality checks** | Accessibility (axe-core, WCAG 2.x), visual regression against approved baselines, Playwright trace + video of failures (secrets masked), AI-repaired selectors kept and written back to test cases |
| **AI-judged assertions** | `assert_ai`: plain-language expectations judged by the AI against the live page (e.g. chatbot answers), with confidence threshold and per-run cache |
| **API testing** | HTTP request steps with status / JSON / header / timing assertions and captured variables, tests generated from OpenAPI (with AI edge cases), mocked or blocked calls in UI tests |
| **Unattended nights** | Pre-flight checks with retries (one alert instead of hundreds of failures when the app is down), failed tests re-run at the end in a fresh browser, maximum run time, interrupted runs started again after a restart, daily digest every morning |
| **Jira** | Stories imported as AI-written tests linked to them, test results shown on each story, requirement coverage page, bugs filed automatically for new failures of unattended runs (screenshot attached, never duplicated, commented when failing again, resolved when the tests pass) — Jira Cloud and Data Center ([docs/integrations.md](docs/integrations.md)) |
| **GitHub** | Tests run on every pull request, push and successful deployment (preview URLs tested), status check on the commit, one pull request comment kept up to date, bugs as issues closed when fixed, signed webhooks or a generated Actions workflow ([docs/integrations.md](docs/integrations.md#github)) |
| **GitLab & Azure DevOps** | The same for merge requests (review apps tested) and Azure Repos pull requests: commit statuses, one comment kept up to date, bugs as GitLab issues or Azure work items (screenshot attached) resolved when fixed, user stories imported as tests, GitLab CI and Azure Pipelines templates |
| **Cross-browser, devices & parallel runs** | Every test in Chromium, Firefox and WebKit and on emulated phones and tablets (iPhone, Pixel, iPad …), results kept per browser, up to 16 tests at a time; locally or on BrowserStack, LambdaTest, Sauce Labs or your own Playwright grid ([docs/agents.md](docs/agents.md#browsers--devices)) |
| **Sign-in & MFA for any app** | Login profiles for any web application (SSO and two-step forms found automatically, authenticator codes typed when asked, "remember this device" accepted) and encrypted sessions reused across runs, for Salesforce personas too; "sign in once" in a server browser for push / SMS MFA; QR-screenshot authenticator setup; emailed and SMS codes read from a test mailbox (IMAP) or Twilio number; sign-in health on the dashboard and warnings before a session saved by a person expires |
| **Test recorder** | Record tests by clicking through the application in a server-side browser (robust unique selectors, secrets as placeholders), or import `npx playwright codegen` scripts (JS/TS/Python) |
| **AI action steps** | “AI: add the cheapest product to the cart”: the AI carries out an instruction on the live page; what worked is replayed without the AI, secrets never reach it, and the actions can be saved as ordinary steps |
| **Page speed** | `assert_performance` and an agent-wide check: LCP, FCP, CLS, TBT, TTFB, load, bytes against budgets and against earlier runs (regressions), optional network/CPU throttling, per-page trend |
| **Test data generation** | `{{fake.email}}`-style values (Faker, 30+ kinds, locales, reproducible with a seed), data-driven tests that run once per data set row, data sets generated from column kinds or by the AI with edge cases |
| **Flaky-test quarantine** | Flaky tests keep running without failing runs, CI or notifications; quarantined by hand or automatically, released when stable |
| **Failure triage** | Failures grouped by cause and classified as app bug, test bug or environment, new vs. seen before, optionally explained by the AI; in notifications and the MCP server |
| **MCP server** | Claude Code, Copilot, Cursor and other agents can write tests, run them and read failure evidence ([docs/mcp-server.md](docs/mcp-server.md)) |
| **Demo** | Built-in demo shop at `/demo` with ready-made tests: one click on the dashboard |

## 🏢 Enterprise features

Turn on authentication (`AUTH_ENABLED=true`) to get projects with role-based access, user
administration with password policy and lockout, project-scoped API keys, an audit log, encrypted
secrets, cron schedules, CI runs that wait for the result, notifications (webhooks, Slack, Teams,
email), analytics (pass-rate trends, flaky tests), data retention, an OpenAPI reference at
`/api/docs` and Docker images (`docker compose --profile full up -d --build`) or a native Windows Server install
without Docker ([docs/windows.md](docs/windows.md)).
See [docs/enterprise-roadmap.md](docs/enterprise-roadmap.md) for the full list and what comes next.

## 🚀 Quick start

**Prerequisites:** Node.js 20.19+ (22 recommended) and PostgreSQL 14+. Works the same on Windows, Linux and macOS.

Everything runs from the root `package.json`:

```bash
git clone https://github.com/rsorrentino/aitestagentbuilder.git
cd aitestagentbuilder
npm run setup        # installs dependencies + Chromium, creates .env, migrates the database
npm run dev          # API on http://localhost:3000 + UI on http://localhost:4000, live reload
```

No PostgreSQL yet? `npm run docker:db` starts one with Docker, or install it natively and set `DATABASE_URL` in `.env`.

| Command | What it does |
|---|---|
| `npm run setup` | development install (`.env` from `.env.example`) |
| `npm run setup -- --production --host myserver --db postgresql://…` | production install: generated secrets, admin account, build, migrations |
| `npm run dev` / `npm start` | run API + UI with live reload / the production build (Ctrl+C stops both) |
| `npm run build` · `npm run db:migrate` · `npm run status` | build both apps · migrate the database · check both are answering |
| `npm run service:install` / `service:uninstall` | start at boot: Windows service or systemd unit |
| `npm test` · `npm run test:integration` · `npm run test:e2e` | unit · API + database + browser · UI end-to-end |
| `npm run demo:seed` · `npm run cli -- run -c agent.yml` | create the demo agent · run tests from CI |

Open **http://localhost:4000** and click **🎮 Try the demo** → **▶ Start Run**. Three tests run against the built-in demo shop and you can watch them live.

To enable the AI features, add one provider to `.env` and restart the backend:

```env
ANTHROPIC_API_KEY=sk-ant-...          # or
OPENAI_API_KEY=sk-...                 # or GitHub Copilot:
COPILOT_MODE=api                      # api | sdk | cli
COPILOT_GITHUB_TOKEN=...              # e.g. the output of `gh auth token`
```

Step-by-step instructions and troubleshooting are in **[RUNNING.md](RUNNING.md)**; Windows Server specifics in **[docs/windows.md](docs/windows.md)**.

## 🐙 GitHub Copilot

Copilot works as a full AI provider through three transports. Pick one with `COPILOT_MODE`:

| Mode | How it talks to Copilot | Auth |
|---|---|---|
| `api` (default) | Copilot chat completions API (GitHub token exchanged for a Copilot token); `COPILOT_BASE_URL` can point at GitHub Models | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` |
| `sdk` | Official [`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk) (installed with the backend) | token, or an existing `copilot` / `gh` login |
| `cli` | [GitHub Copilot CLI](https://www.npmjs.com/package/@github/copilot) in non-interactive mode (`copilot -p … -s`) | token, or an existing `copilot` / `gh` login |

Copilot is always used as a plain text model with **no tools enabled**, so it never runs commands on your server. Details: [docs/copilot.md](docs/copilot.md).

## 🧪 Writing tests

A test case is a list of steps. Each step has an **action**, an optional **target** and an optional **value**:

| Action | Target | Value |
|---|---|---|
| `navigate` | URL or path relative to the agent's base URL (`/login`) | |
| `click`, `hover`, `check`, `uncheck` | selector | |
| `fill`, `select` | selector | text / option |
| `press` | selector (optional) | key, e.g. `Enter` |
| `wait` | selector to wait for | or `data.ms` |
| `assert_visible` | selector | |
| `assert_text` | element (optional; whole page if empty) | expected text |
| `assert_url`, `assert_title` | | expected substring |
| `screenshot` | | |
| `assert_not_visible` | selector | |
| `salesforce_login`, `salesforce_logout` | persona name | |
| `assert_object_access`, `assert_field_access`, `assert_record_access` | `Account`, `Account.AnnualRevenue`, record Id | `{"read": true, "delete": false}` |
| `assert_profile`, `assert_access_denied` | expected profile / page to open | |
| `assert_accessible` | optional element | `{"level": "wcag21aa", "ignore": ["color-contrast"]}` |
| `assert_screenshot` | optional element | `{"name": "home", "mask": [".clock"]}` |

Targets can be CSS selectors (`#id`, `.class`, `input[name=q]`), Playwright selectors (`text=Sign in`), or **plain labels** like `Sign in button` or `Username`. Plain labels resolve in priority order: label, placeholder, button, link, then text. Natural phrasing from extracted documents ("Enter username", "Verify the welcome message is displayed") is understood too. Steps that cannot be automated are reported as skipped rather than failing.

For Salesforce, mark a test with the personas it must run as (`data.personas`) and give per-persona expectations with `by_persona` — see the [Salesforce guide](docs/salesforce-guide.md#1-authentication-and-personas).

## 🏗️ Project layout

```
backend/    Express + TypeScript API, Playwright executor, LLM router, Socket.IO, CLI
frontend/   Next.js UI (dashboard, agents, runs, live view, test cases, documents, settings)
e2e/        Playwright end-to-end tests of the UI (full stack)
mcp-server/ Model Context Protocol server exposing the platform to AI assistants
executor/   Legacy Python executor (optional, EXECUTOR=python)
configs/    Example agent YAML files for the CLI
docs/       Documentation
```

## ✅ Tests

```bash
npm test                  # unit tests
npm run test:integration  # API, enterprise, Salesforce personas: real Postgres + real browser (TEST_DATABASE_URL or a local DB)
npm run test:e2e          # UI end-to-end; run "npm run setup -- --with-e2e" once and start the app first
```

The integration suite also exercises the Copilot **CLI** and **API** transports against local fakes, so it needs no credentials.

## 📚 Documentation

- [RUNNING.md](RUNNING.md): install, configure, run, troubleshoot
- [docs/api.md](docs/api.md): REST API and WebSocket events
- [docs/copilot.md](docs/copilot.md): GitHub Copilot API / SDK / CLI setup
- [docs/architecture.md](docs/architecture.md): how the pieces fit together
- [docs/agents.md](docs/agents.md): agent configuration, CLI and CI usage
- [docs/mvp-demo.md](docs/mvp-demo.md): 10-minute guided demo
- [docs/windows.md](docs/windows.md): install on Windows Server without Docker (PowerShell scripts, Windows services)
- [docs/enterprise-roadmap.md](docs/enterprise-roadmap.md): enterprise features and roadmap
- [docs/salesforce-guide.md](docs/salesforce-guide.md): testing Salesforce orgs as many users (personas, MFA, JWT, Log in as, permission assertions)
- [docs/integrations.md](docs/integrations.md): Jira, GitHub, GitLab and Azure DevOps (stories → tests, results on stories and pull requests, automatic bugs, runs on every pull request and deployment)
- [docs/mcp-server.md](docs/mcp-server.md): MCP server
- [docs/production-readiness.md](docs/production-readiness.md): deployment notes

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

## 📄 License

MIT. See [LICENSE](LICENSE).
