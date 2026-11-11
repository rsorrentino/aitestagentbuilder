# MCP server

The MCP server lets AI assistants and coding agents use AI Test Agent Builder:
- **Who can use it:** Claude Code, GitHub Copilot (agent mode), Cursor, VS Code, or any client that speaks the
  [Model Context Protocol](https://modelcontextprotocol.io).
- **What they can do:** write test cases, run them in a real browser, wait for the verdict, and read the evidence
  of failures.
- **Typical use:** a coding agent checks its own change before calling it done.

## Setup

```bash
npm --prefix mcp-server ci
```

Create an API key in the UI (**Account → API keys**). Pick the project and the **editor** role: the agent can
create tests and run them, but not change secrets or members.

Configure your client to start the server with that key. Claude Code example (`.mcp.json` in your project):

```json
{
  "mcpServers": {
    "ai-test-agent-builder": {
      "command": "npx",
      "args": ["tsx", "/path/to/aitestagentbuilder/mcp-server/src/index.ts"],
      "env": {
        "ATAB_API_URL": "http://atab.contoso.local:3000/api/v1",
        "ATAB_API_KEY": "ak_..."
      }
    }
  }
}
```

The same `command` / `args` / `env` block works for Cursor (`.cursor/mcp.json`) and VS Code (`.vscode/mcp.json`, under `servers`).
After `npm --prefix mcp-server run build` you can use `node /path/to/mcp-server/dist/index.js` instead of `npx tsx …`.

| Variable | |
|---|---|
| `ATAB_API_URL` | API address (default `http://localhost:3000/api/v1`; `API_URL` also works) |
| `ATAB_API_KEY` | project API key, sent as `Authorization: ApiKey …`. Required when login is on |
| `ATAB_TOKEN` | alternatively a JWT from `POST /auth/login` |
| `ATAB_PROJECT` | project id, when the credential is not tied to one |

Without credentials against a server with login on, every tool answers with an error that says to set `ATAB_API_KEY`.

## Tools

| Tool | What it does |
|---|---|
| `list_agents` | Agents (applications under test) of the project, with their base URL |
| `plan_tests` | Test cases the next run of an agent would execute, or a search by module / priority / tags |
| `create_test_case` | Create a test case from steps, e.g. `navigate`, `fill`, `click`, `assert_text`, `assert_accessible`, `assert_screenshot`. Optional Salesforce `personas` |
| `run_tests` | Run an agent's tests (or chosen `testIds`) in a real browser; by default **waits** and returns pass/fail with the failures |
| `start_test_run` | Start a run without waiting |
| `get_run_status` | Status, counts and failed test titles of a run |
| `get_failures` | For each failed test: the failed step and error, screenshots, trace and video links, accessibility violations, visual differences, and selectors repaired by the AI |
| `apply_healing` | Write the selectors the AI repaired during a run back into the test case |
| `ingest_test_book` | Upload a test specification and let the AI extract test cases |
| `run_api_check` | Send one HTTP request from this machine and compare the status and body |
| `generate_report` | HTML / JUnit / JSON reports of a run |

Evidence links are signed and expire (24 h by default), so the agent or a browser can open them without logging in.

Approving a changed screenshot as the new visual baseline is deliberately not a tool: a person approves it on the run page.

### Example: an agent checking its own change

> Add a test that signs in to the demo shop as `demo` / `demo123` and expects "Welcome, demo!", run it with the other tests of
> the Demo Shop agent, and tell me what failed.

The agent calls `list_agents`, `create_test_case`, then `run_tests` with the agent id. The answer looks like this:

```json
{
  "runId": "RUN-…",
  "status": "failed",
  "passed": false,
  "totals": { "tests": 4, "passed": 3, "failed": 1, "skipped": 0 },
  "failures": [{
    "title": "Login shows a wrong greeting",
    "failedStep": { "stepId": 5, "action": "assert_text", "target": "#welcome", "message": "Expected #welcome to contain …" },
    "evidence": { "screenshots": ["http://…/artifacts/RUN-…/…-failure.png?exp=…&sig=…"], "trace": "http://…-trace.zip?…", "video": "http://…-video.webm?…" },
    "accessibility": [], "visual": []
  }]
}
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `HTTP 401 … set ATAB_API_KEY` | Create an API key and put it in the client's `env` |
| `HTTP 403` | The key's role is too low (use editor) or belongs to another project |
| The client shows no tools | Check the `command` path; run it in a terminal: it should print `MCP server running on stdio` on stderr |
| Runs time out | `run_tests` waits up to `timeoutSeconds` (default 600); long suites can use `start_test_run` + `get_failures` |
