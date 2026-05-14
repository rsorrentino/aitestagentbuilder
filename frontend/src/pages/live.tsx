/**
 * LiveTestView Page
 *
 * Streams real-time Playwright screenshots over WebSocket as tests run,
 * giving a "watch the bot test" experience.
 */

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import io, { Socket } from 'socket.io-client';
import Layout from '../components/Layout';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3000';

interface TestEvent {
  type: 'screenshot' | 'log' | 'result' | 'progress' | 'completed';
  testId?: string;
  stepId?: number;
  message?: string;
  screenshot?: string; // base64 PNG
  status?: string;
  timestamp: string;
}

function statusBadge(status: string) {
  const m: Record<string, string> = {
    running:   'badge badge-warning',
    completed: 'badge badge-success',
    failed:    'badge badge-danger',
    cancelled: 'badge badge-neutral',
    connecting:'badge badge-info',
    connected: 'badge badge-info',
  };
  return m[status] ?? 'badge badge-neutral';
}

export default function LiveTestView() {
  const router = useRouter();
  const { runId } = router.query;

  const [events, setEvents] = useState<TestEvent[]>([]);
  const [latestScreenshot, setLatestScreenshot] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string>('connecting');
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!runId) return;

    const socket: Socket = io(WS_URL, { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      setRunStatus('connected');
      socket.emit('subscribe_run', { runId });
    });

    socket.on('disconnect', () => {
      setConnected(false);
    });

    socket.on('run_started', (data: any) => {
      setRunStatus('running');
      appendEvent({ type: 'log', message: `Run started: ${data.runId}`, timestamp: new Date().toISOString() });
    });

    socket.on('run_progress', (data: any) => {
      if (data.screenshot) {
        setLatestScreenshot(data.screenshot);
        appendEvent({ type: 'screenshot', screenshot: data.screenshot, message: data.message, timestamp: new Date().toISOString() });
      }
      if (data.message) {
        appendEvent({ type: 'progress', message: data.message, stepId: data.stepId, timestamp: new Date().toISOString() });
      }
    });

    socket.on('test_result', (data: any) => {
      appendEvent({
        type: 'result',
        testId: data.testId,
        status: data.status,
        message: `Test ${data.testId}: ${data.status}`,
        timestamp: new Date().toISOString(),
      });
    });

    socket.on('run_completed', (data: any) => {
      setRunStatus(data.status ?? 'completed');
      appendEvent({ type: 'completed', message: `Run completed: ${data.status}`, timestamp: new Date().toISOString() });
    });

    return () => {
      socket.disconnect();
    };
  }, [runId]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const appendEvent = (event: TestEvent) => {
    setEvents((prev) => [...prev.slice(-200), event]);
  };

  const logTypeColor: Record<string, string> = {
    result:    'var(--brand-600)',
    completed: 'var(--success)',
    progress:  'var(--gray-500)',
    screenshot:'var(--warning)',
    log:       'var(--gray-400)',
  };

  const actions = (
    <div className="flex gap-3" style={{ alignItems: 'center' }}>
      <span className="text-sm text-muted">Run: <span className="code">{String(runId ?? '—').slice(0, 12)}…</span></span>
      <span className={statusBadge(runStatus)}>{runStatus}</span>
      <span className={`badge ${connected ? 'badge-success' : 'badge-danger'}`}>
        {connected ? '🟢 Live' : '🔴 Disconnected'}
      </span>
    </div>
  );

  return (
    <Layout title="Live Execution" actions={actions}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, height: 'calc(100vh - 120px)' }}>
        {/* Screenshot viewport */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div className="card-header"><h3>🖥 Browser Viewport</h3></div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--gray-50)', overflow: 'hidden' }}>
            {latestScreenshot ? (
              <img
                src={`data:image/png;base64,${latestScreenshot}`}
                alt="Latest browser screenshot"
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
              />
            ) : (
              <div style={{ textAlign: 'center', color: 'var(--gray-400)' }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>🖥</div>
                <div style={{ fontSize: 14 }}>
                  {runStatus === 'connecting' ? 'Waiting for test run to start…' : 'No screenshot yet'}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Event log */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div className="card-header">
            <h3>📋 Execution Log</h3>
            <span className="text-sm text-muted">{events.length} events</span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0', fontFamily: 'SFMono-Regular, Consolas, monospace', fontSize: 12 }}>
            {events.length === 0 && (
              <div style={{ padding: 24, color: 'var(--gray-400)', textAlign: 'center' }}>
                Waiting for events…
              </div>
            )}
            {events.map((evt, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  gap: 8,
                  padding: '3px 14px',
                  borderLeft: `3px solid ${logTypeColor[evt.type] ?? 'transparent'}`,
                  background: evt.type === 'result' ? 'var(--brand-50)' : evt.type === 'completed' ? '#f0fff4' : 'transparent',
                }}
              >
                <span style={{ color: 'var(--gray-400)', minWidth: 60 }}>
                  {evt.timestamp.split('T')[1].split('.')[0]}
                </span>
                <span style={{ color: logTypeColor[evt.type], minWidth: 80, textTransform: 'uppercase', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center' }}>
                  {evt.type}
                </span>
                <span style={{ flex: 1, color: 'var(--gray-700)' }}>
                  {evt.message || (evt.type === 'screenshot' ? '📸 screenshot captured' : '')}
                </span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </Layout>
  );
}
