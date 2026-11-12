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

/**
 * POSIX sh: starts the run (wait mode) with the commit and pull / merge request, downloads
 * the JUnit report, exits non-zero unless the run completed. Expects ATAB_URL, ATAB_PROJECT,
 * ATAB_AGENT, ATAB_API_KEY, optional ATAB_BASE_URL, and PROVIDER, REPO, SHA, PR, REF, CI_URL.
 */
export const CI_RUN_SCRIPT = `set -eu
pr_json=null
if [ -n "\${PR:-}" ]; then pr_json="$PR"; fi
body=$(jq -n --arg agent "$ATAB_AGENT" --arg base "\${ATAB_BASE_URL:-}" --arg provider "$PROVIDER" --arg repo "$REPO" \\
  --arg sha "$SHA" --arg ref "$REF" --arg url "$CI_URL" --argjson pr "$pr_json" \\
  '{agentId: $agent, wait: true, timeoutSeconds: 3300,
    metadata: {triggeredBy: "ci", ciUrl: $url, git: {provider: $provider, repository: $repo, sha: $sha, ref: $ref, pr: $pr}}}
   + (if $base == "" then {} else {baseUrl: $base} end)')
run=$(curl -fsS -X POST "$ATAB_URL/runs" -H "Authorization: ApiKey $ATAB_API_KEY" -H "X-Project-Id: $ATAB_PROJECT" -H 'Content-Type: application/json' -d "$body")
id=$(echo "$run" | jq -r .id)
status=$(echo "$run" | jq -r .status)
echo "Run $id: $status ($(echo "$run" | jq -r '"\\(.passedTests) passed, \\(.failedTests) failed of \\(.totalTests)"'))"
curl -fsS "$ATAB_URL/runs/$id/report?format=junit" -H "Authorization: ApiKey $ATAB_API_KEY" -H "X-Project-Id: $ATAB_PROJECT" -o ai-tests-junit.xml || true
test "$status" = completed`;

const indent = (text: string, spaces: number) => text.split('\n').map((l) => (l ? ' '.repeat(spaces) + l : l)).join('\n');

/** GitLab CI job: merge request pipelines, the default branch and manual pipelines; JUnit shown in the merge request. */
export function gitlabCiJob(o: { apiUrl: string; projectId: string; agentId: string; agentName: string }): string {
  return `# AI tests for "${o.agentName}" — add this job to .gitlab-ci.yml
# Needs the CI/CD variable ATAB_API_KEY (Settings → CI/CD → Variables, masked): an API key of
# AI Test Agent Builder (Account → API keys) with the editor role on this project.
ai-tests:
  stage: test
  image: alpine:3.20
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    - if: $CI_PIPELINE_SOURCE == "web"
  timeout: 1h
  variables:
    ATAB_URL: ${o.apiUrl.replace(/\/+$/, '')}
    ATAB_PROJECT: ${o.projectId}
    ATAB_AGENT: ${o.agentId}
    # Test a review app instead of the agent's address: ATAB_BASE_URL: $CI_ENVIRONMENT_URL
  before_script:
    - apk add --no-cache curl jq
  script:
    - |
      export PROVIDER=gitlab REPO="$CI_PROJECT_PATH" SHA="$CI_COMMIT_SHA" PR="\${CI_MERGE_REQUEST_IID:-}" REF="$CI_COMMIT_REF_NAME" CI_URL="$CI_JOB_URL"
${indent(CI_RUN_SCRIPT, 6)}
  artifacts:
    when: always
    paths: [ai-tests-junit.xml]
    reports:
      junit: ai-tests-junit.xml
`;
}

/** Azure Pipelines: pushes to the branch and pull requests (Azure Repos: add it as a build validation branch policy). */
export function azurePipeline(o: { apiUrl: string; projectId: string; agentId: string; agentName: string; branch?: string }): string {
  const branch = o.branch || 'main';
  return `# AI tests for "${o.agentName}" — save as azure-pipelines.yml (or add the steps to yours)
# Needs the secret pipeline variable ATAB_API_KEY: an API key of AI Test Agent Builder
# (Account → API keys) with the editor role. For Azure Repos pull requests, add this pipeline
# as a build validation in the branch policy of ${branch}.
trigger:
  branches:
    include: [${branch}]
pr:
  branches:
    include: [${branch}]

pool:
  vmImage: ubuntu-latest

variables:
  ATAB_URL: ${o.apiUrl.replace(/\/+$/, '')}
  ATAB_PROJECT: ${o.projectId}
  ATAB_AGENT: ${o.agentId}
  # Test another address (a slot or preview environment): ATAB_BASE_URL: https://…

steps:
  - checkout: none
  - bash: |
      export PROVIDER=azure_devops REPO="$BUILD_REPOSITORY_NAME" SHA="\${SYSTEM_PULLREQUEST_SOURCECOMMITID:-$BUILD_SOURCEVERSION}" PR="\${SYSTEM_PULLREQUEST_PULLREQUESTID:-}" REF="$BUILD_SOURCEBRANCH"
      export CI_URL="\${SYSTEM_COLLECTIONURI}\${SYSTEM_TEAMPROJECT}/_build/results?buildId=\${BUILD_BUILDID}"
${indent(CI_RUN_SCRIPT, 6)}
    displayName: Run the tests
    timeoutInMinutes: 60
    env:
      ATAB_API_KEY: $(ATAB_API_KEY)
  - task: PublishTestResults@2
    displayName: Publish the test results
    condition: always()
    inputs:
      testResultsFormat: JUnit
      testResultsFiles: ai-tests-junit.xml
      testRunTitle: AI tests
      failTaskOnMissingResultsFile: false
`;
}

/**
 * Jenkins declarative pipeline (Jenkinsfile): runs the agent's tests, publishes the JUnit report,
 * fails the build when tests fail. With a code host integration for the repository, the commit
 * also gets a status and the pull request (multibranch CHANGE_ID) a comment.
 */
export function jenkinsfile(o: { apiUrl: string; projectId: string; agentId: string; agentName: string }): string {
  // Groovy ''' strings still interpret backslashes
  const script = CI_RUN_SCRIPT.replace(/\\/g, '\\\\');
  return `// AI tests for "${o.agentName}" — add this stage to your Jenkinsfile (or use it as one)
// Needs: curl and jq on the agent; a "Secret text" credential with id atab-api-key holding an
// API key of AI Test Agent Builder (Account → API keys) with the editor role on this project.
pipeline {
  agent any
  options { timeout(time: 60, unit: 'MINUTES') }
  environment {
    ATAB_URL = '${o.apiUrl.replace(/\/+$/, '')}'
    ATAB_PROJECT = '${o.projectId}'
    ATAB_AGENT = '${o.agentId}'
    // Test another address (a deployed preview): ATAB_BASE_URL = 'https://…'
  }
  stages {
    stage('AI tests') {
      steps {
        withCredentials([string(credentialsId: 'atab-api-key', variable: 'ATAB_API_KEY')]) {
          sh '''
            export PROVIDER=jenkins SHA="\${GIT_COMMIT:-}" PR="\${CHANGE_ID:-}" REF="\${BRANCH_NAME:-\${GIT_BRANCH:-}}" CI_URL="\${BUILD_URL:-}"
            # owner/name of the repository (for commit statuses through a GitHub / GitLab integration)
            export REPO="$(echo "\${GIT_URL:-}" | sed -E 's#\\\\.git$##; s#^.*[:/]([^/]+/[^/]+)$#\\\\1#')"
${indent(script, 12)}
          '''
        }
      }
    }
  }
  post {
    always {
      junit allowEmptyResults: true, testResults: 'ai-tests-junit.xml'
    }
  }
}
`;
}

export const CI_KINDS = ['github', 'gitlab', 'azure', 'jenkins'] as const;

/** A CI template for an agent, by kind. */
export function ciTemplate(kind: typeof CI_KINDS[number], o: { apiUrl: string; projectId: string; agentId: string; agentName: string; branch?: string }) {
  if (kind === 'gitlab') return { kind, path: '.gitlab-ci.yml', secret: 'ATAB_API_KEY', secretWhere: 'Settings → CI/CD → Variables (masked)', text: gitlabCiJob(o) };
  if (kind === 'azure') return { kind, path: 'azure-pipelines.yml', secret: 'ATAB_API_KEY', secretWhere: 'the pipeline\'s Variables (keep this value secret)', text: azurePipeline(o) };
  if (kind === 'jenkins') return { kind, path: 'Jenkinsfile', secret: 'atab-api-key', secretWhere: 'Jenkins credentials (Secret text)', text: jenkinsfile(o) };
  return { kind, path: '.github/workflows/ai-tests.yml', secret: 'ATAB_API_KEY', secretWhere: 'Settings → Secrets and variables → Actions', text: githubActionsWorkflow(o) };
}
