/**
 * Ingestion Controller
 * Handles document upload and test case extraction
 */
import { Request, Response } from 'express';
export declare class IngestionController {
    private documentParser;
    private parserAgent;
    private documentRepo;
    private testCaseRepo;
    /**
     * List all documents
     */
    listDocuments(req: Request, res: Response): Promise<void>;
    /**
     * Upload and parse a document
     */
    uploadDocument(req: Request, res: Response): Promise<void>;
    /**
     * Extract test cases from a document
     */
    extractTestCases(req: Request, res: Response): Promise<void>;
    private determineSourceType;
}
//# sourceMappingURL=ingestion.controller.d.ts.map