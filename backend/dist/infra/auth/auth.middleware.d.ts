/**
 * Authentication Middleware
 */
import { Request, Response, NextFunction } from 'express';
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
/**
 * Authenticate request using JWT or API key
 */
export declare function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void>;
/**
 * Optional authentication - doesn't fail if no auth provided
 */
export declare function optionalAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void>;
/**
 * Authorize based on role
 */
export declare function authorize(...allowedRoles: Role[]): (req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
//# sourceMappingURL=auth.middleware.d.ts.map