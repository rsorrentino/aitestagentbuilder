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
  max_parallel_tests?: number;
  timeout?: number;
  retries?: number;
  metadata?: Record<string, any>;
}

export interface Agent {
  id: string;
  name: string;
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

