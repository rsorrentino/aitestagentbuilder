/**
 * Test Case Repository
 * Data access layer for test cases
 */
import { TestCase, TestCaseCreateInput, TestCaseUpdateInput } from '../domain/test-case.js';
export declare class TestCaseRepository {
    private db;
    create(input: TestCaseCreateInput): Promise<TestCase>;
    findById(id: string): Promise<TestCase | null>;
    findByModule(module: string): Promise<TestCase[]>;
    findByPriority(priority: string): Promise<TestCase[]>;
    findByTags(tags: string[]): Promise<TestCase[]>;
    findAll(limit?: number, offset?: number): Promise<TestCase[]>;
    update(id: string, input: TestCaseUpdateInput): Promise<TestCase | null>;
    delete(id: string): Promise<boolean>;
    searchByEmbedding(embedding: number[], limit?: number): Promise<TestCase[]>;
    updateEmbedding(id: string, embedding: number[]): Promise<void>;
    private mapRowToTestCase;
}
//# sourceMappingURL=test-case.repository.d.ts.map