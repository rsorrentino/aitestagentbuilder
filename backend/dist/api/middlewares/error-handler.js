/**
 * Error Handling Middleware
 */
import logger from '../../infra/logger/index.js';
export function errorHandler(err, req, res, _next) {
    logger.error('Request error', {
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
    });
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
}
export function notFoundHandler(req, res) {
    res.status(404).json({
        error: 'Not found',
        path: req.path,
    });
}
//# sourceMappingURL=error-handler.js.map