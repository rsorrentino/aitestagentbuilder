/**
 * Authenticator key helper: read the key from a screenshot of the QR code
 * (decoded in this browser; the image is not uploaded), and show the
 * current code to compare with the phone before saving. For a key already
 * saved, the server shows its current code without revealing the key.
 */

import { useEffect, useState } from 'react';
import jsQR from 'jsqr';
import { currentCode } from '../lib/totp';

interface Props {
  /** The key being typed (empty or the redacted placeholder when unchanged) */
  value: string;
  onChange: (key: string) => void;
  /** Current code of the saved key, when there is one */
  savedCode?: () => Promise<{ code: string; secondsLeft: number }>;
}

const spaced = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

async function decodeImage(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  // Try the full size first, then smaller (large screenshots), as QR finders work best at moderate sizes
  for (const scale of [1, 0.5, 0.25]) {
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const found = jsQR(ctx.getImageData(0, 0, w, h).data, w, h);
    if (found?.data) return found.data;
  }
  throw new Error('No QR code found in the image: crop it around the QR code and try again');
}

export default function TotpKeyHelper({ value, onChange, savedCode }: Props) {
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ code: string; secondsLeft: number; at: number } | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  let live: ReturnType<typeof currentCode> | null = null;
  let parseError: string | null = null;
  if (value && value.trim() && !value.startsWith('•')) {
    try {
      live = currentCode(value, now);
    } catch (e: any) {
      parseError = e.message;
    }
  }

  const readImage = async (blob: Blob | null | undefined) => {
    if (!blob) return;
    setError(null);
    setNotice(null);
    try {
      const text = await decodeImage(blob);
      if (!/^otpauth:\/\/totp\//i.test(text)) throw new Error('This QR code is not an authenticator key (otpauth://totp/…)');
      onChange(text);
      setNotice('Key read from the QR code');
    } catch (e: any) {
      setError(e.message);
    }
  };

  const showSaved = async () => {
    setError(null);
    try {
      const r = await savedCode!();
      setSaved({ ...r, at: Date.now() });
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e.message);
    }
  };
  const savedLeft = saved ? saved.secondsLeft - Math.floor((now - saved.at) / 1000) : 0;

  return (
    <div className="text-sm" data-testid="totp-helper"
      onPaste={(e) => {
        const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
        if (item) {
          e.preventDefault();
          readImage(item.getAsFile());
        }
      }}>
      <div className="flex gap-2 mt-1" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer', margin: 0 }}>
          📷 Read the QR code from a screenshot
          <input type="file" accept="image/*" aria-label="QR code image" style={{ display: 'none' }} onChange={(e) => readImage(e.target.files?.[0])} />
        </label>
        <span className="text-muted">or paste the image here (Ctrl+V). It stays in your browser.</span>
      </div>
      {notice && <div className="text-success">{notice}</div>}
      {error && <div className="text-danger" role="alert">{error}</div>}
      {parseError && <div className="text-danger">{parseError}</div>}
      {live && (
        <div className="mt-1" data-testid="totp-live">
          Code now: <strong className="code" style={{ fontSize: 15 }}>{spaced(live.code)}</strong> <span className="text-muted">({live.secondsLeft} s)</span>
          {live.key.issuer || live.key.account ? <span className="text-muted"> · {[live.key.issuer, live.key.account].filter(Boolean).join(' · ')}</span> : null}
          <div className="text-muted">It must match the code in the authenticator app on your phone. If it doesn&apos;t, check the key and the server&apos;s clock.</div>
        </div>
      )}
      {!live && savedCode && (
        <div className="mt-1">
          <button type="button" className="btn btn-ghost btn-sm" onClick={showSaved}>Show the current code of the saved key</button>
          {saved && savedLeft > 0 && <span> <strong className="code">{spaced(saved.code)}</strong> <span className="text-muted">({savedLeft} s)</span></span>}
        </div>
      )}
    </div>
  );
}
