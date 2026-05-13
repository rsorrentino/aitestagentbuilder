/**
 * Agent Repository
 */
import { Agent, AgentCreateInput, AgentUpdateInput } from '../domain/agent.js';
export declare class AgentRepository {
    private db;
    create(input: AgentCreateInput): Promise<Agent>;
    findById(id: string): Promise<Agent | null>;
    findByName(name: string): Promise<Agent | null>;
    findAll(limit?: number, offset?: number): Promise<Agent[]>;
    findByStatus(status: string): Promise<Agent[]>;
    update(id: string, input: AgentUpdateInput): Promise<Agent | null>;
    delete(id: string): Promise<boolean>;
    private mapRowToAgent;
}
//# sourceMappingURL=agent.repository.d.ts.map