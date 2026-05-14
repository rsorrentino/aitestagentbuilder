/**
 * Backup Service
 * Handles database backups and data retention
 */
export interface BackupConfig {
    enabled: boolean;
    schedule: string;
    retentionDays: number;
    backupPath: string;
    compress: boolean;
}
export interface BackupResult {
    success: boolean;
    filePath?: string;
    size?: number;
    error?: string;
    timestamp: Date;
}
export declare class BackupService {
    private config;
    private dbConfig;
    constructor();
    /**
     * Create database backup
     */
    createBackup(): Promise<BackupResult>;
    /**
     * Restore database from backup
     */
    restoreBackup(filePath: string): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * Cleanup old backups based on retention policy
     */
    private cleanupOldBackups;
    /**
     * List available backups
     */
    listBackups(): Promise<Array<{
        name: string;
        size: number;
        created: Date;
    }>>;
}
//# sourceMappingURL=backup.service.d.ts.map