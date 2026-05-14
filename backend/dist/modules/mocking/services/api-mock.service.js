/**
 * API Mocking Service
 * Provides API mocking capabilities for testing
 */
import express from 'express';
import logger from '../../../infra/logger/index.js';
export class ApiMockService {
    app;
    server;
    config;
    endpoints = new Map();
    constructor(config) {
        this.config = config;
        this.app = express();
        this.app.use(express.json());
        this.setupEndpoints(config.endpoints);
    }
    /**
     * Setup mock endpoints
     */
    setupEndpoints(endpoints) {
        endpoints.forEach(endpoint => {
            const key = `${endpoint.method}:${endpoint.path}`;
            this.endpoints.set(key, endpoint);
            const handler = async (req, res) => {
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
    async start() {
        return new Promise((resolve, reject) => {
            this.server = this.app.listen(this.config.port, () => {
                logger.info('API Mock server started', { port: this.config.port });
                resolve();
            });
            this.server.on('error', (error) => {
                logger.error('Mock server error', { error: error.message });
                reject(error);
            });
        });
    }
    /**
     * Stop mock server
     */
    async stop() {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    logger.info('API Mock server stopped');
                    resolve();
                });
            }
            else {
                resolve();
            }
        });
    }
    /**
     * Add dynamic endpoint
     */
    addEndpoint(endpoint) {
        const key = `${endpoint.method}:${endpoint.path}`;
        this.endpoints.set(key, endpoint);
        this.setupEndpoints([endpoint]);
    }
    /**
     * Remove endpoint
     */
    removeEndpoint(method, path) {
        const key = `${method}:${path}`;
        this.endpoints.delete(key);
    }
    /**
     * Get server URL
     */
    getUrl() {
        return `http://localhost:${this.config.port}`;
    }
}
//# sourceMappingURL=api-mock.service.js.map