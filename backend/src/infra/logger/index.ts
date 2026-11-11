/**
 * Logger Configuration (Winston)
 */

import winston from 'winston';
import { mkdirSync } from 'fs';
import '../config/env.js';

const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'error' : 'info');
const logFormat = process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'pretty');

const format = logFormat === 'json'
  ? winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    )
  : winston.format.combine(
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} ${level}: ${message}${metaStr}`;
      })
    );

const transports: winston.transport[] = [new winston.transports.Console()];

const logDir = process.env.LOG_DIR || 'logs';
if (process.env.LOG_TO_FILE !== 'false' && process.env.NODE_ENV !== 'test') {
  try {
    mkdirSync(logDir, { recursive: true });
    transports.push(
      new winston.transports.File({ filename: `${logDir}/error.log`, level: 'error', format: winston.format.json() }),
      new winston.transports.File({ filename: `${logDir}/combined.log`, format: winston.format.json() }),
    );
  } catch {
    // file logging is best-effort
  }
}

export const logger = winston.createLogger({ level: logLevel, format, transports });

export default logger;
