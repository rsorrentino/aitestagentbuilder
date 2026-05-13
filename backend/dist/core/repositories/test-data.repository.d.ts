/**
 * Test Data Repository
 */
import { TestDataSet, TestDataCreateInput, TestDataUpdateInput } from '../domain/test-data.js';
export declare class TestDataRepository {
    private db;
    create(input: TestDataCreateInput): Promise<TestDataSet>;
    findById(id: string): Promise<TestDataSet | null>;
    findByName(name: string): Promise<TestDataSet | null>;
    findByEnvironment(environment: string): Promise<TestDataSet[]>;
    findAll(limit?: number, offset?: number): Promise<TestDataSet[]>;
    update(id: string, input: TestDataUpdateInput): Promise<TestDataSet | null>;
    delete(id: string): Promise<boolean>;
    private ensureTableExists;
    private mapRowToDataSet;
}
//# sourceMappingURL=test-data.repository.d.ts.map