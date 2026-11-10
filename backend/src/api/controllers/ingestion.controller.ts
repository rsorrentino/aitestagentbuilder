/**
 * Ingestion Controller
 * Handles document upload and AI test case extraction.
 */

import { Request, Response } from 'express';
import {
  DocumentParserService,
  detectSourceType,
  isTextSourceType,
} from '../../modules/ingestion/services/document-parser.service.js';
import { ParserAgentService } from '../../modules/ingestion/services/parser-agent.service.js';
import { TestCaseRepository } from '../../core/repositories/test-case.repository.js';
import { DocumentRepository } from '../../core/repositories/document.repository.js';
import { NoLLMProviderError } from '../../infra/llm/router.js';
import logger from '../../infra/logger/index.js';

export class IngestionController {
  private documentParser = new DocumentParserService();
  private parserAgent = new ParserAgentService();
  private documentRepo = new DocumentRepository();
  private testCaseRepo = new TestCaseRepository();

  async listDocuments(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      res.json(await this.documentRepo.findAll(limit));
    } catch (error: any) {
      logger.error('Failed to list documents', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  async uploadDocument(req: Request, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded (multipart field name must be "file")' });
        return;
      }

      const file = req.file;
      const sourceType = detectSourceType(file.mimetype, file.originalname);
      const content = isTextSourceType(sourceType)
        ? file.buffer.toString('utf-8')
        : file.buffer.toString('base64');

      const document = await this.documentRepo.create({
        name: file.originalname,
        sourceType,
        content,
        fileSize: file.size,
        mimeType: file.mimetype,
      });

      res.status(201).json({
        id: document.id,
        name: document.name,
        sourceType: document.sourceType,
        fileSize: document.fileSize,
        status: document.status,
        uploadedAt: document.uploadedAt,
      });
    } catch (error: any) {
      logger.error('Document upload failed', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  /** Returns the parsed plain text of a document (useful to check parsing). */
  async previewDocument(req: Request, res: Response): Promise<void> {
    try {
      const document = await this.documentRepo.findById(req.params.documentId);
      if (!document) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }
      const parsed = await this.documentParser.parseDocument(document);
      res.json({ id: document.id, name: document.name, text: parsed.text.slice(0, 20000), metadata: parsed.metadata });
    } catch (error: any) {
      res.status(422).json({ error: error.message });
    }
  }

  async deleteDocument(req: Request, res: Response): Promise<void> {
    try {
      const deleted = await this.documentRepo.delete(req.params.documentId);
      if (!deleted) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }
      res.status(204).send();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async extractTestCases(req: Request, res: Response): Promise<void> {
    const { documentId } = req.params;
    const module = (req.body?.module ?? req.query.module) as string | undefined;
    const priority = (req.body?.priority ?? req.query.priority) as string | undefined;
    const baseUrl = (req.body?.baseUrl ?? req.query.baseUrl) as string | undefined;

    try {
      const document = await this.documentRepo.findById(documentId);
      if (!document) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      await this.documentRepo.updateStatus(documentId, 'processing');

      const parsed = await this.documentParser.parseDocument(document);
      const extraction = await this.parserAgent.extractTestCases(parsed.text, documentId, { module, priority, baseUrl });

      const saved = [];
      for (const tc of extraction.testCases) {
        saved.push(await this.testCaseRepo.create(tc));
      }

      await this.documentRepo.updateStatus(documentId, 'processed');

      res.json({
        documentId,
        extracted: saved.length,
        testCases: saved.map(tc => ({
          id: tc.id,
          title: tc.title,
          module: tc.module,
          priority: tc.priority,
          steps: tc.steps.length,
        })),
        metadata: extraction.metadata,
      });
    } catch (error: any) {
      logger.error('Test case extraction failed', { documentId, error: error.message });
      await this.documentRepo.updateStatus(documentId, 'failed', error.message).catch(() => undefined);
      const status = error instanceof NoLLMProviderError ? 503 : 500;
      res.status(status).json({ error: error.message });
    }
  }
}
