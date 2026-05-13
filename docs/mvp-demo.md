# 🚀 MVP Demo: Zero to Automated Salesforce CRM Test in 10 Minutes

This guide walks through a reproducible demo that takes you from a blank slate to a fully automated Salesforce CRM test using AI-generated test cases and Playwright execution.

---

## Prerequisites

```bash
# Node.js 18+, Python 3.10+, PostgreSQL 14+
node --version   # ≥ 18.0.0
python3 --version  # ≥ 3.10.0
psql --version   # ≥ 14.0
```

You also need API keys for at least one AI provider (Claude recommended):

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # Claude
# OR
export GITHUB_TOKEN="ghp_..."           # GitHub Copilot
# OR
export OPENAI_API_KEY="sk-..."          # OpenAI
```

And Salesforce credentials:

```bash
export SF_USERNAME="user@example.com"
export SF_PASSWORD="MyPassword"
export SF_SECURITY_TOKEN="abc123"       # From Salesforce > Settings > Security Token
```

---

## Step 1 — Install & Start (2 min)

```bash
# Clone and setup
git clone https://github.com/rsorrentino/aitestagentbuilder
cd aitestagentbuilder

# Backend
cd backend && npm install && npm run build
cp .env.example .env
# Edit .env: add ANTHROPIC_API_KEY, DB_URL, etc.

# Executor
cd ../executor && pip install -r requirements.txt
playwright install chromium

# Database
createdb aitestagentbuilder
cd ../backend && npm run db:migrate

# Start backend
npm run dev &
echo "Backend running at http://localhost:3000"

# Start frontend (separate terminal)
cd ../frontend && npm install && npm run dev &
echo "Frontend running at http://localhost:3001"
```

---

## Step 2 — Create a Salesforce Agent (1 min via UI Wizard)

Open **http://localhost:3001/wizard/salesforce** in your browser.

1. **Org Details**: Enter your Salesforce org URL, username, password  
2. **Select Modules**: Choose `Authentication`, `Leads`, `Contacts`  
3. **AI Config**: Select `claude`, enable `Self-Healing`  
4. Click **Create Agent** → note your `agentId`

---

## Step 3 — AI-Generate Test Cases (1 min)

The AI generates structured test cases from your org URL + description:

```bash
curl -X POST http://localhost:3000/api/v1/agents/${AGENT_ID}/generate-tests \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -d '{
    "description": "Test standard Salesforce CRM workflows including login, creating a Lead, and converting it to a Contact",
    "count": 5,
    "modules": ["Authentication", "Leads", "Contacts"]
  }'
```

**Response example:**

```json
{
  "agentId": "AGENT-001",
  "count": 5,
  "tests": [
    {
      "title": "Login to Salesforce Lightning",
      "module": "Authentication",
      "priority": "Critical",
      "steps": [
        { "action": "salesforce_login", "data": { "username": "${SF_USERNAME}", "password": "${SF_PASSWORD}" } },
        { "action": "wait_for_lightning" }
      ],
      "expectedResults": ["User sees Lightning home page"]
    },
    {
      "title": "Create a new Lead",
      "module": "Leads",
      "priority": "High",
      "steps": [
        { "action": "navigate", "target": "/lightning/o/Lead/list" },
        { "action": "wait_for_lightning" },
        { "action": "click", "target": "a[title='New']" },
        { "action": "fill", "target": "input[field-label='First Name']", "data": { "value": "John" } },
        { "action": "fill", "target": "input[field-label='Last Name']", "data": { "value": "Doe" } },
        { "action": "fill", "target": "input[field-label='Company']", "data": { "value": "Acme Corp" } },
        { "action": "click", "target": "button[name='SaveEdit']" }
      ],
      "expectedResults": ["Lead 'John Doe' is created successfully"]
    }
  ]
}
```

---

## Step 4 — Chat-Assisted Test Refinement (2 min)

Open **http://localhost:3001** and click **💬 AI Assistant**.

Try these prompts:

> "Add a test that verifies the Lead status is set to 'New' after creation"

> "Create a negative test: try to create a Lead without a Last Name and verify the validation error"

> "Add a test that converts the Lead to a Contact and Opportunity"

The assistant returns structured test case JSON that you can import directly.

---

## Step 5 — Run the Tests (2 min)

```bash
# Start a test run
curl -X POST http://localhost:3000/api/v1/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -d "{\"agentId\": \"${AGENT_ID}\"}"

# Response: { "runId": "RUN-001", "status": "running" }
```

**Watch it live**: Open **http://localhost:3001/live?runId=RUN-001**

You'll see:
- 🖥️ Real-time Playwright browser screenshots on the left
- 📋 Step-by-step execution log on the right
- Self-healing notifications if any selectors needed recovery

---

## Step 6 — View the Report (30 sec)

```bash
# Generate HTML report
curl -X POST http://localhost:3000/api/v1/reports/runs/RUN-001/generate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -d '{"formats": ["json", "html", "junit"]}'
```

Open the HTML report from the returned URL. It includes:
- Pass/fail summary with visual badges
- Per-step screenshots
- Self-healing events (original selector → healed selector)
- Performance timing per step

---

## What Just Happened?

| Step | Technology | AI Provider |
|---|---|---|
| Created agent via wizard | Next.js + Express | — |
| Generated test cases | `AiTestGeneratorService` | Claude (extraction task) |
| Refined via chat | `ChatController` | Claude (chat task) |
| Executed tests | Playwright (Python) | — |
| Fixed broken selector (if any) | `SelfHealingAgent` | Claude (healing task) |
| Generated report | `ReportingAgentService` | — |

---

## Troubleshooting

**Login fails** → Check `SF_USERNAME`, `SF_PASSWORD`, and that the IP is not blocked (add security token to password)

**`TimeoutError` on selector** → If self-healing is enabled, this is auto-recovered. Otherwise, inspect the HTML snapshot in the log and update the selector.

**LLM provider not found** → Visit **http://localhost:3001/settings/ai-providers** to check which providers are configured and healthy.

**`createdb` fails** → PostgreSQL not running; start with `pg_ctl start` or `brew services start postgresql@14`.

---

## Next Steps

- Set up a **Scheduled CI Run** via GitHub Actions (see `docs/salesforce-guide.md`)
- Add **TestRail / Jira** sync (services already implemented in `backend/src/modules/integrations/`)
- Upload a **test book PDF** to auto-extract test cases: `POST /api/v1/ingestion/upload`
- Explore **API testing** by setting `application_type: api` in the agent config
