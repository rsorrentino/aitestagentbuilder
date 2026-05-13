# Agent Development Guide

## Agent Configuration

Agents are configured via YAML files:

```yaml
agent_name: "MyAgent"
application_type: "web"  # web, api, mobile, hybrid
base_url: "https://staging.myapp.com"
test_selection:
  module: ["Authentication"]
  priority: ["High", "Critical"]
  tags: ["login"]
tools:
  browser: "playwright"
  http: "axios"
reporting:
  formats: ["json", "html"]
environment: "staging"
max_parallel_tests: 5
```

## Creating Custom Agents

### 1. Define Configuration

Create a YAML file in `configs/`:

```yaml
agent_name: "CustomAgent"
application_type: "web"
base_url: "https://example.com"
test_selection:
  module: ["Checkout"]
tools:
  browser: "playwright"
```

### 2. Register Agent

```bash
# Via API
curl -X POST http://localhost:3000/api/v1/agents \
  -H "Content-Type: application/json" \
  -d @configs/custom-agent.yml

# Via CLI
npm run cli -- run --config configs/custom-agent.yml
```

## Test Case Structure

Test cases follow this structure:

```json
{
  "id": "TC-001",
  "title": "User Login",
  "module": "Authentication",
  "steps": [
    {
      "stepId": 1,
      "action": "Navigate to login page",
      "target": "/login"
    },
    {
      "stepId": 2,
      "action": "Enter username",
      "target": "#username",
      "data": {"value": "testuser"}
    }
  ],
  "expectedResults": [
    "User is redirected to dashboard",
    "Welcome message is displayed"
  ],
  "priority": "High"
}
```

## Action Mapping

### Web Actions (Playwright)
- `navigate` / `go to` → Navigate to URL
- `click` → Click element
- `fill` / `enter` / `type` → Fill input field
- `select` → Select dropdown option
- `get text` / `read` → Get element text
- `wait` → Wait for element
- `screenshot` → Capture screenshot

### API Actions (HTTP)
- `get` → GET request
- `post` → POST request
- `put` → PUT request
- `delete` → DELETE request

### Mobile Actions (Appium)
- `click` / `tap` → Tap element
- `fill` / `enter` / `type` → Enter text
- `get text` / `read` → Read element text
- `swipe` → Swipe gesture
- `screenshot` → Capture screenshot

## Validation

Validation happens at two levels:

1. **Step-level**: Each step can have an `expectedResult`
2. **Test-level**: Final `expectedResults` array validates overall outcome

Validation strategies:
- Status code matching
- Text content checking
- URL validation
- Element visibility

## Best Practices

1. **Clear Actions**: Use descriptive action names
2. **Stable Selectors**: Prefer IDs or data-testid attributes
3. **Data Separation**: Keep test data in `data` field
4. **Preconditions**: Document required setup steps
5. **Priority**: Set appropriate priority levels

