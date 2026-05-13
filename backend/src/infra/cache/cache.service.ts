/**
 * Cache Service
 * Provides caching layer for performance optimization
 */

import NodeCache from 'node-cache';
import Redis from 'ioredis';
import logger from '../logger/index.js';

export interface CacheOptions {
  ttl?: number; // Time to live in seconds
  checkperiod?: number; // Check for expired keys interval
}

export class CacheService {
  private cache: NodeCache | Redis;
  private useRedis: boolean;

  constructor() {
    this.useRedis = !!process.env.REDIS_URL;

    if (this.useRedis) {
      this.cache = new Redis(process.env.REDIS_URL!, {
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
      });

      (this.cache as Redis).on('error', (error) => {
        logger.error('Redis cache error', { error: error.message });
      });

      logger.info('Using Redis cache');
    } else {
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
  async get<T>(key: string): Promise<T | undefined> {
    try {
      if (this.useRedis) {
        const value = await (this.cache as Redis).get(key);
        return value ? JSON.parse(value) : undefined;
      } else {
        return (this.cache as NodeCache).get<T>(key);
      }
    } catch (error: any) {
      logger.error('Cache get error', { key, error: error.message });
      return undefined;
    }
  }

  /**
   * Set value in cache
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<boolean> {
    try {
      if (this.useRedis) {
        const serialized = JSON.stringify(value);
        if (ttl) {
          await (this.cache as Redis).setex(key, ttl, serialized);
        } else {
          await (this.cache as Redis).set(key, serialized);
        }
        return true;
      } else {
        return (this.cache as NodeCache).set(key, value, ttl || 0);
      }
    } catch (error: any) {
      logger.error('Cache set error', { key, error: error.message });
      return false;
    }
  }

  /**
   * Delete value from cache
   */
  async delete(key: string): Promise<boolean> {
    try {
      if (this.useRedis) {
        await (this.cache as Redis).del(key);
        return true;
      } else {
        return (this.cache as NodeCache).del(key) > 0;
      }
    } catch (error: any) {
      logger.error('Cache delete error', { key, error: error.message });
      return false;
    }
  }

  /**
   * Clear all cache
   */
  async clear(): Promise<void> {
    try {
      if (this.useRedis) {
        await (this.cache as Redis).flushdb();
      } else {
        (this.cache as NodeCache).flushAll();
      }
    } catch (error: any) {
      logger.error('Cache clear error', { error: error.message });
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    hits: number;
    misses: number;
    keys: number;
    size: number;
  }> {
    if (this.useRedis) {
      const keys = await (this.cache as Redis).keys('*');
      return {
        hits: 0, // Redis doesn't provide hit/miss stats easily
        misses: 0,
        keys: keys.length,
        size: 0,
      };
    } else {
      const stats = (this.cache as NodeCache).getStats();
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
let cacheService: CacheService | null = null;

export function getCacheService(): CacheService {
  if (!cacheService) {
    cacheService = new CacheService();
  }
  return cacheService;
}

