/**
 * Run this agent from a CI pipeline: GitHub Actions, GitLab CI, Azure Pipelines or Jenkins.
 */

import { useEffect, useState } from 'react';
import { API_URL, api, errorMessage } from '../lib/api';

const KINDS = [
  { value: 'github', label: 'GitHub Actions' },
  { value: 'gitlab', label: 'GitLab CI' },
  { value: 'azure', label: 'Azure Pipelines' },
  { value: 'jenkins', label: 'Jenkins' },
];

export default function CiCard({ agentId }: { agentId: string }) {
  const [kind, setKind] = useState('github');
  const [template, setTemplate] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setError(null);
    setCopied(false);
    api.get(`/agents/${agentId}/ci-template`, { params: { kind, apiUrl: API_URL } }).then((r) => setTemplate(r.data)).catch((e) => setError(errorMessage(e)));
  }, [agentId, kind]);

  return (
    <div className="card mb-6" aria-label="Run from CI" role="region">
      <div className="card-header"><h3>🔁 Run from CI</h3><span className="text-sm text-muted">pipeline gate with JUnit report</span></div>
      <div className="card-body">
        <div className="chip-group mb-3" role="radiogroup" aria-label="CI system">
          {KINDS.map((k) => (
            <div key={k.value} role="radio" aria-checked={kind === k.value} tabIndex={0} className={`chip${kind === k.value ? ' selected' : ''}`} onClick={() => setKind(k.value)}>{k.label}</div>
          ))}
        </div>
        {error && <div className="alert alert-error">⚠️ {error}</div>}
        {template && (
          <>
            <p className="text-sm">
              Save as / add to <code>{template.path}</code>, and store an API key (Account → API keys, editor role) as <code>{template.secret}</code> in {template.secretWhere}.
              The job fails when tests fail; with a GitHub, GitLab or Azure DevOps integration for the repository the commit also gets a status.
            </p>
            <div className="flex gap-2 mb-2">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard?.writeText(template.text).then(() => setCopied(true))}>{copied ? '✓ copied' : 'Copy'}</button>
            </div>
            <pre className="code" style={{ maxHeight: 280, overflow: 'auto', fontSize: 12 }} data-testid="ci-template">{template.text}</pre>
          </>
        )}
      </div>
    </div>
  );
}
