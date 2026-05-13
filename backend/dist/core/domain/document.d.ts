/**
 * Core Domain Model: Document
 */
export type DocumentSourceType = 'pdf' | 'word' | 'excel' | 'markdown' | 'html' | 'confluence' | 'text';
export interface Document {
    id: string;
    name: string;
    sourceType: DocumentSourceType;
    content: string;
    filePath?: string;
    fileSize?: number;
    mimeType?: string;
    uploadedAt: Date;
    uploadedBy?: string;
    metadata?: {
        author?: string;
        version?: string;
        pages?: number;
        extractedAt?: Date;
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
    testCases: any[];
    extractionMetadata: {
        extractedAt: Date;
        extractionMethod: 'llm' | 'regex' | 'structured';
        confidence?: number;
        rawText?: string;
    };
}
//# sourceMappingURL=document.d.ts.map