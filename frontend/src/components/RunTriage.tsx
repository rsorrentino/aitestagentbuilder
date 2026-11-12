/**
 * Failure triage of a run: failures grouped by cause, classified as app bug,
 * test bug or environment, marked new or already seen, optionally explained
 * by the AI.
 */

import { useState } from 'react';
import { api, errorMessage, formatDate } from '../lib/api';

const LABEL: Record<string, { text: string; color: string; hint: string }> = {
  app_bug: { text: 'App bug', color: 'var(--danger)', hint: 'The application did not behave as the test expects' },
  test_bug: { text: 'Test bug', color: '#b45309', hint: 'The test is outdated or misconfigured' },
  environment: { text: 'Environment', color: '#6d28d9', hint: 'The application, network or login was not available' },
  unknown: { text: 'Unclassified', color: 'var(--gray-600)', hint: 'No rule matched; ask the AI or check the evidence' },
};

interface Props {
  run: any;
  canEdit: boolean;
  aiAvailable: boolean;
  onOpenResult: (resultId: string) => void;
  onChanged: () => void;
}

export default function RunTriage({ run, canEdit, aiAvailable, onOpenResult, onChanged }: Props) {
  const triage = run.metadata?.triage;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!triage?.groups?.length) return null;

  const explain = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/runs/${run.id}/triage`, { ai: true });
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const total = triage.groups.reduce((n: number, g: any) => n + g.tests.length, 0);
  const fresh = triage.groups.filter((g: any) => !g.seenBefore).reduce((n: number, g: any) => n + g.tests.length, 0);

  return (
    <div className="card mb-6" aria-label="Failure triage" role="region">
      <div className="card-header">
        <h3>🔎 Failure triage</h3>
        <span className="text-sm text-muted">
          {total} failure{total === 1 ? '' : 's'} in {triage.groups.length} group{triage.groups.length === 1 ? '' : 's'} ·{' '}
          {fresh ? `${fresh} new` : 'all seen before'}{triage.ai ? ' · explained by AI' : ''}
        </span>
      </div>
      <div className="card-body" style={{ display: 'grid', gap: 12 }}>
        {error && <div className="alert alert-error" role="alert" style={{ margin: 0 }}>{error}</div>}
        {triage.groups.map((g: any) => {
          const label = LABEL[g.category] ?? LABEL.unknown;
          return (
            <div key={g.signature} data-testid={`triage-${g.category}`} style={{ borderLeft: `4px solid ${label.color}`, paddingLeft: 12 }}>
              <div className="flex gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="badge" style={{ background: label.color, color: '#fff' }} title={label.hint}>{label.text}</span>
                <strong className="text-sm">{g.tests.length} test{g.tests.length === 1 ? '' : 's'}</strong>
                {g.seenBefore
                  ? <span className="text-sm text-muted">seen in {g.seenBefore} earlier run{g.seenBefore === 1 ? '' : 's'} since {formatDate(g.firstSeen)}</span>
                  : <span className="badge badge-info">new</span>}
              </div>
              <div className="text-sm mt-1"><span className="code" style={{ whiteSpace: 'pre-wrap' }}>{g.sample.error}</span></div>
              <div className="text-sm text-muted mt-1">
                {g.cause ? <><strong>Likely cause:</strong> {g.cause}</> : g.reason}
                {g.suggestion && <> · <strong>Next step:</strong> {g.suggestion}</>}
              </div>
              <div className="text-sm mt-1">
                {g.tests.map((t: any, i: number) => (
                  <span key={t.resultId}>
                    {i > 0 && ' · '}
                    <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '0 4px' }} onClick={() => onOpenResult(t.resultId)}>
                      {t.title}{t.persona && !String(t.title).includes(`[as ${t.persona}]`) ? ` [as ${t.persona}]` : ''}
                    </button>
                  </span>
                ))}
              </div>
            </div>
          );
        })}
        {canEdit && aiAvailable && !triage.ai && (
          <div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={explain} disabled={busy}>
              {busy ? 'Asking the AI…' : '🤖 Explain with AI'}
            </button>
            <span className="text-sm text-muted"> One AI call for the whole run: likely cause and next step for each group.</span>
          </div>
        )}
      </div>
    </div>
  );
}
