/**
 * Evidence kept for a test: Playwright trace (actions, DOM snapshots, network,
 * console) and video, on failure or always (agent config `evidence`).
 *
 * Traces record typed values, URLs and response bodies, so every secret the
 * run knows about (agent secrets, persona passwords and TOTP secrets, OAuth
 * access tokens and session ids) is replaced with •••• inside the trace file
 * before it is stored.
 */

import JSZip from 'jszip';

export type EvidenceMode = 'off' | 'on_failure' | 'always';

export interface EvidenceConfig {
  trace: EvidenceMode;
  video: EvidenceMode;
}

const MODES: EvidenceMode[] = ['off', 'on_failure', 'always'];

export function evidenceConfig(config: any): EvidenceConfig {
  const pick = (v: unknown, fallback: EvidenceMode): EvidenceMode => (MODES.includes(v as EvidenceMode) ? (v as EvidenceMode) : fallback);
  const env = (name: string) => process.env[name] as EvidenceMode | undefined;
  return {
    trace: pick(config?.evidence?.trace ?? env('EVIDENCE_TRACE'), 'on_failure'),
    video: pick(config?.evidence?.video ?? env('EVIDENCE_VIDEO'), 'on_failure'),
  };
}

export function keepEvidence(mode: EvidenceMode, status: string): boolean {
  if (mode === 'always') return true;
  if (mode === 'on_failure') return status === 'failed' || status === 'error';
  return false;
}

/** Every way a secret can appear in trace text: raw, URL-encoded, JSON-escaped. */
export function secretVariants(secrets: string[]): string[] {
  const out = new Set<string>();
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    out.add(s);
    out.add(encodeURIComponent(s));
    out.add(JSON.stringify(s).slice(1, -1));
    out.add(encodeURIComponent(s).replace(/%20/g, '+'));
  }
  // Longest first, so a secret that contains another is replaced whole
  return [...out].sort((a, b) => b.length - a.length);
}

function replaceAll(buf: Buffer, needle: Buffer, replacement: Buffer): { buf: Buffer; count: number } {
  let idx = buf.indexOf(needle);
  if (idx === -1) return { buf, count: 0 };
  const parts: Buffer[] = [];
  let start = 0;
  let count = 0;
  while (idx !== -1) {
    parts.push(buf.subarray(start, idx), replacement);
    start = idx + needle.length;
    count++;
    idx = buf.indexOf(needle, start);
  }
  parts.push(buf.subarray(start));
  return { buf: Buffer.concat(parts), count };
}

/** Replace secrets in every file of a trace zip. Returns the redacted zip and how many occurrences were masked. */
export async function redactTrace(zipBuffer: Buffer, secrets: string[]): Promise<{ zip: Buffer; masked: number }> {
  const variants = secretVariants(secrets).map((v) => Buffer.from(v, 'utf8'));
  if (variants.length === 0) return { zip: zipBuffer, masked: 0 };
  const mask = Buffer.from('••••', 'utf8');
  const zip = await JSZip.loadAsync(zipBuffer);
  let masked = 0;
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    let content = await file.async('nodebuffer');
    let changed = false;
    for (const v of variants) {
      const r = replaceAll(content, v, mask);
      if (r.count) {
        content = r.buf;
        masked += r.count;
        changed = true;
      }
    }
    if (changed) zip.file(name, content);
  }
  if (masked === 0) return { zip: zipBuffer, masked: 0 };
  return { zip: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), masked };
}
