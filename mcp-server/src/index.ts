/**
 * MCP server for AI Test Agent Builder.
 *
 * Lets AI assistants and coding agents (Claude Code, GitHub Copilot, Cursor…)
 * write test cases, run them in a real browser, wait for the verdict and read
 * the evidence of failures — e.g. to check their own change before calling it done.
 *
 * Environment:
 *   ATAB_API_URL (or API_URL)  default http://localhost:3000/api/v1
 *   ATAB_API_KEY               project API key (Account → API keys), sent as "Authorization: ApiKey …"
 *   ATAB_TOKEN                 alternatively a JWT from POST /auth/login
 *   ATAB_PROJECT               project id (default: the API key's project, or "default")
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';
import dotenv from 'dotenv';
import { basename } from 'path';

dotenv.config();

export const API_URL = (process.env.ATAB_API_URL || process.env.API_URL || 'http://localhost:3000/api/v1').replace(/\/+$/, '');
const BACKEND_URL = API_URL.replace(/\/api\/v\d+$/, '');

export function createApiClient(env: NodeJS.ProcessEnv = process.env): AxiosInstance {
  const headers: Record<string, string> = {};
  if (env.ATAB_API_KEY) headers.Authorization = `ApiKey ${env.ATAB_API_KEY}`;
  else if (env.ATAB_TOKEN) headers.Authorization = `Bearer ${env.ATAB_TOKEN}`;
  if (env.ATAB_PROJECT) headers['X-Project-Id'] = env.ATAB_PROJECT;
  return axios.create({ baseURL: (env.ATAB_API_URL || env.API_URL || API_URL).replace(/\/+$/, ''), headers, timeout: 15 * 60_000 });
}

/** A readable message for API errors (the API answers { error }). */
function apiError(error: any): string {
  const status = error?.response?.status;
  const message = error?.response?.data?.error ?? error?.message ?? String(error);
  if (status === 401) return `${message} — set ATAB_API_KEY (Account → API keys) for the MCP server`;
  if (status === 403) return `${message} — the API key's role does not allow this`;
  return status ? `HTTP ${status}: ${message}` : message;
}

const artifactUrl = (path?: string) => (path ? `${BACKEND_URL}/artifacts/${path}` : undefined);

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/** Compact description of a failed result: what failed and the evidence to look at. */
export function summarizeFailure(r: any) {
  const steps: any[] = r.metadata?.steps ?? [];
  const failedStep = steps.find((s) => s.status === 'failed');
  return {
    resultId: r.id,
    testCaseId: r.testCaseId,
    title: r.metadata?.title,
    persona: r.metadata?.persona,
    status: r.status,
    // Known flaky: its failure does not fail the run
    quarantined: r.metadata?.quarantined === true || undefined,
    error: r.error,
    failedStep: failedStep ? { stepId: failedStep.stepId, action: failedStep.action, target: failedStep.target, message: failedStep.message } : undefined,
    evidence: {
      screenshots: (r.evidence?.screenshots ?? []).map(artifactUrl),
      trace: artifactUrl(r.evidence?.trace),
      video: artifactUrl(r.evidence?.video),
    },
    accessibility: (r.metadata?.accessibility ?? []).flatMap((a: any) =>
      a.violations.filter((v: any) => v.counted).map((v: any) => ({ rule: v.id, impact: v.impact, help: v.help, elements: v.targets, url: a.url }))),
    visual: (r.metadata?.visual ?? []).filter((v: any) => v.status === 'failed').map((v: any) => ({
      name: v.name, changedPixels: v.diffPixels, ratio: v.ratio, baseline: artifactUrl(v.baseline), actual: artifactUrl(v.actual), diff: artifactUrl(v.diff),
    })),
    healedSelectors: r.metadata?.healing?.steps,
    pageSpeed: (r.metadata?.performance ?? []).filter((p: any) => !p.passed).map((p: any) => ({ page: p.page, metrics: p.metrics, violations: p.violations })),
  };
}

/** Latest attempt of each test (and persona) in a run. */
function finalResults(results: any[] = []): any[] {
  const map = new Map<string, any>();
  for (const r of results) {
    const key = `${r.testCaseId}@${r.metadata?.persona ?? ''}#${r.metadata?.dataRow ?? ''}`;
    const prev = map.get(key);
    if (!prev || new Date(r.startedAt) >= new Date(prev.startedAt)) map.set(key, r);
  }
  return [...map.values()];
}

export function runSummary(run: any) {
  const results = finalResults(run.results);
  return {
    runId: run.id,
    status: run.status,
    passed: run.status === 'completed',
    totals: { tests: run.totalTests, passed: run.passedTests, failed: run.failedTests, skipped: run.skippedTests },
    failures: results.filter((r) => ['failed', 'error', 'timeout'].includes(r.status)).map(summarizeFailure),
    // Failures grouped by cause: app bug / test bug / environment, new or seen before
    ...(run.metadata?.triage ? {
      triage: {
        summary: run.metadata.triage.summary,
        groups: run.metadata.triage.groups.map((g: any) => ({
          category: g.category, tests: g.tests.map((t: any) => t.title), error: g.sample?.error,
          cause: g.cause ?? g.reason, suggestion: g.suggestion, seenBefore: g.seenBefore,
        })),
      },
    } : {}),
  };
}

export const TOOLS = [
  {
    name: 'list_agents',
    description: 'List the test agents (applications under test) of the project, with their base URL.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'plan_tests',
    description: 'Show which test cases a run of an agent would execute, or search test cases by module/priority/tags.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent whose next run to preview' },
        module: { type: 'string' },
        priority: { type: 'string', enum: ['Low', 'Medium', 'High', 'Critical'] },
        tags: { type: 'array', items: { type: 'string' } },
        testIds: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'create_test_case',
    description:
      'Create a test case. Steps use actions such as navigate, click, fill, select, assert_text, assert_visible, assert_url, ' +
      'assert_accessible (axe-core WCAG scan), assert_screenshot (visual regression), salesforce_login, and API steps: ' +
      'http_request (target path, data { method, json, extract: { id: "$.id" } } → later {{vars.id}}), assert_status, assert_json ' +
      '({ path, equals | contains | exists }), mock_route / block_route (stub calls during UI tests), ' +
      'assert_ai (data.value: an expectation in plain language, judged by the AI from the page text). ' +
      'assert_performance (page speed: target optional page to load; data budgets { lcp, fcp, cls, tbt, ttfb, load, transfer_kb, max_regression }). ' +
      'Values may use {{data.column}} (row of the data set named in the test case data.dataset: the test runs once per row), ' +
      '{{fake.email}} / {{fake.email:label}} (fictitious values, the same within a test for the same label) and {{secrets.NAME}}. ' +
      'Targets are CSS selectors, text=…, or plain labels ("Sign in button"); data.value holds text to type or expect.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        module: { type: 'string' },
        priority: { type: 'string', enum: ['Low', 'Medium', 'High', 'Critical'] },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: { action: { type: 'string' }, target: { type: 'string' }, data: { type: 'object' } },
            required: ['action'],
          },
        },
        expectedResults: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
        personas: { type: 'array', items: { type: 'string' }, description: 'Salesforce personas to run the test as' },
        dataset: { type: 'string', description: 'Name of a test data set: the test runs once per row, steps use {{data.column}}' },
      },
      required: ['title', 'module', 'steps'],
    },
  },
  {
    name: 'run_tests',
    description:
      'Run an agent\'s tests in a real browser. By default waits for the result and returns pass/fail with, for each failure, ' +
      'the failed step, error, screenshots, trace/video links, accessibility violations, visual differences and healed selectors.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        testIds: { type: 'array', items: { type: 'string' }, description: 'Only these test cases (default: the agent\'s selection)' },
        wait: { type: 'boolean', description: 'Wait for the result (default true)' },
        timeoutSeconds: { type: 'number', description: 'Maximum wait (default 600)' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'start_test_run',
    description: 'Start a run without waiting (use get_run_status / get_failures afterwards).',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string' }, testIds: { type: 'array', items: { type: 'string' } } },
      required: ['agentId'],
    },
  },
  {
    name: 'get_run_status',
    description: 'Status and counts of a run.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
  },
  {
    name: 'get_failures',
    description: 'Failed tests of a run with their evidence (screenshots, trace, video, accessibility, visual diffs, healed selectors) and the triage: failures grouped as app bug, test bug or environment, new or seen before.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
  },
  {
    name: 'apply_healing',
    description: 'Write the selectors the AI repaired during a run back into the test case.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' }, resultId: { type: 'string' }, stepIds: { type: 'array', items: { type: 'number' } } },
      required: ['runId', 'resultId'],
    },
  },
  {
    name: 'generate_test_data',
    description: 'Generate a test data set: with Faker from column kinds (fields: { "email": "email", "name": "fullName" }) or with the AI ' +
      'from a description (prompt, e.g. "signup data with edge cases"). Give a name to save it; tests then use it with dataset: name.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: { type: 'object', additionalProperties: { type: 'string' }, description: 'column → kind (firstName, lastName, fullName, email, phone, company, street, city, zip, country, iban, testCard, uuid, unique, number, amount, date, pastDate, birthdate, word, sentence, url, …)' },
        prompt: { type: 'string', description: 'What the AI should generate (instead of or with fields)' },
        count: { type: 'number', description: 'Rows, 1–100 (default 10)' },
        locale: { type: 'string', description: 'e.g. en, it, de, fr, es, pt_BR' },
        name: { type: 'string', description: 'Save as a data set with this name' },
      },
    },
  },
  {
    name: 'ingest_test_book',
    description: 'Upload a test specification (PDF, Word, Excel, Markdown, HTML, text) and let the AI extract test cases from it.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path of the file on this machine' },
        extractTestCases: { type: 'boolean', description: 'Extract test cases after the upload (default true)' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'run_api_check',
    description: 'Send one HTTP request from this machine and compare status and body with what is expected.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        url: { type: 'string', description: 'Full URL or path' },
        baseUrl: { type: 'string', description: 'Base URL when url is a path' },
        headers: { type: 'object' },
        body: {},
        expectedStatus: { type: 'number' },
        expectedBody: { description: 'Expected JSON body (exact match)' },
      },
      required: ['method', 'url'],
    },
  },
  {
    name: 'generate_report',
    description: 'Generate HTML / JUnit / JSON reports of a run.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' }, formats: { type: 'array', items: { type: 'string', enum: ['json', 'html', 'junit'] } } },
      required: ['runId'],
    },
  },
];

export class TestAgentMCPServer {
  private server: Server;

  constructor(private api: AxiosInstance = createApiClient()) {
    this.server = new Server({ name: 'ai-test-agent-builder', version: '1.1.0' }, { capabilities: { tools: {} } });
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params as { name: string; arguments?: any };
      const handler = (this.handlers as Record<string, (a: any) => Promise<any>>)[name];
      if (!handler) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      try {
        return text(await handler.call(this, args));
      } catch (error: any) {
        return { ...text({ isError: true, error: apiError(error) }), isError: true };
      }
    });
  }

  private handlers = {
    list_agents: async () => {
      const { data } = await this.api.get('/agents');
      return data.map((a: any) => ({ id: a.id, name: a.name, baseUrl: a.config?.base_url, status: a.status }));
    },

    plan_tests: async (args: { agentId?: string; module?: string; priority?: string; tags?: string[]; testIds?: string[] }) => {
      if (args.agentId) {
        const { data } = await this.api.get(`/agents/${encodeURIComponent(args.agentId)}/plan`);
        return { strategy: data.strategy, count: data.count, testCases: data.testCases.map((tc: any) => ({ id: tc.id, title: tc.title, module: tc.module, priority: tc.priority })) };
      }
      const params: Record<string, string> = {};
      if (args.module) params.module = args.module;
      if (args.priority) params.priority = args.priority;
      if (args.tags?.length) params.tags = args.tags.join(',');
      const { data } = await this.api.get('/testcases', { params });
      const list = args.testIds?.length ? data.filter((tc: any) => args.testIds!.includes(tc.id)) : data;
      return { count: list.length, testCases: list.map((tc: any) => ({ id: tc.id, title: tc.title, module: tc.module, priority: tc.priority })) };
    },

    create_test_case: async (args: any) => {
      const { personas, dataset, ...rest } = args;
      const extra = { ...(personas?.length ? { personas } : {}), ...(dataset ? { dataset } : {}) };
      const { data } = await this.api.post('/testcases', {
        priority: 'Medium',
        expectedResults: [],
        ...rest,
        ...(Object.keys(extra).length ? { data: extra } : {}),
      });
      return { id: data.id, title: data.title, steps: data.steps.length };
    },

    run_tests: async (args: { agentId: string; testIds?: string[]; wait?: boolean; timeoutSeconds?: number }) => {
      const wait = args.wait !== false;
      const { data } = await this.api.post('/runs', {
        agentId: args.agentId,
        ...(args.testIds?.length ? { testIds: args.testIds } : {}),
        ...(wait ? { wait: true, timeoutSeconds: Math.min(Math.max(Number(args.timeoutSeconds) || 600, 10), 3600) } : {}),
        metadata: { triggeredBy: 'mcp' },
      });
      if (!wait) return { runId: data.id, status: data.status };
      if (data.timedOut) return { runId: data.id, status: data.status, timedOut: true, message: 'Still running: call get_run_status / get_failures later' };
      const { data: run } = await this.api.get(`/runs/${data.id}`);
      return runSummary(run);
    },

    start_test_run: async (args: { agentId: string; testIds?: string[] }) => this.handlers.run_tests({ ...args, wait: false }),

    get_run_status: async (args: { runId: string }) => {
      const { data } = await this.api.get(`/runs/${encodeURIComponent(args.runId)}`);
      const { failures, ...summary } = runSummary(data);
      return { ...summary, failedTests: failures.map((f) => f.title), startedAt: data.startedAt, finishedAt: data.finishedAt };
    },

    get_failures: async (args: { runId: string }) => {
      const { data } = await this.api.get(`/runs/${encodeURIComponent(args.runId)}`);
      return runSummary(data);
    },

    apply_healing: async (args: { runId: string; resultId: string; stepIds?: number[] }) => {
      const { data } = await this.api.post(`/runs/${encodeURIComponent(args.runId)}/results/${encodeURIComponent(args.resultId)}/apply-healing`,
        args.stepIds?.length ? { stepIds: args.stepIds } : {});
      return data;
    },

    generate_test_data: async (args: { fields?: Record<string, string>; prompt?: string; count?: number; locale?: string; name?: string }) => {
      const { data } = await this.api.post('/testdata/generate', { ...args, ...(args.name ? { save: true } : {}) });
      return {
        source: data.source,
        rows: data.rows.slice(0, 20),
        ...(data.rows.length > 20 ? { moreRows: data.rows.length - 20 } : {}),
        ...(data.saved ? { saved: { id: data.saved.id, name: data.saved.name }, usage: `Set dataset: "${data.saved.name}" on a test case; steps use {{data.<column>}}` } : {}),
      };
    },

    ingest_test_book: async (args: { filePath: string; extractTestCases?: boolean }) => {
      const { readFileSync } = await import('fs');
      const FormData = (await import('form-data')).default;
      const form = new FormData();
      form.append('file', readFileSync(args.filePath), { filename: basename(args.filePath) });
      const { data: doc } = await this.api.post('/ingestion/upload', form, { headers: form.getHeaders() });
      if (args.extractTestCases === false) return { documentId: doc.id };
      const { data } = await this.api.post(`/ingestion/documents/${doc.id}/extract`, {});
      return { documentId: doc.id, extracted: data.extracted ?? data.testCases?.length ?? 0, testCases: (data.testCases ?? []).map((tc: any) => ({ id: tc.id, title: tc.title })) };
    },

    run_api_check: async (args: { method: string; url: string; baseUrl?: string; headers?: Record<string, string>; body?: any; expectedStatus?: number; expectedBody?: any }) => {
      const url = /^https?:\/\//i.test(args.url) ? args.url : `${args.baseUrl ?? ''}${args.url}`;
      const res = await axios.request({ method: args.method as any, url, headers: args.headers ?? {}, data: args.body, validateStatus: () => true, timeout: 60_000 });
      const statusOk = args.expectedStatus === undefined || res.status === args.expectedStatus;
      const bodyOk = args.expectedBody === undefined || JSON.stringify(res.data) === JSON.stringify(args.expectedBody);
      return { passed: statusOk && bodyOk, status: res.status, body: res.data, expectedStatus: args.expectedStatus, bodyMatches: bodyOk };
    },

    generate_report: async (args: { runId: string; formats?: string[] }) => {
      const { data } = await this.api.post(`/reports/runs/${encodeURIComponent(args.runId)}/generate`, {
        formats: args.formats ?? ['json', 'html'], includeScreenshots: true, includeLogs: true,
      });
      return data;
    },
  };

  async run(): Promise<void> {
    await this.server.connect(new StdioServerTransport());
    console.error(`AI Test Agent Builder MCP server running on stdio (API ${API_URL})`);
  }
}

const isMain = process.argv[1] && /index\.(ts|js)$/.test(process.argv[1]) && !process.env.ATAB_MCP_NO_START;
if (isMain) {
  new TestAgentMCPServer().run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
