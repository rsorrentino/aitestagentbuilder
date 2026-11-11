/**
 * Signed, expiring URLs for run artifacts (screenshots).
 *
 * Images are loaded by <img> tags that cannot send an Authorization header,
 * so the API returns artifact paths with ?exp=&sig= (HMAC-SHA256). When
 * AUTH_ENABLED=true the /artifacts route only serves signed, unexpired paths.
 */

import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { isAuthEnabled } from '../config/env.js';
import { deriveKey } from './secrets.js';
import type { TestRun } from '../../core/domain/run.js';

let signingKey: Buffer | null = null;
function key(): Buffer {
  if (!signingKey) {
    signingKey = process.env.ARTIFACT_SIGNING_KEY
      ? crypto.createHash('sha256').update(process.env.ARTIFACT_SIGNING_KEY).digest()
      : deriveKey('artifact-urls');
  }
  return signingKey;
}

const TTL_SECONDS = () => Math.max(60, parseInt(process.env.ARTIFACT_URL_TTL_SECONDS || '86400'));

function signature(path: string, exp: number): string {
  return crypto.createHmac('sha256', key()).update(`${path}:${exp}`).digest('base64url');
}

/** "RUN-1/x.png" → "RUN-1/x.png?exp=…&sig=…" */
export function signArtifactPath(path: string): string {
  const clean = path.split('?')[0];
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS();
  return `${clean}?exp=${exp}&sig=${signature(clean, exp)}`;
}

export function signRunArtifacts<T extends TestRun | null>(run: T): T {
  if (!run) return run;
  return {
    ...run,
    results: (run.results ?? []).map((r) => r.evidence?.screenshots
      ? { ...r, evidence: { ...r.evidence, screenshots: r.evidence.screenshots.map(signArtifactPath) } }
      : r),
  };
}

/** Express middleware placed in front of the static /artifacts handler. */
export function verifyArtifactSignature(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthEnabled()) return next();
  const path = decodeURIComponent(req.path.replace(/^\//, ''));
  const exp = Number(req.query.exp);
  const sig = String(req.query.sig ?? '');
  if (!exp || !sig || exp < Date.now() / 1000) {
    res.status(403).json({ error: 'Artifact link expired or not signed' });
    return;
  }
  const expected = signature(path, exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(403).json({ error: 'Invalid artifact signature' });
    return;
  }
  next();
}
