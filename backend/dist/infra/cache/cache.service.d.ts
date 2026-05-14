/**
 * Cache Service
 * Provides caching layer for performance optimization
 */
export interface CacheOptions {
    ttl?: number;
    checkperiod?: number;
}
export declare class CacheService {
    private cache;
    private useRedis;
    constructor();
    /**
     * Get value from cache
     */
    get<T>(key: string): Promise<T | undefined>;
    /**
     * Set value in cache
     */
    set<T>(key: string, value: T, ttl?: number): Promise<boolean>;
    /**
     * Delete value from cache
     */
    delete(key: string): Promise<boolean>;
    /**
     * Clear all cache
     */
    clear(): Promise<void>;
    /**
     * Get cache statistics
     */
    getStats(): Promise<{
        hits: number;
        misses: number;
        keys: number;
        size: number;
    }>;
}
export declare function getCacheService(): CacheService;
//# sourceMappingURL=cache.service.d.ts.map