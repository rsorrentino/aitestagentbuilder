/**
 * Authentication Controller
 */
import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../../infra/auth/auth.middleware.js';
export declare class AuthController {
    /**
     * Login with email/password
     */
    login(req: Request, res: Response): Promise<void>;
    /**
     * Refresh access token
     */
    refresh(req: Request, res: Response): Promise<void>;
    /**
     * Create API key
     */
    createApiKey(req: AuthenticatedRequest, res: Response): Promise<void>;
    /**
     * List API keys
     */
    listApiKeys(req: AuthenticatedRequest, res: Response): Promise<void>;
    /**
     * Revoke API key
     */
    revokeApiKey(req: AuthenticatedRequest, res: Response): Promise<void>;
}
//# sourceMappingURL=auth.controller.d.ts.map