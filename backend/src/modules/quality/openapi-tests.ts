/**
 * Test cases from an OpenAPI (3.x) or Swagger (2.0) description.
 *
 * Without AI, every operation that can be called with what the spec provides
 * (examples, defaults, enums) gets a smoke test: request → expected 2xx status
 * → required response fields present. With AI, the model also writes negative
 * and edge cases (missing fields, invalid values, not found, unauthorised).
 */

import { parse as parseYaml } from 'yaml';
import { normalizeTestCaseInput } from '../../core/domain/normalize.js';
import type { TestCaseCreateInput } from '../../core/domain/test-case.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const MAX_SPEC_BYTES = 5 * 1024 * 1024;

export interface Operation {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  tag?: string;
  pathParams: Array<{ name: string; example?: unknown }>;
  queryParams: Array<{ name: string; required: boolean; example?: unknown }>;
  requestBody?: unknown;
  requestBodyRequired: boolean;
  successStatus?: string;
  responseRequired: string[];
  responseIsArray: boolean;
  statuses: string[];
}

/** Parse JSON or YAML text into a spec object. */
export function parseSpec(text: string): any {
  if (Buffer.byteLength(text) > MAX_SPEC_BYTES) throw new Error('The API description is larger than 5 MB');
  let spec: any;
  try {
    spec = text.trim().startsWith('{') ? JSON.parse(text) : parseYaml(text);
  } catch (e: any) {
    throw new Error(`Not valid JSON or YAML: ${e.message}`);
  }
  if (!spec || typeof spec !== 'object' || !spec.paths) throw new Error('Not an OpenAPI / Swagger description (no "paths")');
  if (!spec.openapi && !spec.swagger) throw new Error('Not an OpenAPI / Swagger description (no "openapi" or "swagger" version)');
  return spec;
}

/** Download a spec (http/https only, 5 MB, 20 s). */
export async function fetchSpec(url: string): Promise<any> {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('The API description URL must be http(s)');
  const res = await fetch(u, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json, application/yaml, text/yaml, */*' } });
  if (!res.ok) throw new Error(`Could not download the API description: HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_SPEC_BYTES) throw new Error('The API description is larger than 5 MB');
  return parseSpec(await res.text());
}

/** Follow a local "$ref" ("#/components/schemas/Order"), at most a few levels. */
function deref(spec: any, node: any, depth = 0): any {
  if (!node || typeof node !== 'object' || depth > 10) return node;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    const target = node.$ref.slice(2).split('/').reduce((acc: any, key: string) => acc?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
    return deref(spec, target, depth + 1);
  }
  return node;
}

/** An example value for a schema: its example / default / first enum, else a typed placeholder. */
export function sampleFor(spec: any, schemaIn: any, depth = 0): unknown {
  const schema = deref(spec, schemaIn);
  if (!schema || depth > 5) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (Array.isArray(schema.allOf)) return Object.assign({}, ...schema.allOf.map((s: any) => sampleFor(spec, s, depth + 1) ?? {}));
  if (Array.isArray(schema.oneOf ?? schema.anyOf)) return sampleFor(spec, (schema.oneOf ?? schema.anyOf)[0], depth + 1);
  switch (schema.type ?? (schema.properties ? 'object' : undefined)) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const required: string[] = schema.required ?? [];
      for (const [name, prop] of Object.entries<any>(schema.properties ?? {})) {
        if (!required.includes(name) && deref(spec, prop)?.example === undefined) continue;
        const v = sampleFor(spec, prop, depth + 1);
        if (v !== undefined) out[name] = v;
      }
      return out;
    }
    case 'array': return [sampleFor(spec, schema.items, depth + 1)].filter((v) => v !== undefined);
    case 'integer': return schema.minimum ?? 1;
    case 'number': return schema.minimum ?? 1.5;
    case 'boolean': return true;
    case 'string':
      if (schema.format === 'email') return 'qa@example.com';
      if (schema.format === 'date') return '2026-01-15';
      if (schema.format === 'date-time') return '2026-01-15T10:00:00Z';
      if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000001';
      return schema.minLength ? 'x'.repeat(schema.minLength) : 'test';
    default: return undefined;
  }
}

function paramExample(spec: any, p: any): unknown {
  if (p.example !== undefined) return p.example;
  const ex = p.examples && Object.values<any>(p.examples)[0];
  if (ex?.value !== undefined) return ex.value;
  const schema = deref(spec, p.schema ?? p);
  if (schema?.example !== undefined) return schema.example;
  if (schema?.default !== undefined) return schema.default;
  if (Array.isArray(schema?.enum) && schema.enum.length) return schema.enum[0];
  return undefined;
}

export function listOperations(spec: any): Operation[] {
  const ops: Operation[] = [];
  for (const [path, itemIn] of Object.entries<any>(spec.paths ?? {})) {
    const item = deref(spec, itemIn) ?? {};
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p: any) => deref(spec, p)).filter(Boolean);
      // Request body: OpenAPI 3 requestBody, or Swagger 2 "in: body" parameter
      const rb = deref(spec, op.requestBody);
      const json = rb?.content?.['application/json'] ?? rb?.content?.[Object.keys(rb?.content ?? {})[0]];
      const swaggerBody = params.find((p: any) => p.in === 'body');
      let requestBody: unknown;
      if (json) {
        const named = json.examples && Object.values<any>(json.examples)[0];
        requestBody = json.example ?? deref(spec, named)?.value ?? sampleFor(spec, json.schema);
      } else if (swaggerBody) {
        requestBody = sampleFor(spec, swaggerBody.schema);
      }
      const statuses = Object.keys(op.responses ?? {});
      const success = statuses.find((s) => /^2\d\d$/.test(s)) ?? (statuses.includes('2XX') ? '2xx' : undefined);
      const resp = success ? deref(spec, op.responses[success]) : undefined;
      const respSchema = deref(spec, resp?.content?.['application/json']?.schema ?? resp?.schema);
      ops.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId,
        summary: op.summary ?? op.description?.split('\n')[0],
        tag: op.tags?.[0],
        pathParams: params.filter((p: any) => p.in === 'path').map((p: any) => ({ name: p.name, example: paramExample(spec, p) })),
        queryParams: params.filter((p: any) => p.in === 'query').map((p: any) => ({ name: p.name, required: !!p.required, example: paramExample(spec, p) })),
        requestBody,
        requestBodyRequired: !!(rb?.required || swaggerBody?.required),
        successStatus: success,
        responseRequired: respSchema?.type === 'array' ? [] : (respSchema?.required ?? []).slice(0, 5),
        responseIsArray: respSchema?.type === 'array',
        statuses,
      });
    }
  }
  return ops;
}

export const operationKey = (op: Pick<Operation, 'method' | 'path'>) => `${op.method} ${op.path}`;

/**
 * Path prefix every operation is under: OpenAPI 3 relative server URL ("/api/v1") or Swagger 2 basePath.
 * An absolute server URL is not a prefix: point the agent's API base URL at it instead.
 */
export function basePathOf(spec: any): string {
  const raw = spec.swagger ? spec.basePath : spec.servers?.[0]?.url;
  if (typeof raw !== 'string' || !raw.startsWith('/')) return '';
  return raw.replace(/\/+$/, '');
}

/** Smoke test for one operation, or the reason it cannot be generated without more information. */
export function smokeTest(op: Operation, basePath = ''): { test?: TestCaseCreateInput; skipped?: string } {
  let path = `${basePath}${op.path}`;
  for (const p of op.pathParams) {
    if (p.example === undefined) return { skipped: `no example value for path parameter "${p.name}"` };
    path = path.replace(`{${p.name}}`, encodeURIComponent(String(p.example)));
  }
  const query: Record<string, unknown> = {};
  for (const q of op.queryParams.filter((x) => x.required)) {
    if (q.example === undefined) return { skipped: `no example value for required query parameter "${q.name}"` };
    query[q.name] = q.example;
  }
  if (op.requestBodyRequired && op.requestBody === undefined) return { skipped: 'no example or schema for the request body' };

  const steps: any[] = [{
    action: 'http_request',
    target: path.replace(/^\//, ''),
    data: {
      method: op.method,
      ...(Object.keys(query).length ? { query } : {}),
      ...(op.requestBody !== undefined && op.method !== 'GET' ? { json: op.requestBody } : {}),
    },
  }];
  steps.push({ action: 'assert_status', data: { value: op.successStatus ?? '2xx' } });
  if (op.responseIsArray) steps.push({ action: 'assert_json', data: { path: '$', type: 'array' } });
  for (const field of op.responseRequired) steps.push({ action: 'assert_json', data: { path: `$.${field}` } });

  const test = normalizeTestCaseInput({
    title: `${operationKey(op)}${op.summary ? ` — ${op.summary}` : ''}`.slice(0, 200),
    module: op.tag ?? 'API',
    priority: op.method === 'GET' ? 'Medium' : 'High',
    type: 'Smoke',
    steps,
    expectedResults: [`${op.method} ${op.path} answers ${op.successStatus ?? '2xx'}${op.responseRequired.length ? ` with ${op.responseRequired.join(', ')}` : ''}`],
  }, { tags: ['api', 'openapi'] });
  return test ? { test } : { skipped: 'could not build a test' };
}

/** Compact description of the operations for the AI. */
export function describeOperations(ops: Operation[]): string {
  return ops.map((op) => {
    const lines = [`${operationKey(op)}${op.summary ? ` — ${op.summary}` : ''}`];
    if (op.pathParams.length) lines.push(`  path params: ${op.pathParams.map((p) => `${p.name}${p.example !== undefined ? `=${JSON.stringify(p.example)}` : ''}`).join(', ')}`);
    if (op.queryParams.length) lines.push(`  query: ${op.queryParams.map((p) => `${p.name}${p.required ? '*' : ''}${p.example !== undefined ? `=${JSON.stringify(p.example)}` : ''}`).join(', ')}`);
    if (op.requestBody !== undefined) lines.push(`  body example: ${JSON.stringify(op.requestBody).slice(0, 400)}`);
    lines.push(`  responses: ${op.statuses.join(', ')}${op.responseRequired.length ? `; success has ${op.responseRequired.join(', ')}` : ''}`);
    return lines.join('\n');
  }).join('\n');
}

export const API_STEPS_DOC =
  'Steps (JSON objects with "action", optional "target", optional "data"):\n'
  + '- {"action":"http_request","target":"orders/42","data":{"method":"POST","json":{...},"query":{...},"headers":{...},"extract":{"orderId":"$.id"}}} '
  + '(target is a path relative to the API base URL; extracted values are used later as {{vars.orderId}})\n'
  + '- {"action":"assert_status","data":{"value":201}} (or "4xx")\n'
  + '- {"action":"assert_json","data":{"path":"$.items[0].name","equals":"…"}} (or contains / matches / exists:false / type / length)\n'
  + '- {"action":"assert_header","target":"content-type","data":{"value":"json"}}\n'
  + '- {"action":"assert_response_time","data":{"value":2000}}';

/** AI-written tests (positive, negative, edge cases) for the operations. */
export async function aiApiTests(spec: any, ops: Operation[], count: number, preferred?: string): Promise<{ tests: TestCaseCreateInput[]; provider: string }> {
  const { getLLMRouter } = await import('../../infra/llm/router.js');
  const { extractJsonArray } = await import('../../infra/llm/json.js');
  const title = spec.info?.title ? `API: ${spec.info.title}${spec.info.version ? ` ${spec.info.version}` : ''}\n` : '';
  const response = await getLLMRouter().chat([
    {
      role: 'system',
      content: 'You are a senior API test engineer. Write executable API test cases as a JSON array of objects with '
        + 'title, module, priority (Low|Medium|High|Critical), type, steps, expectedResults. Cover success, validation errors, '
        + 'not found and unauthorised cases where the API description supports them. Only use the documented operations.\n\n'
        + API_STEPS_DOC,
    },
    { role: 'user', content: `${title}Write up to ${count} test cases for these operations:\n\n${describeOperations(ops).slice(0, 60_000)}` },
  ], 'codegen', { preferred, maxTokens: 4000 });
  const tests = extractJsonArray(response.content)
    .map((item) => normalizeTestCaseInput(item, { tags: ['api', 'openapi', 'ai-generated'] }))
    .filter((t): t is TestCaseCreateInput => t !== null && t.steps.length > 0)
    .slice(0, count);
  return { tests, provider: response.provider };
}
