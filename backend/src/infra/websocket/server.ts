/**
 * WebSocket server (Socket.IO) for real-time run updates.
 *
 * Authentication: when AUTH_ENABLED=true the client must connect with
 *   io(url, { auth: { token: '<jwt>' } })        (or 'ApiKey <key>')
 * Subscriptions are authorised per project:
 *   socket.emit('subscribe_run', { runId })       — live events of one run
 *   socket.emit('subscribe_project', { projectId }) — `runs_changed` for a project
 *
 * Every event payload is flat and always includes `runId`:
 *   run_started    { runId, total }
 *   run_log        { runId, level, message, testId?, stepId? }
 *   run_screenshot { runId, testId, image }      (base64 JPEG)
 *   test_started   { runId, testId, title, index, total }
 *   test_result    { runId, testId, title, status, error?, duration }
 *   run_progress   { runId, status, completed, total, passed, failed, skipped }
 *   run_completed  { runId, status, total, passed, failed, skipped, error? }
 *   runs_changed   { runId, event }  (project room)
 */

import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import logger from '../logger/index.js';
import { isAuthEnabled } from '../config/env.js';
import getDatabaseClient from '../db/client.js';
import { identify, LOCAL_USER, projectRoleFor, AuthenticatedRequest } from '../auth/auth.middleware.js';

type SocketIdentity = { user: NonNullable<AuthenticatedRequest['user']>; apiKey?: AuthenticatedRequest['apiKey'] };

/** runId → projectId (runs never move between projects) */
const runProjects = new Map<string, string>();

async function projectOfRun(runId: string): Promise<string | null> {
  const cached = runProjects.get(runId);
  if (cached) return cached;
  const result = await getDatabaseClient().query('SELECT project_id FROM runs WHERE id = $1', [runId]);
  const projectId = result.rows[0]?.project_id ?? null;
  if (projectId) {
    if (runProjects.size > 5000) runProjects.clear();
    runProjects.set(runId, projectId);
  }
  return projectId;
}

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

    this.io.use(async (socket, next) => {
      try {
        const raw = socket.handshake.auth?.token as string | undefined;
        if (!isAuthEnabled() && !raw?.startsWith('ApiKey ')) {
          socket.data.identity = { user: { ...LOCAL_USER } } satisfies SocketIdentity;
          return next();
        }
        const header = raw ? (raw.startsWith('Bearer ') || raw.startsWith('ApiKey ') ? raw : `Bearer ${raw}`) : undefined;
        const result = await identify(header);
        if ('error' in result) return next(new Error(result.error));
        socket.data.identity = result satisfies SocketIdentity;
        next();
      } catch (error: any) {
        next(new Error(error.message));
      }
    });

    this.io.on('connection', (socket) => {
      logger.debug('WebSocket client connected', { clientId: socket.id });

      socket.on('subscribe_run', async (payload: { runId?: string } | string, ack?: (r: any) => void) => {
        const runId = typeof payload === 'string' ? payload : payload?.runId;
        const allowed = runId ? await this.canAccessRun(socket, runId) : false;
        if (allowed) socket.join(`run:${runId}`);
        ack?.({ ok: allowed });
      });

      socket.on('unsubscribe_run', (payload: { runId?: string } | string) => {
        const runId = typeof payload === 'string' ? payload : payload?.runId;
        if (runId) socket.leave(`run:${runId}`);
      });

      socket.on('subscribe_project', async (payload: { projectId?: string } | string, ack?: (r: any) => void) => {
        const projectId = (typeof payload === 'string' ? payload : payload?.projectId) || 'default';
        const identity = socket.data.identity as SocketIdentity;
        const allowed = !!(await projectRoleFor(identity.user, projectId, identity.apiKey).catch(() => null));
        if (allowed) socket.join(`project:${projectId}`);
        ack?.({ ok: allowed });
      });

      socket.on('disconnect', () => {
        logger.debug('WebSocket client disconnected', { clientId: socket.id });
      });
    });
  }

  private async canAccessRun(socket: Socket, runId: string): Promise<boolean> {
    try {
      const projectId = await projectOfRun(runId);
      if (!projectId) return false;
      const identity = socket.data.identity as SocketIdentity;
      return !!(await projectRoleFor(identity.user, projectId, identity.apiKey));
    } catch {
      return false;
    }
  }

  emitRun(runId: string, event: string, data: Record<string, any>): void {
    this.io.to(`run:${runId}`).emit(event, { runId, ...data, timestamp: new Date().toISOString() });
    if (event === 'run_started' || event === 'run_completed' || event === 'test_result') {
      void projectOfRun(runId).then((projectId) => {
        if (projectId) this.io.to(`project:${projectId}`).emit('runs_changed', { runId, event });
      }).catch(() => undefined);
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
