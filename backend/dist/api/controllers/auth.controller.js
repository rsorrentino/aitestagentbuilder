/**
 * Authentication Controller
 */
import { JWTService } from '../../infra/auth/jwt.service.js';
import getDatabaseClient from '../../infra/db/client.js';
import logger from '../../infra/logger/index.js';
import crypto from 'crypto';
const jwtService = new JWTService();
const db = getDatabaseClient();
export class AuthController {
    /**
     * Login with email/password
     */
    async login(req, res) {
        try {
            const { email, password } = req.body;
            if (!email || !password) {
                res.status(400).json({ error: 'Email and password are required' });
                return;
            }
            // Find user
            const userResult = await db.query('SELECT id, email, password_hash, role, active FROM users WHERE email = $1', [email]);
            if (userResult.rows.length === 0) {
                res.status(401).json({ error: 'Invalid credentials' });
                return;
            }
            const user = userResult.rows[0];
            if (!user.active) {
                res.status(403).json({ error: 'Account is disabled' });
                return;
            }
            // Verify password (in production, use bcrypt)
            const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
            if (passwordHash !== user.password_hash) {
                res.status(401).json({ error: 'Invalid credentials' });
                return;
            }
            // Generate tokens
            const tokens = jwtService.generateTokens({
                userId: user.id,
                email: user.email,
                role: user.role,
            });
            // Update last login
            await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
            res.json({
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                user: {
                    id: user.id,
                    email: user.email,
                    role: user.role,
                },
            });
        }
        catch (error) {
            logger.error('Login failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    /**
     * Refresh access token
     */
    async refresh(req, res) {
        try {
            const { refreshToken } = req.body;
            if (!refreshToken) {
                res.status(400).json({ error: 'Refresh token is required' });
                return;
            }
            const { userId } = jwtService.verifyRefreshToken(refreshToken);
            // Get user
            const userResult = await db.query('SELECT id, email, role FROM users WHERE id = $1 AND active = true', [userId]);
            if (userResult.rows.length === 0) {
                res.status(401).json({ error: 'Invalid refresh token' });
                return;
            }
            const user = userResult.rows[0];
            // Generate new tokens
            const tokens = jwtService.generateTokens({
                userId: user.id,
                email: user.email,
                role: user.role,
            });
            res.json({
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
            });
        }
        catch (error) {
            logger.error('Token refresh failed', { error: error.message });
            res.status(401).json({ error: 'Invalid refresh token' });
        }
    }
    /**
     * Create API key
     */
    async createApiKey(req, res) {
        try {
            const { name, permissions, expiresInDays } = req.body;
            const userId = req.user?.userId || req.apiKey?.userId;
            if (!userId) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }
            // Generate API key
            const apiKey = jwtService.generateApiKey();
            const keyHash = jwtService.hashApiKey(apiKey);
            // Calculate expiry
            const expiresAt = expiresInDays
                ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
                : null;
            // Store in database
            const keyId = `KEY-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            await db.query(`INSERT INTO api_keys (id, user_id, key_hash, name, permissions, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`, [
                keyId,
                userId,
                keyHash,
                name || 'API Key',
                JSON.stringify(permissions || []),
                expiresAt,
            ]);
            // Return API key (only shown once)
            res.status(201).json({
                id: keyId,
                apiKey,
                name: name || 'API Key',
                expiresAt,
                message: 'Store this API key securely. It will not be shown again.',
            });
        }
        catch (error) {
            logger.error('API key creation failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    /**
     * List API keys
     */
    async listApiKeys(req, res) {
        try {
            const userId = req.user?.userId || req.apiKey?.userId;
            if (!userId) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }
            const result = await db.query(`SELECT id, name, permissions, active, expires_at, last_used_at, created_at
         FROM api_keys
         WHERE user_id = $1
         ORDER BY created_at DESC`, [userId]);
            res.json(result.rows);
        }
        catch (error) {
            logger.error('Failed to list API keys', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    /**
     * Revoke API key
     */
    async revokeApiKey(req, res) {
        try {
            const { id } = req.params;
            const userId = req.user?.userId || req.apiKey?.userId;
            if (!userId) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }
            await db.query('UPDATE api_keys SET active = false WHERE id = $1 AND user_id = $2', [id, userId]);
            res.status(204).send();
        }
        catch (error) {
            logger.error('API key revocation failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
}
//# sourceMappingURL=auth.controller.js.map