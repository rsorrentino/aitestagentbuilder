# API Documentation

## Base URL

```
http://localhost:3000/api/v1
```

## Authentication

Currently, authentication is optional. In production, use API keys or JWT tokens.

## Endpoints

### Ingestion

#### Upload Document
```http
POST /ingestion/upload
Content-Type: multipart/form-data

file: <file>
```

**Response**:
```json
{
  "id": "DOC-123",
  "name": "test-book.pdf",
  "sourceType": "pdf",
  "uploadedAt": "2024-01-01T00:00:00Z"
}
```

#### Extract Test Cases
```http
POST /ingestion/documents/:documentId/extract
```

**Query Parameters**:
- `module` (optional): Filter by module
- `priority` (optional): Filter by priority

**Response**:
```json
{
  "documentId": "DOC-123",
  "extracted": 10,
  "testCases": [...],
  "metadata": {...}
}
```

### Agents

#### Create Agent
```http
POST /agents
Content-Type: application/json

{
  "name": "LoginTester",
  "config": {
    "agent_name": "LoginTester",
    "application_type": "web",
    "base_url": "https://staging.myapp.com",
    "test_selection": {...},
    "tools": {...},
    "reporting": {...}
  }
}
```

#### List Agents
```http
GET /agents?limit=100&offset=0
```

#### Get Agent
```http
GET /agents/:id
```

#### Update Agent
```http
PUT /agents/:id
Content-Type: application/json

{
  "name": "UpdatedName",
  "config": {...}
}
```

#### Delete Agent
```http
DELETE /agents/:id
```

### Test Cases

#### Create Test Case
```http
POST /testcases
Content-Type: application/json

{
  "title": "User Login",
  "module": "Authentication",
  "steps": [...],
  "expectedResults": [...],
  "priority": "High"
}
```

#### List Test Cases
```http
GET /testcases?module=Auth&priority=High&limit=100&offset=0
```

#### Get Test Case
```http
GET /testcases/:id
```

#### Update Test Case
```http
PUT /testcases/:id
```

#### Delete Test Case
```http
DELETE /testcases/:id
```

### Test Runs

#### Start Run
```http
POST /runs
Content-Type: application/json

{
  "agentId": "AGENT-123",
  "metadata": {
    "environment": "staging",
    "branch": "main"
  }
}
```

#### Get Run Status
```http
GET /runs/:id
```

#### List Runs
```http
GET /runs?agentId=AGENT-123&limit=50
```

#### Cancel Run
```http
POST /runs/:id/cancel
```

### Reports

#### Generate Report
```http
POST /reports/runs/:runId/generate
Content-Type: application/json

{
  "formats": ["json", "html", "junit"],
  "includeScreenshots": true,
  "includeLogs": true,
  "outputPath": "./reports"
}
```

## Error Responses

All errors follow this format:

```json
{
  "error": "Error message"
}
```

**Status Codes**:
- `200` - Success
- `201` - Created
- `400` - Bad Request
- `404` - Not Found
- `500` - Internal Server Error

