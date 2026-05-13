# MCP Server Documentation

## Overview

The MCP (Model Context Protocol) server exposes AI Test Agent Builder functionality to Cursor, allowing you to interact with the testing platform directly from your IDE.

## Installation

1. Install dependencies:
```bash
cd mcp-server
npm install
npm run build
```

2. Configure API URL (if different from default):
```bash
export API_URL=http://localhost:3000/api/v1
```

## Cursor Configuration

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ai-test-agent": {
      "command": "node",
      "args": ["/absolute/path/to/aitestagentbuilder/mcp-server/dist/index.js"],
      "env": {
        "API_URL": "http://localhost:3000/api/v1"
      }
    }
  }
}
```

Restart Cursor after configuration.

## Available Tools

### 1. ingest_test_book

Upload and parse a test book document.

**Parameters:**
- `filePath` (required): Path to the document file
- `sourceType` (required): Type of document (`pdf`, `word`, `excel`, `markdown`, `html`, `text`)
- `extractTestCases` (optional): Whether to extract test cases immediately (default: `true`)
- `module` (optional): Filter by module during extraction
- `priority` (optional): Filter by priority (`Low`, `Medium`, `High`, `Critical`)

**Example:**
```
Ingest the test book at /path/to/test-book.pdf and extract test cases for the Authentication module
```

### 2. plan_tests

Plan which test cases to run.

**Parameters:**
- `agentId` (optional): Use agent configuration for planning
- `module` (optional): Filter by module
- `priority` (optional): Filter by priority
- `tags` (optional): Filter by tags (array)
- `testIds` (optional): Specific test case IDs (array)

**Example:**
```
Plan tests for module Authentication with High priority
```

### 3. run_api_check

Execute an API test check.

**Parameters:**
- `method` (required): HTTP method (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`)
- `url` (required): Full URL or endpoint path
- `baseUrl` (optional): Base URL if url is relative
- `headers` (optional): HTTP headers object
- `body` (optional): Request body (for POST/PUT)
- `expectedStatus` (optional): Expected HTTP status code
- `expectedBody` (optional): Expected response body structure

**Example:**
```
Run an API check: GET /api/users with expected status 200
```

### 4. run_ui_step

Execute a UI test step (requires agent configuration).

**Parameters:**
- `action` (required): Action to perform (`navigate`, `click`, `fill`, `select`, `get_text`, `wait`, `screenshot`)
- `target` (required): Selector or URL
- `data` (optional): Additional data
- `baseUrl` (optional): Base URL for navigation
- `headless` (optional): Run in headless mode (default: `true`)

**Example:**
```
Run UI step: click on #login-button
```

### 5. start_test_run

Start a test run with an agent.

**Parameters:**
- `agentId` (required): Agent ID to use
- `environment` (optional): Environment name
- `metadata` (optional): Additional metadata object

**Example:**
```
Start a test run with agent AGENT-123 in staging environment
```

### 6. get_run_status

Get the status of a test run.

**Parameters:**
- `runId` (required): Test run ID

**Example:**
```
Get status of run RUN-456
```

### 7. generate_report

Generate test reports for a completed run.

**Parameters:**
- `runId` (required): Test run ID
- `formats` (optional): Report formats array (`json`, `html`, `junit`) - default: `['json', 'html']`

**Example:**
```
Generate HTML and JSON reports for run RUN-456
```

## Usage Examples

### Complete Workflow

1. **Ingest test book:**
   ```
   Ingest the test book at ./test-books/login-tests.pdf
   ```

2. **Plan tests:**
   ```
   Plan tests for module Authentication with High priority
   ```

3. **Start test run:**
   ```
   Start a test run with agent AGENT-123
   ```

4. **Check status:**
   ```
   Get status of run RUN-456
   ```

5. **Generate report:**
   ```
   Generate HTML report for run RUN-456
   ```

## Troubleshooting

### Server not starting
- Check that the backend API is running on the configured URL
- Verify Node.js version (18+)
- Check logs in Cursor's MCP server output

### Tools not appearing
- Restart Cursor after configuration changes
- Verify the path in `mcp.json` is absolute
- Check that the server built successfully (`npm run build`)

### API connection errors
- Ensure backend is running: `cd backend && npm run dev`
- Verify `API_URL` environment variable
- Check network connectivity

## Architecture

The MCP server acts as a bridge between Cursor and the AI Test Agent Builder backend:

```
Cursor → MCP Server → Backend API → Services → Database/Executor
```

The server:
- Validates tool inputs using Zod schemas
- Calls backend REST API endpoints
- Formats responses for Cursor
- Handles errors gracefully

## Development

To extend the MCP server:

1. Add tool definition in `setupHandlers()`
2. Implement handler method
3. Update tool schema
4. Rebuild: `npm run build`
5. Restart Cursor

