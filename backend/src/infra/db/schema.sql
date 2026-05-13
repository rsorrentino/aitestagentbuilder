-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Users table (for authentication)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(255) PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'user',
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- API Keys table
CREATE TABLE IF NOT EXISTS api_keys (
    id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255),
    permissions JSONB DEFAULT '[]'::jsonb,
    active BOOLEAN DEFAULT true,
    expires_at TIMESTAMP,
    last_used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_active ON api_keys(active);

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(500) NOT NULL,
    source_type VARCHAR(50) NOT NULL,
    content TEXT,
    file_path VARCHAR(1000),
    file_size BIGINT,
    mime_type VARCHAR(100),
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    uploaded_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
    metadata JSONB
);

CREATE INDEX idx_documents_source_type ON documents(source_type);
CREATE INDEX idx_documents_uploaded_at ON documents(uploaded_at);

-- Test Cases table
CREATE TABLE IF NOT EXISTS test_cases (
    id VARCHAR(255) PRIMARY KEY,
    title VARCHAR(500) NOT NULL,
    module VARCHAR(255) NOT NULL,
    description TEXT,
    steps JSONB NOT NULL,
    expected_results JSONB NOT NULL,
    preconditions JSONB,
    postconditions JSONB,
    priority VARCHAR(20) NOT NULL,
    tags JSONB,
    type VARCHAR(50),
    data JSONB,
    metadata JSONB,
    version VARCHAR(20) DEFAULT '1.0.0',
    versions JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    document_id VARCHAR(255) REFERENCES documents(id) ON DELETE SET NULL,
    created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_test_cases_module ON test_cases(module);
CREATE INDEX idx_test_cases_priority ON test_cases(priority);
CREATE INDEX idx_test_cases_type ON test_cases(type);
CREATE INDEX idx_test_cases_document_id ON test_cases(document_id);
CREATE INDEX idx_test_cases_tags ON test_cases USING GIN(tags);
CREATE INDEX idx_test_cases_version ON test_cases(version);

-- Test Case Versions table (for version history)
CREATE TABLE IF NOT EXISTS test_case_versions (
    id VARCHAR(255) PRIMARY KEY,
    test_case_id VARCHAR(255) NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    version VARCHAR(20) NOT NULL,
    title VARCHAR(500),
    steps JSONB,
    expected_results JSONB,
    changes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_test_case_versions_test_case_id ON test_case_versions(test_case_id);
CREATE INDEX idx_test_case_versions_version ON test_case_versions(version);

-- Vector embeddings for semantic search (using pgvector)
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS embedding vector(1536);

CREATE INDEX IF NOT EXISTS idx_test_cases_embedding ON test_cases 
USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    config JSONB NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_name ON agents(name);

-- Test Runs table
CREATE TABLE IF NOT EXISTS runs (
    id VARCHAR(255) PRIMARY KEY,
    agent_id VARCHAR(255) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP,
    duration BIGINT, -- milliseconds
    total_tests INTEGER DEFAULT 0,
    passed_tests INTEGER DEFAULT 0,
    failed_tests INTEGER DEFAULT 0,
    skipped_tests INTEGER DEFAULT 0,
    metadata JSONB,
    created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_runs_agent_id ON runs(agent_id);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_started_at ON runs(started_at);

-- Test Results table
CREATE TABLE IF NOT EXISTS results (
    id VARCHAR(255) PRIMARY KEY,
    run_id VARCHAR(255) NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    test_case_id VARCHAR(255) NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL,
    started_at TIMESTAMP NOT NULL,
    finished_at TIMESTAMP,
    duration BIGINT, -- milliseconds
    logs JSONB,
    error TEXT,
    evidence JSONB,
    validation_results JSONB,
    metadata JSONB,
    retry_count INTEGER DEFAULT 0,
    performance_metrics JSONB
);

CREATE INDEX idx_results_run_id ON results(run_id);
CREATE INDEX idx_results_test_case_id ON results(test_case_id);
CREATE INDEX idx_results_status ON results(status);
CREATE INDEX idx_results_retry_count ON results(retry_count);

-- Reports table (for storing generated reports)
CREATE TABLE IF NOT EXISTS reports (
    id VARCHAR(255) PRIMARY KEY,
    run_id VARCHAR(255) NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    format VARCHAR(50) NOT NULL,
    file_path VARCHAR(1000),
    content TEXT,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB
);

CREATE INDEX idx_reports_run_id ON reports(run_id);
CREATE INDEX idx_reports_format ON reports(format);

-- Test Data table
CREATE TABLE IF NOT EXISTS test_data (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    data JSONB NOT NULL,
    tags JSONB,
    environment VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_test_data_name ON test_data(name);
CREATE INDEX idx_test_data_environment ON test_data(environment);
