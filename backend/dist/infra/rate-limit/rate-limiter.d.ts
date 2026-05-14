/**
 * Rate Limiting Middleware
 */
import { Request, Response, NextFunction } from 'express';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
export interface RateLimitConfig {
    points: number;
    duration: number;
    blockDuration?: number;
}
/**
 * Rate limit middleware factory
 */
export declare function rateLimit(limiter?: RateLimiterRedis | RateLimiterMemory): (req: Request, res: Response, next: NextFunction) => Promise<void>;
/**
 * Export specific limiters
 */
export declare const rateLimiters: {
    default: (req: Request, res: Response, next: NextFunction) => Promise<void>;
    strict: (req: Request, res: Response, next: NextFunction) => Promise<void>;
    upload: (req: Request, res: Response, next: NextFunction) => Promise<void>;
};
//# sourceMappingURL=rate-limiter.d.ts.map