/**
 * Salesforce CRM Quick-Start Wizard
 *
 * Guides users through setting up a Salesforce CRM test agent in minutes.
 * Step 1: Org details  →  Step 2: Modules  →  Step 3: AI config  →  Step 4: Create agent
 */

import { useState } from 'react';
import axios from 'axios';
import { useRouter } from 'next/router';
import Link from 'next/link';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

const SF_MODULES = ['Authentication', 'Leads', 'Contacts', 'Opportunities', 'Cases', 'Reports', 'Accounts', 'Dashboards'];
const AI_PROVIDERS = ['claude', 'copilot', 'openai'];

type Step = 1 | 2 | 3 | 4;

interface WizardState {
  // Step 1
  agentName: string;
  orgUrl: string;
  sfUsername: string;
  sfPassword: string;
  sfToken: string;
  sandbox: boolean;
  // Step 2
  selectedModules: string[];
  priority: string[];
  // Step 3
  aiProvider: string;
  aiModel: string;
  selfHealing: boolean;
  // Step 4
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

  const toggleModule = (mod: string) => {
    setState((s) => ({
      ...s,
      selectedModules: s.selectedModules.includes(mod)
        ? s.selectedModules.filter((m) => m !== mod)
        : [...s.selectedModules, mod],
    }));
  };

  const buildAgentConfig = () => ({
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
      reporting: {
        formats: ['json', 'html', 'junit'],
        includeScreenshots: true,
        includeLogs: true,
      },
      environment: state.sandbox ? 'sandbox' : 'production',
      max_parallel_tests: state.maxParallelTests,
      timeout: state.timeout,
      retries: state.retries,
    },
  });

  const createAgent = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = buildAgentConfig();
      const res = await axios.post(`${API_URL}/agents`, payload);
      setCreatedAgent(res.data);
      setStep(4);
    } catch (err: any) {
      setError(err.response?.data?.error ?? err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container">
      <div className="wizard-header">
        <Link href="/">← Dashboard</Link>
        <h1>🧪 Salesforce CRM Quick-Start Wizard</h1>
        <div className="step-indicator">
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className={`step-dot ${step === s ? 'active' : step > s ? 'done' : ''}`}>
              {step > s ? '✓' : s}
            </div>
          ))}
        </div>
      </div>

      {step === 1 && (
        <div className="step-panel">
          <h2>Step 1 — Salesforce Org Details</h2>
          <p>Enter your Salesforce org URL and credentials. These are stored only in your deployment environment.</p>

          <label>Agent Name</label>
          <input value={state.agentName} onChange={(e) => update('agentName', e.target.value)} placeholder="SalesforceCRMTester" />

          <label>Org URL</label>
          <input value={state.orgUrl} onChange={(e) => update('orgUrl', e.target.value)} placeholder="https://your-org.my.salesforce.com" />

          <label>Username</label>
          <input value={state.sfUsername} onChange={(e) => update('sfUsername', e.target.value)} placeholder="user@example.com" />

          <label>Password</label>
          <input type="password" value={state.sfPassword} onChange={(e) => update('sfPassword', e.target.value)} placeholder="••••••••" />

          <label>Security Token (optional)</label>
          <input value={state.sfToken} onChange={(e) => update('sfToken', e.target.value)} placeholder="Token from Salesforce Settings" />

          <label className="checkbox-label">
            <input type="checkbox" checked={state.sandbox} onChange={(e) => update('sandbox', e.target.checked)} />
            This is a Sandbox org
          </label>

          <div className="nav-buttons">
            <button className="btn-primary" onClick={() => setStep(2)} disabled={!state.orgUrl}>
              Next →
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="step-panel">
          <h2>Step 2 — Select CRM Modules</h2>
          <p>Choose which Salesforce modules to include in automated testing.</p>

          <div className="module-grid">
            {SF_MODULES.map((mod) => (
              <div
                key={mod}
                className={`module-chip ${state.selectedModules.includes(mod) ? 'selected' : ''}`}
                onClick={() => toggleModule(mod)}
              >
                {mod}
              </div>
            ))}
          </div>

          <div className="nav-buttons">
            <button className="btn-secondary" onClick={() => setStep(1)}>← Back</button>
            <button className="btn-primary" onClick={() => setStep(3)} disabled={state.selectedModules.length === 0}>
              Next →
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="step-panel">
          <h2>Step 3 — AI Configuration</h2>
          <p>Configure which AI provider powers test generation, extraction, and self-healing.</p>

          <label>AI Provider</label>
          <select value={state.aiProvider} onChange={(e) => update('aiProvider', e.target.value)}>
            {AI_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>

          <label>Model</label>
          <input value={state.aiModel} onChange={(e) => update('aiModel', e.target.value)} placeholder="claude-3-5-sonnet-latest" />

          <label className="checkbox-label">
            <input type="checkbox" checked={state.selfHealing} onChange={(e) => update('selfHealing', e.target.checked)} />
            Enable AI Self-Healing (auto-fix broken selectors)
          </label>

          <div className="nav-buttons">
            <button className="btn-secondary" onClick={() => setStep(2)}>← Back</button>
            <button className="btn-primary" onClick={createAgent} disabled={loading}>
              {loading ? 'Creating…' : 'Create Agent →'}
            </button>
          </div>
          {error && <div className="error-banner">{error}</div>}
        </div>
      )}

      {step === 4 && createdAgent && (
        <div className="step-panel success-panel">
          <div className="success-icon">🎉</div>
          <h2>Agent Created Successfully!</h2>
          <p>
            Your Salesforce CRM test agent <strong>{createdAgent.name}</strong> is ready.
          </p>
          <div className="agent-details">
            <div><span>Agent ID:</span> <code>{createdAgent.id}</code></div>
            <div><span>Modules:</span> {state.selectedModules.join(', ')}</div>
            <div><span>AI Provider:</span> {state.aiProvider} ({state.aiModel})</div>
            <div><span>Self-Healing:</span> {state.selfHealing ? '✅ Enabled' : '✗ Disabled'}</div>
          </div>
          <div className="success-actions">
            <Link href="/">
              <button className="btn-primary">← Go to Dashboard</button>
            </Link>
            <Link href={`/live?runId=new-${createdAgent.id}`}>
              <button className="btn-secondary">▶ Start a Test Run</button>
            </Link>
          </div>
        </div>
      )}

      <style jsx>{`
        .container {
          max-width: 700px;
          margin: 0 auto;
          padding: 24px;
          font-family: sans-serif;
        }
        .wizard-header {
          display: flex;
          flex-direction: column;
          gap: 12px;
          margin-bottom: 28px;
        }
        h1 { margin: 0; font-size: 22px; }
        h2 { margin: 0 0 8px 0; font-size: 18px; }
        p { color: #555; font-size: 14px; margin-bottom: 16px; }
        .step-indicator {
          display: flex;
          gap: 10px;
        }
        .step-dot {
          width: 28px; height: 28px;
          border-radius: 50%;
          background: #e0e0e0;
          display: flex; align-items: center; justify-content: center;
          font-size: 13px; font-weight: 600; color: #666;
        }
        .step-dot.active { background: #4a90d9; color: white; }
        .step-dot.done { background: #28a745; color: white; }
        .step-panel {
          background: white;
          border: 1px solid #e0e0e0;
          border-radius: 12px;
          padding: 24px;
        }
        label {
          display: block;
          font-size: 13px;
          font-weight: 600;
          margin-bottom: 4px;
          margin-top: 14px;
          color: #333;
        }
        input[type="text"], input[type="password"], input:not([type="checkbox"]), select {
          width: 100%;
          padding: 10px;
          border: 1px solid #ccc;
          border-radius: 6px;
          font-size: 14px;
          box-sizing: border-box;
        }
        .checkbox-label {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 14px;
          cursor: pointer;
        }
        .module-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-bottom: 20px;
        }
        .module-chip {
          padding: 8px 16px;
          border: 2px solid #e0e0e0;
          border-radius: 20px;
          cursor: pointer;
          font-size: 14px;
          user-select: none;
          transition: all 0.15s;
        }
        .module-chip.selected {
          border-color: #4a90d9;
          background: #e8f4ff;
          color: #1a5fa8;
          font-weight: 600;
        }
        .nav-buttons {
          display: flex;
          gap: 12px;
          margin-top: 24px;
          justify-content: flex-end;
        }
        .btn-primary, .btn-secondary {
          padding: 10px 20px;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          border: none;
        }
        .btn-primary { background: #4a90d9; color: white; }
        .btn-primary:disabled { background: #ccc; cursor: not-allowed; }
        .btn-secondary { background: #f0f0f0; color: #333; }
        .error-banner {
          background: #fff0f0;
          border: 1px solid #ffcccc;
          color: #c00;
          padding: 10px;
          border-radius: 6px;
          margin-top: 14px;
          font-size: 13px;
        }
        .success-panel { text-align: center; }
        .success-icon { font-size: 48px; margin-bottom: 12px; }
        .agent-details {
          background: #f8f9fa;
          border-radius: 8px;
          padding: 16px;
          text-align: left;
          margin: 16px 0;
          font-size: 14px;
        }
        .agent-details div { margin-bottom: 8px; }
        .agent-details span { font-weight: 600; margin-right: 8px; }
        .success-actions {
          display: flex;
          gap: 12px;
          justify-content: center;
          flex-wrap: wrap;
          margin-top: 20px;
        }
      `}</style>
    </div>
  );
}
