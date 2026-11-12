/**
 * Test recorder: drive the agent's application in a browser that runs on the
 * server, and record what you do as test steps. Or import a script recorded
 * locally with `npx playwright codegen`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Layout from '../components/Layout';
import { api, errorMessage, PRIORITIES } from '../lib/api';
import { useSession } from '../lib/session';

type Mode = 'interact' | 'assert_text' | 'assert_visible' | 'hover';

const describe = (s: any) => `${s.action}${s.target ? ` ${s.target}` : ''}${s.data?.value !== undefined ? ` = “${s.data.value}”` : ''}`;

export default function RecorderPage() {
  const session = useSession();
  const router = useRouter();
  const canEdit = session.can('editor');
  const [agents, setAgents] = useState<any[]>([]);
  const [agentId, setAgentId] = useState('');
  const [startPath, setStartPath] = useState('/');
  const [persona, setPersona] = useState('');
  const [rec, setRec] = useState<any>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('interact');
  const [picked, setPicked] = useState<any>(null);
  const [value, setValue] = useState('');
  const [secret, setSecret] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [module, setModule] = useState('Recorded');
  const [priority, setPriority] = useState('Medium');
  const [tab, setTab] = useState<'record' | 'import'>('record');
  const [script, setScript] = useState('');
  const [imported, setImported] = useState<any>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const shotUrl = useRef<string | null>(null);

  useEffect(() => {
    api.get('/agents').then((r) => {
      setAgents(r.data);
      const wanted = typeof router.query.agentId === 'string' && r.data.some((a: any) => a.id === router.query.agentId) ? router.query.agentId : '';
      setAgentId((cur) => wanted || cur || r.data[0]?.id || '');
    }).catch((err) => setError(errorMessage(err)));
    // Reconnect to a session that is still open
    api.get('/recordings').then((r) => { if (r.data[0]) setRec(r.data[0]); }).catch(() => undefined);
  }, [router.query.agentId]);

  const agent = agents.find((a) => a.id === agentId);
  const personas: string[] = (agent?.config?.salesforce?.personas ?? []).map((p: any) => p.name);
  const secrets: string[] = Object.keys(agent?.config?.secrets ?? (rec ? agents.find((a) => a.id === rec.agentId)?.config?.secrets ?? {} : {}));

  const refresh = useCallback(async (id?: string) => {
    const sid = id ?? rec?.id;
    if (!sid) return;
    try {
      const r = await api.get(`/recordings/${sid}/screenshot`, { responseType: 'blob' });
      const next = URL.createObjectURL(r.data);
      if (shotUrl.current) URL.revokeObjectURL(shotUrl.current);
      shotUrl.current = next;
      setShot(next);
      const st = await api.get(`/recordings/${sid}`);
      setRec(st.data);
      setUrl(st.data.url);
    } catch (err) {
      setError(errorMessage(err));
      if ((err as any)?.response?.status === 404) setRec(null);
    }
  }, [rec?.id]);

  useEffect(() => {
    if (!rec?.id) return;
    refresh(rec.id);
    // The page can change by itself (redirects, timers): refresh the picture now and then
    const t = setInterval(() => { if (document.visibilityState === 'visible') refresh(rec.id); }, 4000);
    return () => clearInterval(t);
  }, [rec?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const start = () => run('start', async () => {
    const r = await api.post('/recordings', { agentId, startPath, ...(persona ? { persona } : {}) });
    setRec(r.data);
    setPicked(null);
    setTitle('');
  });

  const record = (body: any) => run('step', async () => {
    const r = await api.post(`/recordings/${rec.id}/steps`, body);
    setRec(r.data.state);
    setPicked(null);
    setValue('');
    setSecret('');
    await refresh();
  });

  const onPick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!rec || busy) return;
    const img = imgRef.current!;
    const rect = img.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * rec.viewport.width;
    const y = ((e.clientY - rect.top) / rect.height) * rec.viewport.height;
    run('inspect', async () => {
      const info = (await api.post(`/recordings/${rec.id}/inspect`, { x, y })).data;
      if (mode === 'assert_visible') return void (await recordNow({ action: 'assert_visible', target: info.selector }));
      if (mode === 'hover') return void (await recordNow({ action: 'hover', target: info.selector }));
      if (mode === 'assert_text') {
        setPicked({ ...info, as: 'assert_text' });
        setValue(info.text || info.value || '');
        return;
      }
      if (info.suggested === 'click' || info.suggested === 'check' || info.suggested === 'uncheck') {
        return void (await recordNow({ action: info.suggested, target: info.selector }));
      }
      setPicked({ ...info, as: info.suggested });
      setValue(info.suggested === 'select' ? info.options?.[0] ?? '' : '');
      if (info.isPassword && secrets.length) setSecret(secrets[0]);
    });
  };

  // Inside run(): record without another busy wrapper
  const recordNow = async (body: any) => {
    const r = await api.post(`/recordings/${rec.id}/steps`, body);
    setRec(r.data.state);
    await refresh();
  };

  const scroll = (dy: number) => run('scroll', async () => {
    await api.post(`/recordings/${rec.id}/scroll`, { dy });
    await refresh();
  });

  const removeStep = (i: number) => run('remove', async () => {
    const r = await api.delete(`/recordings/${rec.id}/steps/${i}`);
    setRec(r.data.state);
  });

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    run('save', async () => {
      const r = await api.post(`/recordings/${rec.id}/save`, { title, module, priority });
      setNotice(`Saved “${r.data.title}” with ${r.data.steps.length} step(s)`);
    });
  };

  const stop = () => run('stop', async () => {
    await api.delete(`/recordings/${rec.id}`).catch(() => undefined);
    setRec(null);
    setShot(null);
    setPicked(null);
  });

  const importScript = (saveIt: boolean) => run('import', async () => {
    const r = await api.post('/recordings/import', { script, agentId: agentId || undefined, ...(saveIt ? { save: true, title, module, priority } : {}) });
    setImported(r.data);
    if (saveIt) setNotice(`Saved “${r.data.testCase.title}” with ${r.data.steps.length} step(s)`);
  });

  if (!canEdit) {
    return <Layout title="Recorder"><div className="alert alert-info">Recording tests needs the editor role in this project.</div></Layout>;
  }

  return (
    <Layout title="Recorder">
      {error && <div className="alert alert-error" role="alert">⚠️ {error}</div>}
      {notice && <div className="alert alert-success" role="status">{notice} · <Link href="/testcases">Test cases →</Link></div>}

      <div className="flex gap-2 mb-4" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'record'} className={`btn btn-sm ${tab === 'record' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('record')}>⏺ Record in the browser</button>
        <button type="button" role="tab" aria-selected={tab === 'import'} className={`btn btn-sm ${tab === 'import' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('import')}>⇪ Import Playwright codegen</button>
      </div>

      {tab === 'record' && !rec && (
        <div className="card mb-6">
          <div className="card-header"><h3>Start recording</h3></div>
          <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, alignItems: 'end' }}>
            <div>
              <label className="form-label" htmlFor="rec-agent">Agent (application)</label>
              <select id="rec-agent" className="form-control" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label" htmlFor="rec-start">Start page</label>
              <input id="rec-start" className="form-control" value={startPath} onChange={(e) => setStartPath(e.target.value)} placeholder="/ or /login" />
            </div>
            {personas.length > 0 && (
              <div>
                <label className="form-label" htmlFor="rec-persona">Log in as</label>
                <select id="rec-persona" className="form-control" value={persona} onChange={(e) => setPersona(e.target.value)}>
                  <option value="">(nobody)</option>
                  {personas.map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>
            )}
            <button type="button" className="btn btn-primary btn-sm" disabled={!agentId || busy !== null} onClick={start}>{busy === 'start' ? 'Opening…' : '⏺ Start recording'}</button>
          </div>
          <p className="form-hint" style={{ padding: '0 16px 12px' }}>
            The browser runs on the server, so the application must be reachable from it. Click on the picture to act; every action runs for real and becomes a step.
          </p>
        </div>
      )}

      {tab === 'record' && rec && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(280px, 1fr)', gap: 16, alignItems: 'start' }}>
          <div className="card">
            <div className="card-header" style={{ gap: 8, flexWrap: 'wrap' }}>
              <form className="flex gap-2" style={{ flex: 1, minWidth: 240 }} onSubmit={(e) => { e.preventDefault(); record({ action: 'navigate', target: url }); }}>
                <input className="form-control" aria-label="Address" value={url} onChange={(e) => setUrl(e.target.value)} />
                <button className="btn btn-secondary btn-sm" type="submit" disabled={busy !== null}>Go</button>
              </form>
              <div className="flex gap-2" role="radiogroup" aria-label="What a click does">
                {([['interact', '👆 Act'], ['assert_text', '✓ Text'], ['assert_visible', '👁 Visible'], ['hover', '↗ Hover']] as Array<[Mode, string]>).map(([m, label]) => (
                  <button key={m} type="button" role="radio" aria-checked={mode === m} className={`btn btn-sm ${mode === m ? 'btn-primary' : 'btn-ghost'}`} onClick={() => { setMode(m); setPicked(null); }}>{label}</button>
                ))}
              </div>
            </div>
            <div className="card-body" style={{ padding: 8 }}>
              {shot ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img ref={imgRef} src={shot} alt={`Screen of ${rec.title || rec.url}`} onClick={onPick} data-testid="recorder-screen"
                  style={{ width: '100%', border: '1px solid var(--gray-200)', borderRadius: 6, cursor: busy ? 'progress' : 'crosshair', display: 'block' }} />
              ) : <div className="text-muted">Loading the screen…</div>}
              <div className="flex gap-2 mt-2" style={{ flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => scroll(-500)} disabled={busy !== null}>▲ Scroll up</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => scroll(500)} disabled={busy !== null}>▼ Scroll down</button>
                {['Enter', 'Tab', 'Escape'].map((k) => (
                  <button key={k} type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => record({ action: 'press', value: k })}>⌨ {k}</button>
                ))}
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => record({ action: 'assert_url', value: new URL(rec.url).pathname })}>✓ URL</button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => record({ action: 'assert_title', value: rec.title })}>✓ Title</button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => refresh()}>⟳ Refresh</button>
                {busy && <span className="text-sm text-muted">Working…</span>}
              </div>

              {picked && (
                <form className="mt-3" aria-label="Picked element" onSubmit={(e) => {
                  e.preventDefault();
                  if (picked.as === 'fill' && secret) record({ action: 'fill', target: picked.selector, secret });
                  else record({ action: picked.as, target: picked.selector, value });
                }} style={{ background: 'var(--gray-50)', padding: 10, borderRadius: 6 }}>
                  <div className="text-sm mb-2">
                    <strong>{picked.as === 'fill' ? 'Type into' : picked.as === 'select' ? 'Choose in' : 'Expect text of'}</strong> <span className="code">{picked.selector}</span>
                    {picked.alternatives?.length > 0 && <span className="text-muted"> (also unique: {picked.alternatives.join(', ')})</span>}
                  </div>
                  <div className="flex gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    {picked.as === 'select' ? (
                      <select className="form-control" aria-label="Option" value={value} onChange={(e) => setValue(e.target.value)} style={{ maxWidth: 300 }}>
                        {(picked.options ?? []).map((o: string) => <option key={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input className="form-control" aria-label="Value" value={value} onChange={(e) => setValue(e.target.value)} disabled={!!secret} autoFocus
                        type={picked.isPassword && !secret ? 'password' : 'text'} style={{ maxWidth: 360 }} />
                    )}
                    {picked.as === 'fill' && secrets.length > 0 && (
                      <select className="form-control" aria-label="Use a secret" value={secret} onChange={(e) => setSecret(e.target.value)} style={{ maxWidth: 220 }}>
                        <option value="">typed value</option>
                        {secrets.map((s) => <option key={s} value={s}>{`{{secrets.${s}}}`}</option>)}
                      </select>
                    )}
                    <button className="btn btn-primary btn-sm" type="submit" disabled={busy !== null}>Record</button>
                    <button className="btn btn-ghost btn-sm" type="button" onClick={() => setPicked(null)}>Cancel</button>
                  </div>
                  {picked.isPassword && !secrets.length && <p className="form-hint">Tip: add the password as an agent secret, so the test stores <code>{'{{secrets.NAME}}'}</code> instead of the password.</p>}
                </form>
              )}
            </div>
          </div>

          <div>
            <div className="card mb-4">
              <div className="card-header"><h3>Steps</h3><span className="text-sm text-muted">{rec.agentName}</span></div>
              <div className="card-body">
                <ol className="text-sm" style={{ margin: '0 0 0 18px' }} data-testid="recorded-steps">
                  {rec.steps.map((s: any, i: number) => (
                    <li key={i} className="mb-1">
                      <span className="code" style={{ wordBreak: 'break-all' }}>{describe(s)}</span>{' '}
                      <button type="button" className="btn btn-ghost btn-sm" title="Remove step" aria-label={`Remove step ${i + 1}`} onClick={() => removeStep(i)}>✕</button>
                    </li>
                  ))}
                </ol>
                <p className="form-hint">Removing a step does not undo it in the browser.</p>
              </div>
            </div>
            <form className="card" onSubmit={save} aria-label="Save recording">
              <div className="card-body">
                <div className="form-group">
                  <label className="form-label" htmlFor="rec-title">Test case title</label>
                  <input id="rec-title" className="form-control" value={title} onChange={(e) => setTitle(e.target.value)} required />
                </div>
                <div className="flex gap-2">
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label" htmlFor="rec-module">Module</label>
                    <input id="rec-module" className="form-control" value={module} onChange={(e) => setModule(e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="rec-priority">Priority</label>
                    <select id="rec-priority" className="form-control" value={priority} onChange={(e) => setPriority(e.target.value)}>
                      {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
                    </select>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button className="btn btn-primary btn-sm" type="submit" disabled={busy !== null || !title.trim()}>Save test case</button>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={stop} disabled={busy !== null}>Stop recording</button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {tab === 'import' && (
        <div className="card">
          <div className="card-header"><h3>Import a script from Playwright codegen</h3></div>
          <div className="card-body">
            <p className="text-sm">
              Record on your own computer with <code>npx playwright codegen https://your-app</code>, copy the generated script (JavaScript, TypeScript or Python) and
              paste it here. URLs of the agent become paths, typed passwords become <code>{'{{secrets.PASSWORD}}'}</code>, and unsupported lines are listed.
            </p>
            <div className="form-group">
              <label className="form-label" htmlFor="imp-agent">Agent</label>
              <select id="imp-agent" className="form-control" value={agentId} onChange={(e) => setAgentId(e.target.value)} style={{ maxWidth: 360 }}>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <textarea className="form-control code" rows={12} value={script} onChange={(e) => setScript(e.target.value)} aria-label="Codegen script" spellCheck={false}
              placeholder={"await page.goto('https://shop.example.com/');\nawait page.getByRole('button', { name: 'Sign in' }).click();"} />
            <div className="flex gap-2 mt-2">
              <button type="button" className="btn btn-secondary btn-sm" disabled={!script.trim() || busy !== null} onClick={() => importScript(false)}>Preview steps</button>
            </div>
            {imported && (
              <div className="mt-3" data-testid="import-result">
                <ol className="text-sm" style={{ margin: '0 0 8px 18px' }}>
                  {imported.steps.map((s: any, i: number) => <li key={i}><span className="code">{describe(s)}</span></li>)}
                </ol>
                {imported.skipped.length > 0 && (
                  <div className="text-sm text-muted mb-2">Skipped: {imported.skipped.map((s: any) => `line ${s.line} (${s.reason})`).join('; ')}</div>
                )}
                {imported.warnings.map((w: string) => <div key={w} className="alert alert-info" style={{ margin: '4px 0' }}>{w}</div>)}
                {imported.steps.length > 0 && !imported.testCase && (
                  <div className="flex gap-2 mt-2" style={{ alignItems: 'end', flexWrap: 'wrap' }}>
                    <div>
                      <label className="form-label" htmlFor="imp-title">Test case title</label>
                      <input id="imp-title" className="form-control" value={title} onChange={(e) => setTitle(e.target.value)} />
                    </div>
                    <div>
                      <label className="form-label" htmlFor="imp-module">Module</label>
                      <input id="imp-module" className="form-control" value={module} onChange={(e) => setModule(e.target.value)} />
                    </div>
                    <button type="button" className="btn btn-primary btn-sm" disabled={!title.trim() || busy !== null} onClick={() => importScript(true)}>Save test case</button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
}
