/**
 * Reporting Agent Service
 * Generates test reports in various formats
 */

import { TestRun } from '../../../core/domain/run.js';
import { RunRepository } from '../../../core/repositories/run.repository.js';
import getDatabaseClient from '../../../infra/db/client.js';
import logger from '../../../infra/logger/index.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface ReportOptions {
  formats: ('json' | 'html' | 'junit')[];
  includeScreenshots?: boolean;
  includeLogs?: boolean;
  outputPath?: string;
}

export class ReportingAgentService {
  private runRepo = new RunRepository();
  private db = getDatabaseClient();

  /**
   * Generate reports for a test run
   */
  async generateReports(runId: string, options: ReportOptions): Promise<string[]> {
    const run = await this.runRepo.findRunById(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    const outputPath = options.outputPath || process.env.REPORT_STORAGE_PATH || './reports';
    mkdirSync(outputPath, { recursive: true });

    const generatedReports: string[] = [];

    for (const format of options.formats) {
      try {
        let reportContent: string;
        let fileExtension: string;

        switch (format) {
          case 'json':
            reportContent = this.generateJSONReport(run, options);
            fileExtension = 'json';
            break;
          case 'html':
            reportContent = this.generateHTMLReport(run, options);
            fileExtension = 'html';
            break;
          case 'junit':
            reportContent = this.generateJUnitReport(run);
            fileExtension = 'xml';
            break;
          default:
            continue;
        }

        const filename = `report-${runId}-${Date.now()}.${fileExtension}`;
        const filepath = join(outputPath, filename);
        writeFileSync(filepath, reportContent, 'utf-8');

        // Store report metadata in database
        await this.db.query(
          `INSERT INTO reports (id, run_id, format, file_path, content, generated_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            `REPORT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            runId,
            format,
            filepath,
            format === 'html' ? null : reportContent, // Don't store HTML in DB
            new Date(),
          ]
        );

        generatedReports.push(filepath);
        logger.info('Report generated', { runId, format, filepath });
      } catch (error: any) {
        logger.error('Report generation failed', { runId, format, error: error.message });
      }
    }

    return generatedReports;
  }

  private generateJSONReport(run: TestRun, options: ReportOptions): string {
    const report: any = {
      runId: run.id,
      agentId: run.agentId,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString(),
      duration: run.duration,
      summary: {
        total: run.totalTests,
        passed: run.passedTests,
        failed: run.failedTests,
        skipped: run.skippedTests,
      },
      results: run.results.map(result => ({
        id: result.id,
        testCaseId: result.testCaseId,
        status: result.status,
        duration: result.duration,
        error: result.error,
        validationResults: result.validationResults,
        ...(options.includeLogs && { logs: result.logs }),
        ...(options.includeScreenshots && { evidence: result.evidence }),
      })),
    };

    return JSON.stringify(report, null, 2);
  }

  private generateHTMLReport(run: TestRun, options: ReportOptions): string {
    const passRate = run.totalTests > 0 
      ? ((run.passedTests / run.totalTests) * 100).toFixed(1)
      : '0';

    const statusColor = run.status === 'completed' && run.failedTests === 0 
      ? '#28a745' 
      : run.status === 'failed' || run.failedTests > 0 
      ? '#dc3545' 
      : '#ffc107';

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Test Report - ${run.id}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h1 { color: #333; margin-bottom: 10px; }
        .meta { color: #666; margin-bottom: 30px; }
        .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .summary-card { padding: 20px; border-radius: 8px; background: #f8f9fa; }
        .summary-card h3 { font-size: 14px; color: #666; margin-bottom: 10px; }
        .summary-card .value { font-size: 32px; font-weight: bold; color: #333; }
        .status-badge { display: inline-block; padding: 4px 12px; border-radius: 4px; color: white; background: ${statusColor}; font-size: 12px; font-weight: bold; }
        .results { margin-top: 30px; }
        .result-item { padding: 15px; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 10px; }
        .result-item.passed { border-left: 4px solid #28a745; }
        .result-item.failed { border-left: 4px solid #dc3545; }
        .result-item.error { border-left: 4px solid #dc3545; }
        .result-item.skipped { border-left: 4px solid #6c757d; }
        .result-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .result-title { font-weight: bold; color: #333; }
        .result-status { padding: 4px 8px; border-radius: 4px; font-size: 12px; }
        .error-message { color: #dc3545; margin-top: 10px; padding: 10px; background: #f8d7da; border-radius: 4px; }
        .logs { margin-top: 10px; padding: 10px; background: #f8f9fa; border-radius: 4px; font-family: monospace; font-size: 12px; max-height: 200px; overflow-y: auto; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Test Execution Report</h1>
        <div class="meta">
            <p><strong>Run ID:</strong> ${run.id}</p>
            <p><strong>Agent ID:</strong> ${run.agentId}</p>
            <p><strong>Started:</strong> ${run.startedAt.toLocaleString()}</p>
            <p><strong>Finished:</strong> ${run.finishedAt?.toLocaleString() || 'N/A'}</p>
            <p><strong>Duration:</strong> ${run.duration ? `${(run.duration / 1000).toFixed(2)}s` : 'N/A'}</p>
            <p><strong>Status:</strong> <span class="status-badge">${run.status}</span></p>
        </div>

        <div class="summary">
            <div class="summary-card">
                <h3>Total Tests</h3>
                <div class="value">${run.totalTests}</div>
            </div>
            <div class="summary-card">
                <h3>Passed</h3>
                <div class="value" style="color: #28a745;">${run.passedTests}</div>
            </div>
            <div class="summary-card">
                <h3>Failed</h3>
                <div class="value" style="color: #dc3545;">${run.failedTests}</div>
            </div>
            <div class="summary-card">
                <h3>Skipped</h3>
                <div class="value" style="color: #6c757d;">${run.skippedTests}</div>
            </div>
            <div class="summary-card">
                <h3>Pass Rate</h3>
                <div class="value">${passRate}%</div>
            </div>
        </div>

        <div class="results">
            <h2>Test Results</h2>
            ${run.results.map(result => `
                <div class="result-item ${result.status}">
                    <div class="result-header">
                        <div class="result-title">Test Case: ${result.testCaseId}</div>
                        <span class="result-status" style="background: ${this.getStatusColor(result.status)}; color: white; padding: 4px 8px; border-radius: 4px;">
                            ${result.status.toUpperCase()}
                        </span>
                    </div>
                    <div><strong>Duration:</strong> ${result.duration ? `${(result.duration / 1000).toFixed(2)}s` : 'N/A'}</div>
                    ${result.error ? `<div class="error-message"><strong>Error:</strong> ${result.error}</div>` : ''}
                    ${options.includeLogs && result.logs && result.logs.length > 0 ? `
                        <div class="logs">
                            <strong>Logs:</strong><br>
                            ${result.logs.map(log => `<div>${log}</div>`).join('')}
                        </div>
                    ` : ''}
                    ${result.validationResults && result.validationResults.length > 0 ? `
                        <div style="margin-top: 10px;">
                            <strong>Validations:</strong>
                            <ul>
                                ${result.validationResults.map(v => `
                                    <li style="color: ${v.passed ? '#28a745' : '#dc3545'};">
                                        Step ${v.stepId}: ${v.passed ? '✓' : '✗'} ${v.message || ''}
                                    </li>
                                `).join('')}
                            </ul>
                        </div>
                    ` : ''}
                </div>
            `).join('')}
        </div>
    </div>
</body>
</html>
    `.trim();
  }

  private generateJUnitReport(run: TestRun): string {
    const tests = run.totalTests;
    const failures = run.failedTests;
    const errors = run.results.filter(r => r.status === 'error').length;
    const skipped = run.skippedTests;
    const time = run.duration ? (run.duration / 1000).toFixed(3) : '0';

    return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
    <testsuite id="${run.id}" name="Test Run ${run.id}" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time}" timestamp="${run.startedAt.toISOString()}">
        ${run.results.map(result => {
          const duration = result.duration ? (result.duration / 1000).toFixed(3) : '0';
          const status = result.status === 'passed' ? 'success' : 'failure';
          
          return `
        <testcase id="${result.id}" name="${result.testCaseId}" classname="TestExecution" time="${duration}">
            ${result.status !== 'passed' ? `
            <${status}>
                ${result.error ? `<message>${this.escapeXml(result.error)}</message>` : ''}
            </${status}>` : ''}
        </testcase>`;
        }).join('')}
    </testsuite>
</testsuites>`;
  }

  private getStatusColor(status: string): string {
    switch (status) {
      case 'passed': return '#28a745';
      case 'failed': return '#dc3545';
      case 'error': return '#dc3545';
      case 'skipped': return '#6c757d';
      default: return '#6c757d';
    }
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

