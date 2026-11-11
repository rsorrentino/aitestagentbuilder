/**
 * Analytics — quality trends for the current project.
 *
 * Two single-axis charts (pass rate; passed vs failed tests per day), KPI
 * tiles, and tables for flaky, failing and slow tests. Colors were checked
 * with the palette validator (contrast and colour-vision separation).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import Layout from '../components/Layout';
import { api, errorMessage, formatDate, formatDuration } from '../lib/api';

const COLORS = { passed: '#059669', failed: '#dc2626', rate: '#4f46e5', grid: '#e2e8f0', axis: '#64748b' };
const RANGES = [7, 14, 30, 90];

const axisProps = { stroke: COLORS.grid, tick: { fill: COLORS.axis, fontSize: 12 }, tickLine: false };
const tooltipStyle = { borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, boxShadow: '0 4px 6px -1px rgba(0,0,0,.08)' };

const shortDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export default function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData((await api.get(`/analytics?days=${days}`)).data);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const t = data?.totals;
  const trend = (data?.trend ?? []).map((d: any) => ({ ...d, label: shortDay(d.day) }));

  return (
    <Layout title="Analytics">
      {error && <div className="alert alert-error">⚠️ {error}</div>}

      <div className="flex gap-3 mb-6" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="text-sm text-muted">Period</span>
        <div className="chip-group" role="radiogroup" aria-label="Period">
          {RANGES.map((r) => (
            <div key={r} role="radio" aria-checked={days === r} tabIndex={0}
              className={`chip${days === r ? ' selected' : ''}`}
              onClick={() => setDays(r)} onKeyDown={(e) => e.key === ' ' && setDays(r)}>
              Last {r} days
            </div>
          ))}
        </div>
      </div>

      {!data ? <div className="page-loading"><div className="spinner" /></div> : (
        <>
          <div className="stat-grid" style={{ marginBottom: 24 }}>
            <div className="stat-card accent">
              <div className="stat-label">Pass rate</div>
              <div className="stat-value">{t.passRate !== null ? `${t.passRate}%` : '—'}</div>
              <div className="stat-sub">{t.passed} passed · {t.failed} failed</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Runs</div>
              <div className="stat-value">{t.runs}</div>
              <div className="stat-sub">{t.runsFailed} with failures</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Tests executed</div>
              <div className="stat-value">{t.testsExecuted}</div>
              <div className="stat-sub">{t.skipped} skipped</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Avg run duration</div>
              <div className="stat-value" style={{ fontSize: 24 }}>{formatDuration(t.avgRunDurationMs ?? undefined)}</div>
              <div className="stat-sub">
                {Object.entries(t.byTrigger).map(([k, v]) => `${v} ${k}`).join(' · ') || 'no runs'}
              </div>
            </div>
            <div className="stat-card warning">
              <div className="stat-label">Flaky tests</div>
              <div className="stat-value">{data.flaky.length}</div>
              <div className="stat-sub">mixed pass/fail results</div>
            </div>
          </div>

          {trend.length === 0 ? (
            <div className="card mb-6"><div className="empty-state"><div className="empty-icon">📈</div><h3>No runs in this period</h3><p>Run an agent (or schedule one) to start collecting trends.</p></div></div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 20, marginBottom: 24 }}>
              <div className="card">
                <div className="card-header"><h3>Pass rate per day</h3></div>
                <div className="card-body" style={{ height: 260 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trend} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
                      <CartesianGrid stroke={COLORS.grid} vertical={false} />
                      <XAxis dataKey="label" {...axisProps} />
                      <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} {...axisProps} axisLine={false} width={48} />
                      <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => (v === null ? 'no results' : `${v}%`)} labelFormatter={(l) => String(l)} />
                      <Line type="monotone" dataKey="passRate" name="Pass rate" stroke={COLORS.rate} strokeWidth={2}
                        dot={{ r: 4, fill: COLORS.rate, stroke: '#fff', strokeWidth: 2 }} activeDot={{ r: 6, stroke: '#fff', strokeWidth: 2 }} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="card">
                <div className="card-header"><h3>Tests per day</h3></div>
                <div className="card-body" style={{ height: 260 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={trend} margin={{ top: 8, right: 16, bottom: 0, left: -8 }} barCategoryGap="30%">
                      <CartesianGrid stroke={COLORS.grid} vertical={false} />
                      <XAxis dataKey="label" {...axisProps} />
                      <YAxis allowDecimals={false} {...axisProps} axisLine={false} width={40} />
                      <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(100,116,139,.08)' }} />
                      <Legend iconType="circle" wrapperStyle={{ fontSize: 13, color: '#334155' }} />
                      <Bar dataKey="passed" name="Passed" stackId="t" fill={COLORS.passed} stroke="#fff" strokeWidth={2} />
                      <Bar dataKey="failed" name="Failed" stackId="t" fill={COLORS.failed} stroke="#fff" strokeWidth={2} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}

          {trend.length > 0 && (
            <div className="mb-6">
              <button className="btn btn-ghost btn-sm" onClick={() => setShowTable(!showTable)} aria-expanded={showTable}>
                {showTable ? 'Hide' : 'Show'} chart data as a table
              </button>
              {showTable && (
                <div className="card mt-2">
                  <div className="table-wrapper">
                    <table className="data-table">
                      <thead><tr><th>Day</th><th>Runs</th><th>Passed</th><th>Failed</th><th>Skipped</th><th>Pass rate</th></tr></thead>
                      <tbody>
                        {trend.map((d: any) => (
                          <tr key={d.day}><td>{d.day}</td><td>{d.runs}</td><td>{d.passed}</td><td>{d.failed}</td><td>{d.skipped}</td><td>{d.passRate !== null ? `${d.passRate}%` : '—'}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 20 }}>
            <div className="card">
              <div className="card-header"><h3>🎲 Flaky tests</h3><span className="text-sm text-muted">mixed results or passed on retry</span></div>
              {data.flaky.length === 0 ? <div className="card-body text-muted">No flaky tests detected.</div> : (
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead><tr><th>Test</th><th>Runs</th><th>Pass / fail</th><th>Flips</th><th>Passed on retry</th></tr></thead>
                    <tbody>
                      {data.flaky.map((f: any) => (
                        <tr key={f.testCaseId}><td className="fw-600">{f.title}</td><td>{f.runs}</td><td>{f.passes} / {f.failures}</td><td>{f.flips}</td><td>{f.passedOnRetry}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-header"><h3>❌ Most failing</h3></div>
              {data.topFailing.length === 0 ? <div className="card-body text-muted">No failures in this period. 🎉</div> : (
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead><tr><th>Test</th><th>Failures</th><th>Last error</th></tr></thead>
                    <tbody>
                      {data.topFailing.map((f: any) => (
                        <tr key={f.testCaseId}>
                          <td><div className="fw-600">{f.title}</div><div className="text-sm text-muted">{formatDate(f.lastFailedAt)}</div></td>
                          <td>{f.failures} / {f.runs}</td>
                          <td className="text-sm" style={{ maxWidth: 280 }}>{f.lastError}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-header"><h3>🐢 Slowest tests</h3></div>
              {data.slowest.length === 0 ? <div className="card-body text-muted">No passing runs yet.</div> : (
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead><tr><th>Test</th><th>Average</th><th>Max</th><th>Runs</th></tr></thead>
                    <tbody>
                      {data.slowest.map((s: any) => (
                        <tr key={s.testCaseId}><td className="fw-600">{s.title}</td><td>{formatDuration(s.avgMs)}</td><td>{formatDuration(s.maxMs)}</td><td>{s.runs}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <p className="text-sm text-muted mt-4">
            Metrics use the final attempt of each test in each run. See individual results on the <Link href="/runs">Runs</Link> page.
          </p>
        </>
      )}
    </Layout>
  );
}
