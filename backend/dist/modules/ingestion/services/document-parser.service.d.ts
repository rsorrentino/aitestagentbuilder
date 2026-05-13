/**
 * Document Parser Service
 * Handles parsing of various document formats
 */
import { Document } from '../../../core/domain/document.js';
export interface ParsedContent {
    text: string;
    metadata?: {
        pages?: number;
        sheets?: string[];
        wordCount?: number;
    };
}
export declare class DocumentParserService {
    /**
     * Parse a document based on its source type
     */
    parseDocument(document: Document): Promise<ParsedContent>;
    private parsePDF;
    private parseWord;
    private parseExcel;
    private parseText;
    private parseHTML;
    /**
     * Chunk text into smaller pieces for processing
     */
    chunkText(text: string, chunkSize?: number, overlap?: number): string[];
}
//# sourceMappingURL=document-parser.service.d.ts.map