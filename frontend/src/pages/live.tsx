/**
 * LiveTestView Page
 *
 * Streams real-time Playwright screenshots over WebSocket as tests run,
 * giving a "watch the bot test" experience.
 */

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import io, { Socket } from 'socket.io-client';
import Link from 'next/link';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3000';
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

interface TestEvent {
  type: 'screenshot' | 'log' | 'result' | 'progress' | 'completed';
  testId?: string;
  stepId?: number;
  message?: string;
  screenshot?: string; // base64 PNG
  status?: string;
  timestamp: string;
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
      // Subscribe to this run's events
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
    setEvents((prev) => [...prev.slice(-200), event]); // keep last 200 events
  };

  return (
    <div className="container">
      <div className="header">
        <Link href="/">← Dashboard</Link>
        <h1>Live Test Execution</h1>
        <div className="run-info">
          <span>Run: {runId}</span>
          <span className={`status-badge ${runStatus}`}>{runStatus}</span>
          <span className={`ws-badge ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? '🟢 Live' : '🔴 Disconnected'}
          </span>
        </div>
      </div>

      <div className="view-grid">
        {/* Screenshot viewport */}
        <div className="screenshot-panel">
          <h3>Browser Viewport</h3>
          {latestScreenshot ? (
            <img
              src={`data:image/png;base64,${latestScreenshot}`}
              alt="Latest browser screenshot"
              className="screenshot-img"
            />
          ) : (
            <div className="screenshot-placeholder">
              {runStatus === 'connecting' ? 'Waiting for test run to start…' : 'No screenshot yet'}
            </div>
          )}
        </div>

        {/* Event log */}
        <div className="log-panel">
          <h3>Execution Log</h3>
          <div className="log-list">
            {events.map((evt, i) => (
              <div key={i} className={`log-entry ${evt.type}`}>
                <span className="log-time">{evt.timestamp.split('T')[1].split('.')[0]}</span>
                <span className={`log-type ${evt.type}`}>{evt.type}</span>
                <span className="log-message">
                  {evt.message || (evt.type === 'screenshot' ? '📸 screenshot captured' : '')}
                </span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>

      <style jsx>{`
        .container {
          max-width: 1400px;
          margin: 0 auto;
          padding: 20px;
          font-family: sans-serif;
        }
        .header {
          display: flex;
          align-items: center;
          gap: 20px;
          margin-bottom: 20px;
          flex-wrap: wrap;
        }
        h1 { margin: 0; font-size: 24px; }
        .run-info {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-left: auto;
        }
        .status-badge {
          padding: 4px 10px;
          border-radius: 12px;
          font-size: 13px;
          font-weight: 600;
          background: #eee;
        }
        .status-badge.running { background: #fff3cd; color: #856404; }
        .status-badge.completed { background: #d4edda; color: #155724; }
        .status-badge.failed { background: #f8d7da; color: #721c24; }
        .ws-badge { font-size: 13px; }
        .view-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
        }
        @media (max-width: 900px) {
          .view-grid { grid-template-columns: 1fr; }
        }
        .screenshot-panel, .log-panel {
          border: 1px solid #ddd;
          border-radius: 8px;
          overflow: hidden;
        }
        .screenshot-panel h3, .log-panel h3 {
          background: #f5f5f5;
          margin: 0;
          padding: 10px 16px;
          font-size: 14px;
          border-bottom: 1px solid #ddd;
        }
        .screenshot-img {
          width: 100%;
          display: block;
          object-fit: contain;
          max-height: 540px;
        }
        .screenshot-placeholder {
          height: 300px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #999;
          font-size: 14px;
        }
        .log-list {
          height: 500px;
          overflow-y: auto;
          padding: 8px 0;
        }
        .log-entry {
          display: flex;
          gap: 8px;
          padding: 4px 12px;
          font-size: 12px;
          font-family: monospace;
          border-left: 3px solid transparent;
        }
        .log-entry.result { border-left-color: #4a90d9; background: #f0f7ff; }
        .log-entry.completed { border-left-color: #28a745; background: #f0fff4; }
        .log-entry.screenshot { border-left-color: #fd7e14; }
        .log-time { color: #888; min-width: 60px; }
        .log-type {
          font-weight: 600;
          min-width: 80px;
          text-transform: uppercase;
          font-size: 10px;
        }
        .log-type.result { color: #4a90d9; }
        .log-type.completed { color: #28a745; }
        .log-type.progress { color: #6c757d; }
        .log-type.screenshot { color: #fd7e14; }
        .log-message { flex: 1; }
      `}</style>
    </div>
  );
}
