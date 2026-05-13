# 🧠 AI Test Agent Builder

An enterprise-grade AI-driven testing automation system that allows QA teams to automate test execution based on documentation.

## 🎯 Overview

The AI Test Agent Builder platform enables:

1. **Reading test books** — Extract, parse, and understand test cases from PDFs, Word, Excel, Confluence, etc.
2. **Converting test cases** — Transform human-readable test cases into structured executable tests
3. **Planning & execution** — Plan, execute, and validate tests across Web, API, and Mobile systems
4. **CI/CD integration** — Integrate with CI/CD pipelines and produce detailed reports

## 🏗️ Architecture

### System Components

- **Ingestion Layer** — Document parsing and test case extraction
- **Knowledge & Storage** — PostgreSQL + pgvector for semantic search
- **Test Abstraction** — Canonical TestCase schema
- **Agent Layer** — Multi-agent system (Parser, Planner, Environment, Execution, Validation, Reporting, Orchestrator)
- **Execution Tooling** — Playwright (Web), Axios (API), Appium (Mobile)
- **Reporting** — HTML, JSON, JUnit, Allure-compatible reports

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Python 3.10+
- PostgreSQL 14+ with pgvector extension
- Docker (optional, for containerized deployment)

### Installation

1. **Backend Setup**
```bash
cd backend
npm install
npm run build
```

2. **Executor Setup**
```bash
cd executor
pip install -r requirements.txt
```

3. **Database Setup**
```bash
# Create database and run migrations
npm run db:migrate
```

4. **Environment Configuration**
```bash
cp .env.example .env
# Edit .env with your configuration
```

### Running the System

1. **Start Backend**
```bash
cd backend
npm run dev
```

2. **Run Tests via CLI**
```bash
npm run cli -- run --config configs/login-agent.yml
```

## 📁 Project Structure

```
/backend          # TypeScript backend (Node.js/Express)
/executor         # Python execution agents
/frontend         # React/Next.js UI (optional)
/configs          # Agent configuration files
/.github/workflows # CI/CD templates
```

## 🔧 Configuration

Agent configurations are defined in YAML:

```yaml
agent_name: "LoginTester"
application_type: "web"
base_url: "https://staging.myapp.com"
test_selection:
  module: ["Auth"]
  priority: ["High"]
tools:
  browser: "playwright"
  http: "axios"
reporting:
  formats: ["json", "html"]
environment: "staging"
max_parallel_tests: 5
```

## 📚 Documentation

- [Architecture Guide](./docs/architecture.md)
- [API Documentation](./docs/api.md)
- [Agent Development Guide](./docs/agents.md)

## 🔄 Workflow Example

1. **Upload Test Book**
```bash
curl -X POST http://localhost:3000/api/v1/ingestion/upload \
  -F "file=@test-book.pdf"
```

2. **Extract Test Cases**
```bash
curl -X POST http://localhost:3000/api/v1/ingestion/documents/DOC-123/extract
```

3. **Create Agent**
```bash
curl -X POST http://localhost:3000/api/v1/agents \
  -H "Content-Type: application/json" \
  -d @configs/login-agent.yml
```

4. **Run Tests**
```bash
curl -X POST http://localhost:3000/api/v1/runs \
  -H "Content-Type: application/json" \
  -d '{"agentId": "AGENT-123"}'
```

5. **Generate Reports**
```bash
curl -X POST http://localhost:3000/api/v1/reports/runs/RUN-123/generate \
  -H "Content-Type: application/json" \
  -d '{"formats": ["json", "html"]}'
```

## 🛠️ Development

### Prerequisites
- Node.js 18+
- Python 3.10+
- PostgreSQL 14+ with pgvector
- Playwright browsers (installed via `playwright install`)

### Setup

1. **Install Backend Dependencies**
```bash
cd backend
npm install
```

2. **Install Executor Dependencies**
```bash
cd executor
pip install -r requirements.txt
playwright install chromium
```

3. **Setup Database**
```bash
# Create database
createdb aitestagentbuilder

# Run migrations
cd backend
npm run db:migrate
```

4. **Configure Environment**
```bash
cp .env.example .env
# Edit .env with your settings
```

5. **Start Backend**
```bash
cd backend
npm run dev
```

### Running Tests

**Backend Tests**
```bash
cd backend
npm test
```

**Executor Tests**
```bash
cd executor
pytest
```

## 🧪 Testing

```bash
# Backend tests
cd backend && npm test

# Executor tests
cd executor && pytest
```

## 📄 License

MIT

