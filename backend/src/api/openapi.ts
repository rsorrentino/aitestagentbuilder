/**
 * OpenAPI 3.1 description of the public API.
 * Served at GET /api/v1/openapi.json and rendered at /api/docs.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: any) => ({ 'application/json': { schema } });
const ok = (schema: any, description = 'OK') => ({ description, content: json(schema) });
const err = (description: string) => ({ description, content: json(ref('Error')) });
const id = (name = 'id', description?: string) => ({ name, in: 'path', required: true, schema: { type: 'string' }, ...(description ? { description } : {}) });
const q = (name: string, schema: any, description?: string) => ({ name, in: 'query', required: false, schema, ...(description ? { description } : {}) });

const projectHeader = {
  name: 'X-Project-Id', in: 'header', required: false, schema: { type: 'string', default: 'default' },
  description: 'Project the request operates on (defaults to "default"). Also accepted as ?projectId=.',
};

const std = { 401: err('Not authenticated'), 403: err('Insufficient role'), 404: err('Not found') };

function op(tag: string, summary: string, extra: Record<string, any> = {}, scoped = true) {
  return {
    tags: [tag],
    summary,
    ...extra,
    parameters: [...(scoped ? [projectHeader] : []), ...(extra.parameters ?? [])],
    responses: { ...(extra.responses ?? { 200: ok({}) }), ...std },
  };
}

export function buildOpenApi(serverUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'AI Test Agent Builder API',
      version: '1.1.0',
      description:
        'Turn test specifications into automated browser tests. Data is organised in projects; ' +
        'send `X-Project-Id` to select one. Roles per project: viewer < editor < admin < owner.\n\n' +
        'Authentication (when AUTH_ENABLED=true): `Authorization: Bearer <jwt>` from /auth/login, ' +
        'or `Authorization: ApiKey <key>` from /auth/api-keys (keys can be limited to one project and role).',
    },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }, { apiKey: [] }],
    tags: ['Auth', 'Projects', 'Admin', 'Agents', 'Test cases', 'Documents', 'Runs', 'Quality', 'Sign-in', 'Recorder', 'Test data', 'Schedules', 'Notifications', 'Integrations', 'Analytics', 'Audit', 'AI']
      .map((name) => ({ name })),
    paths: {
      // ── Auth ─────────────────────────────────────────────────────────────
      '/auth/config': { get: { ...op('Auth', 'Whether authentication is enabled', { security: [], responses: { 200: ok({ type: 'object', properties: { authEnabled: { type: 'boolean' }, passwordMinLength: { type: 'integer' } } }) } }, false) } },
      '/auth/login': {
        post: op('Auth', 'Log in', {
          security: [],
          requestBody: { required: true, content: json({ type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } }) },
          responses: { 200: ok(ref('TokenResponse')), 423: err('Account locked after repeated failures') },
        }, false),
      },
      '/auth/refresh': { post: op('Auth', 'Refresh tokens', { security: [], requestBody: { content: json({ type: 'object', properties: { refreshToken: { type: 'string' } } }) } }, false) },
      '/auth/me': { get: op('Auth', 'Current user and accessible projects', { responses: { 200: ok(ref('Me')) } }, false) },
      '/auth/change-password': {
        post: op('Auth', 'Change own password', {
          requestBody: { required: true, content: json({ type: 'object', required: ['currentPassword', 'newPassword'], properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string' } } }) },
        }, false),
      },
      '/auth/api-keys': {
        get: op('Auth', 'List own API keys', {}, false),
        post: op('Auth', 'Create an API key (shown once)', {
          requestBody: { content: json({ type: 'object', properties: { name: { type: 'string' }, projectId: { type: 'string', description: 'Limit the key to this project' }, role: ref('ProjectRole'), expiresInDays: { type: 'integer' } } }) },
          responses: { 201: ok({ type: 'object', properties: { id: { type: 'string' }, apiKey: { type: 'string' } } }) },
        }, false),
      },
      '/auth/api-keys/{id}': { delete: op('Auth', 'Revoke an API key', { parameters: [id()], responses: { 204: { description: 'Revoked' } } }, false) },

      // ── Projects & admin ─────────────────────────────────────────────────
      '/projects': {
        get: op('Projects', 'Projects visible to the caller', { responses: { 200: ok({ type: 'array', items: ref('Project') }) } }, false),
        post: op('Projects', 'Create a project (administrators)', { requestBody: { content: json({ type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' } } }) }, responses: { 201: ok(ref('Project')) } }, false),
      },
      '/projects/{projectId}': {
        get: op('Projects', 'Get a project', { parameters: [id('projectId')] }, false),
        patch: op('Projects', 'Rename, describe or archive (owner) a project', { parameters: [id('projectId')] }, false),
        delete: op('Projects', 'Delete a project and all its data (owner)', { parameters: [id('projectId'), q('confirm', { type: 'string' }, 'The project slug')], responses: { 204: { description: 'Deleted' } } }, false),
      },
      '/projects/{projectId}/members': {
        get: op('Projects', 'List members', { parameters: [id('projectId')] }, false),
        put: op('Projects', 'Add a member or change a role (project admin)', { parameters: [id('projectId')], requestBody: { content: json({ type: 'object', properties: { email: { type: 'string' }, userId: { type: 'string' }, role: ref('ProjectRole') } }) } }, false),
      },
      '/projects/{projectId}/members/{userId}': { delete: op('Projects', 'Remove a member', { parameters: [id('projectId'), id('userId')], responses: { 204: { description: 'Removed' } } }, false) },
      '/admin/users': {
        get: op('Admin', 'List users', { responses: { 200: ok({ type: 'array', items: ref('User') }) } }, false),
        post: op('Admin', 'Create a user (temporary password returned when none is given)', {
          requestBody: { content: json({ type: 'object', required: ['email'], properties: { email: { type: 'string' }, name: { type: 'string' }, role: { enum: ['admin', 'user'] }, password: { type: 'string' }, projects: { type: 'array', items: { type: 'object', properties: { projectId: { type: 'string' }, role: ref('ProjectRole') } } } } }) },
          responses: { 201: ok({ type: 'object', properties: { user: ref('User'), temporaryPassword: { type: 'string' } } }) },
        }, false),
      },
      '/admin/users/{userId}': { patch: op('Admin', 'Update name, role or active flag', { parameters: [id('userId')] }, false) },
      '/admin/users/{userId}/reset-password': { post: op('Admin', 'Reset to a temporary password', { parameters: [id('userId')] }, false) },
      '/admin/users/{userId}/unlock': { post: op('Admin', 'Unlock a locked account', { parameters: [id('userId')] }, false) },
      '/admin/audit': { get: op('Audit', 'Installation-wide audit log', { parameters: [q('projectId', { type: 'string' }), q('userId', { type: 'string' }), q('action', { type: 'string' }, 'Prefix, e.g. "agent."'), q('from', { type: 'string', format: 'date-time' }), q('to', { type: 'string', format: 'date-time' }), q('format', { enum: ['json', 'csv'] })] }, false) },

      // ── Agents ───────────────────────────────────────────────────────────
      '/agents': {
        get: op('Agents', 'List agents', { responses: { 200: ok({ type: 'array', items: ref('Agent') }) } }),
        post: op('Agents', 'Create an agent (editor)', { requestBody: { content: json(ref('AgentInput')) }, responses: { 201: ok(ref('Agent')), 409: err('Name already used in the project') } }),
      },
      '/agents/{id}': {
        get: op('Agents', 'Get an agent (secrets redacted)', { parameters: [id()], responses: { 200: ok(ref('Agent')) } }),
        put: op('Agents', 'Update an agent (changing secrets requires admin)', { parameters: [id()], requestBody: { content: json(ref('AgentInput')) } }),
        delete: op('Agents', 'Delete an agent (admin)', { parameters: [id()], responses: { 204: { description: 'Deleted' } } }),
      },
      '/agents/{id}/plan': { get: op('Agents', 'Tests the next run would execute', { parameters: [id()] }) },
      '/visual/baselines': { get: op('Quality', 'Visual baselines of the project', { parameters: [{ name: 'agentId', in: 'query', schema: { type: 'string' } }] }) },
      '/visual/baselines/{id}': { delete: op('Quality', 'Delete a visual baseline', { parameters: [id()] }) },
      '/runs/{runId}/results/{resultId}/visual/approve': {
        post: op('Quality', 'Approve the screenshot of a failed visual check as the new baseline', { parameters: [id('runId'), id('resultId')] }),
      },
      '/agents/{id}/generate-api-tests': {
        post: op('Quality', 'Generate API test cases from an OpenAPI / Swagger description (smoke tests, or AI-written edge cases)', { parameters: [id()] }),
      },
      '/testdata/generate': {
        post: op('Test data', 'Generate data set rows with Faker ({ fields: { column: kind } }) or the AI ({ prompt }); save: true stores them', {
          requestBody: { content: json({ type: 'object', properties: {
            fields: { type: 'object', additionalProperties: { type: 'string' }, example: { name: 'fullName', email: 'email' } },
            prompt: { type: 'string' }, count: { type: 'integer', maximum: 100 }, locale: { type: 'string', example: 'it' }, seed: { type: 'string' },
            save: { type: 'boolean' }, name: { type: 'string' }, environment: { type: 'string' }, provider: { type: 'string' },
          } }) },
        }),
      },
      '/testdata/fake-kinds': { get: op('Test data', 'Kinds usable as {{fake.kind}} in steps, with an example', { parameters: [q('locale', { type: 'string' })] }) },
      '/testdata': {
        get: op('Test data', 'List data sets'),
        post: op('Test data', 'Create a data set ({ name, data: { rows: [...] } } or data: [...])'),
      },
      '/testdata/{id}': {
        get: op('Test data', 'Get a data set (with rowCount)', { parameters: [id()] }),
        put: op('Test data', 'Update a data set', { parameters: [id()] }),
        delete: op('Test data', 'Delete a data set (project admin)', { parameters: [id()], responses: { 204: { description: 'Deleted' } } }),
      },
      '/agents/{id}/performance': {
        get: op('Quality', 'Page speed trend of an agent: per page, samples (oldest first), latest and median metrics', { parameters: [id(), q('days', { type: 'integer' })] }),
      },
      '/runs/{runId}/results/{resultId}/ai-actions/apply': {
        post: op('Quality', 'Replace an AI action step of the test case with the ordinary steps the AI performed ({ stepId })', { parameters: [id('runId'), id('resultId')] }),
      },
      '/agents/{id}/ai-action-cache': {
        delete: op('Quality', 'Forget cached AI action sequences of an agent (optionally ?testCaseId=): the AI decides again next run', { parameters: [id(), q('testCaseId', { type: 'string' })] }),
      },
      '/auth/health': { get: op('Sign-in', 'Sign-in health of the project: who can sign in unattended, sessions expiring or expired') },
      '/auth/health/warn': { post: op('Sign-in', 'Send the session expiry warnings now (normally hourly)') },
      '/agents/{id}/auth/sessions': {
        get: op('Sign-in', 'Saved sessions of the agent\'s login profiles and Salesforce personas (never their contents)', { parameters: [id()] }),
        delete: op('Sign-in', 'Forget saved sessions (?kind=app|salesforce&identity=name)', { parameters: [id(), q('kind', { type: 'string' }), q('identity', { type: 'string' })] }),
      },
      '/agents/{id}/auth/profiles/{name}/verify': {
        post: op('Sign-in', 'Sign in as a login profile now and save the session ({ fresh: true } ignores the saved one)', { parameters: [id(), id('name', 'Login profile name')] }),
      },
      '/agents/{id}/code-sources/{name}/check': {
        post: op('Sign-in', 'Check a mailbox / phone number for verification codes: connects and returns the newest message time and subject', { parameters: [id(), id('name', 'Code source name')] }),
      },
      '/agents/{id}/auth/totp': {
        get: op('Sign-in', 'Current code of a saved authenticator key, to compare with the phone (the key is never returned)', { parameters: [id(), q('kind', { type: 'string' }), q('identity', { type: 'string' })] }),
      },
      '/agents/{id}/auth/interactive': {
        post: op('Sign-in', 'Sign in once: open the sign-in page of a login profile or Salesforce persona in a server browser ({ kind, identity })', { parameters: [id()] }),
      },
      '/auth/interactive/{sid}': {
        get: op('Sign-in', 'State of a sign-in browser', { parameters: [id('sid')] }),
        delete: op('Sign-in', 'Close a sign-in browser without saving', { parameters: [id('sid')] }),
      },
      '/auth/interactive/{sid}/screenshot': { get: op('Sign-in', 'Current screen (JPEG)', { parameters: [id('sid')] }) },
      '/auth/interactive/{sid}/input': { post: op('Sign-in', 'Click, type, press a key, scroll, navigate or type a stored value', { parameters: [id('sid')] }) },
      '/auth/interactive/{sid}/finish': { post: op('Sign-in', 'Save the session to the vault and close the browser ({ force })', { parameters: [id('sid')] }) },
      '/recordings': {
        get: op('Recorder', 'Your open recording sessions in this project'),
        post: op('Recorder', 'Start recording: a server-side browser opens the agent\'s application ({ agentId, startPath?, persona? })'),
      },
      '/recordings/{id}': {
        get: op('Recorder', 'Recording state: URL, title, recorded steps', { parameters: [id()] }),
        delete: op('Recorder', 'Stop recording and close the browser', { parameters: [id()], responses: { 204: { description: 'Closed' } } }),
      },
      '/recordings/{id}/screenshot': { get: op('Recorder', 'Current screen (JPEG, 1280×800)', { parameters: [id()] }) },
      '/recordings/{id}/inspect': { post: op('Recorder', 'Element at a point of the screen ({ x, y }) with its most robust unique selector and the suggested action', { parameters: [id()] }) },
      '/recordings/{id}/steps': { post: op('Recorder', 'Perform and record a step ({ action, target?, value?, secret? }); record: false only performs it', { parameters: [id()] }) },
      '/recordings/{id}/steps/{index}': { delete: op('Recorder', 'Remove a recorded step (not undone in the browser)', { parameters: [id(), id('index', 'Step index (0-based)')] }) },
      '/recordings/{id}/scroll': { post: op('Recorder', 'Scroll the page ({ dy }), not recorded', { parameters: [id()] }) },
      '/recordings/{id}/save': { post: op('Recorder', 'Save the recorded steps as a test case ({ title, module?, priority?, tags? })', { parameters: [id()] }) },
      '/recordings/import': { post: op('Recorder', 'Convert a `npx playwright codegen` script (JS/TS or Python) to steps ({ script, agentId?, save?, title? })') },
      '/quarantine': { get: op('Quality', 'Quarantined (flaky) test cases of the project') },
      '/testcases/{id}/quarantine': {
        post: op('Quality', 'Quarantine a test case: it runs, but its failures do not fail runs', { parameters: [id()] }),
        delete: op('Quality', 'Release a quarantined test case', { parameters: [id()] }),
      },
      '/runs/{runId}/triage': {
        post: op('Quality', 'Group and classify the failures of a run (app bug, test bug, environment), optionally explained by the AI', { parameters: [id('runId')] }),
      },
      '/runs/{runId}/results/{resultId}/apply-healing': {
        post: op('Quality', 'Write AI-repaired selectors of a result back into its test case', { parameters: [id('runId'), id('resultId')] }),
      },
      '/agents/{id}/salesforce/personas/{name}/verify': {
        post: op('Agents', 'Log in as a Salesforce persona and report its profile and permission sets', { parameters: [id(), id('name', 'Persona name')] }),
      },
      '/agents/{id}/generate-tests': { post: op('Agents', 'Generate tests with AI from the live page', { parameters: [id()], requestBody: { content: json({ type: 'object', properties: { description: { type: 'string' }, count: { type: 'integer' }, save: { type: 'boolean' } } }) } }) },

      // ── Test cases ───────────────────────────────────────────────────────
      '/testcases': {
        get: op('Test cases', 'List / search test cases', { parameters: [q('q', { type: 'string' }), q('module', { type: 'string' }), q('priority', { type: 'string' }), q('tags', { type: 'string' })], responses: { 200: ok({ type: 'array', items: ref('TestCase') }) } }),
        post: op('Test cases', 'Create a test case (editor)', { requestBody: { content: json(ref('TestCase')) }, responses: { 201: ok(ref('TestCase')) } }),
      },
      '/testcases/{id}': {
        get: op('Test cases', 'Get a test case', { parameters: [id()] }),
        put: op('Test cases', 'Update a test case', { parameters: [id()] }),
        delete: op('Test cases', 'Delete a test case', { parameters: [id()], responses: { 204: { description: 'Deleted' } } }),
      },

      // ── Documents ────────────────────────────────────────────────────────
      '/ingestion/upload': { post: op('Documents', 'Upload a test specification', { requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } }, responses: { 201: ok({}) } }) },
      '/ingestion/documents': { get: op('Documents', 'List documents') },
      '/ingestion/documents/{documentId}/extract': { post: op('Documents', 'Extract test cases with AI', { parameters: [id('documentId')], responses: { 200: ok({}), 503: err('No AI provider configured') } }) },

      // ── Runs ─────────────────────────────────────────────────────────────
      '/runs': {
        get: op('Runs', 'List runs', { parameters: [q('agentId', { type: 'string' }), q('limit', { type: 'integer' })], responses: { 200: ok({ type: 'array', items: ref('Run') }) } }),
        post: op('Runs', 'Start a run; with wait=true block until it finishes (CI)', {
          parameters: [q('wait', { type: 'boolean' }), q('timeoutSeconds', { type: 'integer', default: 1800 })],
          requestBody: { required: true, content: json({ type: 'object', required: ['agentId'], properties: { agentId: { type: 'string' }, testIds: { type: 'array', items: { type: 'string' } }, wait: { type: 'boolean' }, timeoutSeconds: { type: 'integer' } } }) },
          responses: { 201: ok(ref('Run'), 'Started'), 200: ok(ref('Run'), 'Finished (wait mode); `passed` tells whether every test passed'), 202: ok(ref('Run'), 'Still running when the wait timed out'), 400: err('No tests match') },
        }),
      },
      '/runs/{id}': { get: op('Runs', 'Run with per-test results', { parameters: [id()], responses: { 200: ok(ref('Run')) } }) },
      '/runs/{id}/cancel': { post: op('Runs', 'Cancel a run', { parameters: [id()] }) },
      '/runs/{id}/report': { get: op('Runs', 'Report as HTML, JUnit XML or JSON', { parameters: [id(), q('format', { enum: ['html', 'junit', 'json'] }), q('download', { type: 'boolean' })] }) },

      // ── Schedules ────────────────────────────────────────────────────────
      '/schedules': {
        get: op('Schedules', 'List schedules', { parameters: [q('agentId', { type: 'string' })] }),
        post: op('Schedules', 'Create a schedule (editor)', { requestBody: { content: json(ref('ScheduleInput')) }, responses: { 201: ok(ref('Schedule')) } }),
      },
      '/schedules/{id}': {
        put: op('Schedules', 'Update a schedule', { parameters: [id()], requestBody: { content: json(ref('ScheduleInput')) } }),
        delete: op('Schedules', 'Delete a schedule', { parameters: [id()], responses: { 204: { description: 'Deleted' } } }),
      },
      '/schedules/{id}/run': { post: op('Schedules', 'Run a schedule now', { parameters: [id()] }) },

      // ── Notifications ────────────────────────────────────────────────────
      '/notifications': {
        get: op('Notifications', 'List channels (secrets redacted)'),
        post: op('Notifications', 'Create a channel (project admin)', { requestBody: { content: json(ref('ChannelInput')) }, responses: { 201: ok({}) } }),
      },
      '/notifications/{id}': {
        put: op('Notifications', 'Update a channel', { parameters: [id()] }),
        delete: op('Notifications', 'Delete a channel', { parameters: [id()], responses: { 204: { description: 'Deleted' } } }),
      },
      '/notifications/{id}/test': { post: op('Notifications', 'Send a test notification', { parameters: [id()] }) },
      '/notifications/{id}/digest': { post: op('Notifications', 'Send the daily digest of a channel now (channel subscribed to digest.daily)', { parameters: [id()] }) },
      '/notifications/{id}/deliveries': { get: op('Notifications', 'Recent deliveries', { parameters: [id()] }) },

      // ── Integrations (Jira, GitHub, GitLab, Azure DevOps) ────────────────
      '/integrations': {
        get: op('Integrations', 'List integrations (secrets redacted)'),
        post: op('Integrations', 'Add an integration (project admin): { type: jira, name, config: { base_url, deployment?, email, api_token, project_key, bug_issue_type?, defects: { enabled, categories, only_unattended, resolve_transition } } }', { responses: { 201: ok({}) } }),
      },
      '/integrations/{id}': {
        put: op('Integrations', 'Update an integration (config is merged; omitted secrets are kept)', { parameters: [id()] }),
        delete: op('Integrations', 'Delete an integration', { parameters: [id()], responses: { 204: { description: 'Deleted' } } }),
      },
      '/integrations/{id}/check': { post: op('Integrations', 'Check the connection (account and project)', { parameters: [id()] }) },
      '/integrations/{id}/issues': { get: op('Integrations', 'Search issues: keys (PROJ-1, PROJ-2), JQL or words', { parameters: [id(), q('q', { type: 'string' }), q('limit', { type: 'integer', default: 25 })] }) },
      '/integrations/{id}/import': { post: op('Integrations', 'Import stories as AI-written tests linked to them: { keys: [..] } or { query }, module?, agentId?', { parameters: [id()] }) },
      '/testcases/{id}/links': {
        get: op('Integrations', 'Issues a test covers', { parameters: [id()] }),
        post: op('Integrations', 'Link a test to an issue: { integrationId, key }', { parameters: [id()], responses: { 201: ok({}) } }),
      },
      '/testcases/{id}/links/{integrationId}/{key}': { delete: op('Integrations', 'Unlink', { parameters: [id(), { name: 'integrationId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'key', in: 'path', required: true, schema: { type: 'string' } }], responses: { 204: { description: 'Unlinked' } } }) },
      '/integrations/{id}/workflow': { get: op('Integrations', 'GitHub Actions workflow running an agent\'s tests on pull requests and pushes: { path, secret, yaml }', { parameters: [id(), q('agentId', { type: 'string' }), q('branch', { type: 'string' }), q('apiUrl', { type: 'string' })] }) },
      '/hooks/github/{integrationId}': { post: op('Integrations', 'GitHub webhook (no login; X-Hub-Signature-256 HMAC with the integration\'s webhook_secret): push, pull_request and deployment_status start the runs of matching triggers', { parameters: [{ name: 'integrationId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 202: { description: '{ runs: [{ agentId, runId }] } or { ignored }' } } }, false) },
      '/requirements/coverage': { get: op('Integrations', 'Linked stories / issues with their tests\' latest results: passing, failing, partial, not_run') },
      '/defects': { get: op('Integrations', 'Bugs filed by the platform (open / resolved)', { parameters: [q('status', { enum: ['open', 'resolved'] }), q('agentId', { type: 'string' })] }) },

      // ── Analytics, audit, AI ─────────────────────────────────────────────
      '/analytics': { get: op('Analytics', 'Trends, flaky, failing and slowest tests', { parameters: [q('days', { type: 'integer', default: 30 })] }) },
      '/audit': { get: op('Audit', 'Audit log of the current project (project admin)', { parameters: [q('userId', { type: 'string' }), q('action', { type: 'string' }), q('format', { enum: ['json', 'csv'] })] }) },
      '/chat': { post: op('AI', 'Chat with the QA assistant', {}, false) },
      '/llm/providers': { get: op('AI', 'AI provider status (?check=true pings them)', {}, false) },
    },
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        apiKey: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'Value: "ApiKey <key>"' },
      },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' }, code: { type: 'string' } } },
        ProjectRole: { type: 'string', enum: ['viewer', 'editor', 'admin', 'owner'] },
        TokenResponse: { type: 'object', properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string' }, user: ref('User') } },
        User: { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' }, role: { enum: ['admin', 'user'] }, active: { type: 'boolean' }, mustChangePassword: { type: 'boolean' }, lockedUntil: { type: 'string', format: 'date-time' } } },
        Me: { type: 'object', properties: { authEnabled: { type: 'boolean' }, user: ref('User'), projects: { type: 'array', items: ref('Project') } } },
        Project: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' }, archived: { type: 'boolean' }, role: ref('ProjectRole') } },
        AgentInput: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            config: {
              type: 'object',
              properties: {
                base_url: { type: 'string', format: 'uri' },
                environment: { type: 'string' },
                test_selection: { type: 'object', properties: { module: { type: 'array', items: { type: 'string' } }, priority: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } }, testIds: { type: 'array', items: { type: 'string' } } } },
                secrets: { type: 'object', additionalProperties: { type: 'string' }, description: 'Use in steps as {{secrets.NAME}}. Send "••••••••" to keep a stored value, "" to delete it.' },
                ai: { type: 'object', properties: { provider: { type: 'string' }, self_healing: { type: 'boolean' } } },
                retries: { type: 'integer', minimum: 0, maximum: 3 },
              },
            },
            status: { enum: ['active', 'inactive', 'archived'] },
          },
        },
        Agent: { allOf: [ref('AgentInput'), { type: 'object', properties: { id: { type: 'string' }, projectId: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' } } }] },
        TestStep: { type: 'object', required: ['action'], properties: { action: { type: 'string', examples: ['navigate', 'click', 'fill', 'assert_text'] }, target: { type: 'string' }, data: { type: 'object' }, expectedResult: { type: 'string' } } },
        TestCase: {
          type: 'object', required: ['title', 'module'],
          properties: { id: { type: 'string' }, title: { type: 'string' }, module: { type: 'string' }, priority: { enum: ['Low', 'Medium', 'High', 'Critical'] }, type: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, steps: { type: 'array', items: ref('TestStep') }, expectedResults: { type: 'array', items: { type: 'string' } } },
        },
        Run: {
          type: 'object',
          properties: {
            id: { type: 'string' }, agentId: { type: 'string' }, agentName: { type: 'string' }, projectId: { type: 'string' },
            status: { enum: ['pending', 'running', 'completed', 'failed', 'cancelled'] },
            totalTests: { type: 'integer' }, passedTests: { type: 'integer' }, failedTests: { type: 'integer' }, skippedTests: { type: 'integer' },
            startedAt: { type: 'string', format: 'date-time' }, finishedAt: { type: 'string', format: 'date-time' }, duration: { type: 'integer' },
            passed: { type: 'boolean', description: 'Wait mode only' },
            results: { type: 'array', items: { type: 'object' } },
          },
        },
        ScheduleInput: { type: 'object', properties: { agentId: { type: 'string' }, name: { type: 'string' }, cron: { type: 'string', examples: ['0 6 * * 1-5'] }, timezone: { type: 'string', examples: ['Europe/Rome'] }, enabled: { type: 'boolean' } } },
        Schedule: { allOf: [ref('ScheduleInput'), { type: 'object', properties: { id: { type: 'string' }, nextRunAt: { type: 'string', format: 'date-time' }, lastRunId: { type: 'string' }, lastError: { type: 'string' } } }] },
        ChannelInput: {
          type: 'object', required: ['name', 'type', 'config'],
          properties: {
            name: { type: 'string' },
            type: { enum: ['webhook', 'slack', 'teams', 'email'] },
            config: { type: 'object', description: 'webhook: { url, secret? } · slack/teams: { webhookUrl } · email: { recipients: [] }' },
            events: { type: 'array', items: { enum: ['run.completed', 'run.failed', 'run.cancelled'] } },
            enabled: { type: 'boolean' },
          },
        },
      },
    },
  };
}
