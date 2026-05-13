/**
 * Main Application Entry Point
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { createServer } from 'http';
import routes from './api/routes/index.js';
import healthRoutes from './api/routes/health.js';
import { errorHandler, notFoundHandler } from './api/middlewares/error-handler.js';
import { metricsMiddleware } from './api/middlewares/metrics.middleware.js';
import { rateLimiters } from './infra/rate-limit/rate-limiter.js';
import logger from './infra/logger/index.js';
import getDatabaseClient from './infra/db/client.js';
import { initializeWebSocket } from './infra/websocket/server.js';
dotenv.config();
const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3000;
const API_PREFIX = process.env.API_PREFIX || '/api/v1';
// Initialize WebSocket server
initializeWebSocket(server);
// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));
// CORS configuration
app.use(cors({
    origin: process.env.CORS_ORIGIN?.split(',') || '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
// Body parsing with limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Metrics middleware (before routes)
app.use(metricsMiddleware);
// Health and metrics routes (no auth required)
app.use('/health', healthRoutes);
// Rate limiting
app.use(`${API_PREFIX}`, rateLimiters.default);
// API routes
app.use(`${API_PREFIX}`, routes);
// Error handling
app.use(notFoundHandler);
app.use(errorHandler);
// Start server
async function start() {
    try {
        // Verify database connection
        const db = getDatabaseClient();
        const dbHealthy = await db.healthCheck();
        if (!dbHealthy) {
            logger.warn('Database connection failed. Some features may not work.');
        }
        server.listen(PORT, () => {
            logger.info(`Server started on port ${PORT}`, {
                port: PORT,
                apiPrefix: API_PREFIX,
                environment: process.env.NODE_ENV || 'development',
            });
        });
    }
    catch (error) {
        logger.error('Failed to start server', { error: error.message });
        process.exit(1);
    }
}
start();
export default app;
//# sourceMappingURL=index.js.map