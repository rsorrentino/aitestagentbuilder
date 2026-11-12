# Integrations

Connect the platform to the tools your team already uses: **Settings → Integrations** (project admins).

| Integration | Status |
|---|---|
| Jira Cloud, Jira Data Center / Server | Available: story import, results on stories, coverage, automatic bugs |
| GitHub (github.com, Enterprise Server) | Available: runs on pull requests, pushes and deployments (preview URLs), commit status checks, pull request comment, bugs as issues, issues as requirements, Actions workflow |
| GitLab, Azure DevOps | Planned (same framework) |

Every integration is project-scoped, its secrets are encrypted at rest (AES-256-GCM, the same as agent
secrets) and never returned by the API, and every change is in the audit log.

## GitHub

### Connect

**Settings → Integrations → Connect → GitHub.**

| Field | |
|---|---|
| Repository | `owner/name` |
| Token | A [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) (or GitHub App installation token) for the repository with **Commit statuses**, **Issues** and **Pull requests**: read & write (Metadata: read is implied). Use a bot account |
| API URL | Only for GitHub Enterprise Server: `https://github.example.com/api/v3` |
| Webhook secret | Generated for you; copy it to GitHub (below). At least 16 characters |

### Run tests on every pull request, push and deployment

Add **triggers**: an event and the agent to run.

| Event | Filter | |
|---|---|---|
| Pull request opened / updated | target branches, e.g. `main, release/*` | Opened, new commits, reopened, ready for review. Drafts are skipped |
| Push | branches | Branch pushes (not tags or deletions) |
| Deployment succeeded | environments, e.g. `preview*, staging` | With **Test the deployed address**, the run tests the deployment's URL instead of the agent's `base_url`: every preview deployment (Vercel, Netlify, your own) gets tested |

Then on GitHub, **Settings → Webhooks → Add webhook** (the integration's **Setup** shows the exact values):
Payload URL `https://<your server>/api/v1/hooks/github/<integration id>`, content type `application/json`, the
webhook secret, events *Pull requests*, *Pushes*, *Deployment statuses*. GitHub's “ping” confirms the connection.

Webhooks are verified with their HMAC-SHA256 signature (`X-Hub-Signature-256`); unsigned or wrongly signed
requests are refused, redeliveries are ignored, and an event that matches no trigger is acknowledged and ignored
(the reason is in GitHub's *Recent deliveries*).

### Results on the commit and the pull request

- **Status check** `AI tests / <agent>` on the commit: pending while the run is going, then success, failure
  (“2 of 40 failed”) or error (application unreachable, cancelled), linking to the run. Make it a required
  check in branch protection to block merging when the tests fail.
- **Pull request comment**, one per agent, edited on every run instead of adding more: passed / failed counts,
  the failed tests with their errors, quarantined failures not counted, the triage, bugs filed, the tested address.

Runs started any other way report to the commit too when they carry `metadata.git`
(`{ provider: "github", repository, sha, pr? }`) — that is what the Actions workflow below does.

### Without webhooks: GitHub Actions

When GitHub cannot reach your server (it is behind a firewall), let a workflow call the API instead.
**Setup → GitHub Actions workflow** generates `.github/workflows/ai-tests.yml` for an agent: on pull requests,
pushes to `main` and by hand, it starts the run (`wait` mode), passes the commit and pull request (so the status
and comment appear as above), downloads the JUnit report as an artifact and fails the job when tests fail.
It needs one repository secret, `ATAB_API_KEY`: an API key (Account → API keys) with the editor role.
To test a preview deployment, set `ATAB_BASE_URL` to its address (e.g. a previous step's output).

### Bugs and requirements on GitHub

Everything described for Jira below works with GitHub issues too: with **File issues for new failures**,
new failures become issues labelled `atab` (not duplicated, commented when failing again at most once a day),
**closed** as completed when the tests pass. GitHub has no attachment API, so the screenshot stays on the run page
the issue links to. Issues can be imported as tests (`#12`, or words) and linked to tests; the issue then has one
“Automated test results” comment, updated after each run.

## Jira

### Connect

| Field | |
|---|---|
| Jira URL | `https://acme.atlassian.net` (Cloud) or your Data Center URL |
| Deployment | Detected from the URL (`*.atlassian.net` = Cloud); set it for Cloud on a custom domain |
| Account email | Cloud only: the account the API token belongs to. Use a dedicated bot account |
| API token | Cloud: [create an API token](https://id.atlassian.com/manage-profile/security/api-tokens). Data Center: a personal access token |
| Project key | Where bugs are filed (e.g. `SHOP`); also limits word searches |
| Bug issue type | Default `Bug` |

“Connect” saves the integration and checks it (account and project). “Check” runs the check again at any time.

The account needs: browse the projects whose stories you import; create issues, add comments and
attachments, and transition issues in the bug project; and “link issues” (remote links) on the stories.

### Stories → tests

**Import stories as tests** takes issue keys (`SHOP-12, SHOP-15`), JQL (`sprint in openSprints() AND type = Story`)
or words. For each story the AI reads the summary, description and acceptance criteria and writes test cases.
They are tagged `jira:SHOP-12` (and `agent:<id>` when you pick an agent) and linked to the story.
Review them in **Test Cases** like any AI-written test. An AI provider must be configured.

You can also link any existing test to stories in the test case editor (**Covers (stories / issues)**).

### Results on the stories

After every run, each linked story gets one web link per test, updated, never duplicated:

> ✅ Test “Cart shows the order total”: passed (2026-11-12 02:14 UTC)

The link opens the run. To turn this off, set `config.requirements.report_results: false`.

**Requirements** (left menu) shows every linked story with its tests' latest results:
passing, failing, partly run (some tests never ran) or not run.

### Bugs filed automatically

With **File bugs automatically** on, failures of **unattended runs** (scheduled, CI, API, MCP; not runs a person
started from the UI, unless you untick “Only for scheduled / CI runs”) become Jira bugs:

- **One bug per distinct failure.** Failures are grouped by cause (the [triage](agents.md)), so twenty tests broken by the
  same error give one bug listing the twenty tests. The bug has the failed step, the error, the tests, the triage
  category and the AI's likely cause, a link to the run and the screenshot of the failure attached.
- **Only real bugs by default.** Only failures classified as *application bugs* are filed; add *environment problems*,
  *broken tests* or *unclassified* if you want those too. Quarantined (flaky) tests are never filed.
- **Never duplicated.** The same failure on later nights adds a comment “Still failing …” to the open bug, at most once a day.
- **Closed when fixed.** When the bug's tests pass again, the bug gets a “Passing again” comment and is moved with the
  *resolve transition* (e.g. `Done`; a transition name or a target status). Without one, it is only commented.
- Bugs are labelled `atab` and `atab-<id>` (the failure's fingerprint), so you can find them with JQL
  `labels = atab`. **Integrations → Bugs filed by the platform** lists them with how often each was seen.

The run page shows what happened (“Jira: filed SHOP-341”), and so does `run.metadata.integrations` in the API.
A Jira outage never fails a run: the problem is shown on the run page and logged.

Settings (`config.defects`):

| Key | Default | |
|---|---|---|
| `enabled` | `false` | File bugs |
| `categories` | `["app_bug"]` | `app_bug`, `environment`, `test_bug`, `unknown` |
| `only_unattended` | `true` | Only scheduled / CI / API / MCP runs |
| `agents` | all | Only these agent ids |
| `resolve_transition` | — | Transition name or target status used when the tests pass again |
| `labels` | `["atab"]` | Labels on every bug |

### API and MCP

REST: [api.md → Integrations](api.md#integrations). MCP tools: `import_stories`, `requirement_coverage`
([mcp-server.md](mcp-server.md)), e.g. *“import the stories of the current sprint as tests and run them”*.
