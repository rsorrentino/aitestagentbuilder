/**
 * PostgreSQL Database Client
 */

import pg, { QueryResultRow } from 'pg';
import '../config/env.js';
import logger from '../logger/index.js';

const { Pool } = pg;

export interface DatabaseConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export class DatabaseClient {
  private pool: pg.Pool;

  constructor(config?: DatabaseConfig) {
    const connectionString = config?.connectionString ?? process.env.DATABASE_URL;
    const base = {
      max: config?.max || 20,
      idleTimeoutMillis: config?.idleTimeoutMillis || 30000,
      connectionTimeoutMillis: config?.connectionTimeoutMillis || 5000,
    };

    this.pool = connectionString
      ? new Pool({ connectionString, ...base })
      : new Pool({
          host: config?.host || process.env.DB_HOST || 'localhost',
          port: config?.port || parseInt(process.env.DB_PORT || '5432'),
          database: config?.database || process.env.DB_NAME || 'aitestagentbuilder',
          user: config?.user || process.env.DB_USER || 'postgres',
          password: config?.password ?? process.env.DB_PASSWORD ?? '',
          ...base,
        });

    this.pool.on('error', (err: Error) => {
      logger.error('Unexpected error on idle client', { error: err.message });
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]): Promise<pg.QueryResult<T>> {
    const start = Date.now();
    try {
      const result = await this.pool.query<T>(text, params);
      const duration = Date.now() - start;

      try {
        const { getMetricsService } = await import('../monitoring/metrics.service.js');
        const operation = text.trim().split(/\s+/)[0].toLowerCase();
        const tableMatch = text.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i);
        getMetricsService().recordDbQuery(operation, tableMatch ? tableMatch[1] : 'unknown', duration);
      } catch {
        // metrics optional
      }

      logger.debug('Executed query', { text: text.substring(0, 100), duration, rows: result.rowCount });
      return result;
    } catch (error: any) {
      logger.error('Query error', { text: text.substring(0, 100), error: error.message });
      throw error;
    }
  }

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

  async getClient(): Promise<pg.PoolClient> {
    return this.pool.connect();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.pool.query('SELECT 1');
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }
}

let dbClient: DatabaseClient | null = null;

export function getDatabaseClient(): DatabaseClient {
  if (!dbClient) {
    dbClient = new DatabaseClient();
  }
  return dbClient;
}

export default getDatabaseClient;
