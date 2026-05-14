/**
 * Rate Limiting Middleware
 */
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import Redis from 'ioredis';
import logger from '../logger/index.js';
const redisClient = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL)
    : null;
/**
 * Create rate limiter instance
 */
function createRateLimiter(config) {
    if (redisClient) {
        // Use Redis for distributed rate limiting
        return new RateLimiterRedis({
            storeClient: redisClient,
            keyPrefix: 'rl',
            points: config.points,
            duration: config.duration,
            blockDuration: config.blockDuration || 0,
        });
    }
    else {
        // Use in-memory rate limiting (single instance)
        return new RateLimiterMemory({
            points: config.points,
            duration: config.duration,
            blockDuration: config.blockDuration || 0,
        });
    }
}
/**
 * Default rate limiter: 100 requests per 15 minutes
 */
const defaultLimiter = createRateLimiter({
    points: parseInt(process.env.RATE_LIMIT_POINTS || '100'),
    duration: parseInt(process.env.RATE_LIMIT_DURATION || '900'), // 15 minutes
});
/**
 * Strict rate limiter: 10 requests per minute
 */
const strictLimiter = createRateLimiter({
    points: 10,
    duration: 60,
    blockDuration: 60,
});
/**
 * Upload rate limiter: 5 requests per hour
 */
const uploadLimiter = createRateLimiter({
    points: 5,
    duration: 3600,
});
/**
 * Rate limit middleware factory
 */
export function rateLimit(limiter = defaultLimiter) {
    return async (req, res, next) => {
        try {
            // Get identifier (user ID, API key, or IP)
            const identifier = getIdentifier(req);
            await limiter.consume(identifier);
            // Add rate limit headers
            res.setHeader('X-RateLimit-Limit', limiter.points);
            next();
        }
        catch (error) {
            const secs = Math.round(error.msBeforeNext / 1000) || 1;
            res.setHeader('Retry-After', String(secs));
            res.setHeader('X-RateLimit-Limit', limiter.points);
            res.setHeader('X-RateLimit-Remaining', 0);
            logger.warn('Rate limit exceeded', {
                identifier: getIdentifier(req),
                path: req.path,
                method: req.method,
            });
            res.status(429).json({
                error: 'Too many requests',
                retryAfter: secs,
            });
        }
    };
}
/**
 * Get identifier for rate limiting
 */
function getIdentifier(req) {
    // Prefer authenticated user/API key
    const authReq = req;
    if (authReq.user?.userId) {
        return `user:${authReq.user.userId}`;
    }
    if (authReq.apiKey?.keyId) {
        return `apikey:${authReq.apiKey.keyId}`;
    }
    // Fall back to IP address
    const ip = req.ip ||
        req.headers['x-forwarded-for']?.toString().split(',')[0] ||
        req.socket.remoteAddress ||
        'unknown';
    return `ip:${ip}`;
}
/**
 * Export specific limiters
 */
export const rateLimiters = {
    default: rateLimit(defaultLimiter),
    strict: rateLimit(strictLimiter),
    upload: rateLimit(uploadLimiter),
};
//# sourceMappingURL=rate-limiter.js.map