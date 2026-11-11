/**
 * Seeds a "Demo Shop" agent and test cases targeting the built-in demo app.
 *
 *   npm run seed:demo            (uses DEMO_BASE_URL or http://localhost:$PORT/demo/)
 */

import { fileURLToPath } from 'url';
import '../infra/config/env.js';
import getDatabaseClient from '../infra/db/client.js';
import { runMigrations } from '../infra/db/migrate.js';
import { AgentRepository } from '../core/repositories/agent.repository.js';
import { TestCaseRepository } from '../core/repositories/test-case.repository.js';
import { buildAgentConfig } from '../api/controllers/agents.controller.js';
import { TestCaseCreateInput } from '../core/domain/test-case.js';

export const DEMO_AGENT_NAME = 'Demo Shop';

export const DEMO_TESTS: TestCaseCreateInput[] = [
  {
    title: 'Valid login opens the dashboard',
    module: 'Demo: Authentication',
    priority: 'Critical',
    type: 'Smoke',
    tags: ['demo'],
    steps: [
      { action: 'navigate', target: 'login' },
      { action: 'fill', target: '#username', data: { value: 'demo' } },
      { action: 'fill', target: '#password', data: { value: 'demo123' } },
      { action: 'click', target: 'Sign in button' },
      { action: 'assert_url', data: { value: '/dashboard' } },
      { action: 'assert_text', target: '#welcome', data: { value: 'Welcome, demo!' } },
    ],
    expectedResults: ['The dashboard greets the user by name'],
  },
  {
    title: 'Wrong password shows an error',
    module: 'Demo: Authentication',
    priority: 'High',
    type: 'Functional',
    tags: ['demo'],
    steps: [
      { action: 'navigate', target: 'login' },
      { action: 'fill', target: 'Username', data: { value: 'demo' } },
      { action: 'fill', target: 'Password', data: { value: 'wrong' } },
      { action: 'press', target: '#password', data: { value: 'Enter' } },
      { action: 'assert_text', target: '[role=alert]', data: { value: 'Invalid username or password' } },
      { action: 'assert_url', data: { value: '/login' } },
    ],
    expectedResults: ['An error message is shown and the user stays on the login page'],
  },
  {
    title: 'Add an item to the shopping list',
    module: 'Demo: Shopping list',
    priority: 'Medium',
    type: 'E2E',
    tags: ['demo'],
    steps: [
      { action: 'navigate', target: 'login' },
      { action: 'fill', target: '#username', data: { value: 'demo' } },
      { action: 'fill', target: '#password', data: { value: 'demo123' } },
      { action: 'click', target: '#login-btn' },
      { action: 'wait', target: '#welcome' },
      { action: 'fill', target: 'New item', data: { value: 'Coffee beans' } },
      { action: 'click', target: '#add-item' },
      { action: 'assert_text', target: '#items', data: { value: 'Coffee beans' } },
      { action: 'screenshot' },
    ],
    expectedResults: ['The new item appears in the list'],
  },
];

export async function seedDemo(baseUrl?: string, projectId = 'default'): Promise<{ agentId: string; created: number }> {
  const url = baseUrl || process.env.DEMO_BASE_URL || `http://localhost:${process.env.PORT || 3000}/demo/`;

  const agents = new AgentRepository();
  const testCases = new TestCaseRepository();
  const { config } = buildAgentConfig(DEMO_AGENT_NAME, {
    base_url: url,
    environment: 'demo',
    test_selection: { tags: ['demo'] },
    ai: { self_healing: true },
  });

  const existing = await agents.findByName(DEMO_AGENT_NAME, projectId);
  const agent = existing
    ? (await agents.update(existing.id, { config: config! }, projectId))!
    : await agents.create({ name: DEMO_AGENT_NAME, config: config!, projectId });

  const present = new Set((await testCases.search({ projectId, tags: ['demo'], limit: 100 })).map((t) => t.title));
  let created = 0;
  for (const tc of DEMO_TESTS) {
    if (present.has(tc.title)) continue;
    await testCases.create({ ...tc, projectId, metadata: { author: 'demo-seed' } });
    created++;
  }
  return { agentId: agent.id, created };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runMigrations()
    .then(() => seedDemo(undefined, process.env.PROJECT_ID || 'default'))
    .then(({ agentId, created }) => {
      console.log(`✅ Demo agent ready (${agentId}); ${created} new test case(s). Open the agent and click "Start Run".`);
    })
    .catch((e) => {
      console.error('❌ Demo seed failed:', e.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await getDatabaseClient().close().catch(() => undefined);
      process.exit(process.exitCode ?? 0);
    });
}
