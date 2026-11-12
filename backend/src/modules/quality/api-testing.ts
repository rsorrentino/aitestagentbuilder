/**
 * API testing steps, run inside the test's browser context so requests share
 * its cookies (an API call after a UI login is authenticated like the user).
 *
 *   http_request      target: URL or path (relative to config.api_base_url, else base_url)
 *                     data: { method, headers, query, body, json, timeout, extract: { name: "$.path" } }
 *   assert_status     data.value: 200 | "2xx" | [200, 201]
 *   assert_json       data: { path: "$.items[0].name", equals | contains | matches | exists | type | length }
 *   assert_header     target: header name, data.value: text it contains (empty = only present)
 *   assert_response_time   data.value: maximum milliseconds
 *   mock_route        target: URL glob pattern (e.g. https://pay.example.com/v1/charges*), data: { status, json | body, headers, method, delay, times }
 *   block_route       target: URL pattern — requests fail as if the network were down
 *
 * Values extracted with `extract` are used in later steps as {{vars.name}}.
 */

import type { Page, Route } from 'playwright';

export interface ApiResponse {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  text: string;
  json?: unknown;
  durationMs: number;
}

export interface ApiState {
  last?: ApiResponse;
  vars: Record<string, string>;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** Value at a JSONPath-like path: $.a.b[0].c, $[2], $.items.length, $['odd key']. */
export function jsonPath(root: unknown, path: string): { found: boolean; value: unknown } {
  const p = String(path ?? '').trim();
  if (p === '$' || p === '') return { found: true, value: root };
  if (!p.startsWith('$')) return jsonPath(root, `$.${p}`);
  const tokens: Array<string | number> = [];
  const re = /\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[['"]([^'"]+)['"]\]/g;
  let m: RegExpExecArray | null;
  let consumed = 1;
  while ((m = re.exec(p))) {
    if (m.index !== consumed) throw new Error(`Unsupported JSON path "${path}" (use $.a.b[0].c)`);
    tokens.push(m[1] ?? (m[2] !== undefined ? Number(m[2]) : m[3]));
    consumed = re.lastIndex;
  }
  if (consumed !== p.length) throw new Error(`Unsupported JSON path "${path}" (use $.a.b[0].c)`);
  let value: any = root;
  for (const t of tokens) {
    if (t === 'length' && (Array.isArray(value) || typeof value === 'string')) {
      value = value.length;
      continue;
    }
    if (value === null || typeof value !== 'object' || !(t in value)) return { found: false, value: undefined };
    value = value[t as any];
  }
  return { found: true, value };
}

/** Status expectation: 200, "200", "2xx", [200, 201]. */
export function statusMatches(status: number, expected: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((e) => statusMatches(status, e));
  const e = String(expected ?? '').trim().toLowerCase();
  if (/^[1-5]xx$/.test(e)) return Math.floor(status / 100) === Number(e[0]);
  return Number(e) === status;
}

const show = (v: unknown) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));

/** Check one JSON assertion; returns a description or throws with what was found. */
export function checkJson(body: unknown, data: Record<string, any>): string {
  if (body === undefined) throw new Error('The response is not JSON');
  const path = String(data.path ?? data.target ?? '$');
  const { found, value } = jsonPath(body, path);
  if (data.exists === false) {
    if (found) throw new Error(`Expected ${path} not to exist, but it is ${show(value)}`);
    return `${path} does not exist`;
  }
  if (!found) throw new Error(`${path} does not exist in the response`);
  if ('equals' in data || 'value' in data) {
    const expected = 'equals' in data ? data.equals : data.value;
    const same = typeof value === 'object' ? JSON.stringify(value) === JSON.stringify(expected) : String(value) === String(expected);
    if (!same) throw new Error(`Expected ${path} to equal ${show(expected)} but it is ${show(value)}`);
    return `${path} = ${show(value)}`;
  }
  if ('contains' in data) {
    const ok = Array.isArray(value)
      ? value.some((v) => (typeof v === 'object' ? JSON.stringify(v).includes(String(data.contains)) : String(v) === String(data.contains)))
      : String(value).includes(String(data.contains));
    if (!ok) throw new Error(`Expected ${path} to contain ${show(data.contains)} but it is ${show(value)}`);
    return `${path} contains ${show(data.contains)}`;
  }
  if ('matches' in data) {
    if (!new RegExp(String(data.matches)).test(String(value))) throw new Error(`Expected ${path} to match /${data.matches}/ but it is ${show(value)}`);
    return `${path} matches /${data.matches}/`;
  }
  if ('type' in data) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (actual !== String(data.type)) throw new Error(`Expected ${path} to be ${data.type} but it is ${actual}`);
    return `${path} is ${actual}`;
  }
  if ('length' in data) {
    const len = Array.isArray(value) || typeof value === 'string' ? value.length : undefined;
    if (len !== Number(data.length)) throw new Error(`Expected ${path} to have length ${data.length} but it has ${len ?? 'no length'}`);
    return `${path} has length ${len}`;
  }
  return `${path} exists (${show(value)?.slice(0, 80)})`;
}

function apiUrl(config: any, target: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  const base = String(config.api_base_url || config.base_url || '');
  if (!base) throw new Error('No URL: give a full URL or set the agent base URL');
  return new URL(target.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`).toString();
}

export async function sendRequest(page: Page, config: any, target: string, data: Record<string, any>, timeout: number): Promise<ApiResponse> {
  const method = String(data.method ?? 'GET').toUpperCase();
  if (!METHODS.includes(method)) throw new Error(`Unsupported HTTP method "${data.method}"`);
  const url = new URL(apiUrl(config, target));
  for (const [k, v] of Object.entries(data.query ?? {})) url.searchParams.set(k, String(v));
  const body = data.json ?? data.body;
  const started = Date.now();
  const res = await page.request.fetch(url.toString(), {
    method,
    headers: Object.fromEntries(Object.entries(data.headers ?? {}).map(([k, v]) => [k, String(v)])),
    // Objects are sent as JSON (Content-Type: application/json), strings as they are
    ...(body !== undefined ? { data: body } : {}),
    timeout: Number(data.timeout) || Math.max(timeout, 30000),
    failOnStatusCode: false,
    maxRedirects: data.follow_redirects === false ? 0 : 20,
  });
  const text = await res.text();
  let json: unknown;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { method, url: url.toString(), status: res.status(), headers: res.headers(), text, json, durationMs: Date.now() - started };
}

/** Apply `extract: { name: "$.path" }` to the response, into run variables. */
export function extractVars(response: ApiResponse, extract: Record<string, string> | undefined, vars: Record<string, string>): string[] {
  const names: string[] = [];
  for (const [name, path] of Object.entries(extract ?? {})) {
    if (!/^[A-Za-z_]\w{0,63}$/.test(name)) throw new Error(`Invalid variable name "${name}"`);
    const { found, value } = jsonPath(response.json, String(path));
    if (!found) throw new Error(`Cannot extract ${name}: ${path} is not in the response`);
    vars[name] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    names.push(name);
  }
  return names;
}

export function describeResponse(r: ApiResponse): string {
  const snippet = r.text.replace(/\s+/g, ' ').slice(0, 160);
  return `${r.method} ${r.url} → ${r.status} in ${r.durationMs} ms${snippet ? ` · ${snippet}${r.text.length > 160 ? '…' : ''}` : ''}`;
}

/** Stub matching requests of the page (UI tests): fixed responses, delays or network errors. */
export async function mockRoute(page: Page, pattern: string, data: Record<string, any>, block: boolean): Promise<string> {
  if (!pattern) throw new Error('mock_route needs the URL pattern as target, e.g. **/api/payments/**');
  const method = data.method ? String(data.method).toUpperCase() : undefined;
  const handler = async (route: Route) => {
    if (method && route.request().method() !== method) return route.fallback();
    if (data.delay) await new Promise((r) => setTimeout(r, Math.min(Number(data.delay), 30000)));
    if (block) return route.abort(String(data.error ?? 'internetdisconnected'));
    const json = data.json;
    return route.fulfill({
      status: Number(data.status ?? 200),
      headers: Object.fromEntries(Object.entries(data.headers ?? {}).map(([k, v]) => [k, String(v)])),
      ...(json !== undefined ? { json } : { body: typeof data.body === 'string' ? data.body : JSON.stringify(data.body ?? '') }),
    });
  };
  await page.route(pattern, handler, data.times ? { times: Number(data.times) } : undefined);
  return block
    ? `Requests to ${pattern} now fail (${data.error ?? 'internetdisconnected'})`
    : `Requests to ${pattern}${method ? ` (${method})` : ''} now answer ${data.status ?? 200}${data.delay ? ` after ${data.delay} ms` : ''}`;
}
