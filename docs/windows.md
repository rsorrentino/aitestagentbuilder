# Running on Windows Server (no Docker)

AI Test Agent Builder runs natively on Windows Server 2019, 2022 and 2025 (and Windows 10/11):
Node.js runs the API and the web UI, PostgreSQL stores the data, and Playwright drives its own
Chromium. No Docker, WSL or IIS is needed.

Every pull request runs the whole procedure below on GitHub's Windows Server runner: backend
unit and integration tests with a real browser, `install.ps1`, `start.ps1` with a sign-in and a
browser test run, and `install-service.ps1`.

## 1. Prerequisites

| | Version | Notes |
|---|---|---|
| **Node.js** | 22 LTS (20.19+ works) | Windows Installer (.msi) from nodejs.org; keep "Add to PATH" on |
| **PostgreSQL** | 14–17 | EDB installer from postgresql.org; remember the `postgres` password. pgvector is optional |
| **Git** | any | or download the repository as a ZIP |
| Windows | Server 2019+ with *Desktop Experience* | Chromium needs the desktop graphics stack; Server Core is not supported by Playwright |
| NSSM | optional | to run as real Windows services (otherwise Scheduled Tasks are used) |

Create the database once (SQL Shell / psql):

```sql
CREATE DATABASE aitestagentbuilder;
```

Outbound access: the server needs to reach npm (`registry.npmjs.org`), the Playwright CDN (to download Chromium during
install), the applications you test, and your AI provider if you use one. Behind a proxy, set `HTTPS_PROXY` before installing.

## 2. Install

From an **elevated** PowerShell in the repository folder (e.g. `C:\atab`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1 `
  -PublicHost atab.contoso.local `
  -DatabaseUrl "postgresql://postgres:YOUR_PASSWORD@localhost:5432/aitestagentbuilder" `
  -AdminEmail qa-admin@contoso.com
```

The script:

1. checks Node.js;
2. creates `.env` at the repository root (only if it does not exist) with `NODE_ENV=production`,
   authentication on, a generated `JWT_SECRET` and `SECRETS_ENCRYPTION_KEY`, and the administrator
   account. **The administrator password is printed once.** Access to `.env` is limited to
   Administrators, SYSTEM and the installing user;
3. installs dependencies and downloads Chromium into `.playwright-browsers` inside the installation
   (so the service account finds it, unlike the default per-user folder);
4. builds the API and the web UI (the UI is built for `http://<PublicHost>:4000`, calling the API at
   `http://<PublicHost>:3000`);
5. creates the database tables.

Options: `-ApiPort`, `-UiPort`, `-NoAuth` (no login, for a single-user test box), `-SkipBuild`
(rewrite configuration only). Re-run it after `git pull` to update; your `.env` is kept.

Back up `.env` (or at least `SECRETS_ENCRYPTION_KEY`) together with the database: without the key,
stored credentials (agent secrets, Salesforce personas) cannot be decrypted.

## 3. Start

**Try it** (background processes, logs in `logs\`):

```powershell
powershell -File scripts\windows\start.ps1
powershell -File scripts\windows\start.ps1 -Stop
```

**Run at boot** (elevated):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1
```

- With [NSSM](https://nssm.cc) on `PATH` (or `-NssmPath C:\tools\nssm.exe`) you get two Windows services,
  `ATAB-Backend` and `ATAB-Frontend`, restarted automatically if they stop, with rotating logs in `logs\`.
  **Recommended for production.**
- Without NSSM (or with `-NoNssm`), two Scheduled Tasks with the same names start at boot as `SYSTEM`.
- `-User CONTOSO\svc-atab -Password …` runs them as a dedicated account (it is granted read access to
  `.env` and write access to logs, screenshots and the browser folder).
- `-Remove` uninstalls them.

Open the firewall for the UI and API ports:

```powershell
New-NetFirewallRule -DisplayName "AI Test Agent Builder" -Direction Inbound -Protocol TCP -LocalPort 3000,4000 -Action Allow
```

Then browse to `http://atab.contoso.local:4000` and sign in with the administrator account.

### HTTPS

Put a reverse proxy with your certificate in front of ports 4000 and 3000, e.g. IIS with
*URL Rewrite* + *Application Request Routing* (enable WebSocket support for `/socket.io`). Then run
`install.ps1` again with the public URLs in `.env`:

```env
NEXT_PUBLIC_API_URL=https://atab.contoso.com/api/v1
NEXT_PUBLIC_WS_URL=https://atab.contoso.com
CORS_ORIGIN=https://atab.contoso.com
```

## 4. AI providers on Windows

- **Anthropic / OpenAI / Azure OpenAI / Copilot API or SDK**: set the key in `.env` and restart.
- **GitHub Copilot CLI** (`COPILOT_MODE=cli`): `npm install -g @github/copilot`, then sign in as the
  account the service runs as. Windows installs the CLI as `copilot.cmd`; the backend starts its
  JavaScript entry point with Node directly (no `cmd.exe`, so prompts are never interpreted by a
  shell). Windows limits command lines to ~32 KB, so very large documents need `COPILOT_MODE=api` or `sdk`.
  When the service runs as `SYSTEM`, set `COPILOT_CLI_PATH` to the full path of `copilot.cmd`
  (e.g. `C:\Program Files\nodejs\copilot.cmd`) because SYSTEM does not see per-user npm folders.

## 5. CI from Windows build agents

Azure DevOps / Jenkins agents on Windows can trigger runs and wait for the result:

```powershell
$run = Invoke-RestMethod -Method Post -Uri "http://atab.contoso.local:3000/api/v1/runs" `
  -Headers @{ Authorization = "ApiKey $env:ATAB_API_KEY" } -ContentType 'application/json' -TimeoutSec 3600 `
  -Body (@{ agentId = $env:ATAB_AGENT_ID; wait = $true; timeoutSeconds = 3000 } | ConvertTo-Json)
if (-not $run.passed) { throw "Tests failed: $($run.failedTests) of $($run.totalTests)" }
```

or use the CLI on the agent: `cd backend; npm run cli -- run -c ..\configs\my-agent.yml -o .\reports`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `node` not recognised | Reopen PowerShell after installing Node.js, or add `C:\Program Files\nodejs` to PATH |
| `running scripts is disabled on this system` | Use `powershell -ExecutionPolicy Bypass -File …` as shown |
| `Cannot connect to PostgreSQL` | Check the PostgreSQL service is running and `DATABASE_URL` (user, password, port 5432) |
| `Executable doesn't exist at …\ms-playwright\…` | The service does not see the browsers: `PLAYWRIGHT_BROWSERS_PATH` in `.env` must point to `.playwright-browsers`; re-run `install.ps1` |
| Browser fails to start on Server Core | Use a Windows Server installation with Desktop Experience |
| UI loads but shows "Cannot reach the backend" | The UI was built for a different host: fix `NEXT_PUBLIC_API_URL` in `.env` and re-run `install.ps1` |
| Port already in use | Another process uses 3000/4000: `Get-NetTCPConnection -LocalPort 3000` and change `-ApiPort`/`-UiPort` |
| Logs | `logs\ATAB-Backend.log`, `logs\ATAB-Frontend.log` (services) or `logs\*.out.log` (`start.ps1`); the API also writes `backend\logs\` |
