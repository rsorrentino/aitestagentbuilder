/**
 * Error Handling Middleware
 */
import { Request, Response, NextFunction } from 'express';
export declare function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void;
export declare function notFoundHandler(req: Request, res: Response): void;
//# sourceMappingURL=error-handler.d.ts.map