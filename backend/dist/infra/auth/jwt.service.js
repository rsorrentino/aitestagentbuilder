/**
 * JWT Authentication Service
 */
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import logger from '../logger/index.js';
export class JWTService {
    accessTokenSecret;
    refreshTokenSecret;
    accessTokenExpiry;
    refreshTokenExpiry;
    constructor() {
        this.accessTokenSecret = process.env.JWT_ACCESS_SECRET || this.generateSecret();
        this.refreshTokenSecret = process.env.JWT_REFRESH_SECRET || this.generateSecret();
        this.accessTokenExpiry = process.env.JWT_ACCESS_EXPIRY || '15m';
        this.refreshTokenExpiry = process.env.JWT_REFRESH_EXPIRY || '7d';
        if (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET) {
            logger.warn('JWT secrets not configured, using generated secrets. Set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET in production!');
        }
    }
    /**
     * Generate access and refresh token pair
     */
    generateTokens(payload) {
        const accessToken = jwt.sign(payload, this.accessTokenSecret, { expiresIn: this.accessTokenExpiry });
        const refreshToken = jwt.sign({ userId: payload.userId, type: 'refresh' }, this.refreshTokenSecret, { expiresIn: this.refreshTokenExpiry });
        return { accessToken, refreshToken };
    }
    /**
     * Verify access token
     */
    verifyAccessToken(token) {
        try {
            return jwt.verify(token, this.accessTokenSecret);
        }
        catch (error) {
            throw new Error(`Invalid access token: ${error.message}`);
        }
    }
    /**
     * Verify refresh token
     */
    verifyRefreshToken(token) {
        try {
            const decoded = jwt.verify(token, this.refreshTokenSecret);
            if (decoded.type !== 'refresh') {
                throw new Error('Invalid token type');
            }
            return { userId: decoded.userId };
        }
        catch (error) {
            throw new Error(`Invalid refresh token: ${error.message}`);
        }
    }
    /**
     * Generate API key
     */
    generateApiKey() {
        return `ak_${crypto.randomBytes(32).toString('hex')}`;
    }
    /**
     * Hash API key for storage
     */
    hashApiKey(apiKey) {
        return crypto.createHash('sha256').update(apiKey).digest('hex');
    }
    /**
     * Verify API key
     */
    verifyApiKey(apiKey, hashedKey) {
        const hash = this.hashApiKey(apiKey);
        return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hashedKey));
    }
    generateSecret() {
        return crypto.randomBytes(64).toString('hex');
    }
}
//# sourceMappingURL=jwt.service.js.map