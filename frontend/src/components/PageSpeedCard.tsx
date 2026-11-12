/**
 * Page speed of an agent: the agent-wide check (budgets, throttling,
 * regression limit) and the trend of each measured page across runs.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';

interface Props {
  agentId: string;
  config: any;
  canEdit: boolean;
  onSaved: (agent: any) => void;
}

const SHOWN = ['lcp', 'fcp', 'cls', 'tbt', 'ttfb', 'load'] as const;
const LABELS: Record<string, string> = { lcp: 'LCP', fcp: 'FCP', cls: 'CLS', tbt: 'TBT', ttfb: 'TTFB', load: 'Load' };

export const fmt = (k: string, v?: number) => {
  if (v === undefined || v === null) return '—';
  if (k === 'cls') return v.toFixed(3);
  if (k === 'transfer_kb') return v >= 1024 ? `${(v / 1024).toFixed(1)} MB` : `${Math.round(v)} KB`;
  if (k === 'requests') return String(v);
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
};

/** Tiny inline chart of one metric over runs. */
function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;
  const w = 120;
  const h = 28;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} role="img" aria-label={label} style={{ verticalAlign: 'middle' }}>
      <polyline points={pts} fill="none" stroke="var(--brand-600, #4f46e5)" strokeWidth="1.5" />
    </svg>
  );
}

export default function PageSpeedCard({ agentId, config, canEdit, onSaved }: Props) {
  const checks = config.checks ?? {};
  const [mode, setMode] = useState<string>(checks.performance ?? 'off');
  const [budgets, setBudgets] = useState<Record<string, string>>(
    Object.fromEntries(['lcp', 'cls', 'tbt', 'load'].map((k) => [k, checks.performance_budgets?.[k] !== undefined ? String(checks.performance_budgets[k]) : ''])));
  const [regression, setRegression] = useState<string>(checks.performance_budgets?.max_regression !== undefined ? String(Math.round(checks.performance_budgets.max_regression * 100)) : '');
  const [throttle, setThrottle] = useState<string>(checks.performance_options?.throttle ?? 'none');
  const [cpu, setCpu] = useState<string>(checks.performance_options?.cpu_slowdown ? String(checks.performance_options.cpu_slowdown) : '');
  const [pages, setPages] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setPages((await api.get(`/agents/${agentId}/performance`)).data.pages);
    } catch {
      setPages([]);
    }
  }, [agentId]);
  useEffect(() => { load(); }, [load]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const b: Record<string, number> = {};
      for (const [k, v] of Object.entries(budgets)) if (v.trim()) b[k] = Number(v);
      if (regression.trim()) b.max_regression = Number(regression) / 100;
      const res = await api.put(`/agents/${agentId}`, {
        config: {
          checks: {
            ...checks,
            performance: mode,
            performance_budgets: Object.keys(b).length ? b : undefined,
            performance_options: { ...(throttle !== 'none' ? { throttle } : {}), ...(cpu.trim() ? { cpu_slowdown: Number(cpu) } : {}) },
          },
        },
      });
      onSaved(res.data);
      setMessage({ ok: true, text: 'Page speed settings saved' });
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card mb-6">
      <div className="card-header">
        <h3>⚡ Page speed</h3>
        <span className="text-sm text-muted">LCP · FCP · CLS · TBT · TTFB · load · bytes</span>
      </div>
      <div className="card-body">
        {message && <div className={`alert ${message.ok ? 'alert-success' : 'alert-error'}`} role={message.ok ? 'status' : 'alert'}>{message.text}</div>}

        <form onSubmit={save} aria-label="Page speed settings">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, alignItems: 'end' }}>
            <div>
              <label className="form-label" htmlFor="ps-mode">Measure every test&apos;s last page</label>
              <select id="ps-mode" className="form-control" value={mode} onChange={(e) => setMode(e.target.value)} disabled={!canEdit}>
                <option value="off">Off (assert_performance steps only)</option>
                <option value="report">Report</option>
                <option value="fail">Fail the test over budget</option>
              </select>
            </div>
            {[['lcp', 'LCP budget (ms)', '2500'], ['cls', 'CLS budget', '0.1'], ['tbt', 'TBT budget (ms)', '200'], ['load', 'Load budget (ms)', '—']].map(([k, label, ph]) => (
              <div key={k}>
                <label className="form-label" htmlFor={`ps-${k}`}>{label}</label>
                <input id={`ps-${k}`} className="form-control" inputMode="decimal" value={budgets[k]} placeholder={ph} disabled={!canEdit}
                  onChange={(e) => setBudgets((b) => ({ ...b, [k]: e.target.value }))} />
              </div>
            ))}
            <div>
              <label className="form-label" htmlFor="ps-reg">Max slowdown vs. earlier runs (%)</label>
              <input id="ps-reg" className="form-control" inputMode="numeric" value={regression} placeholder="off" disabled={!canEdit} onChange={(e) => setRegression(e.target.value)} />
            </div>
            <div>
              <label className="form-label" htmlFor="ps-throttle">Network</label>
              <select id="ps-throttle" className="form-control" value={throttle} onChange={(e) => setThrottle(e.target.value)} disabled={!canEdit}>
                <option value="none">No throttling</option>
                <option value="slow4g">Slow 4G (150 ms, 1.6 Mbps)</option>
                <option value="fast3g">Fast 3G (560 ms, 1.4 Mbps)</option>
              </select>
            </div>
            <div>
              <label className="form-label" htmlFor="ps-cpu">CPU slowdown (×)</label>
              <input id="ps-cpu" className="form-control" inputMode="numeric" value={cpu} placeholder="1" disabled={!canEdit} onChange={(e) => setCpu(e.target.value)} />
            </div>
            {canEdit && <button className="btn btn-secondary btn-sm" type="submit" disabled={busy} style={{ justifySelf: 'start' }}>{busy ? 'Saving…' : 'Save'}</button>}
          </div>
          <p className="form-hint mt-2">
            Empty budgets use the “good” Core Web Vitals thresholds. Lab values from the test machine: leave headroom. Throttling slows the
            whole test, so step timeouts may need to grow.
          </p>
        </form>

        {pages.length > 0 ? (
          <div className="table-wrapper mt-3">
            <table className="data-table" style={{ fontSize: 13 }} aria-label="Page speed trend">
              <thead><tr><th>Page</th><th>Measurements</th>{SHOWN.map((k) => <th key={k}>{LABELS[k]}</th>)}<th>LCP trend</th></tr></thead>
              <tbody>
                {pages.map((p) => (
                  <tr key={p.page}>
                    <td className="code" style={{ fontSize: 12, wordBreak: 'break-all' }}>{p.page.replace(/^https?:\/\/[^/]+/, '') || '/'}</td>
                    <td>{p.samples.length}</td>
                    {SHOWN.map((k) => {
                      const latest = p.latest?.[k];
                      const med = p.median?.[k];
                      const worse = latest !== undefined && med !== undefined && p.samples.length >= 3 && latest > med * 1.2 && latest - med > (k === 'cls' ? 0.05 : 100);
                      return (
                        <td key={k} title={`median ${fmt(k, med)}`} style={worse ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>
                          {fmt(k, latest)}{worse ? ' ▲' : ''}
                        </td>
                      );
                    })}
                    <td><Sparkline values={p.samples.map((s: any) => s.metrics?.lcp).filter((v: any) => typeof v === 'number')} label={`LCP over the last ${p.samples.length} measurements`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="form-hint">Latest measurement per page; ▲ = more than 20 % worse than the median of the last 30 days (hover for the median).</p>
          </div>
        ) : (
          <p className="text-sm text-muted mt-3">No measurements yet: add an <code>assert_performance</code> step or turn on the agent-wide check.</p>
        )}
      </div>
    </div>
  );
}
