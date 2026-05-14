/**
 * Reporting Agent Service
 * Generates test reports in various formats
 */
export interface ReportOptions {
    formats: ('json' | 'html' | 'junit')[];
    includeScreenshots?: boolean;
    includeLogs?: boolean;
    outputPath?: string;
}
export declare class ReportingAgentService {
    private runRepo;
    private db;
    /**
     * Generate reports for a test run
     */
    generateReports(runId: string, options: ReportOptions): Promise<string[]>;
    private generateJSONReport;
    private generateHTMLReport;
    private generateJUnitReport;
    private getStatusColor;
    private escapeXml;
}
//# sourceMappingURL=reporting-agent.service.d.ts.map