/**
 * Document Repository
 */

import getDatabaseClient from '../../infra/db/client.js';
import { Document, DocumentCreateInput, DocumentStatus } from '../domain/document.js';

export class DocumentRepository {
  private db = getDatabaseClient();

  async create(input: DocumentCreateInput): Promise<Document> {
    const id = `DOC-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    const result = await this.db.query(
      `INSERT INTO documents (
        id, name, source_type, content, file_path, file_size, mime_type, uploaded_at, uploaded_by, metadata, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'uploaded')
      RETURNING *`,
      [
        id,
        input.name,
        input.sourceType,
        input.content,
        input.filePath || null,
        input.fileSize || null,
        input.mimeType || null,
        new Date(),
        input.uploadedBy || null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ],
    );

    return this.mapRowToDocument(result.rows[0]);
  }

  async findById(id: string): Promise<Document | null> {
    const result = await this.db.query('SELECT * FROM documents WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;
    return this.mapRowToDocument(result.rows[0]);
  }

  /** Lists documents without their (potentially large) content. */
  async findAll(limit: number = 100, offset: number = 0): Promise<Document[]> {
    const result = await this.db.query(
      `SELECT d.id, d.name, d.source_type, d.file_size, d.mime_type, d.uploaded_at, d.uploaded_by,
              d.metadata, d.status, d.error,
              (SELECT COUNT(*) FROM test_cases tc WHERE tc.document_id = d.id)::int AS test_case_count
         FROM documents d
        ORDER BY d.uploaded_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return result.rows.map(row => this.mapRowToDocument(row));
  }

  async updateStatus(id: string, status: DocumentStatus, error?: string | null): Promise<void> {
    await this.db.query('UPDATE documents SET status = $1, error = $2 WHERE id = $3', [status, error ?? null, id]);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM documents WHERE id = $1', [id]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  private mapRowToDocument(row: any): Document {
    return {
      id: row.id,
      name: row.name,
      sourceType: row.source_type,
      content: row.content,
      filePath: row.file_path,
      fileSize: row.file_size !== null && row.file_size !== undefined ? Number(row.file_size) : undefined,
      mimeType: row.mime_type,
      uploadedAt: row.uploaded_at,
      uploadedBy: row.uploaded_by,
      status: row.status ?? 'uploaded',
      error: row.error ?? undefined,
      testCaseCount: row.test_case_count,
      metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : undefined,
    };
  }
}
