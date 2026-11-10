/**
 * Settings > AI Providers — configuration and live health of each LLM provider.
 */

import { useCallback, useEffect, useState } from 'react';
import Layout from '../../components/Layout';
import { api, errorMessage } from '../../lib/api';

interface ProviderStatus {
  provider: string;
  model: string;
  configured: boolean;
  healthy: boolean | null;
  lastChecked?: string;
  error?: string;
  mode?: string;
  setup?: string;
}

const META: Record<string, { label: string; icon: string; env: string; docs: string }> = {
  anthropic: { label: 'Anthropic Claude', icon: '🟣', env: 'ANTHROPIC_API_KEY (ANTHROPIC_MODEL)', docs: 'https://console.anthropic.com' },
  copilot: { label: 'GitHub Copilot', icon: '🐙', env: 'COPILOT_MODE=api|sdk|cli + GitHub token', docs: 'https://docs.github.com/en/copilot' },
  openai: { label: 'OpenAI', icon: '🟢', env: 'OPENAI_API_KEY (OPENAI_MODEL, OPENAI_BASE_URL)', docs: 'https://platform.openai.com' },
  azure: { label: 'Azure OpenAI', icon: '🔵', env: 'AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT', docs: 'https://learn.microsoft.com/azure/ai-services/openai/' },
};

export default function AiProvidersSettings() {
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [routing, setRouting] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (check = false) => {
    if (check) setChecking(true);
    setError(null);
    try {
      const res = await api.get(`/llm/providers${check ? '?check=true' : ''}`);
      setStatuses(res.data.providers ?? []);
      setRouting(res.data.routing ?? {});
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
      setChecking(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const badge = (s: ProviderStatus) => {
    if (!s.configured) return <span className="badge badge-neutral">Not configured</span>;
    if (s.healthy === true) return <span className="badge badge-success">✅ Healthy</span>;
    if (s.healthy === false) return <span className="badge badge-danger">⚠️ Error</span>;
    return <span className="badge badge-info">Configured</span>;
  };

  const actions = (
    <button className="btn btn-secondary btn-sm" onClick={() => load(true)} disabled={checking}>
      {checking ? 'Testing connections…' : '⚡ Test connections'}
    </button>
  );

  return (
    <Layout title="AI Providers" actions={actions}>
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      <p className="text-muted" style={{ fontSize: 14, marginBottom: 24 }}>
        Providers are configured with environment variables in the backend <code>.env</code> (restart the backend after changes).
        “Test connections” sends a tiny request to each configured provider.
      </p>

      {loading ? <div className="page-loading"><div className="spinner" /></div> : (
        <>
          {!statuses.some((s) => s.configured) && (
            <div className="alert alert-warning">
              No AI provider is configured. Test runs still work; AI extraction, generation, chat and self-healing need at least one provider.
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))', gap: 16, marginBottom: 32 }}>
            {statuses.map((s) => {
              const meta = META[s.provider] ?? { label: s.provider, icon: '🤖', env: '', docs: '#' };
              return (
                <div key={s.provider} className="card" data-testid={`provider-${s.provider}`}>
                  <div className="card-header">
                    <span style={{ fontSize: 20 }}>{meta.icon}</span>
                    <span style={{ fontWeight: 600, flex: 1 }}>{meta.label}</span>
                    {badge(s)}
                  </div>
                  <div className="card-body" style={{ fontSize: 13 }}>
                    <div className="flex-between mb-4"><span className="text-muted">Model</span><span className="fw-600">{s.model || '—'}</span></div>
                    {s.mode && <div className="flex-between mb-4"><span className="text-muted">Transport</span><span className="fw-600">{s.mode.toUpperCase()}</span></div>}
                    <div className="text-muted">Setup: <span className="code">{s.setup ?? meta.env}</span></div>
                    {s.error && <div className="alert alert-error" style={{ marginTop: 8, fontSize: 12 }}>{s.error}</div>}
                    {s.lastChecked && <div className="text-sm text-muted mt-2">Checked {new Date(s.lastChecked).toLocaleTimeString()}</div>}
                  </div>
                  <div style={{ padding: '10px 18px', borderTop: '1px solid var(--gray-100)' }}>
                    <a href={meta.docs} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>Docs →</a>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="card mb-6">
            <div className="card-header"><h3>Routing (configured providers, in fallback order)</h3></div>
            <div className="table-wrapper">
              <table className="data-table">
                <thead><tr><th>Task</th><th>Order</th></tr></thead>
                <tbody>
                  {Object.entries(routing).map(([task, order]) => (
                    <tr key={task}><td>{task}</td><td>{order.length ? order.join(' → ') : <span className="text-muted">none configured</span>}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-header"><h3>🐙 GitHub Copilot transports</h3></div>
            <div className="card-body" style={{ fontSize: 14 }}>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                <li><strong>COPILOT_MODE=api</strong> (default): Copilot chat API with <code>COPILOT_GITHUB_TOKEN</code>/<code>GH_TOKEN</code>/<code>GITHUB_TOKEN</code>
                  (e.g. <code>gh auth token</code>). Set <code>COPILOT_BASE_URL=https://models.github.ai/inference</code> to use GitHub Models instead.</li>
                <li><strong>COPILOT_MODE=sdk</strong>: the official <code>@github/copilot-sdk</code> (installed with the backend). Uses the token or your <code>copilot</code> / <code>gh</code> login.</li>
                <li><strong>COPILOT_MODE=cli</strong>: the Copilot CLI (<code>npm i -g @github/copilot</code>) in non-interactive mode (<code>copilot -p … -s</code>).</li>
              </ul>
              <p className="text-muted mt-2">Copilot is always used as a text model with no tools — it never runs commands on the server.</p>
            </div>
          </div>
        </>
      )}
    </Layout>
  );
}
