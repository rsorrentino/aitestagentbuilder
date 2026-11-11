# Running on Windows Server (no Docker)

AI Test Agent Builder runs natively on Windows Server 2019, 2022 and 2025 (and Windows 10/11).
Everything is done with **npm from the repository root**: the same commands as on Linux, from
PowerShell or cmd. No Docker, WSL or IIS is needed.

Every pull request runs this whole procedure on GitHub's Windows Server runner:
- backend unit and integration tests with a real browser
- `npm run setup -- --production`, then `npm start` with a sign-in and a browser test run
- `npm run service:install`, including recovery after a crash
- `npm run service:uninstall`

## 1. Prerequisites

| | Version | Notes |
|---|---|---|
| **Node.js** | 22 LTS (20.19+ works) | Windows Installer (.msi) from nodejs.org, with npm and "Add to PATH" |
| **PostgreSQL** | 14–17 | EDB installer from postgresql.org; remember the `postgres` password. pgvector is optional |
| **Git** | any | or download the repository as a ZIP |
| Windows | Server 2019+ with *Desktop Experience* | Chromium needs the desktop graphics stack; Server Core is not supported by Playwright |
| NSSM | optional, recommended | to run as a real Windows service ([nssm.cc](https://nssm.cc), put `nssm.exe` on PATH) |

Create the database once (SQL Shell / psql):

```sql
CREATE DATABASE aitestagentbuilder;
```

Outbound access during setup: npm (`registry.npmjs.org`) and the Playwright CDN (`cdn.playwright.dev`, to download
Chromium). At run time: the applications you test, and your AI provider if you use one. Behind a proxy, set
`HTTPS_PROXY` first.

## 2. Install

In PowerShell, from the repository folder (e.g. `C:\atab`):

```powershell
npm run setup -- --production --host atab.contoso.local --db "postgresql://postgres:YOUR_PASSWORD@localhost:5432/aitestagentbuilder" --admin-email qa-admin@contoso.com
```

This:

1. checks Node.js;
2. creates `.env` at the repository root (only if it does not exist yet) with `NODE_ENV=production`,
   login on, a generated `JWT_SECRET` and `SECRETS_ENCRYPTION_KEY`, and the administrator account.
   **The administrator password is printed once.** Access to `.env` is limited to Administrators,
   SYSTEM and the installing user;
3. installs dependencies and downloads Chromium into `.playwright-browsers` inside the installation
   (so a service account finds it, unlike the default per-user folder);
4. builds the API and the web UI: the UI is built for `http://atab.contoso.local:4000`, calling the
   API at `http://atab.contoso.local:3000`;
5. creates the database tables.

Options: `--api-port`, `--ui-port`, `--public-url` / `--public-ui-url` (behind a reverse proxy),
`--no-auth` (no login, single-user test box), `--skip-build`.

To update after `git pull`: stop the service, run the same `npm run setup -- --production …` (your `.env` is
kept), and start the service again.

Back up `.env` (at least `SECRETS_ENCRYPTION_KEY`) together with the database. Without the key, stored
credentials (agent secrets, Salesforce personas) cannot be decrypted.

## 3. Start

**Interactively**:

```powershell
npm start          # API + web UI, logs in the console; Ctrl+C stops both
npm run status     # from another window: are both answering?
```

**At boot**, from an **elevated** PowerShell:

```powershell
npm run service:install
```

- With NSSM on `PATH` (or `-- --nssm C:\tools\nssm.exe`) you get a Windows service named **ATAB**
  ("AI Test Agent Builder" in services.msc). It runs `npm start`'s supervisor. If the API or the UI
  stops, the supervisor exits with an error and NSSM restarts everything after 5 seconds. Logs go
  to `logs\atab.log`, rotated at 10 MB. **Recommended.**
- Without NSSM (or with `-- --no-nssm`), a Scheduled Task **ATAB** starts it at boot as `SYSTEM`.
- To run as a dedicated account, add `-- --user CONTOSO\svc-atab --password …`. The account is
  granted read access to `.env` and write access to logs, screenshots and the browser folder.
- To uninstall: `npm run service:uninstall`. This also removes the `ATAB-Backend` / `ATAB-Frontend`
  entries created by earlier versions.

Open the firewall for the UI and the API:

```powershell
New-NetFirewallRule -DisplayName "AI Test Agent Builder" -Direction Inbound -Protocol TCP -LocalPort 3000,4000 -Action Allow
```

Then browse to `http://atab.contoso.local:4000` and sign in with the administrator account.

### HTTPS

Put a reverse proxy with your certificate in front of ports 4000 and 3000, e.g. IIS with
*URL Rewrite* + *Application Request Routing* (enable WebSockets for `/socket.io`). Set the public
URLs in `.env`, then rebuild with `npm run build` and restart the service:

```env
NEXT_PUBLIC_API_URL=https://atab.contoso.com/api/v1
NEXT_PUBLIC_WS_URL=https://atab.contoso.com
CORS_ORIGIN=https://atab.contoso.com
```

## 4. AI providers on Windows

- **Anthropic / OpenAI / Azure OpenAI / Copilot API or SDK**: set the key in `.env` and restart.
- **GitHub Copilot CLI** (`COPILOT_MODE=cli`):
  - Install it with `npm install -g @github/copilot` and sign in as the account the service runs as.
  - Windows installs the CLI as `copilot.cmd`. The backend starts its JavaScript entry point with
    Node directly, never through `cmd.exe`, so prompts are never interpreted by a shell.
  - Windows limits command lines to about 32 KB, so very large documents need `COPILOT_MODE=api` or `sdk`.
  - When the service runs as `SYSTEM`, set `COPILOT_CLI_PATH` to the full path of `copilot.cmd`
    (e.g. `C:\Program Files\nodejs\copilot.cmd`).

## 5. CI from Windows build agents

Azure DevOps / Jenkins agents on Windows can trigger runs and wait for the result:

```powershell
$run = Invoke-RestMethod -Method Post -Uri "http://atab.contoso.local:3000/api/v1/runs" `
  -Headers @{ Authorization = "ApiKey $env:ATAB_API_KEY" } -ContentType 'application/json' -TimeoutSec 3600 `
  -Body (@{ agentId = $env:ATAB_AGENT_ID; wait = $true; timeoutSeconds = 3000 } | ConvertTo-Json)
if (-not $run.passed) { throw "Tests failed: $($run.failedTests) of $($run.totalTests)" }
```

Or, with the repository on the agent: `npm run cli -- run -c ..\configs\my-agent.yml -o .\reports`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `node` / `npm` not recognised | Reopen PowerShell after installing Node.js, or add `C:\Program Files\nodejs` to PATH |
| `npm.ps1 cannot be loaded … running scripts is disabled` | Use `npm.cmd run …`, or allow local scripts: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `Cannot connect to PostgreSQL` / migration failed | Check the PostgreSQL service is running and `DATABASE_URL` (user, password, port 5432) |
| `Executable doesn't exist at …\ms-playwright\…` | The service does not see the browsers: `PLAYWRIGHT_BROWSERS_PATH` in `.env` must point to `.playwright-browsers`; run `npm run setup -- --production` again |
| Browser fails to start on Server Core | Use Windows Server with Desktop Experience |
| UI shows "Cannot reach the backend" | The UI was built for another host: fix `NEXT_PUBLIC_API_URL` in `.env`, `npm run build`, restart |
| Port already in use | `Get-NetTCPConnection -LocalPort 3000`; change `PORT` / `UI_PORT` in `.env` (and the public URLs), then rebuild |
| `service:install` fails with "elevated" | Open PowerShell with *Run as administrator* |
| Logs | `logs\atab.log` (service), the console (`npm start`); the API also writes `backend\logs\` |
