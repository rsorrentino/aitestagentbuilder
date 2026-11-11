/**
 * Core Domain Model: Agent Configuration
 */

export type ApplicationType = 'web' | 'api' | 'mobile' | 'hybrid';
export type BrowserTool = 'playwright' | 'selenium';
export type HttpTool = 'axios' | 'requests';
export type MobileTool = 'appium';

export interface TestSelection {
  module?: string[];
  priority?: ('Low' | 'Medium' | 'High' | 'Critical')[];
  tags?: string[];
  type?: ('Functional' | 'Regression' | 'Integration' | 'Smoke' | 'E2E')[];
  testIds?: string[];
}

export interface AgentTools {
  browser?: BrowserTool;
  http?: HttpTool;
  mobile?: MobileTool;
  db?: boolean;
}

export interface ReportingConfig {
  formats: ('json' | 'html' | 'junit' | 'allure')[];
  exportPath?: string;
  includeScreenshots?: boolean;
  includeLogs?: boolean;
}

export interface AgentConfig {
  agent_name: string;
  application_type: ApplicationType;
  base_url: string;
  test_selection: TestSelection;
  tools: AgentTools;
  reporting: ReportingConfig;
  environment: string;
  /** Named secrets usable in steps as {{secrets.NAME}} (encrypted at rest) */
  secrets?: Record<string, string>;
  /** Salesforce org + personas (see modules/salesforce/personas.ts). Secret fields are encrypted at rest. */
  salesforce?: {
    login_url?: string;
    instance_url?: string;
    api_version?: string;
    default_persona?: string;
    api_persona?: string;
    frontdoor_mode?: 'auto' | 'single_access' | 'sid';
    reuse_sessions?: boolean;
    mfa?: { code_selector?: string; submit_selector?: string };
    connected_app?: { client_id?: string; client_secret?: string; private_key?: string };
    personas?: Array<Record<string, any>>;
    /** legacy single user */
    username?: string;
    password?: string;
    security_token?: string;
    sandbox?: boolean;
  };
  ai?: { provider?: string; self_healing?: boolean; model?: string };
  max_parallel_tests?: number;
  timeout?: number;
  retries?: number;
  metadata?: Record<string, any>;
}

export interface Agent {
  id: string;
  name: string;
  projectId: string;
  config: AgentConfig;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  status: 'active' | 'inactive' | 'archived';
}

export interface AgentCreateInput {
  name: string;
  config: AgentConfig;
  createdBy?: string;
}

export interface AgentUpdateInput {
  name?: string;
  config?: Partial<AgentConfig>;
  status?: Agent['status'];
}

