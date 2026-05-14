/**
 * PostgreSQL Database Client with pgvector support
 */
import pg from 'pg';
import dotenv from 'dotenv';
import logger from '../logger/index.js';
dotenv.config();
const { Pool } = pg;
export class DatabaseClient {
    pool;
    config;
    constructor(config) {
        this.config = {
            host: config?.host || process.env.DB_HOST || 'localhost',
            port: config?.port || parseInt(process.env.DB_PORT || '5432'),
            database: config?.database || process.env.DB_NAME || 'aitestagentbuilder',
            user: config?.user || process.env.DB_USER || 'postgres',
            password: config?.password || process.env.DB_PASSWORD || '',
            max: config?.max || 20,
            idleTimeoutMillis: config?.idleTimeoutMillis || 30000,
            connectionTimeoutMillis: config?.connectionTimeoutMillis || 2000,
        };
        this.pool = new Pool(this.config);
        // Handle pool errors
        this.pool.on('error', (err) => {
            logger.error('Unexpected error on idle client', { error: err.message });
        });
    }
    /**
     * Execute a query
     */
    async query(text, params) {
        const start = Date.now();
        try {
            const result = await this.pool.query(text, params);
            const duration = Date.now() - start;
            // Record metrics if available
            try {
                const { getMetricsService } = await import('../monitoring/metrics.service.js');
                const metrics = getMetricsService();
                const operation = text.split(' ')[0].toLowerCase();
                const tableMatch = text.match(/FROM\s+(\w+)/i);
                const table = tableMatch ? tableMatch[1] : 'unknown';
                metrics.recordDbQuery(operation, table, duration);
            }
            catch {
                // Metrics service not available, ignore
            }
            logger.debug('Executed query', { text: text.substring(0, 100), duration, rows: result.rowCount });
            return result;
        }
        catch (error) {
            logger.error('Query error', { text: text.substring(0, 100), error });
            throw error;
        }
    }
    /**
     * Execute a transaction
     */
    async transaction(callback) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
    /**
     * Get a client from the pool (for transactions)
     */
    async getClient() {
        return await this.pool.connect();
    }
    /**
     * Close the pool
     */
    async close() {
        await this.pool.end();
    }
    /**
     * Health check
     */
    async healthCheck() {
        try {
            const result = await this.query('SELECT 1');
            return result.rows.length > 0;
        }
        catch (error) {
            return false;
        }
    }
}
// Singleton instance
let dbClient = null;
export function getDatabaseClient() {
    if (!dbClient) {
        dbClient = new DatabaseClient();
    }
    return dbClient;
}
export default getDatabaseClient;
//# sourceMappingURL=client.js.map