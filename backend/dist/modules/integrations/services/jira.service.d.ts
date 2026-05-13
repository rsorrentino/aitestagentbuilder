/**
 * Jira Integration Service
 */
export interface JiraConfig {
    baseUrl: string;
    username: string;
    apiToken: string;
}
export interface JiraIssue {
    fields: {
        project: {
            key: string;
        };
        summary: string;
        description?: string;
        issuetype: {
            name: string;
        };
        priority?: {
            name: string;
        };
        labels?: string[];
    };
}
export interface JiraComment {
    body: string;
}
export declare class JiraService {
    private config;
    private baseUrl;
    constructor(config: JiraConfig);
    /**
     * Create a Jira issue
     */
    createIssue(issue: JiraIssue): Promise<any>;
    /**
     * Create test execution issue
     */
    createTestExecutionIssue(projectKey: string, summary: string, description: string): Promise<any>;
    /**
     * Add comment to issue
     */
    addComment(issueKey: string, comment: JiraComment): Promise<any>;
    /**
     * Update issue status
     */
    updateIssueStatus(issueKey: string, statusId: string): Promise<any>;
}
//# sourceMappingURL=jira.service.d.ts.map