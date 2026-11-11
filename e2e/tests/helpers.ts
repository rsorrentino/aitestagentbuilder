import { APIRequestContext } from '@playwright/test';

export const API_URL = process.env.API_URL || 'http://localhost:3000/api/v1';

/** Creates (or refreshes) the built-in Demo Shop agent and returns its id. */
export async function seedDemo(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_URL}/demo/seed`);
  if (!res.ok()) throw new Error(`demo seed failed: ${res.status()} ${await res.text()}`);
  return (await res.json()).agentId;
}

export const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}`;
