/**
 * Settings > AI Providers Page
 *
 * Displays configuration status and health for each LLM provider.
 */

import { useState, useEffect } from 'react';
import axios from 'axios';
import Link from 'next/link';

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

  if (loading) return <div className="container">Loading provider statuses…</div>;

  return (
    <div className="container">
      <div className="header">
        <Link href="/">← Dashboard</Link>
        <h1>⚙️ AI Provider Settings</h1>
        <button className="refresh-btn" onClick={() => fetchStatuses(true)} disabled={refreshing}>
          {refreshing ? 'Checking…' : '↻ Refresh'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <p className="intro">
        The AI Test Agent Builder supports multiple LLM providers. Configure each provider via
        environment variables and check their health status below.
      </p>

      <div className="providers-grid">
        {statuses.map((status) => {
          const meta = PROVIDER_META[status.provider] ?? { label: status.provider, icon: '🤖', docs: '#' };
          return (
            <div key={status.provider} className={`provider-card ${status.healthy ? 'healthy' : status.configured ? 'unhealthy' : 'unconfigured'}`}>
              <div className="card-header">
                <span className="provider-icon">{meta.icon}</span>
                <span className="provider-label">{meta.label}</span>
                <span className={`health-badge ${status.healthy ? 'ok' : status.configured ? 'error' : 'off'}`}>
                  {status.healthy ? '✅ Healthy' : status.configured ? '⚠️ Error' : '○ Not configured'}
                </span>
              </div>

              <div className="card-body">
                <div className="detail-row">
                  <span className="detail-label">Model</span>
                  <span className="detail-value">{status.model || '—'}</span>
                </div>

                <div className="detail-row">
                  <span className="detail-label">Env var</span>
                  <span className="detail-value env-var">{getEnvVar(status.provider)}</span>
                </div>

                {status.error && (
                  <div className="error-detail">{status.error}</div>
                )}

                {status.lastChecked && (
                  <div className="last-checked">
                    Last checked: {new Date(status.lastChecked).toLocaleTimeString()}
                  </div>
                )}
              </div>

              <div className="card-footer">
                <a href={meta.docs} target="_blank" rel="noreferrer" className="docs-link">
                  View Docs →
                </a>
              </div>
            </div>
          );
        })}
      </div>

      <div className="routing-info">
        <h2>Task-based Routing</h2>
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Primary Provider</th>
              <th>Fallback</th>
            </tr>
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

      <style jsx>{`
        .container {
          max-width: 1100px;
          margin: 0 auto;
          padding: 24px;
          font-family: sans-serif;
        }
        .header {
          display: flex;
          align-items: center;
          gap: 16px;
          margin-bottom: 8px;
        }
        h1 { margin: 0; font-size: 24px; }
        .refresh-btn {
          margin-left: auto;
          padding: 8px 16px;
          border: 1px solid #ccc;
          border-radius: 6px;
          cursor: pointer;
          background: white;
        }
        .intro {
          color: #555;
          margin-bottom: 24px;
          font-size: 14px;
        }
        .error-banner {
          background: #fff0f0;
          border: 1px solid #ffcccc;
          color: #c00;
          padding: 10px 14px;
          border-radius: 6px;
          margin-bottom: 16px;
        }
        .providers-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: 16px;
          margin-bottom: 40px;
        }
        .provider-card {
          border: 1px solid #e0e0e0;
          border-radius: 10px;
          overflow: hidden;
        }
        .provider-card.healthy { border-color: #b8dbb8; }
        .provider-card.unhealthy { border-color: #f5c2c7; }
        .card-header {
          padding: 14px;
          background: #f8f9fa;
          display: flex;
          align-items: center;
          gap: 8px;
          border-bottom: 1px solid #e0e0e0;
        }
        .provider-icon { font-size: 20px; }
        .provider-label { font-weight: 600; font-size: 15px; flex: 1; }
        .health-badge {
          font-size: 12px;
          padding: 2px 8px;
          border-radius: 10px;
        }
        .health-badge.ok { background: #d4edda; color: #155724; }
        .health-badge.error { background: #f8d7da; color: #721c24; }
        .health-badge.off { background: #e9ecef; color: #6c757d; }
        .card-body { padding: 14px; }
        .detail-row {
          display: flex;
          justify-content: space-between;
          margin-bottom: 8px;
          font-size: 13px;
        }
        .detail-label { color: #888; }
        .detail-value { font-weight: 500; text-align: right; }
        .env-var { font-family: monospace; font-size: 12px; background: #f0f0f0; padding: 1px 5px; border-radius: 3px; }
        .error-detail {
          background: #fff3f3;
          color: #c00;
          font-size: 12px;
          padding: 6px 8px;
          border-radius: 4px;
          margin-top: 8px;
          word-break: break-word;
        }
        .last-checked { font-size: 11px; color: #aaa; margin-top: 8px; text-align: right; }
        .card-footer { padding: 10px 14px; border-top: 1px solid #f0f0f0; }
        .docs-link { font-size: 13px; color: #4a90d9; text-decoration: none; }
        .routing-info h2 { margin-bottom: 12px; font-size: 18px; }
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #e0e0e0; }
        th { background: #f5f5f5; font-weight: 600; }
      `}</style>
    </div>
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
