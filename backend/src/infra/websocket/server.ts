/**
 * WebSocket Server for Real-time Updates
 * Uses Socket.IO for better browser compatibility
 */

import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import logger from '../logger/index.js';

export interface WebSocketMessage {
  type: 'run_started' | 'run_progress' | 'run_completed' | 'test_result' | 'error';
  data: any;
  timestamp: string;
}

export class WebSocketService {
  private io: SocketIOServer;
  private clients: Map<string, any> = new Map();

  constructor(server: HTTPServer) {
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
  broadcast(message: WebSocketMessage): void {
    this.io.emit(message.type, message);
  }

  /**
   * Send message to specific client
   */
  sendToClient(clientId: string, message: WebSocketMessage): void {
    const client = this.clients.get(clientId);
    if (client) {
      try {
        client.emit(message.type, message);
      } catch (error: any) {
        logger.error('Failed to send message to client', { clientId, error: error.message });
      }
    }
  }

  /**
   * Broadcast run progress update
   */
  broadcastRunProgress(runId: string, progress: {
    status: string;
    completed: number;
    total: number;
    passed: number;
    failed: number;
  }): void {
    this.broadcast({
      type: 'run_progress',
      data: { runId, ...progress },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Broadcast test result
   */
  broadcastTestResult(runId: string, result: any): void {
    this.broadcast({
      type: 'test_result',
      data: { runId, result },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Broadcast run completion
   */
  broadcastRunCompleted(runId: string, summary: any): void {
    this.broadcast({
      type: 'run_completed',
      data: { runId, summary },
      timestamp: new Date().toISOString(),
    });
  }


  getClientCount(): number {
    return this.clients.size;
  }
}

// Singleton instance
let wsService: WebSocketService | null = null;

export function initializeWebSocket(server: HTTPServer): WebSocketService {
  if (!wsService) {
    wsService = new WebSocketService(server);
  }
  return wsService;
}

export function getWebSocketService(): WebSocketService | null {
  return wsService;
}

