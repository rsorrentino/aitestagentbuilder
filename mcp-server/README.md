# MCP Server for AI Test Agent Builder

Model Context Protocol server that exposes AI Test Agent Builder tools to Cursor.

## Tools Exposed

1. **ingest_test_book** - Upload and parse test book documents
2. **plan_tests** - Plan test execution based on filters or agent config
3. **run_api_check** - Execute API test checks
4. **run_ui_step** - Execute UI test steps (via agent)
5. **start_test_run** - Start a test run with an agent
6. **get_run_status** - Get status of a running/completed test
7. **generate_report** - Generate test reports

## Setup

1. Install dependencies:
```bash
cd mcp-server
npm install
```

2. Configure API URL (optional):
```bash
export API_URL=http://localhost:3000/api/v1
```

3. Run server:
```bash
npm run dev
```

## Cursor Configuration

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ai-test-agent": {
      "command": "node",
      "args": ["/path/to/aitestagentbuilder/mcp-server/dist/index.js"],
      "env": {
        "API_URL": "http://localhost:3000/api/v1"
      }
    }
  }
}
```

## Usage in Cursor

Once configured, you can use tools like:

- "Ingest the test book at `/path/to/test-book.pdf`"
- "Plan tests for module Authentication with High priority"
- "Run an API check: GET /api/users"
- "Start a test run with agent AGENT-123"
- "Get status of run RUN-456"
- "Generate HTML report for run RUN-456"

