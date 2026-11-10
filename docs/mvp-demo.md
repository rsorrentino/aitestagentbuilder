# 🚀 MVP demo: from zero to a passing automated test run in 10 minutes

This walkthrough uses the built-in demo shop, so it needs no external site and no AI key for the first part.

## 1. Install and start (3 min)

```bash
git clone https://github.com/rsorrentino/aitestagentbuilder.git
cd aitestagentbuilder
./scripts/setup.sh
```

```bash
cd backend && npm run dev
```

```bash
cd frontend && npm run dev
```

Open http://localhost:4000.

## 2. Run the demo tests (1 min)

1. Dashboard → **🎮 Try the demo**. You land on the *Demo Shop* agent. "Tests in the next run (3)" lists:
   - Valid login opens the dashboard
   - Wrong password shows an error
   - Add an item to the shopping list
2. Click **▶ Start Run**. The live view streams the browser viewport and every step.
3. When it finishes, open **Details**: click a test to see each step (action, target, result, timing) and its screenshot.
4. Open **📊 HTML report**, or download **JUnit** for your CI.

## 3. Break something and watch it fail (1 min)

Go to **Test Cases**, edit *Valid login opens the dashboard*, and change the last step's value to `Welcome, nobody!`. Run again: the run is marked **failed**, the failing step says what it expected and what it found, and a failure screenshot is attached.

## 4. Turn on AI (2 min)

Add one provider to `.env` and restart the backend, for example:

```env
ANTHROPIC_API_KEY=sk-ant-...
```

or GitHub Copilot ([details](copilot.md)):

```env
COPILOT_MODE=api
COPILOT_GITHUB_TOKEN=<output of `gh auth token`>
```

**AI Providers → ⚡ Test connections** should show the provider as healthy.

## 5. Generate tests from the live page (1 min)

On the *Demo Shop* agent: **🤖 Generate Tests** → "Test adding several items to the shopping list after logging in as demo/demo123" → **Generate & save**. The AI opens the page, reads its real selectors and saves the new tests. Run the agent again.

## 6. Extract tests from a document (1 min)

Save this as `login-spec.md`:

```markdown
# Login
1. Open /login
2. Sign in with username demo and password demo123
3. The dashboard shows "Welcome, demo!"
4. Signing in with a wrong password shows "Invalid username or password"
```

**Documents** → upload it → **🔍 Extract Tests**. The test cases appear under **Test Cases** with source "Extracted".

## 7. Self-healing (optional)

Edit a demo test and change a selector, e.g. `#login-btn` → `#signin-button`. With an AI provider configured and self-healing on (the default for the demo agent), the run log shows `🩹 Healed: "#signin-button" → "#login-btn"` and the step passes.

## 8. Run from the command line / CI

```bash
cd backend
npm run cli -- run -c ../configs/demo-agent.yml
```

It prints each result, writes reports to `./reports` and exits with code 1 on failure. The backend must be running, because it serves the demo app.

## Troubleshooting

See [RUNNING.md → Troubleshooting](../RUNNING.md#troubleshooting).
