/**
 * Verification codes sent by email or SMS, read automatically, so sign-ins
 * (and flows such as "confirm your email") work unattended.
 *
 * agent.config.code_sources[]:
 *   { name, type: 'email', host, port (993), secure (true), username, password*, mailbox ('INBOX'),
 *     from_contains, subject_contains, code_pattern }
 *   { name, type: 'sms', provider: 'twilio', account_sid, auth_token*, phone_number, api_url, code_pattern }
 *   (* = secret, encrypted at rest)
 *
 * Login profiles and Salesforce personas use one with  codes: { source: 'qa_inbox', to: 'qa+rep@example.com' }.
 * A step can wait for a code and keep it:  { action: 'wait_for_code', target: 'qa_inbox', data: { save_as: 'otp' } }
 * then {{vars.otp}}.
 *
 * Only messages received after the sign-in (or the test) started are considered, newest first, and a
 * message is used once. Use a mailbox (or number) dedicated to testing.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

export const SOURCE_SECRET_FIELDS = ['password', 'auth_token'] as const;
export const SOURCE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,39}$/;

export interface EmailSource {
  name: string; type: 'email'; host: string; port: number; secure: boolean; username: string; password?: string;
  mailbox: string; from_contains?: string; subject_contains?: string; code_pattern?: string;
}
export interface SmsSource {
  name: string; type: 'sms'; provider: 'twilio'; account_sid: string; auth_token?: string; phone_number: string;
  api_url: string; code_pattern?: string;
}
export type CodeSourceConfig = EmailSource | SmsSource;

export interface CodeMessage { id: string; at: Date; from: string; to: string; subject: string; text: string }

const str = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function normalizeSource(raw: any): CodeSourceConfig {
  const base = { name: String(raw?.name ?? '').trim(), code_pattern: str(raw?.code_pattern) };
  if (raw?.type === 'sms') {
    return {
      ...base, type: 'sms', provider: 'twilio', account_sid: str(raw.account_sid) ?? '', auth_token: str(raw.auth_token),
      phone_number: str(raw.phone_number) ?? '', api_url: (str(raw.api_url) ?? 'https://api.twilio.com').replace(/\/+$/, ''),
    };
  }
  const port = Number(raw?.port);
  return {
    ...base, type: 'email', host: str(raw?.host) ?? '', port: Number.isInteger(port) && port > 0 ? port : 993,
    secure: raw?.secure !== false, username: str(raw?.username) ?? '', password: typeof raw?.password === 'string' && raw.password ? raw.password : undefined,
    mailbox: str(raw?.mailbox) ?? 'INBOX', from_contains: str(raw?.from_contains), subject_contains: str(raw?.subject_contains),
  };
}

export function codeSources(config: any): CodeSourceConfig[] {
  return Array.isArray(config?.code_sources) ? config.code_sources.map(normalizeSource) : [];
}

export function validateSources(list: any): void {
  if (list === undefined || list === null) return;
  if (!Array.isArray(list)) throw new Error('code_sources must be a list');
  const names = new Set<string>();
  for (const raw of list) {
    const s = normalizeSource(raw);
    if (!SOURCE_NAME_RE.test(s.name)) throw new Error(`Invalid code source name "${s.name}" (letters, digits, _ . -)`);
    if (names.has(s.name.toLowerCase())) throw new Error(`Duplicate code source "${s.name}"`);
    names.add(s.name.toLowerCase());
    if (raw?.type !== undefined && !['email', 'sms'].includes(raw.type)) throw new Error(`Code source "${s.name}": type must be email or sms`);
    if (s.type === 'email' && (!s.host || !s.username)) throw new Error(`Code source "${s.name}": host and username are required`);
    if (s.type === 'sms' && (!/^AC[0-9a-fA-F]{32}$/.test(s.account_sid) || !/^\+\d{6,15}$/.test(s.phone_number))) {
      throw new Error(`Code source "${s.name}": account_sid (AC…) and phone_number (+E.164) are required`);
    }
    if (s.code_pattern) {
      try {
        new RegExp(s.code_pattern);
      } catch {
        throw new Error(`Code source "${s.name}": code_pattern is not a valid regular expression`);
      }
    }
  }
}

/** The code in a message: the pattern's first group, else digits next to "code / passcode / verification / OTP", else a lone 6–8 digit number. */
export function extractCode(text: string, pattern?: string): string | null {
  if (pattern) {
    const m = text.match(new RegExp(pattern, 'i'));
    return m ? (m[1] ?? m[0]) : null;
  }
  const near = text.match(/(?:code|passcode|pass code|verification|one[- ]time|otp|pin|security key|codice)[^\d\n]{0,60}(\d{4,8})\b/i)
    ?? text.match(/\b(\d{4,8})\b[^\n]{0,40}(?:is your|verification|code)/i);
  if (near) return near[1];
  const lone = text.match(/(?<![\d.,/:-])(\d{6,8})(?![\d.,/:-])/);
  return lone ? lone[1] : null;
}

/** Messages received since a moment (email over IMAP). */
async function readEmail(s: EmailSource, since: Date): Promise<CodeMessage[]> {
  const client = new ImapFlow({ host: s.host, port: s.port, secure: s.secure, auth: { user: s.username, pass: s.password ?? '' }, logger: false, tls: { rejectUnauthorized: true } });
  client.on('error', () => undefined);
  await client.connect();
  const out: CodeMessage[] = [];
  try {
    const lock = await client.getMailboxLock(s.mailbox);
    try {
      // IMAP SINCE is a date (no time): filter by the exact time below
      const uids = await client.search({ since: new Date(since.getTime() - 86_400_000) }, { uid: true });
      const recent = (Array.isArray(uids) ? uids : []).slice(-30);
      if (recent.length) {
        for await (const m of client.fetch(recent, { source: true, internalDate: true, uid: true }, { uid: true })) {
          const parsed = await simpleParser(m.source as Buffer);
          const at = parsed.date ?? (m.internalDate instanceof Date ? m.internalDate : new Date(String(m.internalDate)));
          out.push({
            id: `${s.mailbox}:${m.uid}`,
            at,
            from: parsed.from?.text ?? '',
            to: Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(', ') : parsed.to?.text ?? '',
            subject: parsed.subject ?? '',
            text: (parsed.text || (typeof parsed.html === 'string' ? parsed.html.replace(/<[^>]+>/g, ' ') : '')).slice(0, 20_000),
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return out;
}

/** Text messages received by the number (Twilio REST API). */
async function readSms(s: SmsSource, since: Date): Promise<CodeMessage[]> {
  const url = `${s.api_url}/2010-04-01/Accounts/${encodeURIComponent(s.account_sid)}/Messages.json?To=${encodeURIComponent(s.phone_number)}&PageSize=30`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${Buffer.from(`${s.account_sid}:${s.auth_token ?? ''}`).toString('base64')}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Twilio answered HTTP ${res.status}${res.status === 401 ? ' (check the account SID and auth token)' : ''}`);
  const body: any = await res.json();
  return (body.messages ?? [])
    .filter((m: any) => String(m.direction ?? 'inbound').startsWith('inbound'))
    .map((m: any) => ({ id: `sms:${m.sid}`, at: new Date(m.date_sent ?? m.date_created), from: m.from ?? '', to: m.to ?? '', subject: '', text: String(m.body ?? '') }))
    .filter((m: CodeMessage) => m.at >= new Date(since.getTime() - 86_400_000));
}

export async function readMessages(s: CodeSourceConfig, since: Date): Promise<CodeMessage[]> {
  return s.type === 'email' ? readEmail(s, since) : readSms(s, since);
}

/** Newest unused code received after `since` (60 s of clock skew allowed), waiting for it up to the timeout. */
export async function waitForCode(
  s: CodeSourceConfig,
  opts: { since: Date; to?: string; timeoutMs?: number; pollMs?: number; used?: Set<string> },
): Promise<{ code: string; message: Omit<CodeMessage, 'text'> }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  const after = opts.since.getTime() - 60_000;
  const used = opts.used ?? new Set<string>();
  let lastError: string | undefined;
  for (;;) {
    try {
      const messages = (await readMessages(s, opts.since))
        .filter((m) => m.at.getTime() >= after && !used.has(m.id))
        .filter((m) => s.type !== 'email' || ((!s.from_contains || m.from.toLowerCase().includes(s.from_contains.toLowerCase()))
          && (!s.subject_contains || m.subject.toLowerCase().includes(s.subject_contains.toLowerCase()))))
        .filter((m) => !opts.to || m.to.toLowerCase().includes(opts.to.toLowerCase()))
        .sort((a, b) => b.at.getTime() - a.at.getTime());
      for (const m of messages) {
        const code = extractCode(`${m.subject}\n${m.text}`, s.code_pattern);
        if (code) {
          used.add(m.id);
          const { text: _t, ...meta } = m;
          return { code, message: meta };
        }
      }
      lastError = undefined;
    } catch (e: any) {
      lastError = String(e?.message ?? e);
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 3000));
  }
  throw new Error(`No verification code arrived in ${s.type === 'email' ? `mailbox "${s.name}"` : `phone number "${s.name}"`} within ${Math.round((opts.timeoutMs ?? 90_000) / 1000)} s`
    + (opts.to ? ` for ${opts.to}` : '') + (lastError ? ` (last error: ${lastError})` : ''));
}

/** Connection check for the UI: count of recent messages and the newest one's time and subject (no content). */
export async function checkSource(s: CodeSourceConfig): Promise<{ ok: true; recent: number; newest?: { at: string; from: string; subject: string } }> {
  const messages = await readMessages(s, new Date(Date.now() - 86_400_000));
  const newest = messages.sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  return { ok: true, recent: messages.length, ...(newest ? { newest: { at: newest.at.toISOString(), from: newest.from, subject: newest.subject } } : {}) };
}

export type CodeFetcher = (source: string, opts: { since: Date; to?: string; timeoutMs?: number }) => Promise<{ code: string; message: Omit<CodeMessage, 'text'> }>;

/** Codes from the agent's sources; a message is used once per fetcher (one per run). */
export function codeFetcher(config: any, used = new Set<string>()): CodeFetcher {
  const list = codeSources(config);
  return async (name, opts) => {
    const s = list.find((x) => x.name === name) ?? list.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!s) throw new Error(`Unknown code source "${name}" — configured: ${list.map((x) => x.name).join(', ') || 'none'} (Agent → Sign-in & MFA)`);
    return waitForCode(s, { ...opts, used });
  };
}
