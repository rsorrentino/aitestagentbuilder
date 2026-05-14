/**
 * WebSocket Server for Real-time Updates
 * Uses Socket.IO for better browser compatibility
 */
import { Server as HTTPServer } from 'http';
export interface WebSocketMessage {
    type: 'run_started' | 'run_progress' | 'run_completed' | 'test_result' | 'error';
    data: any;
    timestamp: string;
}
export declare class WebSocketService {
    private io;
    private clients;
    constructor(server: HTTPServer);
    /**
     * Broadcast message to all connected clients
     */
    broadcast(message: WebSocketMessage): void;
    /**
     * Send message to specific client
     */
    sendToClient(clientId: string, message: WebSocketMessage): void;
    /**
     * Broadcast run progress update
     */
    broadcastRunProgress(runId: string, progress: {
        status: string;
        completed: number;
        total: number;
        passed: number;
        failed: number;
    }): void;
    /**
     * Broadcast test result
     */
    broadcastTestResult(runId: string, result: any): void;
    /**
     * Broadcast run completion
     */
    broadcastRunCompleted(runId: string, summary: any): void;
    getClientCount(): number;
}
export declare function initializeWebSocket(server: HTTPServer): WebSocketService;
export declare function getWebSocketService(): WebSocketService | null;
//# sourceMappingURL=server.d.ts.map