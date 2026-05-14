/**
 * Reports Controller
 */
import { ReportingAgentService } from '../../modules/reporting/services/reporting-agent.service.js';
import logger from '../../infra/logger/index.js';
export class ReportsController {
    reportingAgent = new ReportingAgentService();
    async generateReport(req, res) {
        try {
            const { runId } = req.params;
            const { formats, includeScreenshots, includeLogs, outputPath } = req.body;
            const options = {
                formats: formats || ['json', 'html'],
                includeScreenshots: includeScreenshots ?? true,
                includeLogs: includeLogs ?? true,
                outputPath,
            };
            const reportPaths = await this.reportingAgent.generateReports(runId, options);
            res.json({
                runId,
                reports: reportPaths,
                message: `Generated ${reportPaths.length} report(s)`,
            });
        }
        catch (error) {
            logger.error('Report generation failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
}
//# sourceMappingURL=reports.controller.js.map