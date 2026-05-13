/**
 * Jira Integration Service
 */
import axios from 'axios';
import logger from '../../../infra/logger/index.js';
export class JiraService {
    config;
    baseUrl;
    constructor(config) {
        this.config = config;
        this.baseUrl = `${config.baseUrl}/rest/api/3`;
    }
    /**
     * Create a Jira issue
     */
    async createIssue(issue) {
        try {
            const response = await axios.post(`${this.baseUrl}/issue`, issue, {
                auth: {
                    username: this.config.username,
                    password: this.config.apiToken,
                },
                headers: {
                    'Content-Type': 'application/json',
                },
            });
            return response.data;
        }
        catch (error) {
            logger.error('Jira create issue failed', { error: error.message });
            throw new Error(`Jira integration failed: ${error.message}`);
        }
    }
    /**
     * Create test execution issue
     */
    async createTestExecutionIssue(projectKey, summary, description) {
        const issue = {
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
    async addComment(issueKey, comment) {
        try {
            const response = await axios.post(`${this.baseUrl}/issue/${issueKey}/comment`, comment, {
                auth: {
                    username: this.config.username,
                    password: this.config.apiToken,
                },
                headers: {
                    'Content-Type': 'application/json',
                },
            });
            return response.data;
        }
        catch (error) {
            logger.error('Jira add comment failed', { error: error.message });
            throw new Error(`Jira integration failed: ${error.message}`);
        }
    }
    /**
     * Update issue status
     */
    async updateIssueStatus(issueKey, statusId) {
        try {
            const response = await axios.post(`${this.baseUrl}/issue/${issueKey}/transitions`, {
                transition: { id: statusId },
            }, {
                auth: {
                    username: this.config.username,
                    password: this.config.apiToken,
                },
                headers: {
                    'Content-Type': 'application/json',
                },
            });
            return response.data;
        }
        catch (error) {
            logger.error('Jira update status failed', { error: error.message });
            throw new Error(`Jira integration failed: ${error.message}`);
        }
    }
}
//# sourceMappingURL=jira.service.js.map