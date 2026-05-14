/**
 * Test Data Management Domain Model
 */
export interface TestDataSet {
    id: string;
    name: string;
    description?: string;
    data: Record<string, any>;
    tags?: string[];
    environment?: string;
    createdAt: Date;
    updatedAt: Date;
    createdBy?: string;
}
export interface TestDataCreateInput {
    name: string;
    description?: string;
    data: Record<string, any>;
    tags?: string[];
    environment?: string;
    createdBy?: string;
}
export interface TestDataUpdateInput {
    name?: string;
    description?: string;
    data?: Record<string, any>;
    tags?: string[];
    environment?: string;
}
export interface TestDataTemplate {
    id: string;
    name: string;
    schema: Record<string, any>;
    generator?: string;
    createdAt: Date;
}
//# sourceMappingURL=test-data.d.ts.map