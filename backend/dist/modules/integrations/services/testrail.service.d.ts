/**
 * TestRail Integration Service
 */
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
    status_id: number;
    comment?: string;
    elapsed?: string;
    defects?: string;
    version?: string;
}
export declare class TestRailService {
    private config;
    private baseUrl;
    constructor(config: TestRailConfig);
    /**
     * Create a test run in TestRail
     */
    createRun(projectId: number, runData: TestRailRun): Promise<any>;
    /**
     * Add test result to TestRail
     */
    addResult(runId: number, caseId: number, result: TestRailResult): Promise<any>;
    /**
     * Close test run
     */
    closeRun(runId: number): Promise<any>;
    /**
     * Map test result status to TestRail status ID
     */
    mapStatusToTestRail(status: string): number;
}
//# sourceMappingURL=testrail.service.d.ts.map