/**
 * PostgreSQL Database Client with pgvector support
 */
import pg, { QueryResultRow } from 'pg';
export interface DatabaseConfig {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
}
export declare class DatabaseClient {
    private pool;
    private config;
    constructor(config?: Partial<DatabaseConfig>);
    /**
     * Execute a query
     */
    query<T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]): Promise<pg.QueryResult<T>>;
    /**
     * Execute a transaction
     */
    transaction<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T>;
    /**
     * Get a client from the pool (for transactions)
     */
    getClient(): Promise<pg.PoolClient>;
    /**
     * Close the pool
     */
    close(): Promise<void>;
    /**
     * Health check
     */
    healthCheck(): Promise<boolean>;
}
export declare function getDatabaseClient(): DatabaseClient;
export default getDatabaseClient;
//# sourceMappingURL=client.d.ts.map