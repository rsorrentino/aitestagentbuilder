/**
 * Test Runs Controller
 */
import { Request, Response } from 'express';
export declare class RunsController {
    private orchestrator;
    private runRepo;
    startRun(req: Request, res: Response): Promise<void>;
    getRun(req: Request, res: Response): Promise<void>;
    cancelRun(req: Request, res: Response): Promise<void>;
    listRuns(req: Request, res: Response): Promise<void>;
}
//# sourceMappingURL=runs.controller.d.ts.map