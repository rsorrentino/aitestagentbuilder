# Salesforce CRM Testing Guide

This guide covers end-to-end automated testing of Salesforce CRM using the AI Test Agent Builder with Playwright.

## Prerequisites

- Salesforce org (Production, Sandbox, or Developer Edition)
- One test user per kind of user you want to test (e.g. administrator, sales rep, read-only)
- For administrators: a connected app with a certificate (JWT bearer flow) — see below
- Playwright installed (`playwright install chromium`)
- AI Test Agent Builder backend running

---

## 1. Authentication and personas

Security testing in Salesforce means testing **as real users** — an administrator, a sales
rep, a read-only user — not only as an integration user. The agent stores one **persona** per
kind of user, logs the browser in as that user, and can run the same test once per persona
with different expectations for each.

### Personas

Configure them on the agent page (**Agent → ☁️ Salesforce personas**) or in
`config.salesforce` through the API. Passwords, TOTP secrets, security tokens, the consumer
secret and the private key are encrypted at rest (AES-256-GCM), never returned by the API and
masked in run logs. Only project admins can change them; editors can verify them.

| Login method (`auth_method`) | How it logs in | Use it for |
|---|---|---|
| `password` | UI login page: username + password | Users that are not challenged for MFA (e.g. logins from a trusted IP range set on the profile or in Network Access) |
| `password_totp` | UI login + authenticator-app code generated from the user's TOTP secret (RFC 6238) | Standard users with MFA. Register an authenticator for the test user and store the Base32 key ("Can't scan the QR code?") |
| `jwt` | OAuth 2.0 JWT bearer flow (connected app / External Client App + certificate), then **frontdoor** into the UI | **Administrators and other high-privilege users.** Salesforce requires phishing-resistant MFA (security keys, built-in authenticators) for admin UI logins, which a robot cannot complete; the JWT flow involves no password or MFA prompt |
| `oauth_password` | OAuth username-password flow (password + security token), then frontdoor | Legacy orgs where that flow is still enabled |
| `login_as` | An administrator persona logs in, then uses **Log in as** on the user (`/servlet/servlet.su`) | Users whose credentials you do not hold; testing exactly what support sees. Needs "Manage Users" and "Administrators Can Log in as Any User" |

After every login the agent can check **who Salesforce says the user is** — profile and
permission sets — against the persona's `expected_profile` / `expected_permission_sets`, so a
test never silently runs as the wrong kind of user (e.g. after someone changed a profile in the
sandbox). The **Verify** button runs the same check on demand.

Sessions are cached per persona for the duration of a run (`reuse_sessions`, default on), so a
matrix of tests does not repeat the full login and MFA for every test.

```jsonc
"salesforce": {
  "login_url": "https://acme--uat.sandbox.my.salesforce.com",   // My Domain, login. or test.salesforce.com
  "instance_url": "https://acme--uat.sandbox.lightning.force.com", // defaults to the agent base_url
  "api_version": "v62.0",
  "default_persona": "rep",
  "api_persona": "admin",            // OAuth persona used for admin-side checks (see below)
  "frontdoor_mode": "auto",          // auto | single_access | sid
  "connected_app": { "client_id": "3MVG9…", "private_key": "-----BEGIN PRIVATE KEY-----…" },
  "personas": [
    { "name": "admin",  "auth_method": "jwt",           "username": "qa.admin@acme.com.uat",
      "expected_profile": "System Administrator" },
    { "name": "rep",    "auth_method": "password_totp", "username": "qa.rep@acme.com.uat",
      "password": "…", "totp_secret": "JBSWY3DPEHPK3PXP",
      "expected_profile": "Standard User", "expected_permission_sets": ["Sales_Ops"] },
    { "name": "viewer", "auth_method": "password",      "username": "qa.viewer@acme.com.uat",
      "password": "…", "expected_profile": "Read Only" },
    { "name": "rep_support", "auth_method": "login_as", "username": "qa.rep@acme.com.uat",
      "login_as_via": "admin" }
  ]
}
```

#### Setting up the JWT bearer flow (once per org)

1. Create a certificate and key: `openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=atab"`.
2. Create a connected app (or External Client App) with OAuth enabled, **Use digital signatures** = `cert.pem`, scopes `api`, `refresh_token`/`offline_access` and `web`.
3. Under *Manage → OAuth policies* set **Permitted users = Admin approved users are pre-authorized**, then add the test users' profiles or a permission set.
4. Paste the consumer key and the contents of `key.pem` in **Org connection**. The JWT audience is chosen automatically (`login.salesforce.com` for production/Developer Edition and My Domain, `test.salesforce.com` for sandboxes).

The access token is turned into a browser session with a single-use frontdoor URL
(`POST /services/oauth2/singleaccess`); `frontdoor_mode: auto` falls back to
`/secur/frontdoor.jsp?sid=…` where the single-access endpoint is not available.

#### MFA and verification pages

- `password_totp` fills the verification code (`#tc` and similar) and clicks **Verify**. If your
  org uses a different verification page, override the selectors with
  `salesforce.mfa.code_selector` / `salesforce.mfa.submit_selector`.
- If Salesforce sends an **email or SMS code** instead, the test fails with a clear message: make
  the authenticator app the user's verification method, or add the runner's IP range to the
  profile's *Login IP Ranges* / *Network Access*.
- "Register your phone" prompts are skipped automatically.

### Saved sessions (fewer logins, fewer verification codes)

Persona sessions are saved, encrypted, and reused by later tests **and runs** (`salesforce.session_max_age_hours`,
default 8), together with Salesforce's device-activation cookies: once a persona has verified the browser,
Salesforce stops sending *Verify your identity* emails for it. The agent page (**Sign-in & MFA**) shows each persona's
saved session and can forget it; it is also forgotten when the persona's user name, auth method or the login URL
changes. Applications other than Salesforce (SSO portals, other SaaS) use *login profiles*: see docs/agents.md, Sign-in & MFA.

### Steps

| Action | Target | Data | What it does |
|---|---|---|---|
| `salesforce_login` | persona name, or a path to land on | `persona`, `landing`, `fresh`, `verify_identity` | Log in as the persona (default: the test's persona, else `default_persona`) |
| `salesforce_logout` | | | Log out (ends a *Log in as* session, back to the admin) |
| `assert_profile` | expected profile | `profile`, `permission_sets`, `not_permission_sets` | Identity check of the current persona |
| `assert_object_access` | `Account` | `read`, `create`, `edit`, `delete` (true/false) | Object permissions (CRUD) |
| `assert_field_access` | `Account.AnnualRevenue` | `read`, `edit` | Field-level security |
| `assert_record_access` | record Id | `read`, `edit`, `delete` | Sharing (UserRecordAccess) |
| `assert_access_denied` | page to open (optional) | `value` = custom message | The page shows Salesforce's "Insufficient Privileges" / "You don't have access" message |
| `assert_not_visible` | element | | e.g. the **Delete** button is not shown |

Only the keys you give are checked: `{"read": true, "delete": false}` passes whatever create/edit are.

Permission checks run **as the persona** (its OAuth token, or the API session of its browser
login). For personas without their own API session (e.g. `login_as`), they are computed from
the user's profile and permission sets through the `api_persona` (ObjectPermissions,
FieldPermissions, UserRecordAccess) — that persona needs *View Setup and Configuration*.
Admin-side checks do not account for *View All / Modify All Data*, muting permission sets or
permission set group calculations; the UI assertions do.

### Running one test as many personas

Set the personas on the test case (**Run as personas** in the editor, or `data.personas` —
a list or `"all"`). The run executes the test once per persona; results are named
`<title> [as <persona>]` and counted separately in reports and analytics. If the test has no
`salesforce_login` step it starts already logged in as the persona.

Give different expectations per persona with `by_persona` (a `default` entry applies to the
others), and restrict steps with `only_personas` / `skip_personas`:

```json
{
  "title": "Opportunity security",
  "data": { "personas": ["admin", "rep", "viewer"] },
  "steps": [
    { "action": "assert_object_access", "target": "Opportunity", "data": { "by_persona": {
        "admin":  { "read": true, "edit": true, "delete": true },
        "rep":    { "read": true, "edit": true, "delete": false },
        "viewer": { "read": true, "edit": false } } } },
    { "action": "assert_field_access", "target": "Account.AnnualRevenue", "data": { "by_persona": {
        "admin": { "edit": true }, "rep": { "read": true, "edit": false }, "viewer": { "read": false } } } },
    { "action": "navigate", "target": "/lightning/r/Opportunity/006XXXXXXXXXXXXXXX/view" },
    { "action": "assert_visible", "target": "button[name='Edit']", "data": { "only_personas": ["admin", "rep"] } },
    { "action": "assert_not_visible", "target": "button[name='Delete']", "data": { "only_personas": ["rep"] } },
    { "action": "assert_access_denied", "data": { "only_personas": ["viewer"] } },
    { "action": "assert_access_denied", "target": "/lightning/setup/SetupOneHome/home", "data": { "skip_personas": ["admin"] } }
  ]
}
```

### Try it without an org: the Salesforce simulator

Outside production the backend serves a small Salesforce look-alike at `/demo/salesforce`
(enable it in production with `SALESFORCE_SIMULATOR=true`). It implements the login page, the
authenticator verification page, frontdoor, *Log in as*, the OAuth token endpoint (JWT bearer and
password grants), userinfo, the SOQL queries and describe calls used above, and Lightning-like
list/record/setup pages that honour object, field and record permissions.

| User | Password | TOTP secret | Profile |
|---|---|---|---|
| `admin@acme.sim` | `Admin-Pass-1!` | `KRSXG5CTMVRXEZLU` | System Administrator — UI login is refused (phishing-resistant MFA required): use `jwt` or `login_as` |
| `rep@acme.sim` | `Rep-Pass-1!` | `JBSWY3DPEHPK3PXP` | Standard User + `Sales_Ops` |
| `viewer@acme.sim` | `Viewer-Pass-1!` | — | Read Only |

Click **Use the Salesforce simulator** on an agent to configure the admin/rep/viewer personas in
one go. The simulator's behaviour is what `src/tests/integration/salesforce.test.ts` and
`e2e/tests/salesforce.spec.ts` test against; the login flows were written to Salesforce's
documented endpoints and page ids but should be checked once against your own org (use
**Verify** on each persona).

### Legacy single-user configuration

`salesforce.username` / `password` / `security_token` still work: they become a persona named
`default` that logs in through the UI.

---

## 2. Salesforce Lightning Web Components (LWC)

### Shadow DOM

Salesforce Lightning Experience uses Web Components with Shadow DOM. Playwright's CSS selectors automatically pierce shadow roots using the `>>` deep combinator:

```python
# Works across shadow root boundaries
await page.click("lightning-button >> button")
```

### LWC-Specific Selectors

Prefer ARIA roles and `data-*` attributes over class-based selectors, as Salesforce frequently changes CSS class names:

```python
# ✅ Stable: ARIA + semantic selectors
await page.click("button[name='SaveEdit']")
await page.fill("input[field-label='Last Name']", "Smith")
await page.locator("lightning-combobox[field-name='Status']")

# ❌ Fragile: Generated CSS classes
await page.click(".slds-button_brand.forceActionButton")  # may break on upgrades
```

### Waiting for Lightning to Load

Always call `wait_for_lightning` after navigation to ensure Salesforce has finished rendering:

```yaml
steps:
  - action: navigate
    target: "/lightning/o/Lead/list"
  - action: wait_for_lightning
```

---

## 3. CRM Module Testing

### Leads

```yaml
steps:
  - action: navigate
    target: "/lightning/o/Lead/list"
  - action: wait_for_lightning
  - action: click
    target: "a[title='New']"
  - action: fill
    target: "input[field-label='First Name']"
    data: { value: "John" }
  - action: fill
    target: "input[field-label='Last Name']"
    data: { value: "Doe" }
  - action: fill
    target: "input[field-label='Company']"
    data: { value: "Acme Corp" }
  - action: click
    target: "button[name='SaveEdit']"
  - action: wait_for_lightning
expectedResults:
  - "Lead 'John Doe' is created and detail page is displayed"
```

### Contacts

```yaml
steps:
  - action: navigate
    target: "/lightning/o/Contact/list"
  - action: wait_for_lightning
  - action: click
    target: "a[title='New']"
  - action: fill
    target: "input[field-label='Last Name']"
    data: { value: "Smith" }
  - action: fill
    target: "input[field-label='Email']"
    data: { value: "j.smith@example.com" }
  - action: click
    target: "button[name='SaveEdit']"
```

### Opportunities

```yaml
steps:
  - action: navigate
    target: "/lightning/o/Opportunity/list"
  - action: wait_for_lightning
  - action: click
    target: "a[title='New']"
  - action: fill
    target: "input[field-label='Opportunity Name']"
    data: { value: "Q3 Enterprise Deal" }
  - action: select
    target: "lightning-combobox[field-name='StageName']"
    data: { value: "Prospecting" }
  - action: fill
    target: "input[field-label='Close Date']"
    data: { value: "12/31/2026" }
  - action: click
    target: "button[name='SaveEdit']"
```

### Cases

```yaml
steps:
  - action: navigate
    target: "/lightning/o/Case/list"
  - action: wait_for_lightning
  - action: click
    target: "a[title='New']"
  - action: fill
    target: "input[field-label='Subject']"
    data: { value: "Unable to access portal" }
  - action: select
    target: "lightning-combobox[field-name='Priority']"
    data: { value: "High" }
  - action: click
    target: "button[name='SaveEdit']"
```

---

## 4. AI Self-Healing Selectors

Enable self-healing in your agent config to automatically recover from broken selectors:

```yaml
ai:
  provider: claude
  self_healing: true
```

When a selector fails with a `TimeoutError`, the Self-Healing Agent:
1. Captures a compact DOM snapshot of the current page.
2. Sends the failed selector + DOM to Claude (or fallback provider).
3. Receives a suggested alternative selector.
4. Retries the step with the new selector.
5. Records `healed: true`, `original_selector`, `healed_selector` in the result.

---

## 5. Common Gotchas

| Issue | Cause | Fix |
|---|---|---|
| Element not found | Salesforce spinner still showing | Add `wait_for_lightning` after navigation |
| Stale element reference | Page re-rendered after LWC event | Re-query element after interaction |
| `required field missing` alert | Mandatory field not filled | Check required fields in Salesforce object schema |
| Login stops at "Verify your identity" | MFA challenge (new IP / browser) | Use `password_totp` with the user's authenticator secret, `jwt`, or trust the runner's IP range |
| Admin UI login refused | Phishing-resistant MFA required for admins | Use the `jwt` method (or `login_as`) for admin personas |
| `user hasn't approved this consumer` | User not pre-authorized on the connected app | Add the user's profile or a permission set to the connected app |
| Persona misconfigured: profile is "X", expected "Y" | The test user was changed in the org | Fix the user or the persona's expected profile |
| Combobox won't select | Lightning combobox requires click + selection | Use `select` action with `lightning-combobox[field-name='...']` |
| Modal doesn't close | Classic popup blocking | Use `handle_classic_popup` action |

---

## 6. CI/CD Integration

```yaml
# .github/workflows/salesforce-tests.yml
name: Salesforce CRM Tests

on:
  schedule:
    - cron: '0 6 * * 1-5'  # Weekdays at 6am
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Salesforce CRM Tests
        env:
          ATAB_URL: ${{ vars.ATAB_URL }}            # e.g. https://atab.example.com/api/v1
          ATAB_API_KEY: ${{ secrets.ATAB_API_KEY }} # project API key (editor role)
        # Persona credentials live (encrypted) on the agent — the pipeline only needs an API key.
        run: |
          curl -fsS -X POST "$ATAB_URL/runs" \
            -H "Authorization: ApiKey $ATAB_API_KEY" -H "Content-Type: application/json" \
            -d '{"agentId": "${{ vars.SF_AGENT_ID }}", "wait": true, "timeoutSeconds": 1800}' \
            | tee run.json | jq -e '.passed == true'
```

---

## 7. Page Object Reference

The `salesforce_helpers.py` module provides:

| Class | Description |
|---|---|
| `SalesforceLoginPage` | Login/authentication |
| `SalesforceNavigator` | App Launcher, module navigation, Save/Cancel |
| `SalesforceLeadPage` | Lead list, create, search |
| `SalesforceContactPage` | Contact list, create |
| `SalesforceOpportunityPage` | Opportunity list, create |
| `SalesforceCasePage` | Case list, create |

```python
from executor.src.tools.browser.salesforce_helpers import get_salesforce_pages

pages = get_salesforce_pages(playwright_tool)
await pages["login"].login(org_url, username, password)
await pages["leads"].create_lead("John", "Doe", "Acme Corp")
await pages["opportunities"].create_opportunity("Q3 Deal", "Prospecting", "12/31/2026")
```
