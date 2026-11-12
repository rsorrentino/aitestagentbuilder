/**
 * Mock APIs (service virtualization): stand-ins for services that do not exist yet, are not
 * reachable from the test environment, or must answer in a particular way.
 *
 * A mock service answers at /mocks/<slug>/… with
 *   1. one-off answers set by a running test (step mock_service_respond: "the next POST /payments
 *      returns 402"),
 *   2. its fixed routes ({ method, path, status, body, headers, delay_ms }; paths like /orders/{id} or /files/*),
 *   3. its OpenAPI description: the documented example of the operation's success response, else a
 *      value generated from the schema.
 * Every request is recorded, so tests can check what the application sent (assert_mock_service_called).
 */

import crypto from 'crypto';
import getDatabaseClient from '../../infra/db/client.js';
import { basePathOf, deref, listOperations, parseSpec, sampleFor } from '../quality/openapi-tests.js';

export interface MockRoute { method: string; path: string; status?: number; body?: any; headers?: Record<string, string>; delay_ms?: number }
export interface MockService { id: string; projectId: string; name: string; slug: string; spec?: any; routes: MockRoute[]; createdAt: string; createdBy?: string }
export interface RecordedCall { at: string; method: string; path: string; query: Record<string, string>; body?: any; status: number; source: 'test' | 'route' | 'spec' | 'none' }
export interface MockAnswer { status: number; body?: any; headers: Record<string, string>; delayMs: number; source: RecordedCall['source'] }

const METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|\*)$/;

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

/** "/orders/{id}" or "/files/*" → a regular expression for request paths. */
export function pathRegex(template: string): RegExp {
  const parts = template.replace(/\/+$/, '').split(/(\{[^}]+\}|\*)/).map((p) => (p === '*' ? '.*' : /^\{[^}]+\}$/.test(p) ? '[^/]+' : p.replace(/[.+?^$()|[\]\\]/g, '\\$&')));
  return new RegExp(`^${parts.join('') || ''}/?$`);
}

const routeMatches = (r: Pick<MockRoute, 'method' | 'path'>, method: string, path: string) =>
  (r.method === '*' || r.method.toUpperCase() === method.toUpperCase()) && pathRegex(r.path).test(path);

/** The answer the spec documents for a request (pure): the success response's example, else a sample of its schema. */
export function answerFromSpec(spec: any, method: string, path: string): MockAnswer | null {
  const base = basePathOf(spec);
  const p = base && path.startsWith(base) ? path.slice(base.length) || '/' : path;
  const op = listOperations(spec).find((o) => o.method === method.toUpperCase() && pathRegex(o.path).test(p));
  if (!op) return null;
  const raw = deref(spec, spec.paths?.[op.path])?.[op.method.toLowerCase()];
  const status = op.successStatus && /^\d{3}$/.test(op.successStatus) ? op.successStatus : '200';
  const resp = deref(spec, raw?.responses?.[status] ?? raw?.responses?.[op.successStatus ?? ''] ?? {});
  const json = resp?.content?.['application/json'] ?? resp?.content?.[Object.keys(resp?.content ?? {})[0]];
  const named = json?.examples && Object.values<any>(json.examples)[0];
  const schema = json?.schema ?? resp?.schema;
  const body = json?.example ?? deref(spec, named)?.value ?? resp?.examples?.['application/json'] ?? (schema ? sampleFor(spec, schema) : undefined);
  return { status: Number(status), ...(body !== undefined ? { body } : {}), headers: {}, delayMs: 0, source: 'spec' };
}

export function validateMockService(input: any, partial = false): string[] {
  const errors: string[] = [];
  if (!partial || input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) errors.push('name is required (up to 100 characters)');
  }
  if (input.routes !== undefined) {
    if (!Array.isArray(input.routes)) errors.push('routes must be a list of { method, path, status, body }');
    else input.routes.forEach((r: any, i: number) => {
      if (!r || !METHOD_RE.test(String(r.method ?? '').toUpperCase())) errors.push(`routes[${i}].method must be GET, POST, PUT, PATCH, DELETE or *`);
      if (typeof r?.path !== 'string' || !r.path.startsWith('/')) errors.push(`routes[${i}].path must start with / (e.g. /orders/{id})`);
      if (r?.status !== undefined && !(Number.isInteger(r.status) && r.status >= 100 && r.status <= 599)) errors.push(`routes[${i}].status must be an HTTP status`);
      if (r?.delay_ms !== undefined && !(Number(r.delay_ms) >= 0 && Number(r.delay_ms) <= 10_000)) errors.push(`routes[${i}].delay_ms must be 0–10000`);
    });
  }
  return errors;
}

/** OpenAPI / Swagger as an object (parsed from JSON or YAML text when needed). */
export function readSpec(spec: any): any {
  const s = typeof spec === 'string' ? parseSpec(spec) : spec;
  if (!s || typeof s !== 'object' || !(s.openapi || s.swagger) || !s.paths) throw new Error('spec must be an OpenAPI 3 or Swagger 2 description with paths');
  return s;
}

// ── runtime state (this server): one-off answers and recorded calls ──────────

interface OneOff extends MockRoute { remaining: number; expires: number }
const oneOffs = new Map<string, OneOff[]>();
const calls = new Map<string, RecordedCall[]>();
const MAX_CALLS = 200;

export const MockState = {
  /** The next `times` matching requests get this answer (10 minutes at most). */
  respond(serviceId: string, rule: MockRoute & { times?: number }): void {
    const list = (oneOffs.get(serviceId) ?? []).filter((o) => o.remaining > 0 && o.expires > Date.now());
    list.unshift({ ...rule, method: String(rule.method ?? '*').toUpperCase(), remaining: Math.max(1, Math.min(Number(rule.times ?? 1) || 1, 1000)), expires: Date.now() + 10 * 60_000 });
    oneOffs.set(serviceId, list);
  },
  take(serviceId: string, method: string, path: string): OneOff | undefined {
    const list = oneOffs.get(serviceId) ?? [];
    const hit = list.find((o) => o.remaining > 0 && o.expires > Date.now() && routeMatches(o, method, path));
    if (hit) hit.remaining--;
    return hit;
  },
  record(serviceId: string, call: RecordedCall): void {
    const list = calls.get(serviceId) ?? [];
    list.push(call);
    if (list.length > MAX_CALLS) list.splice(0, list.length - MAX_CALLS);
    calls.set(serviceId, list);
  },
  calls(serviceId: string, since?: Date): RecordedCall[] {
    return (calls.get(serviceId) ?? []).filter((c) => !since || new Date(c.at) >= since);
  },
  clear(serviceId: string): void {
    oneOffs.delete(serviceId);
    calls.delete(serviceId);
  },
};

/** What a mock service answers to a request: one-off answers, then fixed routes, then the spec. */
export function answer(service: Pick<MockService, 'id' | 'spec' | 'routes'>, method: string, path: string): MockAnswer {
  const oneOff = MockState.take(service.id, method, path);
  if (oneOff) return { status: oneOff.status ?? 200, body: oneOff.body, headers: oneOff.headers ?? {}, delayMs: Number(oneOff.delay_ms ?? 0), source: 'test' };
  const route = service.routes.find((r) => routeMatches(r, method, path));
  if (route) return { status: route.status ?? 200, body: route.body, headers: route.headers ?? {}, delayMs: Number(route.delay_ms ?? 0), source: 'route' };
  const fromSpec = service.spec ? answerFromSpec(service.spec, method, path) : null;
  if (fromSpec) return fromSpec;
  return { status: 404, body: { error: `No mocked answer for ${method} ${path}` }, headers: {}, delayMs: 0, source: 'none' };
}

// ── storage ───────────────────────────────────────────────────────────────────

export class MockServiceRepository {
  private db = getDatabaseClient();

  private map(r: any): MockService {
    return { id: r.id, projectId: r.project_id, name: r.name, slug: r.slug, spec: r.spec ?? undefined, routes: r.routes ?? [], createdAt: r.created_at, createdBy: r.created_by ?? undefined };
  }

  async list(projectId: string): Promise<MockService[]> {
    return (await this.db.query('SELECT * FROM mock_services WHERE project_id = $1 ORDER BY lower(name)', [projectId])).rows.map((r) => this.map(r));
  }

  async get(id: string, projectId: string): Promise<MockService | null> {
    const r = (await this.db.query('SELECT * FROM mock_services WHERE id = $1 AND project_id = $2', [id, projectId])).rows[0];
    return r ? this.map(r) : null;
  }

  async bySlug(slug: string): Promise<MockService | null> {
    const r = (await this.db.query('SELECT * FROM mock_services WHERE slug = $1', [slug])).rows[0];
    return r ? this.map(r) : null;
  }

  async byName(projectId: string, name: string): Promise<MockService | null> {
    const r = (await this.db.query('SELECT * FROM mock_services WHERE project_id = $1 AND lower(name) = lower($2)', [projectId, name])).rows[0];
    return r ? this.map(r) : null;
  }

  async create(projectId: string, input: { name: string; spec?: any; routes?: MockRoute[] }, user?: string): Promise<MockService> {
    // An unguessable address: the mock answers without a login
    const slug = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'mock'}-${crypto.randomBytes(6).toString('hex')}`;
    try {
      const r = await this.db.query(
        'INSERT INTO mock_services (id, project_id, name, slug, spec, routes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [`MOCK-${crypto.randomUUID()}`, projectId, input.name.trim(), slug, input.spec ? JSON.stringify(input.spec) : null, JSON.stringify(input.routes ?? []), user ?? null],
      );
      return this.map(r.rows[0]);
    } catch (e: any) {
      if (e.code === '23505') throw Object.assign(new Error(`A mock service named "${input.name.trim()}" already exists`), { status: 409 });
      throw e;
    }
  }

  async update(id: string, projectId: string, input: Partial<{ name: string; spec: any; routes: MockRoute[] }>): Promise<MockService | null> {
    const cur = await this.get(id, projectId);
    if (!cur) return null;
    const r = await this.db.query(
      'UPDATE mock_services SET name = $3, spec = $4, routes = $5 WHERE id = $1 AND project_id = $2 RETURNING *',
      [id, projectId, (input.name ?? cur.name).trim(), input.spec === null ? null : JSON.stringify(input.spec ?? cur.spec ?? null), JSON.stringify(input.routes ?? cur.routes)],
    );
    return this.map(r.rows[0]);
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    MockState.clear(id);
    return ((await this.db.query('DELETE FROM mock_services WHERE id = $1 AND project_id = $2', [id, projectId])).rowCount ?? 0) > 0;
  }
}

/** For test steps: the project's mock services by name. */
export function mockAccess(projectId: string) {
  const repo = new MockServiceRepository();
  const find = async (name?: string) => {
    if (!name) throw new Error('Say which mock service (target)');
    const s = await repo.byName(projectId, name);
    if (!s) throw new Error(`Unknown mock service "${name}" (Mock APIs)`);
    return s;
  };
  return {
    async respond(name: string | undefined, rule: MockRoute & { times?: number }) {
      const s = await find(name);
      MockState.respond(s.id, rule);
      return s;
    },
    async calls(name: string | undefined, since?: Date) {
      const s = await find(name);
      return { service: s, calls: MockState.calls(s.id, since) };
    },
  };
}
