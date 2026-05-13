/**
 * TestRail Integration Service
 */

import axios from 'axios';
import logger from '../../../infra/logger/index.js';

export interface TestRailConfig {
  baseUrl: string;
  username: string;
  apiKey: string;
}

export interface TestRailRun {
  suite_id: number;
  name: string;
  description?: string;
  assignedto_id?: number;
  include_all?: boolean;
  case_ids?: number[];
}

export interface TestRailResult {
  status_id: number; // 1=Passed, 2=Blocked, 3=Untested, 4=Retest, 5=Failed
  comment?: string;
  elapsed?: string;
  defects?: string;
  version?: string;
}

export class TestRailService {
  private config: TestRailConfig;
  private baseUrl: string;

  constructor(config: TestRailConfig) {
    this.config = config;
    this.baseUrl = `${config.baseUrl}/index.php?/api/v2`;
  }

  /**
   * Create a test run in TestRail
   */
  async createRun(projectId: number, runData: TestRailRun): Promise<any> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/add_run/${projectId}`,
        runData,
        {
          auth: {
            username: this.config.username,
            password: this.config.apiKey,
          },
        }
      );
      return response.data;
    } catch (error: any) {
      logger.error('TestRail create run failed', { error: error.message });
      throw new Error(`TestRail integration failed: ${error.message}`);
    }
  }

  /**
   * Add test result to TestRail
   */
  async addResult(runId: number, caseId: number, result: TestRailResult): Promise<any> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/add_result/${caseId}`,
        {
          ...result,
          run_id: runId,
        },
        {
          auth: {
            username: this.config.username,
            password: this.config.apiKey,
          },
        }
      );
      return response.data;
    } catch (error: any) {
      logger.error('TestRail add result failed', { error: error.message });
      throw new Error(`TestRail integration failed: ${error.message}`);
    }
  }

  /**
   * Close test run
   */
  async closeRun(runId: number): Promise<any> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/close_run/${runId}`,
        {},
        {
          auth: {
            username: this.config.username,
            password: this.config.apiKey,
          },
        }
      );
      return response.data;
    } catch (error: any) {
      logger.error('TestRail close run failed', { error: error.message });
      throw new Error(`TestRail integration failed: ${error.message}`);
    }
  }

  /**
   * Map test result status to TestRail status ID
   */
  mapStatusToTestRail(status: string): number {
    const statusMap: Record<string, number> = {
      passed: 1,
      blocked: 2,
      untested: 3,
      retest: 4,
      failed: 5,
      error: 5,
      skipped: 2,
    };
    return statusMap[status.toLowerCase()] || 3;
  }
}

