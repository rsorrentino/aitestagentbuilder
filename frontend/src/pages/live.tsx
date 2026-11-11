/**
 * Live Execution — watch a run's browser viewport and execution log in real time.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Layout from '../components/Layout';
import { api, errorMessage, reportUrl, shortId, statusBadge } from '../lib/api';
import { RunEventName, useRunEvents } from '../lib/useRunEvents';

interface LogLine {
  time: string;
  kind: 'log' | 'warn' | 'error' | 'result' | 'done';
  message: string;
}

export default function LiveTestView() {
  const router = useRouter();
  const runId = typeof router.query.runId === 'string' ? router.query.runId : undefined;

  const [run, setRun] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  const loadRun = useCallback(async () => {
    if (!runId) return;
    try {
      const res = await api.get(`/runs/${runId}`);
      setRun(res.data);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [runId]);

  useEffect(() => { loadRun(); }, [loadRun]);

  const push = (kind: LogLine['kind'], message: string) =>
    setLines((prev) => [...prev.slice(-400), { time: new Date().toLocaleTimeString(), kind, message }]);

  const connected = useRunEvents(runId, (event: RunEventName, data: any) => {
    switch (event) {
      case 'run_log':
        push(data.level === 'error' ? 'error' : data.level === 'warn' ? 'warn' : 'log', data.message);
        break;
      case 'run_screenshot':
        setScreenshot(data.image);
        break;
      case 'test_started':
        setCurrent(`${data.index}/${data.total} · ${data.title}`);
        break;
      case 'test_result':
      case 'run_progress':
        loadRun();
        break;
      case 'run_completed':
        push('done', `Run ${data.status}: ${data.passed ?? 0} passed, ${data.failed ?? 0} failed${data.error ? ` — ${data.error}` : ''}`);
        setCurrent(null);
        loadRun();
        break;
      default:
        break;
    }
  });

  // Polling fallback (e.g. websockets blocked by a proxy)
  useEffect(() => {
    if (!run || (run.status !== 'running' && run.status !== 'pending')) return;
    const t = setInterval(loadRun, 5000);
    return () => clearInterval(t);
  }, [run, loadRun]);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [lines]);

  const color: Record<LogLine['kind'], string> = {
    log: 'var(--gray-700)', warn: 'var(--warning)', error: 'var(--danger)', result: 'var(--brand-600)', done: 'var(--success)',
  };

  if (!runId) {
    return (
      <Layout title="Live Execution">
        <div className="alert alert-info">Pick a run from the <Link href="/runs">Runs</Link> page to watch it live.</div>
      </Layout>
    );
  }

  const active = run && (run.status === 'running' || run.status === 'pending');
  const actions = (
    <div className="flex gap-3" style={{ alignItems: 'center' }}>
      <span className="text-sm text-muted">Run <span className="code">{shortId(runId)}</span></span>
      {run && <span className={statusBadge(run.status)}>{run.status}</span>}
      <span className={`badge ${connected ? 'badge-success' : 'badge-neutral'}`}>{connected ? '● Live' : '○ Offline'}</span>
      <Link href={`/runs/${runId}`} className="btn btn-secondary btn-sm">Details</Link>
      {run && !active && <a href={reportUrl(runId, 'html')} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">📊 Report</a>}
    </div>
  );

  return (
    <Layout title="Live Execution" actions={actions}>
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {run && (
        <div className="flex gap-4 mb-4 text-sm" style={{ flexWrap: 'wrap' }}>
          <span>Agent: <strong>{run.agentName}</strong></span>
          <span className="text-success fw-600">✓ {run.passedTests} passed</span>
          <span className="text-danger fw-600">✗ {run.failedTests} failed</span>
          <span className="text-muted">{run.passedTests + run.failedTests + run.skippedTests}/{run.totalTests} done</span>
          {current && <span>Running: <strong>{current}</strong></span>}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 20, minHeight: 'calc(100vh - 170px)' }}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div className="card-header"><h3>🖥 Browser Viewport</h3></div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--gray-50)', minHeight: 300 }}>
            {screenshot ? (
              <img src={`data:image/jpeg;base64,${screenshot}`} alt="Live browser" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            ) : (
              <div style={{ textAlign: 'center', color: 'var(--gray-400)', padding: 24 }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>🖥</div>
                <div style={{ fontSize: 14 }}>
                  {active ? 'Waiting for the first screenshot…' : 'This run is not executing. Screenshots are kept in the run details.'}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div className="card-header"><h3>📋 Execution Log</h3><span className="text-sm text-muted">{lines.length} lines</span></div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0', fontFamily: 'SFMono-Regular, Consolas, monospace', fontSize: 12, maxHeight: 'calc(100vh - 230px)' }}>
            {lines.length === 0 && (
              <div style={{ padding: 24, color: 'var(--gray-400)', textAlign: 'center' }}>
                {active ? 'Waiting for events…' : 'Live log is only available while a run executes. See the run details for step logs.'}
              </div>
            )}
            {lines.map((l, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, padding: '2px 14px', color: color[l.kind], whiteSpace: 'pre-wrap' }}>
                <span style={{ color: 'var(--gray-400)', minWidth: 72 }}>{l.time}</span>
                <span style={{ flex: 1 }}>{l.message}</span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </Layout>
  );
}
