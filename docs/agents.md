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
salesforce:                            # only for Salesforce agents (salesforce_login step)
  username: "${SF_USERNAME}"
  password: "${SF_PASSWORD}"
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
| `salesforce_login` | optional login URL | uses `config.salesforce` |
| `wait_for_lightning` | | waits for Salesforce Lightning spinners |

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
