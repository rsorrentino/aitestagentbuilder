/**
 * API Mocking Service
 * Provides API mocking capabilities for testing
 */
import { Request } from 'express';
export interface MockEndpoint {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    path: string;
    response: any;
    statusCode?: number;
    headers?: Record<string, string>;
    delay?: number;
    condition?: (req: Request) => boolean;
}
export interface MockServerConfig {
    port: number;
    endpoints: MockEndpoint[];
}
export declare class ApiMockService {
    private app;
    private server;
    private config;
    private endpoints;
    constructor(config: MockServerConfig);
    /**
     * Setup mock endpoints
     */
    private setupEndpoints;
    /**
     * Start mock server
     */
    start(): Promise<void>;
    /**
     * Stop mock server
     */
    stop(): Promise<void>;
    /**
     * Add dynamic endpoint
     */
    addEndpoint(endpoint: MockEndpoint): void;
    /**
     * Remove endpoint
     */
    removeEndpoint(method: string, path: string): void;
    /**
     * Get server URL
     */
    getUrl(): string;
}
//# sourceMappingURL=api-mock.service.d.ts.map