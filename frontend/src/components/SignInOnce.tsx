/**
 * "Sign in once": the sign-in page opens in a browser on the server and its
 * screen is shown here. Click, type and approve the MFA prompt (phone push,
 * SMS code, number matching…); then save the session, which runs reuse.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';

interface Props {
  agentId: string;
  kind: 'app' | 'salesforce';
  identity: string;
  onDone: (saved: boolean) => void;
}

export default function SignInOnce({ agentId, kind, identity, onDone }: Props) {
  const [s, setS] = useState<any>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>('start');
  const [error, setError] = useState<string | null>(null);
  const [notSignedIn, setNotSignedIn] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const shotUrl = useRef<string | null>(null);
  const sid = s?.id;

  const refresh = useCallback(async () => {
    if (!sid) return;
    try {
      const r = await api.get(`/auth/interactive/${sid}/screenshot`, { responseType: 'blob' });
      const next = URL.createObjectURL(r.data);
      if (shotUrl.current) URL.revokeObjectURL(shotUrl.current);
      shotUrl.current = next;
      setShot(next);
    } catch {
      // the session may have closed
    }
  }, [sid]);

  useEffect(() => {
    let alive = true;
    api.post(`/agents/${agentId}/auth/interactive`, { kind, identity })
      .then((r) => { if (alive) setS(r.data); })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setBusy(null));
    return () => { alive = false; };
  }, [agentId, kind, identity]);

  useEffect(() => {
    if (!sid) return;
    refresh();
    // Push approvals change the page on their own: keep the picture fresh
    const t = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 1500);
    return () => clearInterval(t);
  }, [sid, refresh]);

  // Close the server browser when leaving without saving
  useEffect(() => () => {
    if (sid) api.delete(`/auth/interactive/${sid}`).catch(() => undefined);
  }, [sid]);

  const send = async (body: any, key = body.type) => {
    setBusy(key);
    setError(null);
    try {
      const r = await api.post(`/auth/interactive/${sid}/input`, body);
      setS(r.data);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const onClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!s || busy) return;
    const rect = imgRef.current!.getBoundingClientRect();
    send({ type: 'click', x: ((e.clientX - rect.left) / rect.width) * s.viewport.width, y: ((e.clientY - rect.top) / rect.height) * s.viewport.height });
  };

  const finish = async (force = false) => {
    setBusy('finish');
    setError(null);
    try {
      await api.post(`/auth/interactive/${sid}/finish`, { force });
      setS(null);
      onDone(true);
    } catch (err: any) {
      if (err?.response?.status === 409) setNotSignedIn(true);
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3" role="region" aria-label={`Sign in as ${identity}`} style={{ border: '1px solid var(--brand-200)', borderRadius: 8, padding: 12 }}>
      <div className="flex gap-2 mb-2" style={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <strong>Sign in as {identity}</strong>
        <span className="text-sm text-muted">{s?.url}</span>
      </div>
      {error && <div className="alert alert-error" role="alert" style={{ margin: '0 0 8px' }}>{error}</div>}
      {!s && busy === 'start' && <p className="text-muted text-sm">Opening the sign-in page…</p>}
      {s && (
        <>
          {shot ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img ref={imgRef} src={shot} alt={`Sign-in screen: ${s.title}`} onClick={onClick} data-testid="signin-screen"
              style={{ width: '100%', maxWidth: 900, border: '1px solid var(--gray-200)', borderRadius: 6, cursor: busy ? 'progress' : 'pointer', display: 'block' }} />
          ) : <p className="text-muted text-sm">Loading the screen…</p>}
          <div className="flex gap-2 mt-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            {s.canFill.username && <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => send({ type: 'fill', what: 'username' }, 'fill')}>Type user name</button>}
            {s.canFill.password && <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => send({ type: 'fill', what: 'password' }, 'fill')}>Type password</button>}
            {s.canFill.code && <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => send({ type: 'fill', what: 'code' }, 'fill')}>Type authenticator code</button>}
            {['Enter', 'Tab', 'Escape'].map((k) => <button key={k} type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => send({ type: 'key', key: k })}>⌨ {k}</button>)}
            <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => send({ type: 'scroll', dy: 400 })}>▼ Scroll</button>
          </div>
          <form className="flex gap-2 mt-2" onSubmit={(e) => { e.preventDefault(); if (text) send({ type: 'text', text }).then(() => setText('')); }}>
            <input className="form-control" aria-label="Text to type" value={text} onChange={(e) => setText(e.target.value)} placeholder="Click a field above, then type here (e.g. the code from your phone)" style={{ maxWidth: 420 }} autoComplete="off" />
            <button className="btn btn-secondary btn-sm" type="submit" disabled={!!busy || !text}>Type</button>
          </form>
          <p className="form-hint mt-2">
            Approve the sign-in on your phone if asked; the screen updates by itself. Tick “remember this device” when offered: runs will then rarely need MFA.
          </p>
          <div className="flex gap-2 mt-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => finish(false)}>{busy === 'finish' ? 'Saving…' : '✓ I\'m signed in: save the session'}</button>
            {notSignedIn && <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => finish(true)}>Save anyway</button>}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onDone(false)}>Cancel</button>
          </div>
        </>
      )}
      {!s && busy !== 'start' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onDone(false)}>Close</button>}
    </div>
  );
}
