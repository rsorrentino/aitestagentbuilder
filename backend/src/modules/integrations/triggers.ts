/**
 * Runs started by code host events (webhooks): which agents to run for a push,
 * a pull request or a successful deployment, and the CI workflow template.
 */

import { GitEvent } from './types.js';

export const TRIGGER_EVENTS = ['push', 'pull_request', 'deployment_status'] as const;

export interface GitTrigger {
  event: typeof TRIGGER_EVENTS[number];
  agent_id: string;
  /** push: pushed branch; pull_request: target (base) branch; deployment_status: deployed ref. Globs with *; empty = all */
  branches?: string[];
  /** deployment_status: environment names (globs); empty = all */
  environments?: string[];
  /** deployment_status: test the deployed address (preview environments) instead of the agent's base_url */
  use_deployment_url?: boolean;
  /** pull_request: also draft pull requests */
  include_drafts?: boolean;
  /** Only these tests (tags of the agent's selection are used otherwise) */
  test_ids?: string[];
}

const glob = (pattern: string) => new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
const matches = (patterns: string[] | undefined, value: string | undefined) => !patterns?.length || (!!value && patterns.some((p) => glob(p).test(value)));

/** The runs an event asks for (pure). */
export function matchTriggers(triggers: GitTrigger[], ev: GitEvent): Array<{ agentId: string; baseUrl?: string; testIds?: string[] }> {
  const out: Array<{ agentId: string; baseUrl?: string; testIds?: string[] }> = [];
  for (const t of Array.isArray(triggers) ? triggers : []) {
    if (t.event !== ev.event || !t.agent_id) continue;
    if (ev.event === 'pull_request' && ev.draft && !t.include_drafts) continue;
    const branch = ev.event === 'pull_request' ? ev.baseBranch : ev.branch;
    if (!matches(t.branches, branch)) continue;
    if (ev.event === 'deployment_status' && !matches(t.environments, ev.environment)) continue;
    if (out.some((o) => o.agentId === t.agent_id)) continue;
    out.push({
      agentId: t.agent_id,
      ...(ev.event === 'deployment_status' && t.use_deployment_url && ev.deploymentUrl ? { baseUrl: ev.deploymentUrl } : {}),
      ...(t.test_ids?.length ? { testIds: t.test_ids } : {}),
    });
  }
  return out;
}

export function validateTriggers(triggers: any): string[] {
  if (triggers === undefined) return [];
  if (!Array.isArray(triggers)) return ['config.triggers must be a list'];
  const errors: string[] = [];
  triggers.forEach((t, i) => {
    const at = `config.triggers[${i}]`;
    if (!t || typeof t !== 'object') return void errors.push(`${at} must be an object`);
    if (!TRIGGER_EVENTS.includes(t.event)) errors.push(`${at}.event must be one of ${TRIGGER_EVENTS.join(', ')}`);
    if (typeof t.agent_id !== 'string' || !t.agent_id) errors.push(`${at}.agent_id is required`);
    for (const k of ['branches', 'environments', 'test_ids']) {
      if (t[k] !== undefined && (!Array.isArray(t[k]) || t[k].some((v: any) => typeof v !== 'string' || !v.trim()))) errors.push(`${at}.${k} must be a list of names`);
    }
  });
  return errors;
}

/**
 * GitHub Actions workflow: runs the agent's tests for pull requests and pushes,
 * through the REST API (wait mode), fails the job when tests fail, keeps the JUnit report.
 */
export function githubActionsWorkflow(o: { apiUrl: string; projectId: string; agentId: string; agentName: string; branch?: string }): string {
  const branch = o.branch || 'main';
  return `# AI tests for "${o.agentName}" — save as .github/workflows/ai-tests.yml
# Needs the repository secret ATAB_API_KEY: an API key of AI Test Agent Builder
# (Account → API keys) with the editor role on this project.
name: AI tests

on:
  pull_request:
  push:
    branches: [${branch}]
  workflow_dispatch:
    inputs:
      base_url:
        description: Address to test (empty = the agent's)
        required: false

permissions:
  contents: read

jobs:
  ai-tests:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      ATAB_URL: ${o.apiUrl.replace(/\/+$/, '')}
      ATAB_PROJECT: ${o.projectId}
      ATAB_AGENT: ${o.agentId}
      # Test a preview deployment instead of the agent's address, e.g. \${{ steps.deploy.outputs.url }}
      ATAB_BASE_URL: \${{ github.event.inputs.base_url }}
    steps:
      - name: Run the tests
        env:
          ATAB_API_KEY: \${{ secrets.ATAB_API_KEY }}
          SHA: \${{ github.event.pull_request.head.sha || github.sha }}
          PR: \${{ github.event.pull_request.number }}
        run: |
          set -euo pipefail
          body=$(jq -n --arg agent "$ATAB_AGENT" --arg base "$ATAB_BASE_URL" --arg repo "$GITHUB_REPOSITORY" \\
            --arg sha "$SHA" --arg pr "$PR" --arg ref "$GITHUB_REF" --arg url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \\
            '{agentId: $agent, wait: true, timeoutSeconds: 3300,
              metadata: {triggeredBy: "ci", ciUrl: $url,
                git: {provider: "github", repository: $repo, sha: $sha, ref: $ref, pr: (if $pr == "" then null else ($pr | tonumber) end)}}}
             + (if $base == "" then {} else {baseUrl: $base} end)')
          auth=(-H "Authorization: ApiKey $ATAB_API_KEY" -H "X-Project-Id: $ATAB_PROJECT")
          run=$(curl -fsS -X POST "$ATAB_URL/runs" "\${auth[@]}" -H 'Content-Type: application/json' -d "$body")
          id=$(jq -r .id <<<"$run"); status=$(jq -r .status <<<"$run")
          echo "Run $id: $status ($(jq -r '"\\(.passedTests) passed, \\(.failedTests) failed of \\(.totalTests)"' <<<"$run"))"
          echo "run_id=$id" >> "$GITHUB_OUTPUT"
          curl -fsS "$ATAB_URL/runs/$id/report?format=junit" "\${auth[@]}" -o ai-tests-junit.xml || true
          test "$status" = completed

      - name: Keep the JUnit report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: ai-tests-junit
          path: ai-tests-junit.xml
          if-no-files-found: ignore
`;
}
