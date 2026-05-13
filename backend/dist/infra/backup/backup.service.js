/**
 * Backup Service
 * Handles database backups and data retention
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import logger from '../logger/index.js';
const execAsync = promisify(exec);
export class BackupService {
    config;
    dbConfig;
    constructor() {
        this.config = {
            enabled: process.env.BACKUP_ENABLED === 'true',
            schedule: process.env.BACKUP_SCHEDULE || '0 2 * * *', // Daily at 2 AM
            retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '30'),
            backupPath: process.env.BACKUP_PATH || './backups',
            compress: process.env.BACKUP_COMPRESS !== 'false',
        };
        this.dbConfig = {
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT || '5432'),
            database: process.env.DB_NAME || 'aitestagentbuilder',
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD || '',
        };
    }
    /**
     * Create database backup
     */
    async createBackup() {
        if (!this.config.enabled) {
            logger.info('Backup disabled, skipping');
            return {
                success: false,
                error: 'Backup disabled',
                timestamp: new Date(),
            };
        }
        try {
            // Ensure backup directory exists
            await mkdir(this.config.backupPath, { recursive: true });
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `backup-${timestamp}.sql`;
            const filePath = join(this.config.backupPath, filename);
            // Create backup using pg_dump
            const pgDumpCmd = `PGPASSWORD="${this.dbConfig.password}" pg_dump -h ${this.dbConfig.host} -p ${this.dbConfig.port} -U ${this.dbConfig.user} -d ${this.dbConfig.database} -F c -f "${filePath}"`;
            await execAsync(pgDumpCmd);
            // Compress if enabled
            let finalPath = filePath;
            if (this.config.compress) {
                const compressedPath = `${filePath}.gz`;
                await execAsync(`gzip "${filePath}"`);
                finalPath = compressedPath;
            }
            // Get file size
            const fs = await import('fs/promises');
            const stats = await fs.stat(finalPath);
            const size = stats.size;
            logger.info('Backup created successfully', { filePath: finalPath, size });
            // Cleanup old backups
            await this.cleanupOldBackups();
            return {
                success: true,
                filePath: finalPath,
                size,
                timestamp: new Date(),
            };
        }
        catch (error) {
            logger.error('Backup failed', { error: error.message });
            return {
                success: false,
                error: error.message,
                timestamp: new Date(),
            };
        }
    }
    /**
     * Restore database from backup
     */
    async restoreBackup(filePath) {
        try {
            // Check if file exists
            const fs = await import('fs/promises');
            await fs.access(filePath);
            // Decompress if needed
            let sqlPath = filePath;
            if (filePath.endsWith('.gz')) {
                sqlPath = filePath.replace('.gz', '');
                await execAsync(`gunzip -c "${filePath}" > "${sqlPath}"`);
            }
            // Restore using pg_restore or psql
            const restoreCmd = filePath.endsWith('.sql')
                ? `PGPASSWORD="${this.dbConfig.password}" psql -h ${this.dbConfig.host} -p ${this.dbConfig.port} -U ${this.dbConfig.user} -d ${this.dbConfig.database} < "${sqlPath}"`
                : `PGPASSWORD="${this.dbConfig.password}" pg_restore -h ${this.dbConfig.host} -p ${this.dbConfig.port} -U ${this.dbConfig.user} -d ${this.dbConfig.database} "${sqlPath}"`;
            await execAsync(restoreCmd);
            // Cleanup temp file if decompressed
            if (filePath.endsWith('.gz')) {
                await fs.unlink(sqlPath);
            }
            logger.info('Backup restored successfully', { filePath });
            return { success: true };
        }
        catch (error) {
            logger.error('Backup restore failed', { error: error.message });
            return { success: false, error: error.message };
        }
    }
    /**
     * Cleanup old backups based on retention policy
     */
    async cleanupOldBackups() {
        try {
            const fs = await import('fs/promises');
            const files = await fs.readdir(this.config.backupPath);
            const now = Date.now();
            const retentionMs = this.config.retentionDays * 24 * 60 * 60 * 1000;
            for (const file of files) {
                if (!file.startsWith('backup-'))
                    continue;
                const filePath = join(this.config.backupPath, file);
                const stats = await fs.stat(filePath);
                const age = now - stats.mtimeMs;
                if (age > retentionMs) {
                    await fs.unlink(filePath);
                    logger.info('Deleted old backup', { file });
                }
            }
        }
        catch (error) {
            logger.error('Backup cleanup failed', { error: error.message });
        }
    }
    /**
     * List available backups
     */
    async listBackups() {
        try {
            const fs = await import('fs/promises');
            const files = await fs.readdir(this.config.backupPath);
            const backups = [];
            for (const file of files) {
                if (!file.startsWith('backup-'))
                    continue;
                const filePath = join(this.config.backupPath, file);
                const stats = await fs.stat(filePath);
                backups.push({
                    name: file,
                    size: stats.size,
                    created: stats.birthtime,
                });
            }
            return backups.sort((a, b) => b.created.getTime() - a.created.getTime());
        }
        catch (error) {
            logger.error('Failed to list backups', { error: error.message });
            return [];
        }
    }
}
//# sourceMappingURL=backup.service.js.map