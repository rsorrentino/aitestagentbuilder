/**
 * Salesforce CRM Quick-Start Wizard
 *
 * Guides users through setting up a Salesforce CRM test agent in minutes.
 * Step 1: Org details  →  Step 2: Modules  →  Step 3: AI config  →  Step 4: Done
 */

import { useState } from 'react';
import axios from 'axios';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Layout from '../../components/Layout';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

const SF_MODULES = ['Authentication', 'Leads', 'Contacts', 'Opportunities', 'Cases', 'Reports', 'Accounts', 'Dashboards'];
const AI_PROVIDERS = ['claude', 'copilot', 'openai'];

type Step = 1 | 2 | 3 | 4;

interface WizardState {
  agentName: string;
  orgUrl: string;
  sfUsername: string;
  sfPassword: string;
  sfToken: string;
  sandbox: boolean;
  selectedModules: string[];
  priority: string[];
  aiProvider: string;
  aiModel: string;
  selfHealing: boolean;
  maxParallelTests: number;
  retries: number;
  timeout: number;
}

const defaultState: WizardState = {
  agentName: 'SalesforceCRMTester',
  orgUrl: '',
  sfUsername: '',
  sfPassword: '',
  sfToken: '',
  sandbox: false,
  selectedModules: ['Authentication', 'Leads', 'Contacts'],
  priority: ['High', 'Critical'],
  aiProvider: 'claude',
  aiModel: 'claude-3-5-sonnet-latest',
  selfHealing: true,
  maxParallelTests: 3,
  retries: 2,
  timeout: 60000,
};

export default function SalesforceWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [state, setState] = useState<WizardState>(defaultState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdAgent, setCreatedAgent] = useState<any>(null);

  const update = (key: keyof WizardState, value: any) => setState((s) => ({ ...s, [key]: value }));

  const toggleModule = (mod: string) =>
    setState((s) => ({
      ...s,
      selectedModules: s.selectedModules.includes(mod)
        ? s.selectedModules.filter((m) => m !== mod)
        : [...s.selectedModules, mod],
    }));

  const createAgent = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = {
        name: state.agentName,
        config: {
          agent_name: state.agentName,
          application_type: 'web',
          platform: 'salesforce',
          base_url: state.orgUrl,
          salesforce: {
            username: state.sfUsername,
            password: state.sfPassword,
            security_token: state.sfToken,
            sandbox: state.sandbox,
          },
          test_selection: {
            module: state.selectedModules,
            priority: state.priority,
            tags: ['salesforce', 'crm'],
          },
          tools: { browser: 'playwright', http: 'axios' },
          ai: {
            provider: state.aiProvider,
            model: state.aiModel,
            fallback: state.aiProvider === 'claude' ? 'copilot' : 'claude',
            self_healing: state.selfHealing,
          },
          reporting: { formats: ['json', 'html', 'junit'], includeScreenshots: true, includeLogs: true },
          environment: state.sandbox ? 'sandbox' : 'production',
          max_parallel_tests: state.maxParallelTests,
          timeout: state.timeout,
          retries: state.retries,
        },
      };
      const res = await axios.post(`${API_URL}/agents`, payload);
      setCreatedAgent(res.data);
      setStep(4);
    } catch (err: any) {
      setError(err.response?.data?.error ?? err.message);
    } finally {
      setLoading(false);
    }
  };

  const stepIndicator = (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {[1, 2, 3, 4].map((s) => (
        <div
          key={s}
          style={{
            width: 28, height: 28, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 700,
            background: step === s ? 'var(--brand-600)' : step > s ? 'var(--success)' : 'var(--gray-200)',
            color: step >= s ? 'white' : 'var(--gray-500)',
          }}
        >{step > s ? '✓' : s}</div>
      ))}
    </div>
  );

  const actions = (
    <>
      {stepIndicator}
      <Link href="/agents" className="btn btn-secondary btn-sm">← Agents</Link>
    </>
  );

  return (
    <Layout title="⚡ Salesforce CRM Wizard" actions={actions}>
      <div style={{ maxWidth: 640 }}>
        {error && <div className="alert alert-error">⚠️ {error}</div>}

        {step === 1 && (
          <div className="card">
            <div className="card-header"><h3>Step 1 — Salesforce Org Details</h3></div>
            <div className="card-body">
              <p className="text-muted text-sm mb-6">Enter your Salesforce org URL and credentials. These are stored only in your deployment environment.</p>
              <div className="form-group">
                <label className="form-label">Agent Name</label>
                <input className="form-control" value={state.agentName} onChange={(e) => update('agentName', e.target.value)} placeholder="SalesforceCRMTester" />
              </div>
              <div className="form-group">
                <label className="form-label">Org URL *</label>
                <input className="form-control" value={state.orgUrl} onChange={(e) => update('orgUrl', e.target.value)} placeholder="https://your-org.my.salesforce.com" />
              </div>
              <div className="form-group">
                <label className="form-label">Username</label>
                <input className="form-control" value={state.sfUsername} onChange={(e) => update('sfUsername', e.target.value)} placeholder="user@example.com" />
              </div>
              <div className="form-group">
                <label className="form-label">Password</label>
                <input className="form-control" type="password" value={state.sfPassword} onChange={(e) => update('sfPassword', e.target.value)} placeholder="••••••••" />
              </div>
              <div className="form-group">
                <label className="form-label">Security Token <span className="text-muted">(optional)</span></label>
                <input className="form-control" value={state.sfToken} onChange={(e) => update('sfToken', e.target.value)} placeholder="Token from Salesforce Settings" />
              </div>
              <label className="form-check mb-6">
                <input type="checkbox" checked={state.sandbox} onChange={(e) => update('sandbox', e.target.checked)} />
                This is a Sandbox org
              </label>
              <div className="flex" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-primary" onClick={() => setStep(2)} disabled={!state.orgUrl}>Next →</button>
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="card">
            <div className="card-header"><h3>Step 2 — Select CRM Modules</h3></div>
            <div className="card-body">
              <p className="text-muted text-sm mb-6">Choose which Salesforce modules to include in automated testing.</p>
              <div className="chip-group mb-6">
                {SF_MODULES.map((mod) => (
                  <div key={mod} className={`chip${state.selectedModules.includes(mod) ? ' selected' : ''}`} onClick={() => toggleModule(mod)}>
                    {mod}
                  </div>
                ))}
              </div>
              <div className="flex gap-3" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-secondary" onClick={() => setStep(1)}>← Back</button>
                <button className="btn btn-primary" onClick={() => setStep(3)} disabled={state.selectedModules.length === 0}>Next →</button>
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="card">
            <div className="card-header"><h3>Step 3 — AI Configuration</h3></div>
            <div className="card-body">
              <p className="text-muted text-sm mb-6">Configure which AI provider powers test generation, extraction, and self-healing.</p>
              <div className="form-group">
                <label className="form-label">AI Provider</label>
                <select className="form-control" value={state.aiProvider} onChange={(e) => update('aiProvider', e.target.value)}>
                  {AI_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Model</label>
                <input className="form-control" value={state.aiModel} onChange={(e) => update('aiModel', e.target.value)} placeholder="claude-3-5-sonnet-latest" />
              </div>
              <label className="form-check mb-6">
                <input type="checkbox" checked={state.selfHealing} onChange={(e) => update('selfHealing', e.target.checked)} />
                Enable AI Self-Healing (auto-fix broken selectors)
              </label>
              <div className="flex gap-3" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-secondary" onClick={() => setStep(2)}>← Back</button>
                <button className="btn btn-primary" onClick={createAgent} disabled={loading}>
                  {loading ? '…' : 'Create Agent →'}
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 4 && createdAgent && (
          <div className="card" style={{ textAlign: 'center' }}>
            <div className="card-body" style={{ padding: 40 }}>
              <div style={{ fontSize: 56, marginBottom: 16 }}>🎉</div>
              <h2 style={{ marginBottom: 8 }}>Agent Created Successfully!</h2>
              <p className="text-muted">
                Your Salesforce CRM test agent <strong>{createdAgent.name}</strong> is ready to go.
              </p>
              <div style={{ background: 'var(--gray-50)', borderRadius: 8, padding: 16, margin: '20px 0', textAlign: 'left', fontSize: 14 }}>
                {[
                  ['Agent ID', <span className="code">{createdAgent.id}</span>],
                  ['Modules', state.selectedModules.join(', ')],
                  ['AI Provider', `${state.aiProvider} (${state.aiModel})`],
                  ['Self-Healing', state.selfHealing ? '✅ Enabled' : '✗ Disabled'],
                ].map(([label, value]) => (
                  <div key={String(label)} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--gray-200)' }}>
                    <span style={{ fontWeight: 600 }}>{label}</span>
                    <span>{value as any}</span>
                  </div>
                ))}
              </div>
              <div className="flex gap-3" style={{ justifyContent: 'center' }}>
                <Link href="/agents" className="btn btn-primary">← Go to Agents</Link>
                <Link href={`/agents/${createdAgent.id}`} className="btn btn-secondary">View Agent →</Link>
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
