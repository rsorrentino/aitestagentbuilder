/**
 * WebSocket server (Socket.IO) for real-time run updates.
 *
 * Clients join a run's room with `socket.emit('subscribe_run', { runId })`.
 * Run events are sent to that room; a lightweight `runs_changed` event is
 * broadcast to everyone so list pages can refresh.
 *
 * Every event payload is flat and always includes `runId`:
 *   run_started    { runId, total }
 *   run_log        { runId, level, message, testId?, stepId? }
 *   run_screenshot { runId, testId, image }      (base64 JPEG)
 *   test_started   { runId, testId, title, index, total }
 *   test_result    { runId, testId, title, status, error?, duration }
 *   run_progress   { runId, status, completed, total, passed, failed, skipped }
 *   run_completed  { runId, status, total, passed, failed, skipped, error? }
 */

import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import logger from '../logger/index.js';

export class WebSocketService {
  private io: SocketIOServer;

  constructor(server: HTTPServer) {
    this.io = new SocketIOServer(server, {
      path: '/socket.io',
      cors: {
        origin: process.env.CORS_ORIGIN?.split(',') || '*',
        methods: ['GET', 'POST'],
      },
    });

    this.io.on('connection', (socket) => {
      logger.debug('WebSocket client connected', { clientId: socket.id });

      socket.on('subscribe_run', (payload: { runId?: string } | string) => {
        const runId = typeof payload === 'string' ? payload : payload?.runId;
        if (runId) socket.join(`run:${runId}`);
      });

      socket.on('unsubscribe_run', (payload: { runId?: string } | string) => {
        const runId = typeof payload === 'string' ? payload : payload?.runId;
        if (runId) socket.leave(`run:${runId}`);
      });

      socket.on('disconnect', () => {
        logger.debug('WebSocket client disconnected', { clientId: socket.id });
      });
    });
  }

  emitRun(runId: string, event: string, data: Record<string, any>): void {
    this.io.to(`run:${runId}`).emit(event, { runId, ...data, timestamp: new Date().toISOString() });
    if (event === 'run_started' || event === 'run_completed' || event === 'test_result') {
      this.io.emit('runs_changed', { runId, event });
    }
  }

  getClientCount(): number {
    return this.io.engine.clientsCount;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.io.close(() => resolve()));
  }
}

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

/** Emit a run event if the WebSocket server is running (no-op in CLI/tests). */
export function emitRunEvent(runId: string, event: string, data: Record<string, any>): void {
  wsService?.emitRun(runId, event, data);
}
