# Agents guide

An **agent** describes an application under test and which test cases to run against it. Test cases live in a shared library. Each agent selects from it with filters.

## Configuration

```yaml
agent_name: "Checkout tester"          # unique name
application_type: "web"                # web (executed by the built-in Playwright executor)
base_url: "https://staging.myapp.com"  # relative step targets resolve against this
environment: "staging"
test_selection:                        # empty / omitted lists = no filter; filters are combined (AND)
  module: ["Checkout"]
  priority: ["High", "Critical"]
  tags: ["smoke"]
  type: ["Functional"]
  testIds: []                          # restrict to these test case IDs (combined with the filters)
ai:
  provider: "copilot"                  # anthropic | openai | azure | copilot | (empty = automatic)
  self_healing: true                   # ask the AI for a new selector when one breaks
retries: 1                             # re-run failed tests (0–3)
ai:
  auto_apply_healing: false            # write AI-repaired selectors back into the test cases
  triage: false                        # explain failed runs with AI (rules-based triage always runs)
quarantine:
  auto: false                          # quarantine flaky tests automatically
  flips: 3                             # pass↔fail changes in the last `window` runs of a test
  window: 10
  passed_on_retry: 3                   # or passing only on retry this many times
  release_after: 5                     # release after this many consecutive first-attempt passes
checks:
  accessibility: report                # off | report | fail — axe-core scan of the page each test ends on
  accessibility_options: { level: wcag21aa, minImpact: serious }
evidence:
  trace: on_failure                    # off | on_failure | always — Playwright trace, secrets masked
  video: on_failure                    # off | on_failure | always
salesforce:                            # only for Salesforce agents — see docs/salesforce-guide.md
  login_url: "https://acme--uat.sandbox.my.salesforce.com"
  connected_app: { client_id: "${SF_CLIENT_ID}", private_key: "${SF_PRIVATE_KEY}" }
  personas:
    - { name: admin, auth_method: jwt, username: "qa.admin@acme.com.uat", expected_profile: "System Administrator" }
    - { name: rep, auth_method: password_totp, username: "qa.rep@acme.com.uat",
        password: "${SF_REP_PASSWORD}", totp_secret: "${SF_REP_TOTP}", expected_profile: "Standard User" }
    - { name: viewer, auth_method: password, username: "qa.viewer@acme.com.uat", password: "${SF_VIEWER_PASSWORD}" }
```

The UI form, the API (`POST /api/v1/agents` with `{ name, config }`) and the CLI all accept this shape. `${VAR}` placeholders in YAML files are replaced with environment variables by the CLI.

The agent page shows **Tests in the next run**: exactly what the planner will execute (`GET /api/v1/agents/:id/plan`). Tests run in priority order: Critical, High, Medium, Low, then module, then title.

## Getting test cases

| Source | How | Notes |
|---|---|---|
| Manual | Test Cases → New Test Case, or `POST /testcases` | Step editor with action suggestions |
| Document | Documents → upload → Extract Tests | AI turns prose, tables or spreadsheets into executable steps |
| AI generation | Agent → 🤖 Generate Tests | AI opens `base_url`, lists the real interactive elements and selectors, writes tests tagged `agent:<id>` and `ai-generated` |
| Chat | Dashboard → 💬 AI Assistant | Ask for tests, then "Save to Test Cases" |

## Test case structure

```json
{
  "title": "User login",
  "module": "Authentication",
  "priority": "High",
  "type": "Functional",
  "tags": ["login"],
  "steps": [
    { "action": "navigate", "target": "/login" },
    { "action": "fill", "target": "#username", "data": { "value": "demo" } },
    { "action": "fill", "target": "Password", "data": { "value": "demo123" } },
    { "action": "click", "target": "Sign in button" },
    { "action": "assert_text", "target": "#welcome", "data": { "value": "Welcome" } }
  ],
  "expectedResults": ["User reaches the dashboard"]
}
```

## Step actions

| Action | Target | Value (`data.value`) |
|---|---|---|
| `navigate` | URL, or a path relative to `base_url` | |
| `click`, `hover` | selector | |
| `fill` | selector | text |
| `select` | `<select>` selector | option label or value |
| `check`, `uncheck` | checkbox selector | |
| `press` | optional selector | key (`Enter`, `Tab`, …) |
| `wait` | selector to become visible | or `data.ms` milliseconds |
| `assert_visible` | selector | |
| `assert_text` | optional element (page body if empty) | expected text |
| `assert_url` | | substring of the URL |
| `assert_title` | | substring of the title |
| `screenshot` | | |
| `assert_not_visible` | selector | |
| `salesforce_login` | persona name (default: the test's persona) | `data.persona`, `data.landing` |
| `salesforce_logout` | | |
| `wait_for_lightning` | | waits for Salesforce Lightning spinners |
| `assert_profile` | expected profile | `data.permission_sets` |
| `assert_object_access` | `Account` | `{"read": true, "create": false, "edit": true, "delete": false}` |
| `assert_field_access` | `Account.AnnualRevenue` | `{"read": true, "edit": false}` |
| `assert_record_access` | record Id | `{"read": true, "edit": false}` |
| `assert_access_denied` | optional page to open | optional custom message |
| `assert_accessible` | optional element to scan | `{"level": "wcag21aa", "min_impact": "serious", "ignore": ["color-contrast"], "exclude": [".chat-widget"], "report_only": false}` |
| `assert_screenshot` | optional element (whole viewport if empty) | `{"name": "cart", "max_diff_ratio": 0.001, "threshold": 0.1, "mask": [".clock"], "full_page": false, "on_missing": "create"}` |
| `assert_ai` | optional element to judge | the expectation in plain language; `{"value": "…", "min_confidence": 0.7, "on_unsure": "fail"}` — or write the action as "Verify with AI that …" |
| `http_request` | path (relative to `api_base_url`, else `base_url`) or URL; also `"GET orders"` as the action | `{"method": "POST", "json": {...}, "query": {...}, "headers": {...}, "extract": {"orderId": "$.id"}, "status": 201}` |
| `assert_status` | | `201`, `"2xx"` or `[200, 204]` (or in the sentence: "Verify the status code is 201") |
| `assert_json` | JSON path | `{"path": "$.items[0].name", "equals": "Lamp"}` — or `contains`, `matches`, `type`, `length`, `exists: false` |
| `assert_header` | header name | text it contains |
| `assert_response_time` | | maximum ms (or "… under 500 ms") |
| `mock_route` / `block_route` | URL pattern, e.g. `**/api/payments/**` | `{"status": 200, "json": {...}, "delay": 2000, "times": 1, "method": "POST"}` |

Persona matrix: `data.personas` on the test case (list or `"all"`) runs it once per persona; `data.by_persona` on a step gives per-persona values and `data.only_personas` / `data.skip_personas` limit a step. Details in [salesforce-guide.md](salesforce-guide.md).

**Natural language works too.** "Navigate to the login page", "Enter username", "Click the Sign in button", "Verify the URL contains /dashboard" and "Check that the welcome message is displayed" map to the actions above. Steps with no recognisable action are marked **skipped** (not failed). A test with only skipped steps is reported as skipped.

**Targets** can be:

- CSS: `#id`, `.class`, `input[name="email"]`, `[data-testid="save"]`
- Playwright selectors: `text=Sign in`, `role=button[name="Save"]`, `xpath=//button`
- Plain labels: `Sign in button`, `Email`, `Search`. These resolve in priority order: form label, placeholder, button, link, then visible text.

## Running

- UI: agent page → **▶ Start Run**, then follow it in the live view.
- API: `POST /api/v1/runs { "agentId": "...", "testIds": ["optional subset"] }`.
- CLI / CI:

  ```bash
  cd backend
  npm run cli -- run -c ../configs/my-agent.yml -o ./reports -f html,junit
  ```

  It exits with code 1 when any test fails, so it works as a CI gate. Publish `reports/report-<run>.xml` as JUnit.

## Self-healing

When a step fails on a selector (timeout, element not found), self-healing is enabled for the agent, and an AI provider is configured, the executor:

1. captures an outline of the current page (interactive elements with suggested selectors),
2. asks the AI for a replacement selector (`healing` task),
3. retries the step once with it.

A healed step passes with the note `(self-healed from "<old selector>")`. The run details show `old → new` in the target column. Update the test case with the new selector to make the fix permanent.

## Best practices

- Prefer stable selectors: `id`, `name`, `data-testid`, or form labels.
- End every test with at least one `assert_*` step. A test without assertions only proves the page did not crash.
- Keep tests independent: each one gets a fresh browser context, with no cookies or storage carried over.
- Use modules and tags to build focused agents (smoke vs regression).


## Quality checks

**Accessibility.** `assert_accessible` runs [axe-core](https://github.com/dequelabs/axe-core) on the page.
- **What fails the step:** violations at or above `min_impact` (default `serious`).
- **What's only reported:** lower-impact violations.
- **Agent-wide scan:** `checks.accessibility` scans the page every test ends on, reporting violations (`report`) or
  failing the test (`fail`).
- **Where results show:** the run page and the HTML report list each rule, impact, explanation link and the elements
  concerned.

**Visual regression.** `assert_screenshot` compares a screenshot of the page or of an element with its approved baseline.
- **How baselines are kept:** per agent, `name`, persona and viewport.
- **First run:** records the baseline (`on_missing: "fail"` to require one).
- **When it fails:** more than `max_diff_ratio` of the pixels differ (default 0.1 %). Anti-aliasing is ignored and
  `threshold` sets the per-pixel colour tolerance.
- **Hiding dynamic content:** mask clocks, ads and similar with `mask`.
- **Reviewing a failure:** the run page shows baseline / this run / difference. A project editor can
  **Approve as new baseline**. Baselines are listed (and can be deleted) on the agent page.

**Evidence.** For failed tests (or always, see `evidence`), the run keeps a Playwright trace and a video.
- **What a trace contains:** every action, DOM snapshot, network request and console message.
- **Opening it:** at [trace.playwright.dev](https://trace.playwright.dev) (in your browser), or with `npx playwright show-trace`.
- **Secrets:** before a trace is stored, every secret of the run is replaced with `••••` everywhere in the file. That covers
  agent secrets, persona passwords and TOTP secrets, OAuth tokens, session ids and cookie values.

**Kept self-healing.** With `ai.self_healing`, a broken selector is repaired by the AI from the live page.
- **Within a run:** the repair is reused for the rest of the run without another AI call.
- **After the run:** it is recorded in the result. The run page's **Save to the test case** writes it into the test case,
  or `ai.auto_apply_healing: true` does that automatically after a passing test.
- **Safety check:** a step is only changed while it still has the broken selector.

**Failure triage.** When a run fails, its failures are grouped by what went wrong (the failed step and the
error, without run-specific details such as ids, numbers and URLs).
- **Categories:** each group is classified by rules as
  - **app bug:** an expectation about the application failed (text, URL, access, visual, accessibility);
  - **test bug:** a selector no longer finds its element, or the test is misconfigured;
  - **environment:** the application, network or login was not available.
- **New or known:** groups are marked *new*, or *seen in N earlier runs* of the same agent in the last 30 days.
- **AI explanation:** with an AI provider, **Explain with AI** on the run page, `ai.triage: true`, or
  `POST /runs/:id/triage {"ai": true}` adds a likely cause and a next step to each group. It costs one AI call per run.
- **Where it shows:** the triage summary is included in Slack / Teams / email notifications and in the MCP server's
  `run_tests` / `get_failures` answers.

**Flaky-test quarantine.** A quarantined test still runs and reports its result, but its failure does not fail the run.
- **Effect:** the run stays *completed*, CI wait mode reports `passed`, no failure notification is sent, and JUnit
  reports it as *skipped*. The run page and reports mark it 🧪 and count it apart.
- **By hand:** quarantine a test from the test case list or the analytics flaky table (with a reason), and release it the same way.
- **Automatically:** with `quarantine.auto`, a test is quarantined after the run where it reaches `flips` pass↔fail changes
  (or `passed_on_retry` passes on retry) within its last `window` runs. A test that always fails is a real failure and is
  never quarantined automatically.
- **Release:** an automatically quarantined test is released after `release_after` consecutive first-attempt passes;
  hand-quarantined tests stay until released by hand.

**API testing.** API steps run in the test's browser context, so requests share its cookies: an API call made after a UI
login is authenticated as that user.
- **Variables:** `extract` saves values from a JSON response, used later as `{{vars.name}}` (per test).
- **Mocking in UI tests:** `mock_route` answers matching browser requests with a fixed response (or a delay), and
  `block_route` makes them fail as if the network were down. Use them to test error handling, or to stub third-party
  services in UI tests.
- **Tests from OpenAPI.** The **API tests** card on the agent page (or `POST /agents/:id/generate-api-tests`) reads an
  OpenAPI 3 / Swagger 2 description, from a URL or pasted.
  - Without AI, every operation that can be called with the description's examples, defaults or enums gets a smoke
    test: request, then expected success status, then required response fields.
  - Operations needing values the description does not give are listed as skipped.
  - With AI, it also writes negative and edge cases.
  - Paths are prefixed with a relative server URL (`/api/v1`) or Swagger `basePath`. For an absolute server URL, set the
    agent's **API base URL** to it.

**AI-judged assertions.** `assert_ai` checks an expectation written in plain language against the live page. For example,
"the chatbot's answer explains how to reset a password and links to the help page" can verify Salesforce Agentforce or
Einstein answers.
- **What the AI sees:** the page's (or the element's) visible text, its headings and controls, the URL and the title. It does
  not see pixels; use `assert_screenshot` for how a page looks. Known secrets are masked before anything is sent.
- **How it decides:** the step passes only on a *pass* verdict at or above `min_confidence` (default 0.7). *Unsure* fails
  unless `on_unsure: "pass"`.
- **Caching:** identical page content with the same expectation is judged once per run.
- **Where verdicts show:** with their reasons, on the run page; failed AI checks are triaged as app bugs.
- **Cost and variability:** each check is one AI call (through the `analysis` route). Verdicts can vary more than classic
  assertions, so keep exact assertions for what must never change.
