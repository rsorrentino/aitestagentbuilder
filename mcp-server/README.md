# MCP server for AI Test Agent Builder

Lets AI assistants and coding agents (Claude Code, GitHub Copilot, Cursor, VS Code…) write test cases,
run them in a real browser, wait for the verdict and read the evidence of failures.

```bash
npm ci
ATAB_API_URL=http://localhost:3000/api/v1 ATAB_API_KEY=ak_... npx tsx src/index.ts
```

Setup, client configuration and the list of tools: [docs/mcp-server.md](../docs/mcp-server.md).
