/**
 * PostgreSQL Database Client with pgvector support
 */

import pg, { QueryResultRow } from 'pg';
import dotenv from 'dotenv';
import logger from '../logger/index.js';

dotenv.config();

const { Pool } = pg;

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

export class DatabaseClient {
  private pool: pg.Pool;
  private config: DatabaseConfig;

  constructor(config?: Partial<DatabaseConfig>) {
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
    this.pool.on('error', (err: Error) => {
      logger.error('Unexpected error on idle client', { error: err.message });
    });
  }

  /**
   * Execute a query
   */
  async query<T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]): Promise<pg.QueryResult<T>> {
    const start = Date.now();
    try {
      const result = await this.pool.query<T>(text, params);
      const duration = Date.now() - start;
      
      // Record metrics if available
      try {
        const { getMetricsService } = await import('../monitoring/metrics.service.js');
        const metrics = getMetricsService();
        const operation = text.split(' ')[0].toLowerCase();
        const tableMatch = text.match(/FROM\s+(\w+)/i);
        const table = tableMatch ? tableMatch[1] : 'unknown';
        metrics.recordDbQuery(operation, table, duration);
      } catch {
        // Metrics service not available, ignore
      }

      logger.debug('Executed query', { text: text.substring(0, 100), duration, rows: result.rowCount });
      return result;
    } catch (error) {
      logger.error('Query error', { text: text.substring(0, 100), error });
      throw error;
    }
  }

  /**
   * Execute a transaction
   */
  async transaction<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get a client from the pool (for transactions)
   */
  async getClient(): Promise<pg.PoolClient> {
    return await this.pool.connect();
  }

  /**
   * Close the pool
   */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.query('SELECT 1');
      return result.rows.length > 0;
    } catch (error) {
      return false;
    }
  }
}

// Singleton instance
let dbClient: DatabaseClient | null = null;

export function getDatabaseClient(): DatabaseClient {
  if (!dbClient) {
    dbClient = new DatabaseClient();
  }
  return dbClient;
}

export default getDatabaseClient;

