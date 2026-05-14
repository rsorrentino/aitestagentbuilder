/**
 * Create New Agent — generic form for any application type.
 */

import { useState } from 'react';
import axios from 'axios';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Layout from '../../components/Layout';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

const APP_TYPES = ['web', 'api', 'mobile', 'hybrid'];
const AI_PROVIDERS = ['claude', 'openai', 'copilot', 'azure'];
const PRIORITY_OPTS = ['Low', 'Medium', 'High', 'Critical'];

interface FormState {
  name: string;
  applicationType: string;
  baseUrl: string;
  environment: string;
  aiProvider: string;
  aiModel: string;
  selfHealing: boolean;
  maxParallelTests: number;
  timeout: number;
  retries: number;
  priorityTags: string[];
}

const DEFAULTS: FormState = {
  name: '',
  applicationType: 'web',
  baseUrl: '',
  environment: 'staging',
  aiProvider: 'claude',
  aiModel: 'claude-3-5-sonnet-latest',
  selfHealing: true,
  maxParallelTests: 3,
  timeout: 60000,
  retries: 2,
  priorityTags: ['High', 'Critical'],
};

export default function NewAgentPage() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(DEFAULTS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof FormState, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const togglePriority = (p: string) =>
    set('priorityTags', form.priorityTags.includes(p)
      ? form.priorityTags.filter((x) => x !== p)
      : [...form.priorityTags, p]);

  const modelPlaceholder = () => {
    const m: Record<string, string> = {
      claude: 'claude-3-5-sonnet-latest',
      openai: 'gpt-4o',
      copilot: 'gpt-4o',
      azure:   'gpt-4',
    };
    return m[form.aiProvider] ?? 'model name';
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('Agent name is required'); return; }
    if (!form.baseUrl.trim()) { setError('Base URL is required'); return; }

    setLoading(true);
    setError(null);

    const payload = {
      name: form.name.trim(),
      config: {
        agent_name: form.name.trim(),
        application_type: form.applicationType,
        base_url: form.baseUrl.trim(),
        environment: form.environment,
        test_selection: { priority: form.priorityTags, tags: [] },
        tools: { browser: 'playwright', http: 'axios' },
        ai: {
          provider: form.aiProvider,
          model: form.aiModel || modelPlaceholder(),
          self_healing: form.selfHealing,
          fallback: form.aiProvider === 'claude' ? 'openai' : 'claude',
        },
        reporting: { formats: ['json', 'html', 'junit'], includeScreenshots: true, includeLogs: true },
        max_parallel_tests: form.maxParallelTests,
        timeout: form.timeout,
        retries: form.retries,
      },
    };

    try {
      const res = await axios.post(`${API_URL}/agents`, payload);
      router.push(`/agents/${res.data.id}`);
    } catch (err: any) {
      setError(err.response?.data?.error ?? err.message);
    } finally {
      setLoading(false);
    }
  };

  const actions = (
    <Link href="/agents" className="btn btn-secondary btn-sm">← Back to Agents</Link>
  );

  return (
    <Layout title="New Agent" actions={actions}>
      <div style={{ maxWidth: 700 }}>
        {error && <div className="alert alert-error">⚠️ {error}</div>}

        <form onSubmit={submit}>
          {/* Basic info */}
          <div className="card mb-6">
            <div className="card-header"><h3>🤖 Agent Identity</h3></div>
            <div className="card-body">
              <div className="form-group">
                <label className="form-label">Agent Name *</label>
                <input
                  className="form-control"
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="e.g. Checkout Flow Tester"
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Application Type *</label>
                <select className="form-control" value={form.applicationType} onChange={(e) => set('applicationType', e.target.value)}>
                  {APP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Base URL *</label>
                <input
                  className="form-control"
                  value={form.baseUrl}
                  onChange={(e) => set('baseUrl', e.target.value)}
                  placeholder="https://staging.yourapp.com"
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Environment</label>
                <input
                  className="form-control"
                  value={form.environment}
                  onChange={(e) => set('environment', e.target.value)}
                  placeholder="staging"
                />
              </div>
            </div>
          </div>

          {/* AI Config */}
          <div className="card mb-6">
            <div className="card-header"><h3>🧠 AI Configuration</h3></div>
            <div className="card-body">
              <div className="form-group">
                <label className="form-label">AI Provider</label>
                <select className="form-control" value={form.aiProvider} onChange={(e) => set('aiProvider', e.target.value)}>
                  {AI_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Model</label>
                <input
                  className="form-control"
                  value={form.aiModel}
                  onChange={(e) => set('aiModel', e.target.value)}
                  placeholder={modelPlaceholder()}
                />
              </div>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={form.selfHealing}
                  onChange={(e) => set('selfHealing', e.target.checked)}
                />
                Enable AI Self-Healing (auto-fix broken selectors)
              </label>
            </div>
          </div>

          {/* Execution settings */}
          <div className="card mb-6">
            <div className="card-header"><h3>⚙️ Execution Settings</h3></div>
            <div className="card-body">
              <div className="form-group">
                <label className="form-label">Priority Filter</label>
                <div className="chip-group mt-2">
                  {PRIORITY_OPTS.map((p) => (
                    <div
                      key={p}
                      className={`chip${form.priorityTags.includes(p) ? ' selected' : ''}`}
                      onClick={() => togglePriority(p)}
                    >{p}</div>
                  ))}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">Max Parallel Tests</label>
                  <input
                    type="number" className="form-control" min={1} max={20}
                    value={form.maxParallelTests}
                    onChange={(e) => set('maxParallelTests', +e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Timeout (ms)</label>
                  <input
                    type="number" className="form-control" min={5000} step={5000}
                    value={form.timeout}
                    onChange={(e) => set('timeout', +e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Retries</label>
                  <input
                    type="number" className="form-control" min={0} max={5}
                    value={form.retries}
                    onChange={(e) => set('retries', +e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Creating…</> : '✓ Create Agent'}
            </button>
            <Link href="/agents" className="btn btn-secondary">Cancel</Link>
          </div>
        </form>
      </div>
    </Layout>
  );
}
