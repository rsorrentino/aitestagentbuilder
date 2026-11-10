/**
 * Environment loading.
 *
 * Loads `.env` from the backend directory first, then from the repository root,
 * so `cp .env.example .env` at the repo root (as documented) works no matter
 * which directory the server is started from. Values already present in the
 * process environment always win.
 */

import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
// src/infra/config -> backend
export const BACKEND_ROOT = resolve(here, '..', '..', '..');
export const REPO_ROOT = resolve(BACKEND_ROOT, '..');

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const file of [join(process.cwd(), '.env'), join(BACKEND_ROOT, '.env'), join(REPO_ROOT, '.env')]) {
    if (existsSync(file)) dotenv.config({ path: file });
  }
}

loadEnv();

/** Auth is opt-in: the MVP runs open on localhost unless AUTH_ENABLED=true. */
export function isAuthEnabled(): boolean {
  return (process.env.AUTH_ENABLED || '').toLowerCase() === 'true';
}
