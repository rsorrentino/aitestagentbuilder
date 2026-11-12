/**
 * Remote test recorder: the server drives a browser for the agent's
 * application, the UI shows its screen, and what the user does there
 * (click on the picture, type, pick, press keys, add checks) is executed
 * and recorded as test steps.
 *
 * Every action runs through the same step executor as a test run, so a
 * recorded step replays exactly as it was performed. Element picks get the
 * most robust selector that is unique on the page (id, test id, name, role
 * and name, label, placeholder, text, then a CSS path). Passwords are
 * recorded as {{secrets.NAME}} placeholders, never as typed values.
 *
 * Sessions live in memory, belong to one user and project, close after 10
 * minutes without use, and are limited by RECORDER_MAX_SESSIONS (default 4).
 */

import crypto from 'crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import { launchBrowser, outlinePage } from '../execution/browser.js';
import { executeStep, StepContext } from '../execution/step-runner.js';
import { resolvePlaceholders } from '../../core/domain/agent-secrets.js';
import { maskSecrets } from '../../infra/security/secrets.js';
import { salesforceSettings } from '../salesforce/personas.js';
import { SalesforceSessions } from '../salesforce/session.js';

export const RECORDABLE = ['navigate', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'hover', 'wait',
  'assert_text', 'assert_visible', 'assert_not_visible', 'assert_url', 'assert_title', 'salesforce_login'] as const;
export type RecordableAction = typeof RECORDABLE[number];

export interface RecordedStep {
  action: string;
  target?: string;
  data?: Record<string, any>;
}

export interface ElementInfo {
  selector: string;
  /** Other unique selectors, most robust first */
  alternatives: string[];
  tag: string;
  type?: string;
  text: string;
  value?: string;
  options?: string[];
  checked?: boolean;
  /** What a click on it should record: fill a field, pick an option, tick a box, or click */
  suggested: 'fill' | 'select' | 'check' | 'uncheck' | 'click';
  isPassword: boolean;
}

export const VIEWPORT = { width: 1280, height: 800 };
const IDLE_MS = 10 * 60 * 1000;

/**
 * Runs in the page (a string, so no transpiler helpers leak into it): the element at a point, climbed to
 * the control the user meant, with selector candidates in order of robustness.
 */
const INSPECT_SCRIPT = `({ x, y }) => {
  let el = document.elementFromPoint(x, y);
  if (!el) return null;
  const interactive = (n) => n && n.matches && n.matches('a[href], button, input, select, textarea, label, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [role=option], [onclick], [contenteditable=true]');
  let cur = el;
  for (let i = 0; i < 5 && cur && !interactive(cur); i++) cur = cur.parentElement;
  if (cur && interactive(cur)) el = cur;
  // A label stands for its control
  if (el.tagName === 'LABEL') {
    const forId = el.getAttribute('for');
    const ctl = forId ? document.getElementById(forId) : el.querySelector('input, select, textarea');
    if (ctl && ctl.type !== 'checkbox' && ctl.type !== 'radio') el = ctl;
  }
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const qs = (s) => JSON.stringify(s);
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const text = clean(el.innerText || el.textContent || '').slice(0, 200);
  const cands = [];
  const id = el.getAttribute('id');
  if (id && /^[A-Za-z][\\w-]*$/.test(id) && !/\\d{4,}/.test(id)) cands.push('#' + id);
  for (const a of ['data-testid', 'data-test', 'data-test-id', 'data-qa']) {
    const v = el.getAttribute(a);
    if (v) cands.push('[' + a + '=' + qs(v) + ']');
  }
  const name = el.getAttribute('name');
  if (name && /^(input|select|textarea|button)$/.test(tag)) cands.push(tag + '[name=' + qs(name) + ']');
  const aria = el.getAttribute('aria-label');
  const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' || type === 'submit' || type === 'button' ? 'button'
    : type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : '');
  const accName = clean(aria || (tag === 'input' ? el.value : el.innerText)).slice(0, 80);
  if (role && accName) cands.push('role=' + role + '[name=' + qs(accName) + 's]');
  let labelText = '';
  if (el.labels && el.labels.length) labelText = clean(el.labels[0].innerText).slice(0, 80);
  if (labelText) cands.push('internal:label=' + qs(labelText) + 's');
  const ph = el.getAttribute('placeholder');
  if (ph) cands.push('[placeholder=' + qs(ph) + ']');
  if (aria) cands.push('[aria-label=' + qs(aria) + ']');
  if (text && text.length <= 60 && !/^(input|select|textarea)$/.test(tag)) cands.push('text=' + qs(text));
  // CSS path: unique by construction
  const path = [];
  for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
    const nid = n.getAttribute('id');
    if (nid && /^[A-Za-z][\\w-]*$/.test(nid) && !/\\d{4,}/.test(nid)) { path.unshift('#' + nid); break; }
    let i = 1;
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
    path.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
  }
  cands.push('css=' + path.join(' > '));
  return {
    candidates: cands,
    tag,
    type,
    text,
    value: 'value' in el && type !== 'password' ? String(el.value).slice(0, 200) : undefined,
    options: tag === 'select' ? Array.from(el.options).slice(0, 50).map((o) => clean(o.text)) : undefined,
    checked: type === 'checkbox' || type === 'radio' ? !!el.checked : undefined,
    isPassword: type === 'password',
  };
}`;

export class RecorderError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export class RecordingSession {
  readonly id = `REC-${crypto.randomBytes(8).toString('hex')}`;
  readonly createdAt = new Date();
  lastUsed = Date.now();
  steps: RecordedStep[] = [];
  private busy: Promise<unknown> = Promise.resolve();
  private browser?: Browser;
  private context?: BrowserContext;
  page?: Page;
  private salesforce?: SalesforceSessions;

  constructor(
    readonly projectId: string,
    readonly userId: string,
    readonly agent: { id: string; name: string; config: any },
    private secrets: Record<string, string>,
    private secretList: string[],
  ) {}

  async start(startPath?: string, persona?: string): Promise<void> {
    this.browser = await launchBrowser();
    this.context = await this.browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
    this.page = await this.context.newPage();
    const sf = salesforceSettings(this.agent.config);
    if (sf) this.salesforce = new SalesforceSessions(sf);
    // The first steps of the test: log in as the persona, open the start page
    if (persona) {
      await this.perform({ action: 'salesforce_login', target: persona });
      this.steps.push({ action: 'salesforce_login', target: persona });
    }
    const open = { action: 'navigate', target: startPath || '/' };
    await this.perform(open);
    this.steps.push(open);
  }

  private ctx(): StepContext {
    return {
      page: this.page!,
      baseUrl: this.agent.config.base_url,
      stepTimeout: Math.min(Number(this.agent.config.step_timeout) || 10000, 30000),
      config: this.agent.config,
      salesforce: this.salesforce,
    };
  }

  /** One action at a time per session. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => undefined);
    return next;
  }

  mask(text: string): string {
    return maskSecrets(text, this.secretList);
  }

  /** The element at a point of the screen, with its most robust unique selector. */
  inspect(x: number, y: number): Promise<ElementInfo> {
    return this.serial(async () => {
      this.lastUsed = Date.now();
      const page = this.page!;
      const raw: any = await page.evaluate(`(${INSPECT_SCRIPT})(${JSON.stringify({ x: Math.round(x), y: Math.round(y) })})`);
      if (!raw) throw new RecorderError('Nothing at that point of the page');
      const unique: string[] = [];
      for (const c of raw.candidates as string[]) {
        const n = await page.locator(c).count().catch(() => 0);
        if (n === 1) unique.push(c);
        if (unique.length >= 4) break;
      }
      const selector = unique[0] ?? raw.candidates[raw.candidates.length - 1];
      const fillable = raw.tag === 'textarea' || (raw.tag === 'input' && !['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'image'].includes(raw.type));
      const suggested: ElementInfo['suggested'] = raw.tag === 'select' ? 'select'
        : raw.type === 'checkbox' || raw.type === 'radio' ? (raw.checked ? 'uncheck' : 'check')
          : fillable ? 'fill' : 'click';
      return {
        selector,
        alternatives: unique.slice(1),
        tag: raw.tag,
        ...(raw.type ? { type: raw.type } : {}),
        text: this.mask(raw.text),
        ...(raw.value !== undefined ? { value: this.mask(raw.value) } : {}),
        ...(raw.options ? { options: raw.options } : {}),
        ...(raw.checked !== undefined ? { checked: raw.checked } : {}),
        suggested,
        isPassword: !!raw.isPassword,
      };
    });
  }

  /** Execute a step on the live page and record it. Values may use {{secrets.NAME}}: they are recorded as typed. */
  record(step: RecordedStep, opts: { record?: boolean } = {}): Promise<{ step: RecordedStep; message: string; index: number }> {
    return this.serial(async () => {
      this.lastUsed = Date.now();
      if (!(RECORDABLE as readonly string[]).includes(step.action)) throw new RecorderError(`Cannot record "${step.action}" (${RECORDABLE.join(', ')})`);
      const clean: RecordedStep = {
        action: step.action,
        ...(step.target ? { target: String(step.target).slice(0, 500) } : {}),
        ...(step.data && Object.keys(step.data).length ? { data: step.data } : {}),
      };
      const message = await this.perform(clean);
      if (opts.record === false) return { step: clean, message, index: -1 };
      this.steps.push(clean);
      return { step: clean, message, index: this.steps.length - 1 };
    });
  }

  private async perform(step: RecordedStep): Promise<string> {
    const resolve = (v: any): any => (typeof v === 'string' ? resolvePlaceholders(v, this.secrets)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)])) : v);
    try {
      const outcome = await executeStep({ stepId: this.steps.length + 1, action: step.action, target: step.target ? resolve(step.target) : undefined, data: resolve(step.data) }, this.ctx());
      return this.mask(outcome.message);
    } catch (e: any) {
      throw new RecorderError(this.mask(String(e?.message ?? e).split('\n')[0]), 422);
    }
  }

  /** Scroll the page (not recorded: steps scroll to their element by themselves). */
  scroll(dy: number): Promise<void> {
    return this.serial(async () => {
      this.lastUsed = Date.now();
      await this.page!.mouse.wheel(0, Math.max(Math.min(Number(dy) || 0, 5000), -5000));
      await this.page!.waitForTimeout(150);
    });
  }

  removeStep(index: number): RecordedStep {
    if (!Number.isInteger(index) || index < 0 || index >= this.steps.length) throw new RecorderError('No such step');
    return this.steps.splice(index, 1)[0];
  }

  screenshot(): Promise<Buffer> {
    return this.serial(async () => {
      this.lastUsed = Date.now();
      return this.page!.screenshot({ type: 'jpeg', quality: 70, timeout: 15000 });
    });
  }

  async state(): Promise<{ id: string; agentId: string; agentName: string; url: string; title: string; steps: RecordedStep[]; viewport: typeof VIEWPORT }> {
    const page = this.page!;
    return {
      id: this.id,
      agentId: this.agent.id,
      agentName: this.agent.name,
      url: this.mask(page.url()),
      title: this.mask(await page.title().catch(() => '')),
      steps: this.steps,
      viewport: VIEWPORT,
    };
  }

  /** Controls of the current page, to help write steps by hand. */
  outline(): Promise<string> {
    return this.serial(async () => this.mask(await outlinePage(this.page!, 120)));
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
  }
}

/** Open sessions; idle ones are closed. */
export class RecorderManager {
  private static instance?: RecorderManager;
  private sessions = new Map<string, RecordingSession>();
  private timer = setInterval(() => void this.sweep(), 60_000);

  static get(): RecorderManager {
    if (!RecorderManager.instance) RecorderManager.instance = new RecorderManager();
    return RecorderManager.instance;
  }

  private constructor() {
    this.timer.unref?.();
  }

  get max(): number {
    return Math.max(1, parseInt(process.env.RECORDER_MAX_SESSIONS || '', 10) || 4);
  }

  async open(session: RecordingSession, startPath?: string, persona?: string): Promise<RecordingSession> {
    await this.sweep();
    if (this.sessions.size >= this.max) throw new RecorderError(`All ${this.max} recording sessions are in use: close one, or raise RECORDER_MAX_SESSIONS`, 429);
    this.sessions.set(session.id, session);
    try {
      await session.start(startPath, persona);
    } catch (e) {
      this.sessions.delete(session.id);
      await session.close();
      throw e instanceof RecorderError ? e : new RecorderError(`Could not start recording: ${session.mask(String((e as Error).message ?? e))}`, 422);
    }
    return session;
  }

  /** The session, only for its own user and project. */
  find(id: string, projectId: string, userId: string): RecordingSession {
    const s = this.sessions.get(id);
    if (!s || s.projectId !== projectId || s.userId !== userId) throw new RecorderError('Recording session not found (it closes after 10 minutes without use)', 404);
    return s;
  }

  list(projectId: string, userId: string): RecordingSession[] {
    return [...this.sessions.values()].filter((s) => s.projectId === projectId && s.userId === userId);
  }

  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    await s?.close();
  }

  async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.lastUsed > IDLE_MS) await this.close(id);
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    for (const id of [...this.sessions.keys()]) await this.close(id);
  }
}
