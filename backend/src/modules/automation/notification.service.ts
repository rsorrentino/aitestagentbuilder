/**
 * Notification channels: signed webhooks, Slack, Microsoft Teams, email.
 *
 * Channels belong to a project and subscribe to run events:
 *   run.completed (all tests passed) · run.failed · run.cancelled
 *
 * Secret parts of a channel (webhook signing secret, Slack/Teams webhook
 * URLs, which embed tokens) are encrypted at rest and redacted in the API.
 * Outbound URLs that resolve to private/loopback addresses are refused unless
 * NOTIFICATIONS_ALLOW_PRIVATE_URLS=true (SSRF protection).
 */

import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import nodemailer from 'nodemailer';
import getDatabaseClient from '../../infra/db/client.js';
import logger from '../../infra/logger/index.js';
import { decryptSecret, REDACTED, sealSecret } from '../../infra/security/secrets.js';
import type { TestRun } from '../../core/domain/run.js';
import { runEvents, RunFinishedEvent } from './run-events.js';

export type ChannelType = 'webhook' | 'slack' | 'teams' | 'email';
export const CHANNEL_TYPES: ChannelType[] = ['webhook', 'slack', 'teams', 'email'];
/** Run events, and a warning before a session saved by a person expires (it cannot be renewed unattended). */
export const RUN_EVENTS = ['run.completed', 'run.failed', 'run.cancelled', 'auth.session_expiring', 'digest.daily'] as const;
export type RunEventName = typeof RUN_EVENTS[number];

export interface NotificationChannel {
  id: string;
  projectId: string;
  name: string;
  type: ChannelType;
  config: Record<string, any>;
  events: RunEventName[];
  enabled: boolean;
  createdAt: Date;
  lastDelivery?: { status: string; event: string; at: Date; error?: string; responseCode?: number };
}

/** Config keys that hold secrets, per channel type. */
const SECRET_KEYS: Record<ChannelType, string[]> = {
  webhook: ['secret'],
  slack: ['webhookUrl'],
  teams: ['webhookUrl'],
  email: [],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function eventForRun(run: TestRun): RunEventName | null {
  if (run.status === 'completed') return 'run.completed';
  if (run.status === 'failed') return 'run.failed';
  if (run.status === 'cancelled') return 'run.cancelled';
  return null;
}

export function validateChannel(type: any, config: any, events: any, partial = false): string[] {
  const errors: string[] = [];
  if (!partial || type !== undefined) {
    if (!CHANNEL_TYPES.includes(type)) errors.push(`type must be one of ${CHANNEL_TYPES.join(', ')}`);
  }
  if (events !== undefined && (!Array.isArray(events) || events.length === 0 || events.some((e) => !RUN_EVENTS.includes(e)))) {
    errors.push(`events must be a non-empty list of ${RUN_EVENTS.join(', ')}`);
  }
  if (config !== undefined && (typeof config !== 'object' || config === null)) errors.push('config must be an object');
  if (errors.length || !config) return errors;

  const url = type === 'webhook' ? config.url : config.webhookUrl;
  if (type !== 'email' && url !== undefined && url !== REDACTED) {
    try {
      const u = new URL(String(url));
      if (!/^https?:$/.test(u.protocol)) errors.push('URL must be http(s)');
    } catch {
      errors.push(`${type === 'webhook' ? 'config.url' : 'config.webhookUrl'} must be a valid URL`);
    }
  }
  if (!partial && type !== 'email' && !url) errors.push(`${type === 'webhook' ? 'config.url' : 'config.webhookUrl'} is required`);
  if (config.digest_time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(config.digest_time))) errors.push('config.digest_time must be HH:MM (24 h)');
  if (config.digest_timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: String(config.digest_timezone) });
    } catch {
      errors.push('config.digest_timezone must be a time zone such as Europe/Rome');
    }
  }
  if (type === 'email' && (config.recipients !== undefined || !partial)) {
    const r = config.recipients;
    if (!Array.isArray(r) || r.length === 0 || r.some((x: any) => !EMAIL_RE.test(String(x)))) {
      errors.push('config.recipients must be a list of email addresses');
    }
  }
  return errors;
}

function seal(type: ChannelType, next: Record<string, any>, previous?: Record<string, any>): Record<string, any> {
  const out = { ...(previous ?? {}), ...next };
  for (const key of SECRET_KEYS[type]) {
    const v = sealSecret(next[key], previous?.[key]);
    if (v === undefined) delete out[key];
    else out[key] = v;
  }
  return out;
}

function redact(type: ChannelType, config: Record<string, any>): Record<string, any> {
  const out = { ...config };
  for (const key of SECRET_KEYS[type]) if (out[key]) out[key] = REDACTED;
  return out;
}

function decrypt(type: ChannelType, config: Record<string, any>): Record<string, any> {
  const out = { ...config };
  for (const key of SECRET_KEYS[type]) if (out[key]) out[key] = decryptSecret(String(out[key]));
  return out;
}

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('::ffff:127.') || v6.startsWith('::ffff:10.') || v6.startsWith('::ffff:192.168.');
}

async function assertPublicUrl(rawUrl: string): Promise<void> {
  if (process.env.NOTIFICATIONS_ALLOW_PRIVATE_URLS === 'true') return;
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivateAddress)) {
    throw new Error(`Refusing to call a private/loopback address (${host}). Set NOTIFICATIONS_ALLOW_PRIVATE_URLS=true for internal endpoints.`);
  }
}

export function runSummary(run: TestRun, projectName?: string) {
  const appUrl = (process.env.PUBLIC_APP_URL || 'http://localhost:4000').replace(/\/$/, '');
  return {
    id: run.id,
    status: run.status,
    agentId: run.agentId,
    agentName: run.agentName,
    projectId: run.projectId,
    projectName,
    total: run.totalTests,
    passed: run.passedTests,
    failed: run.failedTests,
    skipped: run.skippedTests,
    durationMs: run.duration,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    triggeredBy: run.metadata?.triggeredBy,
    error: run.metadata?.error,
    url: `${appUrl}/runs/${run.id}`,
    triage: triageLine(run.metadata?.triage),
    failures: (run.results ?? [])
      .filter((r) => r.status === 'failed' || r.status === 'error')
      .slice(0, 10)
      .map((r) => ({ title: (r.metadata?.title as string) ?? r.testCaseId, error: r.error })),
  };
}

type Summary = ReturnType<typeof runSummary>;

const CATEGORY_LABEL: Record<string, string> = { app_bug: 'app bug', test_bug: 'test bug', environment: 'environment', unknown: 'unclassified' };

/** "Triage: 2 app bug, 1 test bug — 1 new failure" */
export function triageLine(triage: any): string | undefined {
  if (!triage?.groups?.length) return undefined;
  const parts = Object.entries(triage.summary ?? {}).filter(([, n]) => Number(n) > 0).map(([k, n]) => `${n} ${CATEGORY_LABEL[k] ?? k}`);
  const fresh = triage.groups.filter((g: any) => !g.seenBefore).reduce((sum: number, g: any) => sum + g.tests.length, 0);
  return `Triage: ${parts.join(', ')}${fresh ? ` — ${fresh} new failure${fresh === 1 ? '' : 's'}` : ' — all seen before'}`;
}

function headline(event: RunEventName, s: Summary): string {
  if ((s as any).headline) return (s as any).headline;
  const icon = event === 'run.completed' ? '✅' : event === 'run.failed' ? '❌' : '⏹';
  return `${icon} ${s.agentName ?? s.agentId}: ${s.status} — ${s.passed}/${s.total} passed${s.failed ? `, ${s.failed} failed` : ''}`;
}

export class NotificationService {
  private db = getDatabaseClient();
  private mailer?: nodemailer.Transporter;

  private map(row: any, withSecrets = false): NotificationChannel {
    const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      type: row.type,
      config: withSecrets ? decrypt(row.type, config) : redact(row.type, config),
      events: typeof row.events === 'string' ? JSON.parse(row.events) : row.events,
      enabled: row.enabled,
      createdAt: row.created_at,
      ...(row.last_status ? { lastDelivery: { status: row.last_status, event: row.last_event, at: row.last_at, error: row.last_error ?? undefined, responseCode: row.last_code ?? undefined } } : {}),
    };
  }

  async list(projectId: string): Promise<NotificationChannel[]> {
    const result = await this.db.query(
      `SELECT c.*, d.status AS last_status, d.event AS last_event, d.attempted_at AS last_at, d.error AS last_error, d.response_code AS last_code
         FROM notification_channels c
         LEFT JOIN LATERAL (SELECT * FROM notification_deliveries WHERE channel_id = c.id ORDER BY attempted_at DESC LIMIT 1) d ON true
        WHERE c.project_id = $1 ORDER BY c.created_at`, [projectId]);
    return result.rows.map((r) => this.map(r));
  }

  async get(id: string, projectId: string, withSecrets = false): Promise<NotificationChannel | null> {
    const result = await this.db.query('SELECT * FROM notification_channels WHERE id = $1 AND project_id = $2', [id, projectId]);
    return result.rows.length ? this.map(result.rows[0], withSecrets) : null;
  }

  async create(input: { projectId: string; name: string; type: ChannelType; config: Record<string, any>; events: RunEventName[]; enabled?: boolean; createdBy?: string }): Promise<NotificationChannel> {
    const id = `NCH-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.db.query(
      `INSERT INTO notification_channels (id, project_id, name, type, config, events, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, input.projectId, input.name, input.type, JSON.stringify(seal(input.type, input.config)), JSON.stringify(input.events), input.enabled ?? true, input.createdBy ?? null],
    );
    return (await this.get(id, input.projectId))!;
  }

  async update(id: string, projectId: string, input: { name?: string; config?: Record<string, any>; events?: RunEventName[]; enabled?: boolean }): Promise<NotificationChannel | null> {
    const raw = await this.db.query('SELECT * FROM notification_channels WHERE id = $1 AND project_id = $2', [id, projectId]);
    if (!raw.rows.length) return null;
    const row = raw.rows[0];
    const prevConfig = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    await this.db.query(
      `UPDATE notification_channels SET name = $1, config = $2, events = $3, enabled = $4 WHERE id = $5`,
      [
        input.name ?? row.name,
        JSON.stringify(input.config ? seal(row.type, input.config, prevConfig) : prevConfig),
        JSON.stringify(input.events ?? row.events),
        input.enabled ?? row.enabled,
        id,
      ],
    );
    return this.get(id, projectId);
  }

  async delete(id: string, projectId: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM notification_channels WHERE id = $1 AND project_id = $2', [id, projectId]);
    return (result.rowCount ?? 0) > 0;
  }

  async deliveries(id: string, limit = 20) {
    const result = await this.db.query(
      'SELECT * FROM notification_deliveries WHERE channel_id = $1 ORDER BY attempted_at DESC LIMIT $2', [id, limit]);
    return result.rows.map((r) => ({
      id: Number(r.id), event: r.event, runId: r.run_id, status: r.status, responseCode: r.response_code ?? undefined,
      error: r.error ?? undefined, attemptedAt: r.attempted_at,
    }));
  }

  /** Called for every finished run. */
  async onRunFinished(run: TestRun): Promise<void> {
    const event = eventForRun(run);
    if (!event || !run.projectId) return;
    const result = await this.db.query(
      `SELECT c.*, p.name AS project_name FROM notification_channels c JOIN projects p ON p.id = c.project_id
        WHERE c.project_id = $1 AND c.enabled AND c.events ? $2`,
      [run.projectId, event],
    );
    await Promise.all(result.rows.map((row) =>
      this.deliver(this.map(row, true), event, runSummary(run, row.project_name))));
  }

  /** Sends a prepared message (digest) through one channel. */
  async deliverMessage(channelId: string, event: RunEventName, summary: any): Promise<{ ok: boolean; status: string; error?: string }> {
    const row = (await this.db.query('SELECT * FROM notification_channels WHERE id = $1', [channelId])).rows[0];
    if (!row) return { ok: false, status: 'failed', error: 'Channel not found' };
    return this.deliver(this.map(row, true), event, summary);
  }

  /** Warns the project's subscribed channels that a saved sign-in session will expire soon. */
  async onSessionExpiring(n: { projectId: string; agentId: string; agentName: string; kind: string; identity: string; expiresAt: Date; unattended: boolean }): Promise<number> {
    const event: RunEventName = 'auth.session_expiring';
    const result = await this.db.query(
      `SELECT c.*, p.name AS project_name FROM notification_channels c JOIN projects p ON p.id = c.project_id
        WHERE c.project_id = $1 AND c.enabled AND c.events ? $2`,
      [n.projectId, event],
    );
    const appUrl = (process.env.PUBLIC_APP_URL || 'http://localhost:4000').replace(/\/$/, '');
    const hours = Math.max(0, Math.round((n.expiresAt.getTime() - Date.now()) / 3_600_000));
    const who = `${n.kind === 'salesforce' ? 'Salesforce persona' : 'login profile'} ${n.identity}`;
    for (const row of result.rows) {
      const summary: any = {
        id: `SESSION-${n.agentId}-${n.identity}`, status: 'expiring', agentId: n.agentId, agentName: n.agentName, projectId: n.projectId, projectName: row.project_name,
        total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0, startedAt: new Date(), finishedAt: new Date(), triggeredBy: 'sign-in health', error: undefined,
        url: `${appUrl}/agents/${n.agentId}`, triage: undefined,
        headline: `🔐 ${n.agentName}: the saved sign-in of ${who} expires in ${hours} h`,
        failures: [{ title: 'What to do', error: n.unattended
          ? 'Nothing: the next run signs in by itself.'
          : 'Open the agent, Sign-in & MFA, and use "Sign in once…" again, or add an authenticator key or a mailbox for codes so it renews by itself.' }],
      };
      await this.deliver(this.map(row, true), event, summary);
    }
    return result.rows.length;
  }

  /** Sends a sample notification through a channel (UI "Test" button). */
  async sendTest(id: string, projectId: string): Promise<{ ok: boolean; status: string; error?: string; responseCode?: number }> {
    const channel = await this.get(id, projectId, true);
    if (!channel) throw new Error('Channel not found');
    const sample: Summary = {
      id: 'RUN-TEST', status: 'failed', agentId: 'AGENT-TEST', agentName: 'Sample agent', projectId, projectName: undefined,
      total: 3, passed: 2, failed: 1, skipped: 0, durationMs: 4200, startedAt: new Date(), finishedAt: new Date(),
      triggeredBy: 'test', error: undefined, url: `${(process.env.PUBLIC_APP_URL || 'http://localhost:4000').replace(/\/$/, '')}/runs`,
      triage: 'Triage: 1 app bug — 1 new failure',
      failures: [{ title: 'Sample failing test', error: 'This is a test notification from AI Test Agent Builder' }],
    };
    return this.deliver(channel, 'run.failed', sample, true);
  }

  private async deliver(channel: NotificationChannel, event: RunEventName, summary: Summary, isTest = false) {
    let attempt = 0;
    let lastError: string | undefined;
    let responseCode: number | undefined;
    const maxAttempts = isTest ? 1 : 3;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        responseCode = await this.send(channel, event, summary, isTest);
        await this.record(channel.id, event, summary.id, 'sent', responseCode);
        return { ok: true, status: 'sent', responseCode };
      } catch (error: any) {
        lastError = error.message;
        responseCode = error.responseCode;
        const retryable = !error.permanent && attempt < maxAttempts;
        if (!retryable) break;
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
    logger.warn('Notification delivery failed', { channel: channel.name, event, error: lastError });
    await this.record(channel.id, event, summary.id, 'failed', responseCode, lastError);
    return { ok: false, status: 'failed', error: lastError, responseCode };
  }

  private async record(channelId: string, event: string, runId: string, status: string, code?: number, error?: string) {
    await this.db.query(
      `INSERT INTO notification_deliveries (channel_id, event, run_id, status, response_code, error) VALUES ($1, $2, $3, $4, $5, $6)`,
      [channelId, event, runId, status, code ?? null, error ?? null],
    ).catch((e) => logger.error('Could not record notification delivery', { error: e.message }));
  }

  private async post(url: string, body: string, headers: Record<string, string>): Promise<number> {
    await assertPublicUrl(url).catch((e) => { throw Object.assign(e, { permanent: true }); });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ai-test-agent-builder', ...headers },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw Object.assign(new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`), {
        responseCode: res.status,
        permanent: res.status >= 400 && res.status < 500 && res.status !== 429,
      });
    }
    return res.status;
  }

  private async send(channel: NotificationChannel, event: RunEventName, s: Summary, isTest: boolean): Promise<number | undefined> {
    const title = `${isTest ? '[TEST] ' : ''}${headline(event, s)}`;
    const failures = [s.triage, ...s.failures.map((f) => `• ${f.title}${f.error ? ` — ${f.error}` : ''}`)].filter(Boolean).join('\n');

    switch (channel.type) {
      case 'webhook': {
        const body = JSON.stringify({ event, test: isTest, timestamp: new Date().toISOString(), run: s });
        const headers: Record<string, string> = { 'X-ATAB-Event': event, 'X-ATAB-Delivery': crypto.randomUUID() };
        if (channel.config.secret) {
          headers['X-ATAB-Signature'] = `sha256=${crypto.createHmac('sha256', String(channel.config.secret)).update(body).digest('hex')}`;
        }
        return this.post(String(channel.config.url), body, headers);
      }
      case 'slack': {
        const text = `${title}\n<${s.url}|Open run>${failures ? `\n${failures}` : ''}`;
        return this.post(String(channel.config.webhookUrl), JSON.stringify({ text }), {});
      }
      case 'teams': {
        const card = {
          type: 'message',
          attachments: [{
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.4',
              body: [
                { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: title, wrap: true },
                ...(failures ? [{ type: 'TextBlock', text: failures, wrap: true }] : []),
              ],
              actions: [{ type: 'Action.OpenUrl', title: 'Open run', url: s.url }],
            },
          }],
        };
        return this.post(String(channel.config.webhookUrl), JSON.stringify(card), {});
      }
      case 'email': {
        const mailer = this.getMailer();
        await mailer.sendMail({
          from: process.env.SMTP_FROM || 'AI Test Agent Builder <no-reply@localhost>',
          to: (channel.config.recipients as string[]).join(', '),
          subject: title,
          text: `${title}\n\nProject: ${s.projectName ?? s.projectId}\nDuration: ${Math.round((s.durationMs ?? 0) / 1000)}s\n${failures ? `\nFailures:\n${failures}\n` : ''}\nDetails: ${s.url}\n`,
        });
        return undefined;
      }
    }
  }

  private getMailer(): nodemailer.Transporter {
    if (this.mailer) return this.mailer;
    const smtp = process.env.SMTP_URL;
    if (!smtp) throw Object.assign(new Error('Email is not configured: set SMTP_URL (e.g. smtps://user:pass@smtp.example.com)'), { permanent: true });
    this.mailer = smtp === 'json' ? nodemailer.createTransport({ jsonTransport: true }) : nodemailer.createTransport(smtp);
    return this.mailer;
  }
}

let service: NotificationService | null = null;
export function getNotificationService(): NotificationService {
  if (!service) service = new NotificationService();
  return service;
}

/** Subscribes notifications to run events (call once at startup). */
export function wireNotifications(): void {
  runEvents.on('run.finished', ({ run }: RunFinishedEvent) => {
    getNotificationService().onRunFinished(run).catch((e) => logger.error('Notification dispatch failed', { error: e.message }));
  });
}
