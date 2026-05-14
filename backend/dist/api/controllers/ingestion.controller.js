/**
 * Ingestion Controller
 * Handles document upload and test case extraction
 */
import { DocumentParserService } from '../../modules/ingestion/services/document-parser.service.js';
import { ParserAgentService } from '../../modules/ingestion/services/parser-agent.service.js';
import { TestCaseRepository } from '../../core/repositories/test-case.repository.js';
import { DocumentRepository } from '../../core/repositories/document.repository.js';
import logger from '../../infra/logger/index.js';
export class IngestionController {
    documentParser = new DocumentParserService();
    parserAgent = new ParserAgentService();
    documentRepo = new DocumentRepository();
    testCaseRepo = new TestCaseRepository();
    /**
     * List all documents
     */
    async listDocuments(req, res) {
        try {
            const limit = parseInt(req.query.limit) || 100;
            const documents = await this.documentRepo.findAll(limit);
            res.json(documents);
        }
        catch (error) {
            logger.error('Failed to list documents', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    /**
     * Upload and parse a document
     */
    async uploadDocument(req, res) {
        try {
            if (!req.file) {
                res.status(400).json({ error: 'No file uploaded' });
                return;
            }
            const file = req.file;
            const sourceType = this.determineSourceType(file.mimetype, file.originalname);
            // Create document record
            const document = await this.documentRepo.create({
                name: file.originalname,
                sourceType,
                content: file.buffer.toString('base64'),
                filePath: file.path,
                fileSize: file.size,
                mimeType: file.mimetype,
            });
            res.status(201).json({
                id: document.id,
                name: document.name,
                sourceType: document.sourceType,
                uploadedAt: document.uploadedAt,
            });
        }
        catch (error) {
            logger.error('Document upload failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    /**
     * Extract test cases from a document
     */
    async extractTestCases(req, res) {
        try {
            const { documentId } = req.params;
            const { module, priority } = req.query;
            // Fetch document
            const document = await this.documentRepo.findById(documentId);
            if (!document) {
                res.status(404).json({ error: 'Document not found' });
                return;
            }
            // Parse document
            const parsed = await this.documentParser.parseDocument(document);
            // Extract test cases using LLM
            const extraction = await this.parserAgent.extractTestCases(parsed.text, documentId, { module: module, priority: priority });
            // Store test cases
            const savedTestCases = await Promise.all(extraction.testCases.map(tc => this.testCaseRepo.create(tc)));
            res.json({
                documentId,
                extracted: savedTestCases.length,
                testCases: savedTestCases.map(tc => ({
                    id: tc.id,
                    title: tc.title,
                    module: tc.module,
                    priority: tc.priority,
                })),
                metadata: extraction.metadata,
            });
        }
        catch (error) {
            logger.error('Test case extraction failed', { error: error.message });
            res.status(500).json({ error: error.message });
        }
    }
    determineSourceType(mimetype, filename) {
        if (mimetype === 'application/pdf')
            return 'pdf';
        if (mimetype.includes('word') || filename.endsWith('.docx') || filename.endsWith('.doc')) {
            return 'word';
        }
        if (mimetype.includes('excel') || mimetype.includes('spreadsheet') ||
            filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
            return 'excel';
        }
        if (mimetype === 'text/html')
            return 'html';
        if (mimetype === 'text/markdown' || filename.endsWith('.md'))
            return 'markdown';
        return 'text';
    }
}
//# sourceMappingURL=ingestion.controller.js.map