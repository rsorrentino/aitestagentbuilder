/**
 * Document Parser Service
 * Turns uploaded documents into plain text.
 *
 * Text formats (txt, md, csv, html) are stored as UTF-8; binary formats
 * (pdf, docx, xlsx) are stored base64-encoded.
 */

import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { Document, DocumentSourceType, TEXT_SOURCE_TYPES } from '../../../core/domain/document.js';
import logger from '../../../infra/logger/index.js';

export interface ParsedContent {
  text: string;
  metadata?: {
    pages?: number;
    sheets?: string[];
    wordCount?: number;
  };
}

export function detectSourceType(mimetype: string, filename: string): DocumentSourceType {
  const name = filename.toLowerCase();
  if (mimetype === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.docx') || mimetype.includes('wordprocessingml') || mimetype === 'application/msword') return 'word';
  if (name.endsWith('.csv') || mimetype === 'text/csv') return 'csv';
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || mimetype.includes('spreadsheet') || mimetype.includes('excel')) return 'excel';
  if (name.endsWith('.html') || name.endsWith('.htm') || mimetype === 'text/html') return 'html';
  if (name.endsWith('.md') || name.endsWith('.markdown') || mimetype === 'text/markdown') return 'markdown';
  return 'text';
}

export function isTextSourceType(type: DocumentSourceType): boolean {
  return TEXT_SOURCE_TYPES.includes(type);
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

export class DocumentParserService {
  async parseDocument(document: Document): Promise<ParsedContent> {
    const content = document.content ?? '';
    try {
      switch (document.sourceType) {
        case 'pdf':
          return await this.parsePDF(Buffer.from(content, 'base64'));
        case 'word':
          return await this.parseWord(Buffer.from(content, 'base64'));
        case 'excel':
          return this.parseExcel(Buffer.from(content, 'base64'));
        case 'html':
          return this.parseHTML(content);
        case 'csv':
        case 'markdown':
        case 'text':
        case 'confluence':
          return { text: content, metadata: { wordCount: wordCount(content) } };
        default:
          throw new Error(`Unsupported document type: ${document.sourceType}`);
      }
    } catch (error: any) {
      logger.error('Document parsing failed', { documentId: document.id, error: error.message });
      throw new Error(`Failed to parse document: ${error.message}`);
    }
  }

  private async parsePDF(buffer: Buffer): Promise<ParsedContent> {
    const data = await pdfParse(buffer);
    return { text: data.text, metadata: { pages: data.numpages, wordCount: wordCount(data.text) } };
  }

  private async parseWord(buffer: Buffer): Promise<ParsedContent> {
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value, metadata: { wordCount: wordCount(result.value) } };
  }

  private parseExcel(buffer: Buffer): ParsedContent {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheets: string[] = [];
    let allText = '';

    workbook.SheetNames.forEach((sheetName) => {
      sheets.push(sheetName);
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
      allText += `\n\nSheet: ${sheetName}\n${csv}`;
    });

    return { text: allText.trim(), metadata: { sheets, wordCount: wordCount(allText) } };
  }

  private parseHTML(content: string): ParsedContent {
    const text = content
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim();
    return { text, metadata: { wordCount: wordCount(text) } };
  }
}
