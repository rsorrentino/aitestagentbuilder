/**
 * Versioned database migrations.
 *
 * Each migration runs once, inside a transaction, and is recorded in
 * `schema_migrations`. A Postgres advisory lock makes concurrent starts
 * (several API replicas) safe. Migration 1 is the original idempotent schema,
 * so databases created before versioning upgrade cleanly.
 */

import { CORE_SCHEMA } from './schema.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'core schema', sql: CORE_SCHEMA },

  {
    version: 2,
    name: 'projects and project membership',
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(100) NOT NULL UNIQUE,
        description TEXT,
        archived BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by VARCHAR(255)
      );

      CREATE TABLE IF NOT EXISTS project_members (
        project_id VARCHAR(255) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL CHECK (role IN ('viewer', 'editor', 'admin', 'owner')),
        added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

      INSERT INTO projects (id, name, slug, description)
      VALUES ('default', 'Default', 'default', 'Default project')
      ON CONFLICT (id) DO NOTHING;

      -- Existing rows are backfilled into the Default project
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS project_id VARCHAR(255) NOT NULL DEFAULT 'default' REFERENCES projects(id) ON DELETE CASCADE;
      ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS project_id VARCHAR(255) NOT NULL DEFAULT 'default' REFERENCES projects(id) ON DELETE CASCADE;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS project_id VARCHAR(255) NOT NULL DEFAULT 'default' REFERENCES projects(id) ON DELETE CASCADE;
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS project_id VARCHAR(255) NOT NULL DEFAULT 'default' REFERENCES projects(id) ON DELETE CASCADE;
      ALTER TABLE test_data ADD COLUMN IF NOT EXISTS project_id VARCHAR(255) NOT NULL DEFAULT 'default' REFERENCES projects(id) ON DELETE CASCADE;

      CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
      CREATE INDEX IF NOT EXISTS idx_test_cases_project ON test_cases(project_id);
      CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
      CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_test_data_project ON test_data(project_id);

      -- Agent names are unique per project, not globally
      ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_name_key;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_project_name ON agents(project_id, name);
    `,
  },

  {
    version: 3,
    name: 'account security, scoped API keys, audit log',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP;

      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS project_id VARCHAR(255) REFERENCES projects(id) ON DELETE CASCADE;
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS role VARCHAR(20);
      ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_prefix VARCHAR(16);

      CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        user_id VARCHAR(255),
        user_email VARCHAR(255),
        action VARCHAR(100) NOT NULL,
        entity_type VARCHAR(50),
        entity_id VARCHAR(255),
        project_id VARCHAR(255),
        status INTEGER,
        ip VARCHAR(100),
        user_agent VARCHAR(500),
        details JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id, at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    `,
  },

  {
    version: 4,
    name: 'schedules and notifications',
    sql: `
      CREATE TABLE IF NOT EXISTS schedules (
        id VARCHAR(255) PRIMARY KEY,
        project_id VARCHAR(255) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_id VARCHAR(255) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        cron VARCHAR(100) NOT NULL,
        timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
        enabled BOOLEAN NOT NULL DEFAULT true,
        next_run_at TIMESTAMP,
        last_run_at TIMESTAMP,
        last_run_id VARCHAR(255),
        last_error TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by VARCHAR(255)
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(next_run_at) WHERE enabled;
      CREATE INDEX IF NOT EXISTS idx_schedules_agent ON schedules(agent_id);

      CREATE TABLE IF NOT EXISTS notification_channels (
        id VARCHAR(255) PRIMARY KEY,
        project_id VARCHAR(255) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(20) NOT NULL CHECK (type IN ('webhook', 'slack', 'teams', 'email')),
        config JSONB NOT NULL,
        events JSONB NOT NULL DEFAULT '["run.failed"]'::jsonb,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by VARCHAR(255)
      );
      CREATE INDEX IF NOT EXISTS idx_channels_project ON notification_channels(project_id);

      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id BIGSERIAL PRIMARY KEY,
        channel_id VARCHAR(255) NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
        event VARCHAR(50) NOT NULL,
        run_id VARCHAR(255),
        status VARCHAR(20) NOT NULL,
        response_code INTEGER,
        error TEXT,
        attempted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_channel ON notification_deliveries(channel_id, attempted_at DESC);
    `,
  },
  {
    version: 5,
    name: 'visual regression baselines',
    sql: `
      CREATE TABLE IF NOT EXISTS visual_baselines (
        id VARCHAR(255) PRIMARY KEY,
        project_id VARCHAR(255) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_id VARCHAR(255) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        persona VARCHAR(100) NOT NULL DEFAULT '',
        viewport VARCHAR(20) NOT NULL,
        path TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        source_run_id VARCHAR(255),
        approved_by VARCHAR(255),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (agent_id, name, persona, viewport)
      );
      CREATE INDEX IF NOT EXISTS idx_visual_baselines_project ON visual_baselines(project_id, agent_id);
    `,
  },
  {
    version: 6,
    name: 'flaky test quarantine',
    sql: `
      CREATE TABLE IF NOT EXISTS test_quarantine (
        test_case_id VARCHAR(255) PRIMARY KEY REFERENCES test_cases(id) ON DELETE CASCADE,
        project_id VARCHAR(255) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        auto BOOLEAN NOT NULL DEFAULT false,
        quarantined_by VARCHAR(255),
        quarantined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        stats JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_quarantine_project ON test_quarantine(project_id);
    `,
  },
  {
    version: 7,
    name: 'AI action cache',
    sql: `
      CREATE TABLE IF NOT EXISTS ai_action_cache (
        agent_id VARCHAR(255) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        test_case_id VARCHAR(255) NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
        step_id INTEGER NOT NULL,
        variant VARCHAR(200) NOT NULL DEFAULT '',
        instruction_hash VARCHAR(64) NOT NULL,
        actions JSONB NOT NULL,
        uses INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (agent_id, test_case_id, step_id, variant, instruction_hash)
      );
    `,
  },
  {
    version: 8,
    name: 'saved sign-in sessions',
    sql: `
      CREATE TABLE IF NOT EXISTS auth_sessions (
        agent_id VARCHAR(255) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        kind VARCHAR(20) NOT NULL,
        identity VARCHAR(100) NOT NULL,
        state TEXT NOT NULL,
        cookies INTEGER NOT NULL DEFAULT 0,
        captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        last_used_at TIMESTAMP,
        captured_by VARCHAR(20) NOT NULL DEFAULT 'auto',
        captured_by_user VARCHAR(255),
        PRIMARY KEY (agent_id, kind, identity)
      );
    `,
  },
  {
    version: 9,
    name: 'session expiry warnings',
    sql: `ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS warned_at TIMESTAMP;`,
  },
  {
    version: 10,
    name: 'daily digest',
    sql: `ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS last_digest_at TIMESTAMP;`,
  },
  {
    version: 11,
    name: 'integrations (Jira, GitHub, …), requirement links, filed defects',
    sql: `
      CREATE TABLE IF NOT EXISTS integrations (
        id VARCHAR(255) PRIMARY KEY,
        project_id VARCHAR(255) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type VARCHAR(30) NOT NULL,
        name VARCHAR(255) NOT NULL,
        config JSONB NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        last_check JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by VARCHAR(255)
      );
      CREATE INDEX IF NOT EXISTS idx_integrations_project ON integrations(project_id);

      CREATE TABLE IF NOT EXISTS test_links (
        test_case_id VARCHAR(255) NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
        integration_id VARCHAR(255) NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
        issue_key VARCHAR(255) NOT NULL,
        issue_url TEXT,
        issue_title TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (test_case_id, integration_id, issue_key)
      );
      CREATE INDEX IF NOT EXISTS idx_test_links_issue ON test_links(integration_id, issue_key);

      CREATE TABLE IF NOT EXISTS defects (
        id VARCHAR(255) PRIMARY KEY,
        project_id VARCHAR(255) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        integration_id VARCHAR(255) NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
        agent_id VARCHAR(255) NOT NULL,
        signature TEXT NOT NULL,
        issue_key VARCHAR(255) NOT NULL,
        issue_url TEXT,
        title TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'open',
        tests JSONB NOT NULL DEFAULT '[]'::jsonb,
        first_run_id VARCHAR(255),
        last_run_id VARCHAR(255),
        occurrences INTEGER NOT NULL DEFAULT 1,
        last_commented_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_defects_open ON defects(integration_id, agent_id, status);
    `,
  },
];
