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
ai:
  auto_apply_healing: false            # write AI-repaired selectors back into the test cases
  triage: false                        # explain failed runs with AI (rules-based triage always runs)
  action_cache: true                   # replay AI action steps that worked before, without calling the AI
quarantine:
  auto: false                          # quarantine flaky tests automatically
  flips: 3                             # pass↔fail changes in the last `window` runs of a test
  window: 10
  passed_on_retry: 3                   # or passing only on retry this many times
  release_after: 5                     # release after this many consecutive first-attempt passes
checks:
  accessibility: report                # off | report | fail — axe-core scan of the page each test ends on
  accessibility_options: { level: wcag21aa, minImpact: serious }
  performance: report                  # off | report | fail — page speed of the page each test ends on
  performance_budgets: { lcp: 2500, cls: 0.1, tbt: 200, load: 4000, max_regression: 0.25 }
  performance_options: { throttle: slow4g, cpu_slowdown: 4 }   # throttle: none | slow4g | fast3g
unattended:                            # scheduled / CI / API runs, e.g. at night (see "Unattended runs")
  preflight: true                      # check the application answers first; retry, then fail once
  preflight_retries: 3
  preflight_wait_seconds: 300
  rerun_failed: auto                   # re-run failed tests once at the end: auto (unattended runs) | true | false
  max_run_minutes: 240                 # stop a run that takes longer
  resume_interrupted: true             # start a scheduled / CI run again after a server restart
test_data:
  locale: it                           # names, addresses, phone numbers of {{fake.*}} values (default en)
  seed: 42                             # optional: the same values in every run (per test, row and persona)
  environment: staging                 # optional: prefer data sets of this environment when names repeat
evidence:
  trace: on_failure                    # off | on_failure | always — Playwright trace, secrets masked
  video: on_failure                    # off | on_failure | always
salesforce:                            # only for Salesforce agents — see docs/salesforce-guide.md
  login_url: "https://acme--uat.sandbox.my.salesforce.com"
  connected_app: { client_id: "${SF_CLIENT_ID}", private_key: "${SF_PRIVATE_KEY}" }
  personas:
    - { name: admin, auth_method: jwt, username: "qa.admin@acme.com.uat", expected_profile: "System Administrator" }
    - { name: rep, auth_method: password_totp, username: "qa.rep@acme.com.uat",
        password: "${SF_REP_PASSWORD}", totp_secret: "${SF_REP_TOTP}", expected_profile: "Standard User" }
    - { name: viewer, auth_method: password, username: "qa.viewer@acme.com.uat", password: "${SF_VIEWER_PASSWORD}" }
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

## Unattended runs

Scheduled, CI and API runs (anything not started by a person in the UI) are built to run at night with nobody watching:

- **Pre-flight.** Before running, the application (and the Salesforce login page, when there is one) must answer.
  - If it doesn't, the run waits and retries (`preflight_retries` × `preflight_wait_seconds`), e.g. while a deploy or a
    nightly restart finishes.
  - Then it fails **once**, with the reason and without running the tests. Instead of 200 failures you get one clear
    alert.
  - Tests with AI steps also check that an AI provider is configured, as a warning.
- **Re-run failures at the end.** Failed tests run once more, in a fresh browser, after all the others.
  - A test that passes then counts as passed, is marked **↻ re-run**, and feeds the flaky-test quarantine.
  - Runs started by a person are not re-run unless `rerun_failed: true`.
- **Maximum duration.** A run stops after `max_run_minutes` (hung application, endless waits) and fails with the reason.
- **Restarts.** A scheduled / CI / API run interrupted by a server restart (or a Windows service restart) is started
  again once, with the same tests, when the server is back (within 12 hours).
- **Daily digest.** A notification channel subscribed to **Daily digest** gets one message every morning at its time
  and time zone, also with several servers. For each agent it lists:
  - the last 24 hours: runs, passed and failed tests;
  - new vs still-failing tests;
  - tests that passed only when re-run;
  - pre-flight failures;
  - test users that need a person to sign in.

  **Send digest now** on the notifications page sends it immediately.

A typical night: a schedule at 02:00, saved sign-ins (Sign-in & MFA), triage and quarantine on, and a daily digest at
07:30 to Slack / Teams / email.

## Sign-in & MFA

Tests of an application behind a login start signed in, also with multi-factor authentication. Set up test users on
the agent page (**Sign-in & MFA**) or in the config:

```yaml
auth:
  default_profile: buyer                 # tests start signed in as this user (optional)
  profiles:
    - name: buyer
      login_url: login                   # sign-in page, relative to base_url or absolute (SSO page included)
      username: buyer@example.com
      password: "${BUYER_PASSWORD}"      # encrypted at rest
      totp_secret: "${BUYER_TOTP}"       # authenticator key (Base32) or otpauth:// link, encrypted
      landing_path: /dashboard           # opened after sign-in, and used to check the session works
      success: { url_contains: /dashboard }        # optional: how to tell sign-in worked
      selectors: { username: "#email", code: "#otp" }  # optional: only if the form is not found by itself
      session: { reuse: true, max_age_hours: 12 }
    - name: admin
      ...
```

- **The form is found by itself.** User name or email, password, *Next* for two-step forms (Microsoft Entra ID, Okta,
  Google, Auth0, Keycloak, …), a verification-code page answered with the authenticator code, and *Stay signed in? /
  Trust this device?* prompts accepted. "Remember this device" boxes are ticked, so most applications stop asking
  for MFA after the first sign-in.
- **Sessions are saved.** After signing in, the browser session (cookies and local storage) is stored encrypted and
  reused by the next tests and runs until it expires (`max_age_hours`) or the application shows its sign-in page
  again, when the sign-in runs again (device cookies kept). Salesforce personas use the same vault.
- **Session storage is not kept.** Applications that keep their login in `sessionStorage` sign in again for each test.
- **Who a test runs as:**
  - **Default:** the `default_profile`.
  - **One test:** `"data": { "login_as": "admin" }`, or `false` for none.
  - **A step:** “Log in as admin”.
  - **Every listed user:** `"personas": ["buyer", "admin"]` runs the test once per user, as for Salesforce personas.
- **Checking a profile:** **Test sign-in** signs in now and shows what happened. **Forget session** makes the next run
  sign in again. A saved session is also forgotten when its user name or sign-in page changes.
- **When MFA cannot be answered:** an application that asks for a code without an authenticator key gives a clear error
  (triaged as *environment*). Then add the key, or let a person sign in once.

**Setting up an authenticator key.** When you add an authenticator app for the test user in the application:
1. Take a screenshot of the QR code and use **📷 Read the QR code from a screenshot**, or paste the image (Ctrl+V).
   It is decoded in your browser and never uploaded. You can also choose "Can't scan the QR code?" and paste the key.
2. Add the same key to the authenticator app on your phone. The form shows **Code now: 123 456**, and it must match
   the phone; if it doesn't, check the key and the server clock.
3. Save. The key is encrypted and never shown again; **Show the current code of the saved key** checks it later.

The same helper is on Salesforce personas (*Authenticator (TOTP) secret*). Steps can type a current code with
`{{totp.NAME}}`, where NAME is:
- a login profile or a Salesforce persona with a key, or
- an agent secret holding a key, e.g. for a VPN or second application: `{ "action": "fill", "target": "#otp", "data": { "value": "{{totp.VPN_KEY}}" } }`.

**Codes by email or SMS.** Some applications email or text a code, e.g. Salesforce's *Verify your identity* from a new
browser, a new-device check, or "confirm your email". Connect the mailbox or phone number that receives it (agent page,
**Mailboxes & phone numbers for codes**), and the code is read and typed without a person:

```yaml
code_sources:
  - { name: qa_inbox, type: email, host: imap.example.com, port: 993, username: qa@example.com, password: "${IMAP_PASSWORD}",
      mailbox: INBOX, from_contains: salesforce.com }            # IMAP; Gmail / Outlook need an app password
  - { name: qa_phone, type: sms, provider: twilio, account_sid: "AC…", auth_token: "${TWILIO_TOKEN}", phone_number: "+15550001111" }
auth:
  profiles:
    - { name: buyer, ..., codes: { source: qa_inbox, to: qa+buyer@example.com } }   # `to`: for shared mailboxes
salesforce:
  personas:
    - { name: ops, auth_method: password, ..., codes: { source: qa_inbox } }
```

- **Which code is read:** only messages received after the sign-in (or the test) started, newest first, each used once.
  - The code is the number next to "code / passcode / verification / OTP", else a lone 6–8 digit number.
  - Set `code_pattern` (first group) for other formats.
- **Passwords:** mailbox and Twilio credentials are encrypted.
- **Check:** shows that the source connects and the newest message's time and subject, never message content.
- **Authenticator and email together:** with both a key and a code source, a page that says the code was emailed or
  texted is answered from the source, and other code pages with the authenticator.
- **Codes during a test** (e.g. "confirm your email"):
  `{ "action": "wait_for_code", "target": "qa_inbox", "data": { "to": "qa@example.com", "save_as": "otp", "timeout_s": 90 } }`,
  then `{{vars.otp}}`.
- **Salesforce:** after one verification the session and the device cookie are saved, so the email is rarely needed again.

**Sign in once (any MFA).** For MFA that a script cannot answer (a push approval on the phone, an SMS code, number
matching, a hardware token), use **Sign in once…** next to a login profile or a Salesforce persona.
- **What happens:** the sign-in page opens in a browser on the server and its screen is shown on the agent page.
  - Click on the picture, type in the text box, use the key buttons.
  - **Type user name**, **Type password** and **Type authenticator code** enter the stored values without showing them.
  - Approve the prompt on your phone: the screen refreshes by itself.
- **Saving:** **I'm signed in** saves the session (encrypted) and runs reuse it until it expires. If the page doesn't look
  signed in, you're asked to confirm with **Save anyway**.
- **Fewer prompts later:** tick "remember this device" when offered, so later automatic sign-ins rarely need MFA.
- **Privacy:** typed text is never stored or logged.
- **Limits:** the browser closes after saving or after 10 minutes without use, and at most `SIGNIN_MAX_SESSIONS`
  (default 4) are open at once.

**Sign-in health.** The dashboard's **Sign-in health** card lists the test users (login profiles and Salesforce
personas) that may need a person before the next runs.
- **Who is listed:** users who cannot sign in unattended (no stored password, or no answer for MFA), and whose saved
  session is missing, expiring or expired.
- **Warnings:** a session saved with *Sign in once* is announced to the project's notification channels subscribed to
  **Saved sign-in expiring** (`auth.session_expiring`) when less than half of its lifetime (at most 24 h) is left, once
  per saved session.
- **When it has expired:** a run fails with "… cannot sign in by itself: use Sign in once… again", triaged as
  *environment*.
- **API:** `GET /auth/health` gives the same list.

## Recording tests

**Recorder page.** Record a test by using the application instead of writing steps.
- **How it works:** the browser runs on the server (Windows Server included), and the page shows its screen. Click on the
  picture to act: links and buttons are clicked, fields ask for the text to type, lists for the option, check boxes
  toggle. **✓ Text**, **👁 Visible** and **↗ Hover** turn the next click into a check or a hover. Buttons add key presses
  (Enter, Tab, Escape) and URL / title checks, and the address bar navigates.
- **Steps replay as recorded:** every action runs through the same executor as a test run, and a failing action is
  reported and not recorded.
- **Selectors:** each pick gets the most robust selector that is unique on the page: id, test id
  (`data-testid`, `data-test`, `data-qa`), `name`, role and accessible name (`role=button[name="Save"s]`), label,
  placeholder, text, and finally a CSS path. Ids that look generated (4+ digits) are skipped.
- **Passwords:** pick one of the agent's secrets instead of typing it: the step stores `{{secrets.NAME}}`. Password
  fields are never read back.
- **Salesforce:** start *logged in as* a persona; the first step is then `salesforce_login`.
- **Limits:** sessions belong to their user and project, close after 10 minutes without use, and at most
  `RECORDER_MAX_SESSIONS` (default 4) run at once. The application must be reachable from the server.

**Importing Playwright codegen.** Record on your own computer with `npx playwright codegen https://your-app`, then
paste the script (JavaScript, TypeScript or Python) in the recorder's **Import** tab or send it to
`POST /recordings/import`.
- **What converts:** `goto`, click, fill, press, check/uncheck, `selectOption`, hover and the `expect` assertions
  (`toBeVisible`, `toBeHidden`, `toHaveText`, `toContainText`, `toHaveValue`, `toHaveURL`, `toHaveTitle`, with `not`), on
  `getByRole` / `getByText` / `getByLabel` / `getByPlaceholder` / `getByTestId` / `getByTitle` / `getByAltText` /
  `locator`, chained, with `first()` / `last()` / `nth()`.
- **Adjusted for the agent:** URLs of the agent become paths, and values typed into password-like fields become
  `{{secrets.PASSWORD}}`, with a reminder to add that secret.
- **Anything else** (regular expressions, screenshots, mouse coordinates, popups) is listed as skipped with its line.

## Test data

**Generated values.** Steps can use `{{fake.<kind>}}` anywhere in a target or value:

```json
{ "action": "fill", "target": "#email", "data": { "value": "{{fake.email:buyer}}" } },
{ "action": "assert_text", "target": "#summary", "data": { "value": "Order for {{fake.email:buyer}}" } }
```

- **The same within a test:** the same kind and label give the same value, so a later step can check what an
  earlier one typed. Different labels (`{{fake.email:buyer}}`, `{{fake.email:seller}}`) give different values.
- **Safe values:** emails use `example.com/.net/.org`, card numbers are well-known test cards (`4111111111111111`, …),
  URLs point at `example.com`.
- **Kinds:** firstName, lastName, fullName, email, username, password, phone, company, jobTitle, street, city, state,
  zip, country, countryCode, iban, testCard, cvv, expiry, uuid, unique, number, amount, date, pastDate, birthdate,
  word, words, sentence, paragraph, url, color. The **Test Data** page lists them with examples in each locale.
- **Reproducible or unique:** `test_data.seed` gives the same values in every run; `{{fake.unique}}` stays unique
  anyway, e.g. `{{fake.firstName}}.{{fake.unique}}@example.com` for records that must not already exist.
- **Where they show:** the run page lists the values each test used.

**Data-driven tests.** A test case with `"data": { "dataset": "signups" }` runs once per row of the data set, and steps
use `{{data.<column>}}` (nested: `{{data.address.city}}`).

```json
{ "name": "signups", "data": { "rows": [
  { "_label": "valid", "email": "ada@example.com", "qty": 1 },
  { "_label": "empty email", "email": "", "qty": 1 },
  { "_label": "admin", "email": "{{fake.email}}", "password": "{{secrets.ADMIN_PASSWORD}}" }
] } }
```

- **Row names:** `_label` (or `label`, `name`, `title`, `id`) names the row in titles and reports:
  *Signup works [empty email]*.
- **Placeholders in rows:** values may use `{{secrets.NAME}}` and `{{fake.kind}}`. Results show the row as stored, so
  secrets stay out of reports.
- **With personas:** each persona runs each row.
- **Limits:** at most 100 rows run. A missing data set fails the test as a *test bug* in triage.

**Generating data sets.** On the **Test Data** page, or with `POST /testdata/generate`:
- **From columns (Faker):** `{ "fields": { "name": "fullName", "email": "email" }, "count": 20, "locale": "it" }`.
  Add `seed` for reproducible rows.
- **With AI:** `{ "prompt": "customers for the signup form, with edge cases: empty email, 255-char name, apostrophes" }`.
  The AI labels each edge case and is told to keep every value fictitious. Its answer is checked: flat rows, safe
  column names, scalar values only.
- **Saving:** preview first, then save as a data set; with the API, add `"save": true, "name": "signups"`.

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
| `assert_not_visible` | selector | |
| `salesforce_login` | persona name (default: the test's persona) | `data.persona`, `data.landing` |
| `salesforce_logout` | | |
| `wait_for_lightning` | | waits for Salesforce Lightning spinners |
| `assert_profile` | expected profile | `data.permission_sets` |
| `assert_object_access` | `Account` | `{"read": true, "create": false, "edit": true, "delete": false}` |
| `assert_field_access` | `Account.AnnualRevenue` | `{"read": true, "edit": false}` |
| `assert_record_access` | record Id | `{"read": true, "edit": false}` |
| `assert_access_denied` | optional page to open | optional custom message |
| `assert_accessible` | optional element to scan | `{"level": "wcag21aa", "min_impact": "serious", "ignore": ["color-contrast"], "exclude": [".chat-widget"], "report_only": false}` |
| `assert_screenshot` | optional element (whole viewport if empty) | `{"name": "cart", "max_diff_ratio": 0.001, "threshold": 0.1, "mask": [".clock"], "full_page": false, "on_missing": "create"}` |
| `assert_performance` | optional page to load fresh (else the last page load is measured) | budgets `{"lcp": 2500, "fcp": 1800, "cls": 0.1, "tbt": 200, "ttfb": 800, "load": 3000, "transfer_kb": 1500, "requests": 80, "max_regression": 0.25, "report_only": false}`; also “Verify the page loads in under 2 seconds” |
| `ai` | — | the instruction: `{"value": "Add the cheapest product to the cart", "max_actions": 12, "cache": true}`; also written as “AI: add the cheapest product to the cart” |
| `wait_for_code` | code source (mailbox / phone number) | `{"save_as": "otp", "to": "qa@example.com", "timeout_s": 90}`: waits for an emailed / texted code, then `{{vars.otp}}` |
| `assert_ai` | optional element to judge | the expectation in plain language; `{"value": "…", "min_confidence": 0.7, "on_unsure": "fail"}` — or write the action as "Verify with AI that …" |
| `http_request` | path (relative to `api_base_url`, else `base_url`) or URL; also `"GET orders"` as the action | `{"method": "POST", "json": {...}, "query": {...}, "headers": {...}, "extract": {"orderId": "$.id"}, "status": 201}` |
| `assert_status` | | `201`, `"2xx"` or `[200, 204]` (or in the sentence: "Verify the status code is 201") |
| `assert_json` | JSON path | `{"path": "$.items[0].name", "equals": "Lamp"}` — or `contains`, `matches`, `type`, `length`, `exists: false` |
| `assert_header` | header name | text it contains |
| `assert_response_time` | | maximum ms (or "… under 500 ms") |
| `mock_route` / `block_route` | URL pattern, e.g. `**/api/payments/**` | `{"status": 200, "json": {...}, "delay": 2000, "times": 1, "method": "POST"}` |

Persona matrix: `data.personas` on the test case (list or `"all"`) runs it once per persona; `data.by_persona` on a step gives per-persona values and `data.only_personas` / `data.skip_personas` limit a step. Details in [salesforce-guide.md](salesforce-guide.md).

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

## Browsers & devices

Agent page → **Browsers & devices**, or in the agent JSON:

```json
"browsers": ["chromium", "firefox", "webkit", "iPhone 15", "Pixel 7"]
```

Every test runs once per entry; the results are kept per browser (title `Checkout [firefox]`, `metadata.browser`),
so the same test can pass in Chromium and fail in WebKit, and flaky detection, triage, reports and coverage count them
apart. All tests of one browser run together, in one browser start (one session on a grid).

- `chromium` (alias `chrome` for installed Google Chrome), `firefox`, `webkit` (alias `safari`).
- Any [Playwright device](https://playwright.dev/docs/emulation#devices) name (`iPhone 15`, `iPad Pro 11`, `Pixel 7`,
  `Galaxy S9+`, …): the device's screen size, pixel density, touch and user agent, in its browser engine. Pages without
  `<meta name="viewport">` are laid out 980 px wide, as on a real phone.
- On this server, Firefox and WebKit must be installed: `cd backend && npx playwright install firefox webkit`
  (Windows: the same command). A browser that cannot start fails only its own tests, with that hint.

### Parallel tests

```json
"parallel": 4
```

Up to 4 tests of a browser run at the same time (1–16; the server caps it with `MAX_PARALLEL_TESTS`, default 8), each in
its own browser context, so a night suite finishes in a fraction of the time. Retries, the re-run of failures at the end,
cancellation and the maximum run time work as before.

- Tests must be independent: no test may rely on another having run first, and tests running together should not change the
  same records — give each its own data (`{{fake.email}}`, data sets) or its own persona.
- Parallel tests signing in as the same user take turns at the sign-in: the first signs in, the others reuse its session (no
  second MFA prompt). Authenticator codes are never typed twice: a sign-in waits for the next code when the current one was just used.
- On a cloud grid, all tests of a browser share one session; your plan's parallel limit applies to separate runs.
- Page speed measured during parallel runs is slower than alone: keep speed budgets in agents with `parallel: 1`.

### Cloud grids

`"grid"` runs the browsers elsewhere: real Windows and macOS machines, browser versions this server does not have.

| Provider | `grid` | Browsers |
|---|---|---|
| BrowserStack | `{ "provider": "browserstack", "username": "…", "access_key": "…", "os": "Windows", "os_version": "11" }` | Chromium / Chrome, Firefox, WebKit |
| LambdaTest | `{ "provider": "lambdatest", "username": "…", "access_key": "…", "os": "Windows 11" }` | Chromium / Chrome, Firefox, WebKit |
| Sauce Labs | `{ "provider": "saucelabs", "username": "…", "access_key": "…", "region": "eu-central-1" }` | Chrome only (Playwright's Selenium Grid connection) |
| Playwright server | `{ "provider": "playwright", "ws_endpoint": "ws://grid.internal:3000/" }` | what the server has (`npx playwright run-server`, Moon, Browserless, …) |

- The access key is encrypted at rest, never returned by the API and masked in logs. Without one, the server's
  `BROWSERSTACK_USERNAME` / `BROWSERSTACK_ACCESS_KEY`, `LT_USERNAME` / `LT_ACCESS_KEY` or `SAUCE_USERNAME` / `SAUCE_ACCESS_KEY` are used.
- `browser_version` (default `latest`), `os`, `os_version` choose the machine; `capabilities` adds provider capabilities
  as given (e.g. `{ "browserstack.local": true }` with BrowserStack Local, `{ "LT:Options": { "tunnel": true } }` with
  LambdaTest Tunnel — needed to test an application that is not reachable from the internet). `ws_endpoint` overrides
  the provider's address if it gives you another.
- BrowserStack and LambdaTest sessions are named after the agent and browser, grouped in a build per run, and marked
  passed / failed so their dashboards match.
- Runs started from a grid still use everything else: sign-in sessions, test data, evidence, triage, integrations.

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


## Quality checks

**Accessibility.** `assert_accessible` runs [axe-core](https://github.com/dequelabs/axe-core) on the page.
- **What fails the step:** violations at or above `min_impact` (default `serious`).
- **What's only reported:** lower-impact violations.
- **Agent-wide scan:** `checks.accessibility` scans the page every test ends on, reporting violations (`report`) or
  failing the test (`fail`).
- **Where results show:** the run page and the HTML report list each rule, impact, explanation link and the elements
  concerned.

**Visual regression.** `assert_screenshot` compares a screenshot of the page or of an element with its approved baseline.
- **How baselines are kept:** per agent, `name`, persona and viewport.
- **First run:** records the baseline (`on_missing: "fail"` to require one).
- **When it fails:** more than `max_diff_ratio` of the pixels differ (default 0.1 %). Anti-aliasing is ignored and
  `threshold` sets the per-pixel colour tolerance.
- **Hiding dynamic content:** mask clocks, ads and similar with `mask`.
- **Reviewing a failure:** the run page shows baseline / this run / difference. A project editor can
  **Approve as new baseline**. Baselines are listed (and can be deleted) on the agent page.

**Evidence.** For failed tests (or always, see `evidence`), the run keeps a Playwright trace and a video.
- **What a trace contains:** every action, DOM snapshot, network request and console message.
- **Opening it:** at [trace.playwright.dev](https://trace.playwright.dev) (in your browser), or with `npx playwright show-trace`.
- **Secrets:** before a trace is stored, every secret of the run is replaced with `••••` everywhere in the file. That covers
  agent secrets, persona passwords and TOTP secrets, OAuth tokens, session ids and cookie values.

**Page speed.** `assert_performance` measures the last full page load with the browser's own timing APIs.
- **Metrics:** TTFB, FCP, LCP, CLS, TBT (long-task time over 50 ms after first contentful paint, as in Lighthouse), DOMContentLoaded, load, bytes transferred and
  request count. Single-page-app route changes are not page loads: give the step a target to load a page fresh.
- **Budgets:** from the step, else the agent's `performance_budgets`, else the "good" Core Web Vitals thresholds
  (LCP 2.5 s, FCP 1.8 s, CLS 0.1, TBT 200 ms, TTFB 800 ms). A sentence such as “Verify the page loads in under
  2 seconds” sets a load budget.
- **Regressions:** with `max_regression` (0.25 = 25 %), each metric is compared with the median of the same page
  (origin and path, no query) in the agent's earlier runs. It needs at least 3 earlier measurements, and small absolute
  changes (e.g. under 200 ms of LCP) are ignored as noise.
- **Agent-wide check:** `checks.performance` measures the page each test ends on, reporting (`report`) or failing the
  test (`fail`).
- **Throttling:** `performance_options.throttle` (Lighthouse *slow 4G* or DevTools *fast 3G*) and `cpu_slowdown`
  approximate slower devices (Chromium). They apply to the whole test, so steps get slower too. Emulated latency shows
  in load, DOMContentLoaded and LCP, not in TTFB.
- **Lab values:** they come from the test machine, so they vary between machines and runs; leave headroom in budgets.
- **Where results show:** the run page and the HTML report; failures over budget are triaged as app bugs. The agent page's
  **Page speed** card shows each page's latest values against its 30-day median, with an LCP trend
  (`GET /agents/:id/performance`).

**AI action steps.** A step written as an instruction is carried out by the AI on the live page:
`{ "action": "AI: add the cheapest product to the cart" }` or `{ "action": "ai", "data": { "value": "…" } }`.
- **How it works:** in rounds, the AI sees the instruction, what it did so far and the page (visible text, controls with
  selectors), and answers with the next few actions: click, fill, select, check, uncheck, press, hover, navigate (only
  within the application) or wait. It stops when it reports the instruction done, gives up (the step fails with its
  reason, triaged as *unknown*), or reaches `max_actions` (default 12).
- **Secrets:** `{{secrets.NAME}}` stays a placeholder in what the AI sees; the AI copies it into values and it is
  resolved only when the action runs. Page content is masked as everywhere else. `{{data.*}}` and `{{fake.*}}` are
  resolved before, so the AI can reason with them.
- **Replay:** a sequence that completed the instruction is remembered per agent, test, step, persona/data row and
  instruction, and replayed in later runs without calling the AI. If the replay breaks (the page changed), the AI
  continues from where it stopped and the new sequence is remembered. Turn it off with `ai.action_cache: false` or the
  step's `"cache": false`; forget remembered sequences with **Forget remembered AI actions** on the agent page
  (`DELETE /agents/:id/ai-action-cache`).
- **Save as steps:** the run page lists every action. **Save as steps** replaces the AI step in the test case with
  ordinary steps: reviewable, and no AI needed any more. Values that came from the data set row or fake values go back
  to placeholders (`{{data.email}}`), and `only_personas` / `skip_personas` carry over.
- **When to use it:** for flows that are tedious to script or change often (e.g. setting up state); keep classic steps
  and assertions for what the test checks. AI actions do not assert; follow them with `assert_*` or `assert_ai`.

**Kept self-healing.** With `ai.self_healing`, a broken selector is repaired by the AI from the live page.
- **Within a run:** the repair is reused for the rest of the run without another AI call.
- **After the run:** it is recorded in the result. The run page's **Save to the test case** writes it into the test case,
  or `ai.auto_apply_healing: true` does that automatically after a passing test.
- **Safety check:** a step is only changed while it still has the broken selector.

**Failure triage.** When a run fails, its failures are grouped by what went wrong (the failed step and the
error, without run-specific details such as ids, numbers and URLs).
- **Categories:** each group is classified by rules as
  - **app bug:** an expectation about the application failed (text, URL, access, visual, accessibility);
  - **test bug:** a selector no longer finds its element, or the test is misconfigured;
  - **environment:** the application, network or login was not available.
- **New or known:** groups are marked *new*, or *seen in N earlier runs* of the same agent in the last 30 days.
- **AI explanation:** with an AI provider, **Explain with AI** on the run page, `ai.triage: true`, or
  `POST /runs/:id/triage {"ai": true}` adds a likely cause and a next step to each group. It costs one AI call per run.
- **Where it shows:** the triage summary is included in Slack / Teams / email notifications and in the MCP server's
  `run_tests` / `get_failures` answers.

**Flaky-test quarantine.** A quarantined test still runs and reports its result, but its failure does not fail the run.
- **Effect:** the run stays *completed*, CI wait mode reports `passed`, no failure notification is sent, and JUnit
  reports it as *skipped*. The run page and reports mark it 🧪 and count it apart.
- **By hand:** quarantine a test from the test case list or the analytics flaky table (with a reason), and release it the same way.
- **Automatically:** with `quarantine.auto`, a test is quarantined after the run where it reaches `flips` pass↔fail changes
  (or `passed_on_retry` passes on retry) within its last `window` runs. A test that always fails is a real failure and is
  never quarantined automatically.
- **Release:** an automatically quarantined test is released after `release_after` consecutive first-attempt passes;
  hand-quarantined tests stay until released by hand.

**API testing.** API steps run in the test's browser context, so requests share its cookies: an API call made after a UI
login is authenticated as that user.
- **Variables:** `extract` saves values from a JSON response, used later as `{{vars.name}}` (per test).
- **Mocking in UI tests:** `mock_route` answers matching browser requests with a fixed response (or a delay), and
  `block_route` makes them fail as if the network were down. Use them to test error handling, or to stub third-party
  services in UI tests.
- **Tests from OpenAPI.** The **API tests** card on the agent page (or `POST /agents/:id/generate-api-tests`) reads an
  OpenAPI 3 / Swagger 2 description, from a URL or pasted.
  - Without AI, every operation that can be called with the description's examples, defaults or enums gets a smoke
    test: request, then expected success status, then required response fields.
  - Operations needing values the description does not give are listed as skipped.
  - With AI, it also writes negative and edge cases.
  - Paths are prefixed with a relative server URL (`/api/v1`) or Swagger `basePath`. For an absolute server URL, set the
    agent's **API base URL** to it.

**AI-judged assertions.** `assert_ai` checks an expectation written in plain language against the live page. For example,
"the chatbot's answer explains how to reset a password and links to the help page" can verify Salesforce Agentforce or
Einstein answers.
- **What the AI sees:** the page's (or the element's) visible text, its headings and controls, the URL and the title. It does
  not see pixels; use `assert_screenshot` for how a page looks. Known secrets are masked before anything is sent.
- **How it decides:** the step passes only on a *pass* verdict at or above `min_confidence` (default 0.7). *Unsure* fails
  unless `on_unsure: "pass"`.
- **Caching:** identical page content with the same expectation is judged once per run.
- **Where verdicts show:** with their reasons, on the run page; failed AI checks are triaged as app bugs.
- **Cost and variability:** each check is one AI call (through the `analysis` route). Verdicts can vary more than classic
  assertions, so keep exact assertions for what must never change.
