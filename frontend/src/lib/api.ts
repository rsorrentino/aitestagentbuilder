/**
 * Shared API client.
 */

import axios, { AxiosError } from 'axios';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';
/** Origin of the backend (for Socket.IO, screenshots and reports) */
export const BACKEND_URL = process.env.NEXT_PUBLIC_WS_URL || API_URL.replace(/\/api\/v\d+\/?$/, '');

const TOKEN_KEY = 'atab_token';
const PROJECT_KEY = 'atab_project';

export function getProjectId(): string {
  try {
    return (typeof window !== 'undefined' && window.localStorage.getItem(PROJECT_KEY)) || 'default';
  } catch {
    return 'default';
  }
}

export function setProjectId(id: string): void {
  try {
    window.localStorage.setItem(PROJECT_KEY, id);
  } catch {
    // storage unavailable
  }
}

export function getToken(): string | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable
  }
}

export const api = axios.create({ baseURL: API_URL, timeout: 300000 });

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (!config.headers['X-Project-Id']) config.headers['X-Project-Id'] = getProjectId();
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (error: AxiosError) => {
    if (typeof window !== 'undefined') {
      const data: any = error.response?.data;
      if (error.response?.status === 401 && !window.location.pathname.startsWith('/login')) {
        setToken(null);
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      } else if (error.response?.status === 403 && data?.code === 'PASSWORD_CHANGE_REQUIRED' && !window.location.pathname.startsWith('/account')) {
        window.location.href = '/account?mustChange=1';
      } else if (error.response?.status === 403 && /not a member of project/.test(data?.error ?? '') && getProjectId() !== 'default') {
        // The remembered project is no longer accessible: fall back
        setProjectId('default');
      }
    }
    return Promise.reject(error);
  },
);

/** Human-readable message for any API error. */
export function errorMessage(err: any): string {
  if (err?.response?.data?.error) return err.response.data.error;
  if (err?.code === 'ERR_NETWORK') return `Cannot reach the backend at ${API_URL}. Is it running? (cd backend && npm run dev)`;
  return err?.message ?? String(err);
}

export function artifactUrl(path: string): string {
  return `${BACKEND_URL}/artifacts/${path}`;
}

export function reportUrl(runId: string, format: 'html' | 'json' | 'junit', download = false): string {
  return `${API_URL}/runs/${runId}/report?format=${format}${download ? '&download=1' : ''}`;
}

export function statusBadge(status?: string): string {
  const map: Record<string, string> = {
    completed: 'badge badge-success',
    passed: 'badge badge-success',
    processed: 'badge badge-success',
    active: 'badge badge-success',
    running: 'badge badge-warning',
    processing: 'badge badge-warning',
    pending: 'badge badge-info',
    uploaded: 'badge badge-info',
    failed: 'badge badge-danger',
    error: 'badge badge-danger',
    timeout: 'badge badge-danger',
    cancelled: 'badge badge-neutral',
    skipped: 'badge badge-neutral',
    inactive: 'badge badge-neutral',
  };
  return map[status ?? ''] ?? 'badge badge-neutral';
}

export function priorityBadge(p?: string): string {
  const m: Record<string, string> = {
    Critical: 'badge badge-danger',
    High: 'badge badge-warning',
    Medium: 'badge badge-info',
    Low: 'badge badge-neutral',
  };
  return m[p ?? ''] ?? 'badge badge-neutral';
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function shortId(id?: string): string {
  if (!id) return '—';
  const parts = id.split('-');
  return parts.length >= 3 ? `${parts[0]}-…${parts[parts.length - 1]}` : id;
}

export type ProjectRole = 'viewer' | 'editor' | 'admin' | 'owner';
export const ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };
export const REDACTED = '••••••••';
export const PROJECT_ROLES_LIST: ProjectRole[] = ['viewer', 'editor', 'admin', 'owner'];

export function formatDate(value?: string | Date | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
export const TEST_TYPES = ['Functional', 'Regression', 'Integration', 'Smoke', 'E2E'];
export const STEP_ACTIONS = [
  'navigate', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'hover', 'wait',
  'assert_visible', 'assert_not_visible', 'assert_text', 'assert_url', 'assert_title', 'screenshot',
  'salesforce_login', 'salesforce_logout', 'wait_for_lightning', 'assert_access_denied',
  'assert_profile', 'assert_object_access', 'assert_field_access', 'assert_record_access',
  'assert_accessible', 'assert_screenshot',
  'http_request', 'assert_status', 'assert_json', 'assert_header', 'assert_response_time', 'mock_route', 'block_route',
  'assert_ai',
  'assert_performance',
  'ai',
  'wait_for_code',
];
export const AI_PROVIDERS = [
  { value: '', label: 'Automatic (best available)' },
  { value: 'anthropic', label: 'Anthropic Claude' },
  { value: 'copilot', label: 'GitHub Copilot' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'azure', label: 'Azure OpenAI' },
];
