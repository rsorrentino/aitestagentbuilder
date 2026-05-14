/**
 * Document Repository
 */
import { Document, DocumentCreateInput } from '../domain/document.js';
export declare class DocumentRepository {
    private db;
    create(input: DocumentCreateInput): Promise<Document>;
    findById(id: string): Promise<Document | null>;
    findAll(limit?: number, offset?: number): Promise<Document[]>;
    delete(id: string): Promise<boolean>;
    private mapRowToDocument;
}
//# sourceMappingURL=document.repository.d.ts.map