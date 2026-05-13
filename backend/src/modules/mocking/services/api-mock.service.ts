/**
 * API Mocking Service
 * Provides API mocking capabilities for testing
 */

import express, { Express, Request, Response } from 'express';
import logger from '../../../infra/logger/index.js';

export interface MockEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  response: any;
  statusCode?: number;
  headers?: Record<string, string>;
  delay?: number; // milliseconds
  condition?: (req: Request) => boolean;
}

export interface MockServerConfig {
  port: number;
  endpoints: MockEndpoint[];
}

export class ApiMockService {
  private app: Express;
  private server: any;
  private config: MockServerConfig;
  private endpoints: Map<string, MockEndpoint> = new Map();

  constructor(config: MockServerConfig) {
    this.config = config;
    this.app = express();
    this.app.use(express.json());
    this.setupEndpoints(config.endpoints);
  }

  /**
   * Setup mock endpoints
   */
  private setupEndpoints(endpoints: MockEndpoint[]): void {
    endpoints.forEach(endpoint => {
      const key = `${endpoint.method}:${endpoint.path}`;
      this.endpoints.set(key, endpoint);

      const handler = async (req: Request, res: Response) => {
        // Check condition if provided
        if (endpoint.condition && !endpoint.condition(req)) {
          res.status(404).json({ error: 'Endpoint condition not met' });
          return;
        }

        // Apply delay if configured
        if (endpoint.delay) {
          await new Promise(resolve => setTimeout(resolve, endpoint.delay));
        }

        // Set headers
        if (endpoint.headers) {
          Object.entries(endpoint.headers).forEach(([key, value]) => {
            res.setHeader(key, value);
          });
        }

        // Send response
        const statusCode = endpoint.statusCode || 200;
        res.status(statusCode).json(endpoint.response);
      };

      switch (endpoint.method) {
        case 'GET':
          this.app.get(endpoint.path, handler);
          break;
        case 'POST':
          this.app.post(endpoint.path, handler);
          break;
        case 'PUT':
          this.app.put(endpoint.path, handler);
          break;
        case 'DELETE':
          this.app.delete(endpoint.path, handler);
          break;
        case 'PATCH':
          this.app.patch(endpoint.path, handler);
          break;
      }
    });
  }

  /**
   * Start mock server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.config.port, () => {
        logger.info('API Mock server started', { port: this.config.port });
        resolve();
      });

      this.server.on('error', (error: any) => {
        logger.error('Mock server error', { error: error.message });
        reject(error);
      });
    });
  }

  /**
   * Stop mock server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('API Mock server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Add dynamic endpoint
   */
  addEndpoint(endpoint: MockEndpoint): void {
    const key = `${endpoint.method}:${endpoint.path}`;
    this.endpoints.set(key, endpoint);
    this.setupEndpoints([endpoint]);
  }

  /**
   * Remove endpoint
   */
  removeEndpoint(method: string, path: string): void {
    const key = `${method}:${path}`;
    this.endpoints.delete(key);
  }

  /**
   * Get server URL
   */
  getUrl(): string {
    return `http://localhost:${this.config.port}`;
  }
}

