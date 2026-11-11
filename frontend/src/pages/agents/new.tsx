/**
 * Create New Agent.
 */

import { useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Layout from '../../components/Layout';
import { AI_PROVIDERS, api, errorMessage, PRIORITIES } from '../../lib/api';

export default function NewAgentPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [environment, setEnvironment] = useState('staging');
  const [modules, setModules] = useState('');
  const [priorities, setPriorities] = useState<string[]>([]);
  const [tags, setTags] = useState('');
  const [aiProvider, setAiProvider] = useState('');
  const [selfHealing, setSelfHealing] = useState(true);
  const [retries, setRetries] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const togglePriority = (p: string) =>
    setPriorities((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.post('/agents', {
        name: name.trim(),
        config: {
          application_type: 'web',
          base_url: baseUrl.trim(),
          environment,
          test_selection: { module: list(modules), priority: priorities, tags: list(tags) },
          tools: { browser: 'playwright' },
          ai: { provider: aiProvider || undefined, self_healing: selfHealing },
          reporting: { formats: ['html', 'junit', 'json'], includeScreenshots: true, includeLogs: true },
          retries,
        },
      });
      router.push(`/agents/${res.data.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  };

  return (
    <Layout title="New Agent" actions={<Link href="/agents" className="btn btn-secondary btn-sm">← Back to Agents</Link>}>
      <div style={{ maxWidth: 700 }}>
        {error && <div className="alert alert-error">⚠️ {error}</div>}
        <form onSubmit={submit}>
          <div className="card mb-6">
            <div className="card-header"><h3>🤖 Application under test</h3></div>
            <div className="card-body">
              <div className="form-group">
                <label className="form-label" htmlFor="agent-name">Agent Name *</label>
                <input id="agent-name" className="form-control" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Checkout Flow Tester" required />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="agent-url">Base URL *</label>
                <input id="agent-url" className="form-control" type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://staging.yourapp.com" required />
                <p className="form-hint">Test steps with relative paths (e.g. <code>/login</code>) are resolved against this URL.</p>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="agent-env">Environment</label>
                <input id="agent-env" className="form-control" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="card mb-6">
            <div className="card-header"><h3>🎯 Which tests to run</h3></div>
            <div className="card-body">
              <p className="form-hint mb-4">Leave everything empty to run every test case. Filters are combined (AND).</p>
              <div className="form-group">
                <label className="form-label" htmlFor="agent-modules">Modules (comma separated)</label>
                <input id="agent-modules" className="form-control" value={modules} onChange={(e) => setModules(e.target.value)} placeholder="Authentication, Checkout" />
              </div>
              <div className="form-group">
                <label className="form-label">Priorities</label>
                <div className="chip-group mt-2">
                  {PRIORITIES.map((p) => (
                    <div key={p} role="checkbox" aria-checked={priorities.includes(p)} tabIndex={0}
                      className={`chip${priorities.includes(p) ? ' selected' : ''}`}
                      onClick={() => togglePriority(p)} onKeyDown={(e) => e.key === ' ' && togglePriority(p)}>{p}</div>
                  ))}
                </div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="agent-tags">Tags (comma separated)</label>
                <input id="agent-tags" className="form-control" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="smoke" />
              </div>
            </div>
          </div>

          <div className="card mb-6">
            <div className="card-header"><h3>🧠 AI & execution</h3></div>
            <div className="card-body">
              <div className="form-group">
                <label className="form-label" htmlFor="agent-ai">Preferred AI provider</label>
                <select id="agent-ai" className="form-control" value={aiProvider} onChange={(e) => setAiProvider(e.target.value)}>
                  {AI_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
                <p className="form-hint">Used for test generation and self-healing; falls back to any other configured provider.</p>
              </div>
              <label className="form-check mb-4">
                <input type="checkbox" checked={selfHealing} onChange={(e) => setSelfHealing(e.target.checked)} />
                AI self-healing (ask the AI for a new selector when one breaks)
              </label>
              <div className="form-group" style={{ maxWidth: 200 }}>
                <label className="form-label" htmlFor="agent-retries">Retries per failed test</label>
                <input id="agent-retries" type="number" className="form-control" min={0} max={3} value={retries} onChange={(e) => setRetries(+e.target.value)} />
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Creating…' : '✓ Create Agent'}</button>
            <Link href="/agents" className="btn btn-secondary">Cancel</Link>
          </div>
        </form>
      </div>
    </Layout>
  );
}
