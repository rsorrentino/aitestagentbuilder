/**
 * Core Domain Model: Document
 */

export type DocumentSourceType = 'pdf' | 'word' | 'excel' | 'csv' | 'markdown' | 'html' | 'confluence' | 'text';
export type DocumentStatus = 'uploaded' | 'processing' | 'processed' | 'failed';

/** Source types whose content is stored as UTF-8 text (the rest as base64). */
export const TEXT_SOURCE_TYPES: DocumentSourceType[] = ['text', 'markdown', 'html', 'csv', 'confluence'];

export interface Document {
  id: string;
  name: string;
  sourceType: DocumentSourceType;
  content?: string; // UTF-8 text for text formats, base64 for binary formats
  filePath?: string;
  fileSize?: number;
  mimeType?: string;
  uploadedAt: Date;
  uploadedBy?: string;
  status?: DocumentStatus;
  error?: string;
  testCaseCount?: number;
  metadata?: {
    author?: string;
    version?: string;
    pages?: number;
    extractedAt?: Date;
    provider?: string;
    truncated?: boolean;
  };
}

export interface DocumentCreateInput {
  name: string;
  sourceType: DocumentSourceType;
  content: string;
  filePath?: string;
  fileSize?: number;
  mimeType?: string;
  uploadedBy?: string;
  metadata?: Document['metadata'];
}

export interface ParsedTestCases {
  documentId: string;
  testCases: any[]; // TestCase[] from test-case.ts
  extractionMetadata: {
    extractedAt: Date;
    extractionMethod: 'llm' | 'regex' | 'structured';
    confidence?: number;
    rawText?: string;
  };
}

