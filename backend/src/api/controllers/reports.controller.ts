/**
 * Reports Controller
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../../infra/auth/auth.middleware.js';
import {
  REPORT_CONTENT_TYPES,
  ReportFormat,
  ReportingAgentService,
} from '../../modules/reporting/services/reporting-agent.service.js';
import logger from '../../infra/logger/index.js';
import { signRunArtifacts } from '../../infra/security/signed-urls.js';

export class ReportsController {
  private reporting = new ReportingAgentService();

  /**
   * GET /runs/:runId/report?format=html|json|junit[&download=1]
   * Renders the report on the fly.
   */
  async downloadReport(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const format = ((req.query.format as string) || 'html').toLowerCase() as ReportFormat;
      const meta = REPORT_CONTENT_TYPES[format];
      if (!meta) {
        res.status(400).json({ error: 'format must be one of html, json, junit' });
        return;
      }
      const run = signRunArtifacts(await this.reporting.loadRun(req.params.runId, req.project!.id));
      const artifactsBaseUrl = `${req.protocol}://${req.get('host')}/artifacts/`;
      const content = this.reporting.render(run, format, { artifactsBaseUrl });

      res.setHeader('Content-Type', meta.type);
      if (req.query.download) {
        res.setHeader('Content-Disposition', `attachment; filename="report-${run.id}.${meta.ext}"`);
      }
      res.send(content);
    } catch (error: any) {
      const notFound = /not found/i.test(error.message);
      if (!notFound) logger.error('Report rendering failed', { error: error.message });
      res.status(notFound ? 404 : 500).json({ error: error.message });
    }
  }

  /** POST /reports/runs/:runId/generate — writes report files to REPORT_STORAGE_PATH */
  async generateReport(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { formats, includeScreenshots, includeLogs } = req.body ?? {};
      await this.reporting.loadRun(req.params.runId, req.project!.id);
      const reports = await this.reporting.generateReports(req.params.runId, {
        formats: Array.isArray(formats) && formats.length ? formats : ['json', 'html', 'junit'],
        includeScreenshots: includeScreenshots ?? true,
        includeLogs: includeLogs ?? true,
      });
      res.json({ runId: req.params.runId, reports, message: `Generated ${reports.length} report(s)` });
    } catch (error: any) {
      const notFound = /not found/i.test(error.message);
      if (!notFound) logger.error('Report generation failed', { error: error.message });
      res.status(notFound ? 404 : 500).json({ error: error.message });
    }
  }
}
