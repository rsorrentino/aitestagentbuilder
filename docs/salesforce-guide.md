# Salesforce CRM Testing Guide

This guide covers end-to-end automated testing of Salesforce CRM using the AI Test Agent Builder with Playwright.

## Prerequisites

- Salesforce org (Production, Sandbox, or Developer Edition)
- Salesforce user credentials with login access
- Playwright installed (`playwright install chromium`)
- AI Test Agent Builder backend running

---

## 1. Authentication

### Standard Login

The `salesforce_login` action handles both Lightning Experience and Classic login pages:

```yaml
steps:
  - action: salesforce_login
    data:
      username: "${SF_USERNAME}"
      password: "${SF_PASSWORD}"
```

The executor navigates to your org URL, fills the username/password form, clicks Login, and waits for the Lightning App Launcher to confirm successful login.

### Security Token

If Salesforce requires IP whitelisting, append your security token to the password:

```bash
SF_PASSWORD=MyPassword${SF_SECURITY_TOKEN}
```

### Session Token Injection (Advanced)

For CI/CD environments where UI login is slow or unreliable, use Salesforce Connected App OAuth to obtain a session token and inject it directly:

```python
import requests

def get_sf_session(client_id, client_secret, username, password):
    resp = requests.post(
        "https://login.salesforce.com/services/oauth2/token",
        data={
            "grant_type": "password",
            "client_id": client_id,
            "client_secret": client_secret,
            "username": username,
            "password": password,
        },
    )
    resp.raise_for_status()
    return resp.json()["access_token"]
```

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
| Login redirect loop | IP not whitelisted | Add security token to password or whitelist CI IP |
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
          SF_USERNAME: ${{ secrets.SF_USERNAME }}
          SF_PASSWORD: ${{ secrets.SF_PASSWORD }}
          SF_SECURITY_TOKEN: ${{ secrets.SF_SECURITY_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          curl -X POST http://localhost:3000/api/v1/runs \
            -H "Content-Type: application/json" \
            -d '{"agentId": "${{ vars.SF_AGENT_ID }}"}'
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
