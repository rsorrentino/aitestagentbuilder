/**
 * GitHub Copilot provider — three interchangeable transports.
 *
 *   COPILOT_MODE=api  (default) OpenAI-compatible Copilot chat API.
 *                     The GitHub token is exchanged for a short-lived Copilot
 *                     token (works with OAuth tokens from a Copilot-enabled
 *                     app, e.g. `gh auth token`); if the exchange is not
 *                     available the token is sent directly as a bearer token
 *                     (fine-grained PATs with the "Copilot Requests" permission).
 *                     COPILOT_BASE_URL can point at any OpenAI-compatible
 *                     endpoint, e.g. GitHub Models: https://models.github.ai/inference
 *   COPILOT_MODE=sdk  GitHub Copilot SDK (`@github/copilot-sdk`), which drives
 *                     the Copilot runtime over JSON-RPC.
 *   COPILOT_MODE=cli  GitHub Copilot CLI (`copilot -p ... -s`), non-interactive.
 *
 * In every mode the model gets no tools: Copilot is used purely as a text
 * model (extraction, generation, chat, self-healing), never as an agent that
 * can touch the host.
 */

import OpenAI from 'openai';
import { spawn } from 'child_process';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, delimiter } from 'path';
import type { LLMMessage, LLMResponse } from './client.js';
import '../config/env.js';
import logger from '../logger/index.js';

export type CopilotMode = 'api' | 'sdk' | 'cli';

export function getCopilotMode(): CopilotMode {
  const mode = (process.env.COPILOT_MODE || 'api').toLowerCase().trim();
  return mode === 'sdk' || mode === 'cli' ? mode : 'api';
}

/** Token lookup in the same precedence order the Copilot CLI uses. */
export function getCopilotGitHubToken(): string {
  return process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
}

export function getCopilotModel(): string {
  return process.env.COPILOT_MODEL || (getCopilotMode() === 'api' ? 'gpt-4o' : '');
}

function getCliCommand(): string {
  return process.env.COPILOT_CLI_PATH || 'copilot';
}

function isOnPath(command: string): boolean {
  if (command.includes('/') || command.includes('\\')) return existsSync(command);
  return (process.env.PATH || '').split(delimiter).some((dir) => dir && existsSync(join(dir, command)));
}

/**
 * Whether Copilot is usable in the selected mode. CLI and SDK modes can also
 * authenticate with a stored `copilot /login` or `gh auth login`, so they only
 * need to be selected explicitly.
 */
export function isCopilotConfigured(): boolean {
  switch (getCopilotMode()) {
    case 'api':
      return !!getCopilotGitHubToken();
    case 'cli':
      return isOnPath(getCliCommand());
    case 'sdk':
      return true;
  }
}

export function describeCopilotSetup(): string {
  switch (getCopilotMode()) {
    case 'api':
      return 'COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN';
    case 'cli':
      return `Copilot CLI (${getCliCommand()}) + copilot /login or a token`;
    case 'sdk':
      return '@github/copilot-sdk + copilot /login, gh auth, or a token';
  }
}

/** Collapse a chat transcript into a single prompt for the SDK/CLI transports. */
export function flattenForPrompt(messages: LLMMessage[]): { system: string; prompt: string } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  if (turns.length === 1) return { system, prompt: turns[0].content };
  const prompt = turns
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n') + '\n\nAssistant:';
  return { system, prompt };
}

export class CopilotClient {
  private mode: CopilotMode = getCopilotMode();
  private model = getCopilotModel();
  private timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS || '180000');

  // --- api mode state ---
  private apiToken?: { value: string; baseURL: string; expiresAt: number };

  getModel(): string {
    return this.model || 'default';
  }

  getMode(): CopilotMode {
    return this.mode;
  }

  async chat(messages: LLMMessage[], options?: { maxTokens?: number }): Promise<LLMResponse> {
    try {
      switch (this.mode) {
        case 'api':
          return await this.chatApi(messages, options);
        case 'sdk':
          return await this.chatSdk(messages);
        case 'cli':
          return await this.chatCli(messages);
      }
    } catch (error: any) {
      const authHint = /token|auth|login|401|403/i.test(error.message)
        ? ' — authenticate with COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN, `gh auth login`, or run `copilot` and use /login'
        : '';
      throw new Error(`GitHub Copilot (${this.mode}) error: ${error.message}${authHint}`);
    }
  }

  // ------------------------------------------------------------------
  // API transport
  // ------------------------------------------------------------------

  private async resolveApiToken(): Promise<{ value: string; baseURL: string }> {
    const githubToken = getCopilotGitHubToken();
    if (!githubToken) throw new Error('no GitHub token — set COPILOT_GITHUB_TOKEN, GH_TOKEN or GITHUB_TOKEN');

    // Custom OpenAI-compatible endpoint (e.g. GitHub Models): use the token as-is.
    if (process.env.COPILOT_BASE_URL) {
      return { value: githubToken, baseURL: process.env.COPILOT_BASE_URL };
    }

    if (this.apiToken && this.apiToken.expiresAt - 60_000 > Date.now()) {
      return this.apiToken;
    }

    const tokenUrl = process.env.COPILOT_TOKEN_URL || 'https://api.github.com/copilot_internal/v2/token';
    try {
      const res = await fetch(tokenUrl, {
        headers: {
          Authorization: `token ${githubToken}`,
          Accept: 'application/json',
          'User-Agent': 'ai-test-agent-builder',
        },
      });
      if (res.ok) {
        const body: any = await res.json();
        if (body?.token) {
          this.apiToken = {
            value: body.token,
            baseURL: body.endpoints?.api || 'https://api.githubcopilot.com',
            expiresAt: body.expires_at ? body.expires_at * 1000 : Date.now() + 20 * 60_000,
          };
          return this.apiToken;
        }
      }
      logger.debug('Copilot token exchange unavailable, using GitHub token directly', { status: res.status });
    } catch (error: any) {
      logger.debug('Copilot token exchange failed, using GitHub token directly', { error: error.message });
    }

    // Fine-grained PATs with the "Copilot Requests" permission are accepted directly.
    this.apiToken = {
      value: githubToken,
      baseURL: 'https://api.githubcopilot.com',
      expiresAt: Date.now() + 60 * 60_000,
    };
    return this.apiToken;
  }

  private async chatApi(messages: LLMMessage[], options?: { maxTokens?: number }): Promise<LLMResponse> {
    const { value, baseURL } = await this.resolveApiToken();
    const client = new OpenAI({
      apiKey: value,
      baseURL,
      timeout: this.timeoutMs,
      defaultHeaders: {
        'Copilot-Integration-Id': process.env.COPILOT_INTEGRATION_ID || 'vscode-chat',
        'Editor-Version': 'ai-test-agent-builder/1.0.0',
        'Editor-Plugin-Version': 'ai-test-agent-builder/1.0.0',
        'User-Agent': 'ai-test-agent-builder',
      },
    });

    try {
      const response = await client.chat.completions.create({
        model: this.model || 'gpt-4o',
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: Math.min(options?.maxTokens ?? 16000, 16000),
        temperature: 0.2,
      });
      const content = response.choices[0]?.message?.content || '';
      return {
        content,
        usage: response.usage ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        } : undefined,
      };
    } catch (error: any) {
      if (error?.status === 401 || error?.status === 403) {
        this.apiToken = undefined; // force a fresh exchange next time
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------
  // SDK transport
  // ------------------------------------------------------------------

  private static sdkClient?: Promise<any>;

  private static async getSdkClient(): Promise<any> {
    if (!CopilotClient.sdkClient) {
      CopilotClient.sdkClient = (async () => {
        let sdk: any;
        try {
          sdk = await import('@github/copilot-sdk');
        } catch (error: any) {
          throw new Error(`@github/copilot-sdk is not installed (npm install @github/copilot-sdk): ${error.message}`);
        }
        const token = getCopilotGitHubToken();
        const client = new sdk.CopilotClient({
          ...(token ? { gitHubToken: token } : {}),
          logLevel: 'error',
        });
        await client.start();
        return client;
      })();
      CopilotClient.sdkClient.catch(() => { CopilotClient.sdkClient = undefined; });
    }
    return CopilotClient.sdkClient;
  }

  /** Stop the shared SDK runtime (called on shutdown). */
  static async shutdown(): Promise<void> {
    if (!CopilotClient.sdkClient) return;
    try {
      const client = await CopilotClient.sdkClient;
      await client.stop();
    } catch {
      // ignore
    } finally {
      CopilotClient.sdkClient = undefined;
    }
  }

  private async chatSdk(messages: LLMMessage[]): Promise<LLMResponse> {
    const client = await CopilotClient.getSdkClient();
    const { system, prompt } = flattenForPrompt(messages);

    const session = await client.createSession({
      ...(this.model ? { model: this.model } : {}),
      ...(system ? { systemMessage: { mode: 'replace', content: system } } : {}),
      availableTools: [],
      workingDirectory: mkdtempSync(join(tmpdir(), 'copilot-sdk-')),
      onPermissionRequest: () => ({ kind: 'reject', feedback: 'Tools are disabled for this integration.' }),
    });

    try {
      const response = await session.sendAndWait({ prompt }, this.timeoutMs);
      const content = response?.data?.content;
      if (typeof content !== 'string') {
        throw new Error('no assistant message returned');
      }
      return { content };
    } finally {
      await session.disconnect().catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------
  // CLI transport
  // ------------------------------------------------------------------

  private chatCli(messages: LLMMessage[]): Promise<LLMResponse> {
    const { system, prompt } = flattenForPrompt(messages);
    const fullPrompt = system ? `${system}\n\n---\n\n${prompt}` : prompt;
    if (Buffer.byteLength(fullPrompt) > 120_000) {
      return Promise.reject(new Error(
        'prompt is too large for the Copilot CLI command line (max ~120 KB); use COPILOT_MODE=api or sdk for large documents',
      ));
    }

    const args = [
      '-p', fullPrompt,
      '-s',
      '--no-ask-user',
      '--no-custom-instructions',
      '--no-auto-update',
      '--no-color',
      '--available-tools',
    ];
    if (this.model) args.push('--model', this.model);

    return new Promise((resolve, reject) => {
      const child = spawn(getCliCommand(), args, {
        // Run in an empty directory so the CLI never reads project files.
        cwd: mkdtempSync(join(tmpdir(), 'copilot-cli-')),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`timed out after ${this.timeoutMs / 1000}s`));
      }, this.timeoutMs);

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (error: any) => {
        clearTimeout(timer);
        reject(new Error(error.code === 'ENOENT'
          ? `Copilot CLI not found (${getCliCommand()}). Install it with: npm install -g @github/copilot`
          : error.message));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ content: stdout.trim() });
        } else {
          const detail = (stderr || stdout).trim().split('\n').slice(0, 4).join(' ');
          reject(new Error(`copilot exited with code ${code}: ${detail}`));
        }
      });
    });
  }
}
