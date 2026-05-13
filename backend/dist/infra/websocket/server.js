/**
 * WebSocket Server for Real-time Updates
 * Uses Socket.IO for better browser compatibility
 */
import { Server as SocketIOServer } from 'socket.io';
import logger from '../logger/index.js';
export class WebSocketService {
    io;
    clients = new Map();
    constructor(server) {
        this.io = new SocketIOServer(server, {
            path: '/socket.io',
            cors: {
                origin: '*',
                methods: ['GET', 'POST'],
            },
        });
        this.io.on('connection', (socket) => {
            const clientId = socket.id;
            this.clients.set(clientId, socket);
            logger.info('WebSocket client connected', { clientId });
            socket.on('disconnect', () => {
                this.clients.delete(clientId);
                logger.info('WebSocket client disconnected', { clientId });
            });
            socket.on('error', (error) => {
                logger.error('WebSocket error', { clientId, error: error.message });
            });
            // Send welcome message
            socket.emit('run_started', {
                type: 'run_started',
                data: { message: 'Connected to AI Test Agent Builder' },
                timestamp: new Date().toISOString(),
            });
        });
    }
    /**
     * Broadcast message to all connected clients
     */
    broadcast(message) {
        this.io.emit(message.type, message);
    }
    /**
     * Send message to specific client
     */
    sendToClient(clientId, message) {
        const client = this.clients.get(clientId);
        if (client) {
            try {
                client.emit(message.type, message);
            }
            catch (error) {
                logger.error('Failed to send message to client', { clientId, error: error.message });
            }
        }
    }
    /**
     * Broadcast run progress update
     */
    broadcastRunProgress(runId, progress) {
        this.broadcast({
            type: 'run_progress',
            data: { runId, ...progress },
            timestamp: new Date().toISOString(),
        });
    }
    /**
     * Broadcast test result
     */
    broadcastTestResult(runId, result) {
        this.broadcast({
            type: 'test_result',
            data: { runId, result },
            timestamp: new Date().toISOString(),
        });
    }
    /**
     * Broadcast run completion
     */
    broadcastRunCompleted(runId, summary) {
        this.broadcast({
            type: 'run_completed',
            data: { runId, summary },
            timestamp: new Date().toISOString(),
        });
    }
    getClientCount() {
        return this.clients.size;
    }
}
// Singleton instance
let wsService = null;
export function initializeWebSocket(server) {
    if (!wsService) {
        wsService = new WebSocketService(server);
    }
    return wsService;
}
export function getWebSocketService() {
    return wsService;
}
//# sourceMappingURL=server.js.map