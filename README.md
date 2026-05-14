<div align="center">

# 🧠 AI Test Agent Builder

**The AI-powered platform that turns test specs into running automated tests — in minutes.**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js)](https://nodejs.org)
[![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

[**Live Demo**](#running-locally) · [**Quick Start**](#-quick-start) · [**API Docs**](docs/api.md) · [**Architecture**](docs/architecture.md)

---

</div>

## ✨ Why AI Test Agent Builder?

Stop writing brittle test scripts by hand. AI Test Agent Builder reads your documentation, extracts test cases with an LLM, and executes them against real applications — automatically.

| ✅ Without this tool | 🚀 With AI Test Agent Builder |
|---|---|
| Weeks of manual test scripting | Test suite running in hours |
| Tests break after every UI change | AI self-heals broken selectors |
| One AI provider or bust | Multi-LLM routing with automatic fallback |
| Hard to see what's happening | Live browser-viewport streaming |
| Spec docs gathering dust | Upload → extract → run in 3 steps |

---

## 🎯 Key Features

### 🤖 AI-Powered Test Generation
Upload a PDF, Word doc, or spreadsheet. The LLM reads it and generates structured, executable test cases — no copy-pasting, no manual translation.

### ⚡ Salesforce CRM Quick-Start Wizard
Get a full Salesforce test suite running in under 5 minutes. Pick your modules (Leads, Contacts, Opportunities…), choose your AI provider, and go.

### 🛡️ Self-Healing Selectors
When a UI update breaks a selector, the AI automatically finds the new element and patches the test — zero downtime for your QA pipeline.

### �� Multi-LLM Routing
Works with **Anthropic Claude**, **OpenAI GPT-4o**, **GitHub Copilot**, and **Azure OpenAI**. Each task type routes to the best model, with automatic fallback.

### 📡 Real-Time Live View
Watch automated tests execute live in a split-screen — browser viewport on one side, execution log on the other.

### 📄 Document Ingestion
Drop in PDFs, Word files, Excel sheets, Markdown or plain text. The parser agent turns prose into structured test cases.

### 📊 Rich Reports
JSON, HTML, JUnit, and Allure-compatible reports with screenshots, logs, and pass/fail breakdowns.

---

## 🚀 Quick Start

### Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 18+ |
| PostgreSQL | 14+ with [pgvector](https://github.com/pgvector/pgvector) |
| Python *(optional, for executor)* | 3.10+ |
| Docker *(optional)* | 24+ |

### 1. Clone & Configure

```bash
git clone https://github.com/rsorrentino/aitestagentbuilder.git
cd aitestagentbuilder
cp .env.example .env
```

Edit `.env` and set at least one AI provider key:

```env
# Pick ONE or MORE providers:
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...          # For GitHub Copilot
DATABASE_URL=postgresql://user:pass@localhost:5432/aitestagentbuilder
JWT_SECRET=change-me-to-something-long-and-random
AUTH_ENABLED=false            # Set to true to enable token auth
```

### 2. Database Setup

```bash
# Create the database
createdb aitestagentbuilder

# Run migrations
cd backend && npm install && npm run db:migrate
```

### 3. Start the Backend

```bash
cd backend
npm run dev
# API running at http://localhost:3000
```

### 4. Start the Frontend

```bash
cd frontend
npm install
npm run dev
# UI running at http://localhost:4000
```

Open [http://localhost:4000](http://localhost:4000) — you should see the dashboard.

---

## 🖥️ Application Tour

| Page | URL | What you can do |
|---|---|---|
| **Dashboard** | `/` | Overview of agents, recent runs, KPIs |
| **Agents** | `/agents` | List, create, manage test agents |
| **Create Agent** | `/agents/new` | Generic wizard for any app type |
| **SF Wizard** | `/wizard/salesforce` | 3-step Salesforce quick-start |
| **Documents** | `/documents` | Upload test books, trigger AI extraction |
| **Test Cases** | `/testcases` | Browse, filter, manage extracted tests |
| **Run Detail** | `/runs/:id` | Pass/fail breakdown per test case |
| **Live View** | `/live?runId=…` | Real-time browser viewport + log stream |
| **AI Providers** | `/settings/ai-providers` | Provider health & routing config |

---

## 🔄 End-to-End Workflow

```
1. Upload test book (PDF / Word / Excel)
         ↓
2. AI extracts structured test cases
         ↓
3. Create agent (target URL, AI provider, modules)
         ↓
4. Trigger a test run
         ↓
5. Watch it live — browser viewport + real-time log
         ↓
6. Get HTML / JUnit / JSON reports
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Next.js Frontend                  │
│   Dashboard · Agents · Documents · Live View        │
└─────────────────┬───────────────────────────────────┘
                  │ REST + WebSocket
┌─────────────────▼───────────────────────────────────┐
│              Express Backend (TypeScript)            │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │Ingestion │  │Agents    │  │Orchestrator      │  │
│  │  Layer   │  │  CRUD    │  │(run lifecycle)   │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │              LLM Router                       │  │
│  │  Claude → OpenAI → Copilot → Azure            │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────┬───────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────┐
│          PostgreSQL + pgvector                      │
│   agents · runs · test_cases · documents · results  │
└─────────────────────────────────────────────────────┘
```

**Agent Types:**

| Agent | Responsibility |
|---|---|
| **Parser Agent** | Reads documents, extracts test cases via LLM |
| **Planner Agent** | Prioritises and sequences test execution |
| **Environment Agent** | Sets up browser / API / mobile context |
| **Execution Agent** | Runs Playwright / Axios / Appium steps |
| **Reporting Agent** | Produces HTML, JSON, JUnit reports |
| **Orchestrator** | Coordinates all agents, manages run lifecycle |

---

## 🔧 Configuration Reference

Agent configs live in `configs/` as YAML:

```yaml
agent_name: "CheckoutFlowTester"
application_type: web          # web | api | mobile | hybrid
base_url: "https://staging.example.com"
environment: staging
test_selection:
  module: ["Cart", "Checkout", "Payment"]
  priority: ["Critical", "High"]
  tags: ["smoke", "regression"]
tools:
  browser: playwright
  http: axios
ai:
  provider: claude              # claude | openai | copilot | azure
  model: claude-3-5-sonnet-latest
  self_healing: true
  fallback: openai
reporting:
  formats: [json, html, junit]
  includeScreenshots: true
  includeLogs: true
max_parallel_tests: 3
timeout: 60000
retries: 2
```

---

## 🧪 Running Tests

```bash
# Backend unit + integration tests
cd backend && npm test

# Python executor tests (requires Python 3.10+)
cd executor && pip install -r requirements.txt && pytest
```

---

## �� Docker (optional)

```bash
docker compose up -d        # starts backend + postgres + redis
```

---

## 🤝 Contributing

1. Fork → Branch → PR
2. Read [CONTRIBUTING.md](CONTRIBUTING.md)
3. All PRs must include tests

---

## 📄 License

MIT — see [LICENSE](LICENSE)

---

<div align="center">

Built with ❤️ using **Next.js**, **Express**, **Playwright**, and the power of **Multi-LLM AI**

</div>
