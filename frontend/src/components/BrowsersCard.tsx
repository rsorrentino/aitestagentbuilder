/**
 * Browsers & devices of an agent: every test runs once per browser / emulated device,
 * on this server or on a cloud grid (BrowserStack, LambdaTest, Sauce Labs, a Playwright server).
 */

import { useState } from 'react';
import { api, errorMessage, REDACTED } from '../lib/api';

const ENGINES = [
  { value: 'chromium', label: 'Chromium (Chrome, Edge)' },
  { value: 'firefox', label: 'Firefox' },
  { value: 'webkit', label: 'WebKit (Safari)' },
];
const DEVICES = ['iPhone 15', 'iPhone 15 Pro Max', 'iPad Pro 11', 'Pixel 7', 'Galaxy S9+', 'Galaxy Tab S4'];
const PROVIDERS = [
  { value: '', label: 'This server' },
  { value: 'browserstack', label: 'BrowserStack' },
  { value: 'lambdatest', label: 'LambdaTest' },
  { value: 'saucelabs', label: 'Sauce Labs (Chrome only)' },
  { value: 'playwright', label: 'Playwright server (self-hosted grid)' },
];
const OS_HINT: Record<string, string> = {
  browserstack: 'Windows or OS X (version below)',
  lambdatest: 'e.g. Windows 11, MacOS Sonoma',
  saucelabs: 'e.g. Windows 11, macOS 13',
};

interface Props { agentId: string; config: any; canEdit: boolean; onSaved: (agent: any) => void }

export default function BrowsersCard({ agentId, config, canEdit, onSaved }: Props) {
  const current: string[] = Array.isArray(config.browsers) && config.browsers.length ? config.browsers : ['chromium'];
  const g = config.grid ?? {};
  const [selected, setSelected] = useState<string[]>(current.filter((b) => ENGINES.some((e) => e.value === b) || DEVICES.includes(b)));
  const [otherDevices, setOtherDevices] = useState(current.filter((b) => !ENGINES.some((e) => e.value === b) && !DEVICES.includes(b)).join(', '));
  const [provider, setProvider] = useState<string>(g.provider ?? '');
  const [grid, setGrid] = useState({ username: g.username ?? '', access_key: '', os: g.os ?? '', os_version: g.os_version ?? '', ws_endpoint: g.ws_endpoint ?? '', region: g.region ?? '' });
  const [parallel, setParallel] = useState(String(config.parallel ?? 1));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const toggle = (v: string) => setSelected((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]));
  const hasKey = g.access_key === REDACTED && provider === g.provider;

  const browsers = [...selected, ...otherDevices.split(',').map((d) => d.trim()).filter(Boolean)];
  const runsPerTest = browsers.length || 1;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    // An empty access key is left out: the stored one is kept (same provider)
    const gridConfig = provider ? Object.fromEntries(Object.entries({ provider, ...grid }).filter(([, v]) => v !== '')) : null;
    try {
      const res = await api.put(`/agents/${agentId}`, { config: { browsers, grid: gridConfig, parallel: Number(parallel) || 1 } });
      onSaved(res.data);
      setGrid((x) => ({ ...x, access_key: '' }));
      setMessage({ ok: true, text: `Saved: every test runs ${runsPerTest} time${runsPerTest === 1 ? '' : 's'}${provider ? ` on ${PROVIDERS.find((p) => p.value === provider)?.label}` : ''}${Number(parallel) > 1 ? `, ${parallel} at a time` : ''}` });
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card mb-6" onSubmit={save} aria-label="Browsers and devices">
      <div className="card-header">
        <h3>🌐 Browsers, devices &amp; parallel runs</h3>
        <span className="text-sm text-muted">each test runs {runsPerTest}× per run{Number(parallel) > 1 ? `, ${parallel} at a time` : ''}</span>
      </div>
      <div className="card-body">
        <div className="form-group">
          <div className="form-label">Browsers</div>
          <div className="chip-group">
            {ENGINES.map((o) => (
              <div key={o.value} role="checkbox" aria-checked={selected.includes(o.value)} tabIndex={0} className={`chip${selected.includes(o.value) ? ' selected' : ''}`}
                onClick={() => canEdit && toggle(o.value)} onKeyDown={(e) => e.key === ' ' && canEdit && toggle(o.value)}>{o.label}</div>
            ))}
          </div>
        </div>
        <div className="form-group">
          <div className="form-label">Phones and tablets (emulated: screen size, touch, user agent)</div>
          <div className="chip-group">
            {DEVICES.map((d) => (
              <div key={d} role="checkbox" aria-checked={selected.includes(d)} tabIndex={0} className={`chip${selected.includes(d) ? ' selected' : ''}`}
                onClick={() => canEdit && toggle(d)} onKeyDown={(e) => e.key === ' ' && canEdit && toggle(d)}>{d}</div>
            ))}
          </div>
          <input className="form-control mt-2" style={{ maxWidth: 420 }} value={otherDevices} onChange={(e) => setOtherDevices(e.target.value)} disabled={!canEdit}
            placeholder="Other Playwright devices, e.g. Galaxy S24, iPhone 13 Mini" aria-label="Other devices" />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor={`parallel-${agentId}`}>Tests at the same time</label>
          <input id={`parallel-${agentId}`} type="number" min={1} max={16} className="form-control" style={{ width: 100 }} value={parallel}
            onChange={(e) => setParallel(e.target.value)} disabled={!canEdit} />
          <p className="form-hint">
            Per browser, each test in its own browser context. Tests must not depend on each other or change the same records
            (use test data such as <code>{'{{fake.email}}'}</code>). Parallel tests signing in as the same user sign in once and share the session.
            On a cloud grid, your plan&apos;s parallel sessions are the limit.
          </p>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor={`grid-${agentId}`}>Run on</label>
          <select id={`grid-${agentId}`} className="form-control" style={{ maxWidth: 320 }} value={provider} onChange={(e) => setProvider(e.target.value)} disabled={!canEdit}>
            {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          {!provider && <p className="form-hint">Firefox and WebKit must be installed on this server: <code>cd backend &amp;&amp; npx playwright install firefox webkit</code>. A cloud grid adds real Windows / macOS machines and browser versions.</p>}
        </div>
        {provider && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            {provider !== 'playwright' && (
              <>
                <div className="form-group">
                  <label className="form-label" htmlFor={`grid-user-${agentId}`}>Username</label>
                  <input id={`grid-user-${agentId}`} className="form-control" value={grid.username} onChange={(e) => setGrid({ ...grid, username: e.target.value })} disabled={!canEdit} autoComplete="off" />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor={`grid-key-${agentId}`}>Access key</label>
                  <input id={`grid-key-${agentId}`} type="password" className="form-control" value={grid.access_key} onChange={(e) => setGrid({ ...grid, access_key: e.target.value })}
                    disabled={!canEdit} autoComplete="new-password" placeholder={hasKey ? 'stored (leave empty to keep)' : ''} />
                  <p className="form-hint">Stored encrypted. Empty: the server&apos;s {provider === 'browserstack' ? 'BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY' : provider === 'lambdatest' ? 'LT_USERNAME / LT_ACCESS_KEY' : 'SAUCE_USERNAME / SAUCE_ACCESS_KEY'} variables.</p>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor={`grid-os-${agentId}`}>Operating system</label>
                  <input id={`grid-os-${agentId}`} className="form-control" value={grid.os} onChange={(e) => setGrid({ ...grid, os: e.target.value })} disabled={!canEdit} placeholder={OS_HINT[provider]} />
                </div>
                {provider === 'browserstack' && (
                  <div className="form-group">
                    <label className="form-label" htmlFor={`grid-osv-${agentId}`}>OS version</label>
                    <input id={`grid-osv-${agentId}`} className="form-control" value={grid.os_version} onChange={(e) => setGrid({ ...grid, os_version: e.target.value })} disabled={!canEdit} placeholder="11 · Sonoma" />
                  </div>
                )}
                {provider === 'saucelabs' && (
                  <div className="form-group">
                    <label className="form-label" htmlFor={`grid-region-${agentId}`}>Data center</label>
                    <input id={`grid-region-${agentId}`} className="form-control" value={grid.region} onChange={(e) => setGrid({ ...grid, region: e.target.value })} disabled={!canEdit} placeholder="us-west-1" />
                  </div>
                )}
              </>
            )}
            <div className="form-group" style={{ gridColumn: provider === 'playwright' ? 'span 2' : undefined }}>
              <label className="form-label" htmlFor={`grid-ws-${agentId}`}>{provider === 'playwright' ? 'Server address *' : 'Endpoint (override)'}</label>
              <input id={`grid-ws-${agentId}`} className="form-control" value={grid.ws_endpoint} onChange={(e) => setGrid({ ...grid, ws_endpoint: e.target.value })} disabled={!canEdit}
                required={provider === 'playwright'} placeholder={provider === 'playwright' ? 'ws://grid.internal:3000/' : 'only if the provider gave you another address'} />
              {provider === 'playwright' && <p className="form-hint">Start one with <code>npx playwright run-server --port 3000</code> (or Moon, Browserless …).</p>}
            </div>
          </div>
        )}
        {(provider === 'browserstack' || provider === 'lambdatest') && (
          <p className="form-hint">Testing an internal application from the cloud needs the provider&apos;s tunnel (BrowserStack Local, LambdaTest Tunnel): add its capability in the agent JSON under <code>grid.capabilities</code>.</p>
        )}
        {message && <div className={`alert ${message.ok ? 'alert-success' : 'alert-error'}`}>{message.text}</div>}
        {canEdit && <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !browsers.length}>{busy ? 'Saving…' : 'Save'}</button>}
      </div>
    </form>
  );
}
