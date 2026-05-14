/**
 * Settings > AI Providers Page
 *
 * Displays configuration status and health for each LLM provider.
 */

import { useState, useEffect } from 'react';
import axios from 'axios';
import Layout from '../../components/Layout';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

interface ProviderStatus {
  provider: string;
  model: string;
  configured: boolean;
  healthy: boolean;
  lastChecked?: string;
  error?: string;
}

const PROVIDER_META: Record<string, { label: string; icon: string; docs: string }> = {
  anthropic: {
    label: 'Anthropic Claude',
    icon: '🟣',
    docs: 'https://console.anthropic.com',
  },
  copilot: {
    label: 'GitHub Copilot',
    icon: '🐙',
    docs: 'https://docs.github.com/en/copilot',
  },
  openai: {
    label: 'OpenAI',
    icon: '🟢',
    docs: 'https://platform.openai.com',
  },
  azure: {
    label: 'Azure OpenAI',
    icon: '🔵',
    docs: 'https://azure.microsoft.com/en-us/products/ai-services/openai-service',
  },
};

export default function AiProvidersSettings() {
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStatuses();
  }, []);

  const fetchStatuses = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    setError(null);
    try {
      const res = await axios.get(`${API_URL}/llm/providers`);
      setStatuses(res.data.providers ?? []);
    } catch (err: any) {
      setError(err.response?.data?.error ?? err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const actions = (
    <button className="btn btn-secondary btn-sm" onClick={() => fetchStatuses(true)} disabled={refreshing}>
      {refreshing ? 'Checking…' : '↻ Refresh'}
    </button>
  );

  if (loading) {
    return (
      <Layout title="AI Providers" actions={actions}>
        <div className="page-loading"><div className="spinner" /><span>Loading provider statuses…</span></div>
      </Layout>
    );
  }

  return (
    <Layout title="⚙️ AI Providers" actions={actions}>
      {error && <div className="alert alert-error">⚠️ {error}</div>}

      <p style={{ color: 'var(--gray-500)', fontSize: 14, marginBottom: 24 }}>
        The AI Test Agent Builder supports multiple LLM providers. Configure each provider via
        environment variables and check their health status below.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16, marginBottom: 40 }}>
        {statuses.map((status) => {
          const meta = PROVIDER_META[status.provider] ?? { label: status.provider, icon: '🤖', docs: '#' };
          return (
            <div
              key={status.provider}
              className="card"
              style={{
                borderColor: status.healthy ? '#86efac' : status.configured ? '#fca5a5' : undefined,
              }}
            >
              <div className="card-header">
                <span style={{ fontSize: 20 }}>{meta.icon}</span>
                <span style={{ fontWeight: 600, flex: 1 }}>{meta.label}</span>
                <span className={
                  status.healthy ? 'badge badge-success' :
                  status.configured ? 'badge badge-danger' : 'badge badge-neutral'
                }>
                  {status.healthy ? '✅ Healthy' : status.configured ? '⚠️ Error' : '○ Not configured'}
                </span>
              </div>
              <div className="card-body">
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
                  <span className="text-muted">Model</span>
                  <span style={{ fontWeight: 500 }}>{status.model || '—'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
                  <span className="text-muted">Env var</span>
                  <span className="code">{getEnvVar(status.provider)}</span>
                </div>
                {status.error && (
                  <div className="alert alert-error" style={{ marginTop: 8, fontSize: 12 }}>{status.error}</div>
                )}
                {status.lastChecked && (
                  <div style={{ fontSize: 11, color: 'var(--gray-400)', marginTop: 6, textAlign: 'right' }}>
                    Last checked: {new Date(status.lastChecked).toLocaleTimeString()}
                  </div>
                )}
              </div>
              <div style={{ padding: '10px 18px', borderTop: '1px solid var(--gray-100)' }}>
                <a href={meta.docs} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--brand-600)' }}>
                  View Docs →
                </a>
              </div>
            </div>
          );
        })}
      </div>

      <div className="card">
        <div className="card-header"><h3>Task-based AI Routing</h3></div>
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr><th>Task</th><th>Primary Provider</th><th>Fallback</th></tr>
            </thead>
            <tbody>
              <tr><td>Test Extraction</td><td>Claude</td><td>OpenAI → Copilot</td></tr>
              <tr><td>Code Generation</td><td>GitHub Copilot</td><td>OpenAI → Claude</td></tr>
              <tr><td>Chat / Test Authoring</td><td>Claude</td><td>Copilot → OpenAI</td></tr>
              <tr><td>Self-Healing Selectors</td><td>Claude</td><td>Copilot → OpenAI</td></tr>
              <tr><td>Embeddings</td><td>OpenAI</td><td>OpenAI (only)</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}

function getEnvVar(provider: string): string {
  const map: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    azure: 'AZURE_OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    copilot: 'GITHUB_TOKEN',
  };
  return map[provider] ?? '';
}

