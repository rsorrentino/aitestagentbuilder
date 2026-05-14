/**
 * Document Parser Service
 * Handles parsing of various document formats
 */
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { readFileSync } from 'fs';
import logger from '../../../infra/logger/index.js';
export class DocumentParserService {
    /**
     * Parse a document based on its source type
     */
    async parseDocument(document) {
        const { sourceType, filePath, content } = document;
        try {
            switch (sourceType) {
                case 'pdf':
                    return await this.parsePDF(filePath || content);
                case 'word':
                    return await this.parseWord(filePath || content);
                case 'excel':
                    return await this.parseExcel(filePath || content);
                case 'markdown':
                case 'text':
                    return this.parseText(content);
                case 'html':
                    return this.parseHTML(content);
                default:
                    throw new Error(`Unsupported document type: ${sourceType}`);
            }
        }
        catch (error) {
            logger.error('Document parsing failed', { documentId: document.id, error: error.message });
            throw new Error(`Failed to parse document: ${error.message}`);
        }
    }
    async parsePDF(filePathOrContent) {
        let buffer;
        if (filePathOrContent.startsWith('/') || filePathOrContent.includes('\\')) {
            // File path
            buffer = readFileSync(filePathOrContent);
        }
        else {
            // Base64 or direct content
            buffer = Buffer.from(filePathOrContent, 'base64');
        }
        const data = await pdfParse(buffer);
        return {
            text: data.text,
            metadata: {
                pages: data.numpages,
                wordCount: data.text.split(/\s+/).length,
            },
        };
    }
    async parseWord(filePathOrContent) {
        let buffer;
        if (filePathOrContent.startsWith('/') || filePathOrContent.includes('\\')) {
            buffer = readFileSync(filePathOrContent);
        }
        else {
            buffer = Buffer.from(filePathOrContent, 'base64');
        }
        const result = await mammoth.extractRawText({ buffer });
        return {
            text: result.value,
            metadata: {
                wordCount: result.value.split(/\s+/).length,
            },
        };
    }
    async parseExcel(filePathOrContent) {
        let workbook;
        if (filePathOrContent.startsWith('/') || filePathOrContent.includes('\\')) {
            workbook = XLSX.readFile(filePathOrContent);
        }
        else {
            const buffer = Buffer.from(filePathOrContent, 'base64');
            workbook = XLSX.read(buffer, { type: 'buffer' });
        }
        const sheets = [];
        let allText = '';
        workbook.SheetNames.forEach((sheetName) => {
            sheets.push(sheetName);
            const worksheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
            allText += `\n\nSheet: ${sheetName}\n`;
            jsonData.forEach((row) => {
                allText += JSON.stringify(row) + '\n';
            });
        });
        return {
            text: allText,
            metadata: {
                sheets,
                wordCount: allText.split(/\s+/).length,
            },
        };
    }
    parseText(content) {
        return {
            text: content,
            metadata: {
                wordCount: content.split(/\s+/).length,
            },
        };
    }
    parseHTML(content) {
        // Simple HTML to text extraction (remove tags)
        const text = content
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return {
            text,
            metadata: {
                wordCount: text.split(/\s+/).length,
            },
        };
    }
    /**
     * Chunk text into smaller pieces for processing
     */
    chunkText(text, chunkSize = 2000, overlap = 200) {
        const chunks = [];
        let start = 0;
        while (start < text.length) {
            const end = Math.min(start + chunkSize, text.length);
            const chunk = text.substring(start, end);
            chunks.push(chunk);
            start = end - overlap;
        }
        return chunks;
    }
}
//# sourceMappingURL=document-parser.service.js.map