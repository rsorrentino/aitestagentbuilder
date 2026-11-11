/**
 * Subscribe to a run's real-time events over Socket.IO.
 */

import { useEffect, useRef, useState } from 'react';
import io, { Socket } from 'socket.io-client';
import { BACKEND_URL, getProjectId, getToken } from './api';

function connect(): Socket {
  const token = getToken();
  return io(BACKEND_URL, { path: '/socket.io', transports: ['websocket', 'polling'], ...(token ? { auth: { token } } : {}) });
}

export type RunEventName =
  | 'run_started' | 'run_log' | 'run_screenshot' | 'test_started' | 'test_result' | 'run_progress' | 'run_completed';

export type RunEventHandler = (event: RunEventName, data: any) => void;

const EVENTS: RunEventName[] = ['run_started', 'run_log', 'run_screenshot', 'test_started', 'test_result', 'run_progress', 'run_completed'];

export function useRunEvents(runId: string | undefined, onEvent: RunEventHandler): boolean {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!runId) return;
    const socket: Socket = connect();

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('subscribe_run', { runId });
    });
    socket.on('disconnect', () => setConnected(false));
    EVENTS.forEach((name) => socket.on(name, (data: any) => {
      if (data?.runId === runId) handlerRef.current(name, data);
    }));

    return () => {
      socket.emit('unsubscribe_run', { runId });
      socket.disconnect();
    };
  }, [runId]);

  return connected;
}

/** Calls `onChange` whenever any run starts, finishes or records a result. */
export function useRunsChanged(onChange: () => void): void {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    const socket: Socket = connect();
    socket.on('connect', () => socket.emit('subscribe_project', { projectId: getProjectId() }));
    socket.on('runs_changed', () => ref.current());
    return () => { socket.disconnect(); };
  }, []);
}
