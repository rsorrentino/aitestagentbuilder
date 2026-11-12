/**
 * Evidence and quality findings of one test result: video, trace,
 * accessibility violations, visual differences (approve as new baseline)
 * and selectors repaired by the AI (save them to the test case).
 */

import { useState } from 'react';
import { api, artifactUrl, errorMessage } from '../lib/api';
import { fmt } from './PageSpeedCard';

interface Props {
  runId: string;
  result: any;
  canEdit: boolean;
  onChanged: () => void;
}

const impactColor: Record<string, string> = { critical: 'var(--danger)', serious: '#c2410c', moderate: 'var(--gray-700)', minor: 'var(--gray-500)' };
const pct = (r: number) => `${(r * 100).toFixed(r < 0.01 ? 3 : 1)}%`;

export default function ResultQuality({ runId, result, canEdit, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const ev = result.evidence ?? {};
  const a11y: any[] = result.metadata?.accessibility ?? [];
  const visual: any[] = result.metadata?.visual ?? [];
  const healing = result.metadata?.healing;
  const aiChecks: any[] = result.metadata?.aiChecks ?? [];
  const testData = result.metadata?.testData;
  const perf: any[] = result.metadata?.performance ?? [];
  const aiActions: any[] = result.metadata?.aiActions ?? [];
  if (!ev.trace && !ev.video && !a11y.length && !visual.length && !healing?.steps?.length && !aiChecks.length && !testData && !perf.length && !aiActions.length) return null;

  const act = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await fn() });
      onChanged();
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const approve = (v: any) => act(`visual-${v.name}`, async () => {
    await api.post(`/runs/${runId}/results/${result.id}/visual/approve`, { name: v.name, persona: v.persona, viewport: v.viewport });
    return `New baseline saved for “${v.name}”`;
  });

  const saveAiSteps = (stepId: number) => act(`ai-${stepId}`, async () => {
    const res = await api.post(`/runs/${runId}/results/${result.id}/ai-actions/apply`, { stepId });
    return `Step ${stepId} replaced by ${res.data.added} ordinary step(s) in the test case`;
  });

  const applyHealing = () => act('healing', async () => {
    const res = await api.post(`/runs/${runId}/results/${result.id}/apply-healing`, {});
    return res.data.applied.length
      ? `Saved ${res.data.applied.length} repaired selector(s) to the test case`
      : 'Nothing to save: the test case no longer has the broken selector';
  });

  return (
    <div className="mt-3" style={{ display: 'grid', gap: 16 }}>
      {message && <div className={`alert ${message.ok ? 'alert-success' : 'alert-error'}`} role={message.ok ? 'status' : 'alert'} style={{ margin: 0 }}>{message.text}</div>}

      {(ev.video || ev.trace) && (
        <section aria-label="Evidence">
          <h4 className="mb-2">🎬 Evidence</h4>
          {ev.video && (
            <video src={artifactUrl(ev.video)} controls preload="metadata" style={{ width: '100%', maxWidth: 640, borderRadius: 6, border: '1px solid var(--gray-200)' }}>
              <a href={artifactUrl(ev.video)}>Download the video</a>
            </video>
          )}
          {ev.trace && (
            <p className="text-sm mt-2">
              <a className="btn btn-secondary btn-sm" href={artifactUrl(ev.trace)} download>⬇ Download Playwright trace</a>{' '}
              <span className="text-muted">
                Open it at <a href="https://trace.playwright.dev" target="_blank" rel="noreferrer">trace.playwright.dev</a> (runs in your browser)
                {' '}or with <code>npx playwright show-trace trace.zip</code>: every action, DOM snapshot, network call and console message.
                {result.metadata?.traceRedactions ? ` ${result.metadata.traceRedactions} secret value(s) were masked.` : ''}
              </span>
            </p>
          )}
        </section>
      )}

      {a11y.length > 0 && (
        <section aria-label="Accessibility">
          <h4 className="mb-2">♿ Accessibility</h4>
          {a11y.map((report, i) => (
            <div key={i} className="mb-2">
              <div className="text-sm text-muted">
                {report.url} · {String(report.level).toUpperCase()} · {report.failing} violation(s) at {report.minImpact}+
                {report.violations.length > report.failing ? ` · ${report.violations.length - report.failing} lower-impact` : ''}
              </div>
              {report.violations.length > 0 && (
                <table className="data-table" style={{ fontSize: 13 }}>
                  <thead><tr><th>Rule</th><th>Impact</th><th>Problem</th><th>Elements</th></tr></thead>
                  <tbody>
                    {report.violations.map((v: any) => (
                      <tr key={v.id} style={{ opacity: v.counted ? 1 : 0.65 }}>
                        <td><a href={v.helpUrl} target="_blank" rel="noreferrer" className="code">{v.id}</a></td>
                        <td style={{ color: impactColor[v.impact], fontWeight: 600 }}>{v.impact}</td>
                        <td>{v.help}</td>
                        <td className="code" style={{ fontSize: 12 }}>{v.targets.join(', ')}{v.nodes > v.targets.length ? ` +${v.nodes - v.targets.length}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </section>
      )}

      {visual.length > 0 && (
        <section aria-label="Visual checks">
          <h4 className="mb-2">🖼️ Visual checks</h4>
          {visual.map((v) => (
            <div key={`${v.name}-${v.persona}-${v.viewport}`} className="mb-4" data-testid={`visual-${v.name}`}>
              <div className="text-sm">
                <strong>{v.name}</strong> <span className="text-muted">· {v.viewport}{v.persona ? ` · ${v.persona}` : ''}</span> ·{' '}
                {v.status === 'created' && 'baseline created'}
                {v.status === 'passed' && <span className="text-success">matches ({pct(v.ratio)} different)</span>}
                {v.status === 'failed' && <span className="text-danger">{v.sizeMismatch ? 'size changed' : `${pct(v.ratio)} of pixels changed (max ${pct(v.maxDiffRatio)})`}</span>}
                {v.approved && <span className="badge badge-info" style={{ marginLeft: 6 }}>approved as new baseline</span>}
              </div>
              {v.status === 'failed' && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginTop: 6 }}>
                    {[['Baseline', v.baseline], ['This run', v.actual], ['Difference', v.diff]].filter(([, p]) => p).map(([label, p]) => (
                      <figure key={label} style={{ margin: 0 }}>
                        <figcaption className="text-sm text-muted">{label}</figcaption>
                        <a href={artifactUrl(p)} target="_blank" rel="noreferrer">
                          <img src={artifactUrl(p)} alt={`${label} of ${v.name}`} style={{ width: '100%', border: '1px solid var(--gray-200)', borderRadius: 6 }} />
                        </a>
                      </figure>
                    ))}
                  </div>
                  {canEdit && !v.approved && (
                    <button type="button" className="btn btn-secondary btn-sm mt-2" disabled={busy !== null} onClick={() => approve(v)}>
                      {busy === `visual-${v.name}` ? 'Saving…' : '✓ Approve as new baseline'}
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
        </section>
      )}

      {aiActions.length > 0 && (
        <section aria-label="AI actions">
          <h4 className="mb-2">🧭 AI actions</h4>
          {aiActions.map((r) => (
            <div key={r.stepId} className="mb-3" data-testid={`ai-action-${r.stepId}`}>
              <div className="text-sm">
                <strong>Step {r.stepId}:</strong> {r.instruction}{' '}
                <span className={r.done ? 'text-success' : 'text-danger'} style={{ fontWeight: 600 }}>{r.done ? 'done' : 'not completed'}</span>
                <span className="text-muted">
                  {' · '}{r.replayed ? 'replayed from earlier runs (no AI call)' : `${r.rounds} AI round(s)${r.provider ? ` · ${r.provider}` : ''}`}
                  {r.cacheSaved ? ' · remembered for next runs' : ''}
                </span>
              </div>
              {r.reason && <div className="text-sm text-muted">AI: {r.reason}</div>}
              <ol className="text-sm" style={{ margin: '4px 0 6px 18px' }}>
                {r.actions.map((a: any, i: number) => (
                  <li key={i} style={a.ok ? undefined : { color: 'var(--danger)' }}>
                    <span className="code">{a.action}</span>{a.target ? <> <span className="code">{a.target}</span></> : null}
                    {a.value !== undefined ? <> = <span className="code">{a.value}</span></> : null}
                    {a.cached ? <span className="text-muted"> (cached)</span> : null}
                    {a.ok ? null : <> — {a.error}</>}
                  </li>
                ))}
              </ol>
              {r.applied ? (
                <span className="badge badge-info">saved as steps</span>
              ) : canEdit && r.done && r.actions.some((a: any) => a.ok) && (
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => saveAiSteps(r.stepId)}>
                  {busy === `ai-${r.stepId}` ? 'Saving…' : 'Save as steps'}
                </button>
              )}
            </div>
          ))}
          <p className="form-hint">“Save as steps” replaces the AI step in the test case with these actions: reviewable, and no AI needed any more.</p>
        </section>
      )}

      {aiChecks.length > 0 && (
        <section aria-label="AI checks">
          <h4 className="mb-2">🤖 AI checks</h4>
          <table className="data-table" style={{ fontSize: 13 }}>
            <thead><tr><th>Expectation</th><th>Verdict</th><th>Why</th></tr></thead>
            <tbody>
              {aiChecks.map((c, i) => (
                <tr key={i}>
                  <td>{c.expectation}</td>
                  <td>
                    <span className={c.passed ? 'text-success' : 'text-danger'} style={{ fontWeight: 600 }}>{c.verdict}</span>
                    <div className="text-muted">{Math.round(c.confidence * 100)}% confident{c.provider ? ` · ${c.provider}` : ''}</div>
                  </td>
                  <td>{c.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="form-hint">Judged from the page&apos;s text and structure, not its pixels. AI verdicts can vary; keep classic assertions for what must never change.</p>
        </section>
      )}

      {perf.length > 0 && (
        <section aria-label="Page speed">
          <h4 className="mb-2">⚡ Page speed</h4>
          {perf.map((p, i) => (
            <div key={i} className="mb-2">
              <div className="text-sm text-muted">
                {p.page}{p.throttle ? ` · throttled (${p.throttle})` : ''}{p.maxRegression ? ` · compared with ${p.baselineRuns} earlier run(s), max +${Math.round(p.maxRegression * 100)}%` : ''} ·{' '}
                <span className={p.passed ? 'text-success' : 'text-danger'} style={{ fontWeight: 600 }}>{p.passed ? 'within budget' : `${p.violations.length} problem(s)`}</span>
              </div>
              <table className="data-table" style={{ fontSize: 13 }}>
                <thead><tr><th>Metric</th><th>Value</th><th>Budget</th><th>Earlier runs</th></tr></thead>
                <tbody>
                  {['lcp', 'fcp', 'cls', 'tbt', 'ttfb', 'dom_content_loaded', 'load', 'transfer_kb', 'requests'].filter((k) => p.metrics[k] !== undefined).map((k) => {
                    const v = p.violations.filter((x: any) => x.metric === k);
                    const reg = v.find((x: any) => x.kind === 'regression');
                    return (
                      <tr key={k} style={v.length ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>
                        <td>{k.toUpperCase().replace(/_/g, ' ')}</td>
                        <td>{fmt(k, p.metrics[k])}</td>
                        <td>{p.budgets?.[k] !== undefined ? fmt(k, p.budgets[k]) : '—'}</td>
                        <td>{reg ? `${fmt(k, reg.baseline)} (+${Math.round((reg.value / reg.baseline - 1) * 100)}%)` : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      )}

      {testData && (
        <section aria-label="Test data">
          <h4 className="mb-2">🎲 Test data</h4>
          {testData.row && (
            <div className="text-sm mb-2">
              <span className="text-muted">Data set row{result.metadata?.dataLabel ? ` “${result.metadata.dataLabel}”` : ''}: </span>
              {Object.entries(testData.row).map(([k, v]) => (
                <span key={k} className="code" style={{ marginRight: 10 }}>{k}={typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
              ))}
            </div>
          )}
          {testData.fake && (
            <div className="text-sm">
              <span className="text-muted">Generated values: </span>
              {Object.entries(testData.fake).map(([k, v]) => (
                <span key={k} className="code" style={{ marginRight: 10 }}>{`{{fake.${k}}}`}={String(v)}</span>
              ))}
            </div>
          )}
        </section>
      )}

      {healing?.steps?.length > 0 && (
        <section aria-label="Repaired selectors">
          <h4 className="mb-2">🩹 Selectors repaired by the AI</h4>
          <ul className="text-sm" style={{ margin: '0 0 8px 18px' }}>
            {healing.steps.map((h: any) => (
              <li key={h.stepId}>Step {h.stepId}: <span className="code">{h.from}</span> → <span className="code">{h.to}</span></li>
            ))}
          </ul>
          {healing.applied ? (
            <span className="badge badge-info">saved to the test case</span>
          ) : canEdit && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={applyHealing}>
              {busy === 'healing' ? 'Saving…' : 'Save to the test case'}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
