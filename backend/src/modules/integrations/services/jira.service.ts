/**
 * Jira Integration Service
 */

import axios from 'axios';
import logger from '../../../infra/logger/index.js';

export interface JiraConfig {
  baseUrl: string;
  username: string;
  apiToken: string;
}

export interface JiraIssue {
  fields: {
    project: { key: string };
    summary: string;
    description?: string;
    issuetype: { name: string };
    priority?: { name: string };
    labels?: string[];
  };
}

export interface JiraComment {
  body: string;
}

export class JiraService {
  private config: JiraConfig;
  private baseUrl: string;

  constructor(config: JiraConfig) {
    this.config = config;
    this.baseUrl = `${config.baseUrl}/rest/api/3`;
  }

  /**
   * Create a Jira issue
   */
  async createIssue(issue: JiraIssue): Promise<any> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/issue`,
        issue,
        {
          auth: {
            username: this.config.username,
            password: this.config.apiToken,
          },
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
      return response.data;
    } catch (error: any) {
      logger.error('Jira create issue failed', { error: error.message });
      throw new Error(`Jira integration failed: ${error.message}`);
    }
  }

  /**
   * Create test execution issue
   */
  async createTestExecutionIssue(
    projectKey: string,
    summary: string,
    description: string
  ): Promise<any> {
    const issue: JiraIssue = {
      fields: {
        project: { key: projectKey },
        summary,
        description,
        issuetype: { name: 'Test Execution' },
        labels: ['automated-testing', 'ai-test-agent'],
      },
    };

    return await this.createIssue(issue);
  }

  /**
   * Add comment to issue
   */
  async addComment(issueKey: string, comment: JiraComment): Promise<any> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/issue/${issueKey}/comment`,
        comment,
        {
          auth: {
            username: this.config.username,
            password: this.config.apiToken,
          },
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
      return response.data;
    } catch (error: any) {
      logger.error('Jira add comment failed', { error: error.message });
      throw new Error(`Jira integration failed: ${error.message}`);
    }
  }

  /**
   * Update issue status
   */
  async updateIssueStatus(issueKey: string, statusId: string): Promise<any> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/issue/${issueKey}/transitions`,
        {
          transition: { id: statusId },
        },
        {
          auth: {
            username: this.config.username,
            password: this.config.apiToken,
          },
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
      return response.data;
    } catch (error: any) {
      logger.error('Jira update status failed', { error: error.message });
      throw new Error(`Jira integration failed: ${error.message}`);
    }
  }
}

