# GitHub Copilot integration

GitHub Copilot is a first-class AI provider. It can power document extraction, test generation, the chat assistant, and selector self-healing, through **three transports**. Select one with `COPILOT_MODE`.

| Mode | Implementation | When to use |
|---|---|---|
| `api` (default) | OpenAI-compatible Copilot chat completions API | Servers and CI with a GitHub token |
| `sdk` | Official [`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk), which drives the Copilot runtime over JSON-RPC | Machines where you use Copilot already; richest auth options |
| `cli` | [GitHub Copilot CLI](https://www.npmjs.com/package/@github/copilot), run as `copilot -p "<prompt>" -s` | You already have the CLI installed and logged in |

In every mode Copilot is used as a **text model only**: no tools are enabled (`availableTools: []` for the SDK, an empty `--available-tools` list for the CLI, and a permission handler that rejects everything). It runs in an empty temporary directory, so it cannot read your project or run commands on the server.

You need a GitHub account with an active Copilot subscription (Free, Pro, Business or Enterprise).

## Authentication

The token is read in the same order the Copilot CLI uses:

1. `COPILOT_GITHUB_TOKEN`
2. `GH_TOKEN`
3. `GITHUB_TOKEN`

Accepted tokens:

- an OAuth token from the GitHub CLI: `gh auth token` (after `gh auth login`),
- a fine-grained personal access token with the **Copilot Requests** permission.

The `sdk` and `cli` modes can also authenticate without a token, using an existing `copilot` login (run `copilot`, then `/login`) or `gh auth login`.

## Mode `api`

```env
COPILOT_MODE=api
COPILOT_GITHUB_TOKEN=gho_...
# COPILOT_MODEL=gpt-4o
```

How it works:

1. The GitHub token is exchanged for a short-lived Copilot session token (`GET https://api.github.com/copilot_internal/v2/token`). The session token is cached until shortly before it expires.
2. Chat requests go to the Copilot endpoint returned by the exchange (normally `https://api.githubcopilot.com/chat/completions`).
3. If the exchange is not available for the token (for example, a fine-grained PAT), the token is sent directly as a bearer token.

**GitHub Models instead of the Copilot API.** Point the transport at any OpenAI-compatible endpoint, and the token is used as-is:

```env
COPILOT_MODE=api
COPILOT_BASE_URL=https://models.github.ai/inference
COPILOT_GITHUB_TOKEN=github_pat_...    # PAT with the models:read permission
COPILOT_MODEL=openai/gpt-4o
```

## Mode `sdk`

```env
COPILOT_MODE=sdk
# optional — otherwise the copilot / gh login is used
COPILOT_GITHUB_TOKEN=gho_...
# optional — default is the runtime's default model
COPILOT_MODEL=gpt-4.1
```

`@github/copilot-sdk` is an optional dependency of the backend and is installed by `npm install`. It ships the Copilot runtime, so no separate CLI install is needed. It requires Node.js `^20.19.0 || >=22.12.0`.

One SDK client is started lazily and reused. Each request creates a session with a replaced system message and no tools, sends the prompt with `sendAndWait`, and disconnects the session. The client is stopped on shutdown.

## Mode `cli`

```bash
npm install -g @github/copilot
copilot          # then /login once, or set a token
```

```env
COPILOT_MODE=cli
# COPILOT_CLI_PATH=/usr/local/bin/copilot   # if it is not on PATH
# COPILOT_MODEL=claude-sonnet-4.5
```

Each request runs:

```bash
copilot -p "<prompt>" -s --no-ask-user --no-custom-instructions --no-auto-update --no-color --available-tools [--model <model>]
```

The prompt is passed on the command line, so prompts above about 120 KB are rejected. Use `api` or `sdk` mode for very large documents (extraction sends up to `EXTRACTION_MAX_CHARS`, 60,000 characters by default).

## Routing

With Copilot configured, it takes part in the normal provider routing (`extraction`, `chat`, `healing`, `codegen`), with Claude/OpenAI/Azure as fallbacks when they are configured. To try Copilot first for everything:

```env
LLM_PROVIDER=copilot
```

An agent can also prefer Copilot through its **Preferred AI provider** setting. That applies to test generation and self-healing for that agent.

**AI Providers** in the UI shows the active transport, and **Test connections** sends a one-word request through it.

## Troubleshooting

| Error | Cause / fix |
|---|---|
| `GitHub Copilot (api) error: … 401/403` | The token has no Copilot access. Use `gh auth token` or a fine-grained PAT with Copilot Requests, and check the account's Copilot subscription. |
| `GitHub Copilot (sdk) error: … No GitHub OAuth token` | Set `COPILOT_GITHUB_TOKEN`, or log in with `copilot` → `/login` / `gh auth login` as the user running the backend. |
| `@github/copilot-sdk is not installed` | `cd backend && npm install` (optional dependencies must not be disabled). |
| `Copilot CLI not found` | `npm install -g @github/copilot`, or set `COPILOT_CLI_PATH`. |
| `prompt is too large for the Copilot CLI command line` | Use `COPILOT_MODE=api` or `sdk`. |
| Copilot shows "Not configured" in `api` mode | No token found in `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`. |

## Tests

`backend/src/tests/integration/api.test.ts` covers the transports without real credentials:

- **CLI**: a fake `copilot` executable checks the non-interactive flags and returns test cases; document extraction goes end to end through it.
- **API**: a local mock serves the token exchange and the chat endpoint, and the test checks both requests and the integration headers.
- **SDK**: verified manually; it starts the bundled runtime and returns a clear error when no credentials are available.
