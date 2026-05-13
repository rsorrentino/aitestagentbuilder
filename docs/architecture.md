# Architecture Documentation

## System Overview

The AI Test Agent Builder is a multi-layered system that transforms test documentation into executable test automation.

## Architecture Layers

### 1. Ingestion Layer

**Purpose**: Parse and extract test cases from various document formats.

**Components**:
- `DocumentParserService`: Handles PDF, Word, Excel, HTML, Markdown parsing
- `ParserAgentService`: Uses LLM to extract structured test cases from parsed text

**Flow**:
1. Document uploaded via API
2. Document parsed based on source type
3. Text extracted and chunked
4. LLM agent extracts structured test cases
5. Test cases stored in database with embeddings

### 2. Knowledge & Storage Layer

**Database**: PostgreSQL with pgvector extension

**Tables**:
- `documents`: Raw documents and metadata
- `test_cases`: Structured test case definitions
- `agents`: Agent configurations
- `runs`: Test execution runs
- `results`: Individual test results
- `reports`: Generated reports

**Features**:
- Semantic search using pgvector embeddings
- Full CRUD operations for all entities
- Transaction support

### 3. Test Abstraction Layer

**Core Model**: `TestCase`

```typescript
interface TestCase {
  id: string;
  title: string;
  module: string;
  steps: TestStep[];
  expectedResults: string[];
  priority: Priority;
  // ... more fields
}
```

**Purpose**: Normalize all test cases into a canonical format that can be executed across different platforms.

### 4. Agent Layer

#### Parser Agent
- Extracts test cases from documents using LLM
- Validates extracted structure
- Generates embeddings for semantic search

#### Planner Agent
- Selects tests based on agent configuration filters
- Orders tests by priority
- Creates execution plan

#### Environment Agent
- Sets up test environment
- Manages test data
- Handles cleanup

#### Execution Agent (Python)
- Executes test steps using appropriate tools
- Supports Web (Playwright), API (HTTP), Mobile (Appium)
- Captures screenshots and logs

#### Validation Agent
- Validates step results against expected outcomes
- Supports deterministic and fuzzy validation
- Generates validation reports

#### Reporting Agent
- Generates reports in multiple formats (JSON, HTML, JUnit)
- Aggregates test results
- Exports to CI/CD systems

#### Orchestrator Agent
- Coordinates entire test execution workflow
- Manages concurrency
- Handles errors and retries

### 5. Execution Tooling Layer

**Web**: Playwright
- Browser automation
- Screenshot capture
- Network interception

**API**: HTTP Client (Axios/Requests)
- REST API testing
- Authentication support
- Request/response validation

**Mobile**: Appium
- Cross-platform mobile testing
- Gesture support
- Native and hybrid apps

### 6. API Layer

**REST Endpoints**:
- `/api/v1/ingestion/*` - Document upload and extraction
- `/api/v1/agents/*` - Agent management
- `/api/v1/testcases/*` - Test case management
- `/api/v1/runs/*` - Test execution
- `/api/v1/reports/*` - Report generation

## Data Flow

1. **Document Upload** → Parse → Extract Test Cases → Store
2. **Agent Configuration** → Create Agent → Store Config
3. **Test Execution** → Planner selects tests → Execution Agent runs → Validation → Results stored
4. **Reporting** → Aggregate results → Generate reports → Export

## Technology Stack

- **Backend**: Node.js + TypeScript + Express
- **Executor**: Python 3.10+ with Playwright/Appium
- **Database**: PostgreSQL 14+ with pgvector
- **AI**: OpenAI / Azure OpenAI / Anthropic
- **CI/CD**: GitHub Actions

## Security Considerations

- API authentication (JWT/API keys)
- Secure credential storage
- Input validation
- SQL injection prevention (parameterized queries)
- File upload restrictions

## Scalability

- Horizontal scaling via stateless API
- Database connection pooling
- Async test execution
- Parallel test execution support

