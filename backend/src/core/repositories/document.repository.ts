/**
 * Document Repository
 */

import getDatabaseClient from '../../infra/db/client.js';
import { Document, DocumentCreateInput } from '../domain/document.js';

export class DocumentRepository {
  private db = getDatabaseClient();

  async create(input: DocumentCreateInput): Promise<Document> {
    const id = `DOC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date();

    const query = `
      INSERT INTO documents (
        id, name, source_type, content, file_path, file_size, mime_type, uploaded_at, uploaded_by, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;

    const result = await this.db.query<Document>(query, [
      id,
      input.name,
      input.sourceType,
      input.content,
      input.filePath || null,
      input.fileSize || null,
      input.mimeType || null,
      now,
      input.uploadedBy || null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ]);

    return this.mapRowToDocument(result.rows[0]);
  }

  async findById(id: string): Promise<Document | null> {
    const query = 'SELECT * FROM documents WHERE id = $1';
    const result = await this.db.query<Document>(query, [id]);
    
    if (result.rows.length === 0) return null;
    return this.mapRowToDocument(result.rows[0]);
  }

  async findAll(limit: number = 100, offset: number = 0): Promise<Document[]> {
    const query = 'SELECT * FROM documents ORDER BY uploaded_at DESC LIMIT $1 OFFSET $2';
    const result = await this.db.query<Document>(query, [limit, offset]);
    return result.rows.map(row => this.mapRowToDocument(row));
  }

  async delete(id: string): Promise<boolean> {
    const query = 'DELETE FROM documents WHERE id = $1';
    const result = await this.db.query(query, [id]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  private mapRowToDocument(row: any): Document {
    return {
      id: row.id,
      name: row.name,
      sourceType: row.source_type,
      content: row.content,
      filePath: row.file_path,
      fileSize: row.file_size,
      mimeType: row.mime_type,
      uploadedAt: row.uploaded_at,
      uploadedBy: row.uploaded_by,
      metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : undefined,
    };
  }
}

