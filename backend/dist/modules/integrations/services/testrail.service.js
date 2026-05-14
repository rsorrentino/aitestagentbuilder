/**
 * TestRail Integration Service
 */
import axios from 'axios';
import logger from '../../../infra/logger/index.js';
export class TestRailService {
    config;
    baseUrl;
    constructor(config) {
        this.config = config;
        this.baseUrl = `${config.baseUrl}/index.php?/api/v2`;
    }
    /**
     * Create a test run in TestRail
     */
    async createRun(projectId, runData) {
        try {
            const response = await axios.post(`${this.baseUrl}/add_run/${projectId}`, runData, {
                auth: {
                    username: this.config.username,
                    password: this.config.apiKey,
                },
            });
            return response.data;
        }
        catch (error) {
            logger.error('TestRail create run failed', { error: error.message });
            throw new Error(`TestRail integration failed: ${error.message}`);
        }
    }
    /**
     * Add test result to TestRail
     */
    async addResult(runId, caseId, result) {
        try {
            const response = await axios.post(`${this.baseUrl}/add_result/${caseId}`, {
                ...result,
                run_id: runId,
            }, {
                auth: {
                    username: this.config.username,
                    password: this.config.apiKey,
                },
            });
            return response.data;
        }
        catch (error) {
            logger.error('TestRail add result failed', { error: error.message });
            throw new Error(`TestRail integration failed: ${error.message}`);
        }
    }
    /**
     * Close test run
     */
    async closeRun(runId) {
        try {
            const response = await axios.post(`${this.baseUrl}/close_run/${runId}`, {}, {
                auth: {
                    username: this.config.username,
                    password: this.config.apiKey,
                },
            });
            return response.data;
        }
        catch (error) {
            logger.error('TestRail close run failed', { error: error.message });
            throw new Error(`TestRail integration failed: ${error.message}`);
        }
    }
    /**
     * Map test result status to TestRail status ID
     */
    mapStatusToTestRail(status) {
        const statusMap = {
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
//# sourceMappingURL=testrail.service.js.map