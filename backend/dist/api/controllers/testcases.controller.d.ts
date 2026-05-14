/**
 * Test Cases Controller
 */
import { Request, Response } from 'express';
export declare class TestCasesController {
    private testCaseRepo;
    createTestCase(req: Request, res: Response): Promise<void>;
    getTestCase(req: Request, res: Response): Promise<void>;
    listTestCases(req: Request, res: Response): Promise<void>;
    updateTestCase(req: Request, res: Response): Promise<void>;
    deleteTestCase(req: Request, res: Response): Promise<void>;
}
//# sourceMappingURL=testcases.controller.d.ts.map