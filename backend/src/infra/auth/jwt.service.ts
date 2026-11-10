/**
 * JWT Authentication Service
 */

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import logger from '../logger/index.js';

export interface JWTPayload {
  userId: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export class JWTService {
  private accessTokenSecret: string;
  private refreshTokenSecret: string;
  private accessTokenExpiry: string;
  private refreshTokenExpiry: string;

  constructor() {
    // All instances must share the same secrets, otherwise a token issued by
    // one instance (login) cannot be verified by another (middleware).
    const base = process.env.JWT_SECRET || getProcessSecret();
    this.accessTokenSecret = process.env.JWT_ACCESS_SECRET || `${base}:access`;
    this.refreshTokenSecret = process.env.JWT_REFRESH_SECRET || `${base}:refresh`;
    this.accessTokenExpiry = process.env.JWT_ACCESS_EXPIRY || process.env.JWT_EXPIRES_IN || '12h';
    this.refreshTokenExpiry = process.env.JWT_REFRESH_EXPIRY || '7d';
  }

  /**
   * Generate access and refresh token pair
   */
  generateTokens(payload: Omit<JWTPayload, 'iat' | 'exp'>): TokenPair {
    const accessToken = jwt.sign(
      payload,
      this.accessTokenSecret,
      { expiresIn: this.accessTokenExpiry } as jwt.SignOptions
    );

    const refreshToken = jwt.sign(
      { userId: payload.userId, type: 'refresh' },
      this.refreshTokenSecret,
      { expiresIn: this.refreshTokenExpiry } as jwt.SignOptions
    );

    return { accessToken, refreshToken };
  }

  /**
   * Verify access token
   */
  verifyAccessToken(token: string): JWTPayload {
    try {
      return jwt.verify(token, this.accessTokenSecret) as JWTPayload;
    } catch (error: any) {
      throw new Error(`Invalid access token: ${error.message}`);
    }
  }

  /**
   * Verify refresh token
   */
  verifyRefreshToken(token: string): { userId: string } {
    try {
      const decoded = jwt.verify(token, this.refreshTokenSecret) as any;
      if (decoded.type !== 'refresh') {
        throw new Error('Invalid token type');
      }
      return { userId: decoded.userId };
    } catch (error: any) {
      throw new Error(`Invalid refresh token: ${error.message}`);
    }
  }

  /**
   * Generate API key
   */
  generateApiKey(): string {
    return `ak_${crypto.randomBytes(32).toString('hex')}`;
  }

  /**
   * Hash API key for storage
   */
  hashApiKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
  }

  /**
   * Verify API key
   */
  verifyApiKey(apiKey: string, hashedKey: string): boolean {
    const hash = this.hashApiKey(apiKey);
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hashedKey));
  }

}

let processSecret: string | null = null;
function getProcessSecret(): string {
  if (!processSecret) {
    processSecret = crypto.randomBytes(64).toString('hex');
    logger.warn('JWT_SECRET not set — using a random per-process secret (tokens reset on restart).');
  }
  return processSecret;
}

/** Password hashing with scrypt (salted). Format: scrypt$<salt>$<hash> */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith('scrypt$')) {
    const [, salt, hash] = stored.split('$');
    const candidate = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
  }
  // Legacy unsalted sha256 hashes
  return crypto.createHash('sha256').update(password).digest('hex') === stored;
}

