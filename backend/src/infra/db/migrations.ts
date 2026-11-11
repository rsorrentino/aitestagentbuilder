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
];
