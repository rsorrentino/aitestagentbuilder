/**
 * Environment Agent Service
 * Handles test environment setup, teardown, and data management
 */
export interface EnvironmentConfig {
    name: string;
    baseUrl: string;
    database?: {
        host: string;
        port: number;
        database: string;
        user: string;
        password: string;
    };
    apiEndpoints?: {
        setup?: string;
        teardown?: string;
        reset?: string;
    };
    setupScripts?: string[];
    teardownScripts?: string[];
}
export interface EnvironmentSetupResult {
    success: boolean;
    environment: string;
    setupTime: number;
    errors?: string[];
    metadata?: Record<string, any>;
}
export declare class EnvironmentAgentService {
    /**
     * Setup test environment
     */
    setupEnvironment(config: EnvironmentConfig): Promise<EnvironmentSetupResult>;
    /**
     * Teardown test environment
     */
    teardownEnvironment(config: EnvironmentConfig): Promise<EnvironmentSetupResult>;
    /**
     * Reset environment to initial state
     */
    resetEnvironment(config: EnvironmentConfig): Promise<EnvironmentSetupResult>;
    private setupDatabase;
    private cleanupDatabase;
    private callSetupEndpoint;
    private callTeardownEndpoint;
    private executeScript;
}
//# sourceMappingURL=environment-agent.service.d.ts.map