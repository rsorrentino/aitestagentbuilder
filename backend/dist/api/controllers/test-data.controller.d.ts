/**
 * Test Data Controller
 */
import { Request, Response } from 'express';
export declare class TestDataController {
    private testDataRepo;
    createTestData(req: Request, res: Response): Promise<void>;
    getTestData(req: Request, res: Response): Promise<void>;
    listTestData(req: Request, res: Response): Promise<void>;
    updateTestData(req: Request, res: Response): Promise<void>;
    deleteTestData(req: Request, res: Response): Promise<void>;
}
//# sourceMappingURL=test-data.controller.d.ts.map