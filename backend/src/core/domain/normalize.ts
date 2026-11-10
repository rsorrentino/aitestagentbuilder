/**
 * Normalization of test cases coming from LLMs, the UI or the API into the
 * canonical TestCaseCreateInput shape.
 */

import { Priority, TestCaseCreateInput, TestStep, TestType } from './test-case.js';

const PRIORITIES: Priority[] = ['Low', 'Medium', 'High', 'Critical'];
const TYPES: TestType[] = ['Functional', 'Regression', 'Integration', 'Smoke', 'E2E'];

function pickEnum<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  if (typeof value !== 'string') return fallback;
  const match = allowed.find((a) => a.toLowerCase() === value.trim().toLowerCase());
  return match ?? fallback;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export function normalizeStep(raw: any): Omit<TestStep, 'stepId'> | null {
  if (typeof raw === 'string') {
    return raw.trim() ? { action: raw.trim() } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const action = String(raw.action ?? raw.step ?? raw.description ?? '').trim();
  if (!action) return null;

  let data: Record<string, any> | undefined;
  if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
    data = raw.data;
  } else if (raw.data !== undefined && raw.data !== null && raw.data !== '') {
    data = { value: raw.data };
  } else if (raw.value !== undefined && raw.value !== null && raw.value !== '') {
    data = { value: raw.value };
  }

  const step: Omit<TestStep, 'stepId'> = { action };
  const target = raw.target ?? raw.selector ?? raw.url;
  if (target !== undefined && target !== null && String(target).trim()) step.target = String(target).trim();
  if (data) step.data = data;
  const expected = raw.expectedResult ?? raw.expected ?? raw.expected_result;
  if (expected) step.expectedResult = String(expected);
  return step;
}

export function normalizeTestCaseInput(
  raw: any,
  ctx: { module?: string; documentId?: string; author?: string; tags?: string[] } = {},
): TestCaseCreateInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title ?? raw.name ?? '').trim();
  if (!title) return null;

  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .map(normalizeStep)
    .filter((s: any): s is Omit<TestStep, 'stepId'> => s !== null);

  let expectedResults = toStringArray(raw.expectedResults ?? raw.expected_results ?? raw.expectedResult);
  if (expectedResults.length === 0) {
    expectedResults = steps.filter((s: any) => s.expectedResult).map((s: any) => s.expectedResult as string);
  }

  const tags = [...new Set([...toStringArray(raw.tags), ...(ctx.tags ?? [])])];

  return {
    title: title.slice(0, 500),
    module: String(raw.module || ctx.module || 'General').trim().slice(0, 255),
    description: raw.description ? String(raw.description) : undefined,
    steps,
    expectedResults,
    preconditions: toStringArray(raw.preconditions),
    postconditions: toStringArray(raw.postconditions),
    priority: pickEnum(raw.priority, PRIORITIES, 'Medium'),
    type: pickEnum(raw.type, TYPES, 'Functional'),
    tags,
    data: raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : undefined,
    documentId: ctx.documentId,
    metadata: {
      ...(ctx.documentId ? { sourceDocument: ctx.documentId } : {}),
      ...(ctx.author ? { author: ctx.author } : {}),
      extractedAt: new Date(),
    },
  };
}

/** Validation for test cases submitted through the API. Returns error messages. */
export function validateTestCaseInput(input: any, partial = false): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') return ['Request body must be a JSON object'];

  if (!partial || input.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim()) errors.push('title is required');
  }
  if (!partial || input.module !== undefined) {
    if (typeof input.module !== 'string' || !input.module.trim()) errors.push('module is required');
  }
  if (input.priority !== undefined && !PRIORITIES.includes(input.priority)) {
    errors.push(`priority must be one of ${PRIORITIES.join(', ')}`);
  }
  if (input.type !== undefined && input.type !== null && !TYPES.includes(input.type)) {
    errors.push(`type must be one of ${TYPES.join(', ')}`);
  }
  if (input.steps !== undefined) {
    if (!Array.isArray(input.steps)) {
      errors.push('steps must be an array');
    } else {
      input.steps.forEach((s: any, i: number) => {
        if (!s || typeof s.action !== 'string' || !s.action.trim()) errors.push(`steps[${i}].action is required`);
      });
    }
  }
  if (input.expectedResults !== undefined && !Array.isArray(input.expectedResults)) {
    errors.push('expectedResults must be an array of strings');
  }
  return errors;
}
