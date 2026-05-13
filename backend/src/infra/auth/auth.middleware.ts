/**
 * Authentication Middleware
 */

import { Request, Response, NextFunction } from 'express';
import { JWTService } from './jwt.service.js';
import logger from '../logger/index.js';

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    email: string;
    role: string;
  };
  apiKey?: {
    keyId: string;
    userId: string;
    permissions: string[];
  };
}

export type Role = 'admin' | 'user' | 'viewer' | 'service';

const jwtService = new JWTService();

/**
 * Authenticate request using JWT or API key
 */
export async function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Check for Bearer token (JWT)
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const payload = jwtService.verifyAccessToken(token);
      
      req.user = {
        userId: payload.userId,
        email: payload.email,
        role: payload.role,
      };
      
      return next();
    }

    // Check for API key
    if (authHeader.startsWith('ApiKey ')) {
      const apiKey = authHeader.substring(7);
      const apiKeyInfo = await validateApiKey(apiKey);
      
      if (!apiKeyInfo) {
        res.status(401).json({ error: 'Invalid API key' });
        return;
      }

      req.apiKey = apiKeyInfo;
      return next();
    }

    res.status(401).json({ error: 'Invalid authentication format' });
  } catch (error: any) {
    logger.error('Authentication failed', { error: error.message });
    res.status(401).json({ error: 'Authentication failed' });
  }
}

/**
 * Optional authentication - doesn't fail if no auth provided
 */
export async function optionalAuth(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const payload = jwtService.verifyAccessToken(token);
      req.user = {
        userId: payload.userId,
        email: payload.email,
        role: payload.role,
      };
    } else if (authHeader?.startsWith('ApiKey ')) {
      const apiKey = authHeader.substring(7);
      const apiKeyInfo = await validateApiKey(apiKey);
      if (apiKeyInfo) {
        req.apiKey = apiKeyInfo;
      }
    }

    next();
  } catch (error) {
    // Ignore auth errors for optional auth
    next();
  }
}

/**
 * Authorize based on role
 */
export function authorize(...allowedRoles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const user = req.user || req.apiKey;
    
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const role = 'role' in user ? user.role : 'service';
    const permissions = 'permissions' in user ? user.permissions : [];

    if (allowedRoles.includes(role as Role) || permissions.includes('*')) {
      return next();
    }

    res.status(403).json({ error: 'Insufficient permissions' });
  };
}

/**
 * Validate API key from database
 */
async function validateApiKey(apiKey: string): Promise<{
  keyId: string;
  userId: string;
  permissions: string[];
} | null> {
  try {
    // Hash the provided key
    const hashedKey = jwtService.hashApiKey(apiKey);
    
    // Query database for API key (dynamic import to avoid circular dependency)
    const { default: getDatabaseClient } = await import('../db/client.js');
    const db = getDatabaseClient();

    // Query database for API key
    const result = await db.query(
      `SELECT id, user_id, permissions, expires_at 
       FROM api_keys 
       WHERE key_hash = $1 AND active = true 
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [hashedKey]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const key = result.rows[0];
    return {
      keyId: key.id,
      userId: key.user_id,
      permissions: key.permissions || [],
    };
  } catch (error: any) {
    logger.error('API key validation failed', { error: error.message });
    return null;
  }
}

