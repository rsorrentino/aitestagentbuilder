/**
 * Cache Service
 * Provides caching layer for performance optimization
 */
import NodeCache from 'node-cache';
import Redis from 'ioredis';
import logger from '../logger/index.js';
export class CacheService {
    cache;
    useRedis;
    constructor() {
        this.useRedis = !!process.env.REDIS_URL;
        if (this.useRedis) {
            this.cache = new Redis(process.env.REDIS_URL, {
                retryStrategy: (times) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                },
            });
            this.cache.on('error', (error) => {
                logger.error('Redis cache error', { error: error.message });
            });
            logger.info('Using Redis cache');
        }
        else {
            this.cache = new NodeCache({
                stdTTL: 3600, // Default 1 hour
                checkperiod: 600, // Check every 10 minutes
                useClones: false,
            });
            logger.info('Using in-memory cache');
        }
    }
    /**
     * Get value from cache
     */
    async get(key) {
        try {
            if (this.useRedis) {
                const value = await this.cache.get(key);
                return value ? JSON.parse(value) : undefined;
            }
            else {
                return this.cache.get(key);
            }
        }
        catch (error) {
            logger.error('Cache get error', { key, error: error.message });
            return undefined;
        }
    }
    /**
     * Set value in cache
     */
    async set(key, value, ttl) {
        try {
            if (this.useRedis) {
                const serialized = JSON.stringify(value);
                if (ttl) {
                    await this.cache.setex(key, ttl, serialized);
                }
                else {
                    await this.cache.set(key, serialized);
                }
                return true;
            }
            else {
                return this.cache.set(key, value, ttl || 0);
            }
        }
        catch (error) {
            logger.error('Cache set error', { key, error: error.message });
            return false;
        }
    }
    /**
     * Delete value from cache
     */
    async delete(key) {
        try {
            if (this.useRedis) {
                await this.cache.del(key);
                return true;
            }
            else {
                return this.cache.del(key) > 0;
            }
        }
        catch (error) {
            logger.error('Cache delete error', { key, error: error.message });
            return false;
        }
    }
    /**
     * Clear all cache
     */
    async clear() {
        try {
            if (this.useRedis) {
                await this.cache.flushdb();
            }
            else {
                this.cache.flushAll();
            }
        }
        catch (error) {
            logger.error('Cache clear error', { error: error.message });
        }
    }
    /**
     * Get cache statistics
     */
    async getStats() {
        if (this.useRedis) {
            const keys = await this.cache.keys('*');
            return {
                hits: 0, // Redis doesn't provide hit/miss stats easily
                misses: 0,
                keys: keys.length,
                size: 0,
            };
        }
        else {
            const stats = this.cache.getStats();
            return {
                hits: stats.hits,
                misses: stats.misses,
                keys: stats.keys,
                size: stats.ksize + stats.vsize,
            };
        }
    }
}
// Singleton instance
let cacheService = null;
export function getCacheService() {
    if (!cacheService) {
        cacheService = new CacheService();
    }
    return cacheService;
}
//# sourceMappingURL=cache.service.js.map