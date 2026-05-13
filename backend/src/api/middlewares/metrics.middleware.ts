/**
 * Metrics Middleware
 * Records HTTP request metrics
 */

import { Request, Response, NextFunction } from 'express';
import { getMetricsService } from '../../infra/monitoring/metrics.service.js';

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  const route = req.route?.path || req.path;
  const method = req.method;

  // Override res.end to capture response
  const originalEnd = res.end.bind(res);
  res.end = function(chunk?: any, encoding?: any) {
    const duration = Date.now() - startTime;
    const status = res.statusCode;
    const contentLength = res.get('content-length') || 0;

    const metrics = getMetricsService();
    metrics.recordHttpRequest(method, route, status, duration, parseInt(contentLength.toString()));

    return originalEnd(chunk, encoding);
  };

  next();
}

