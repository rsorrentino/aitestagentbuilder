/**
 * The adapters for an integration type: an issue tracker (Jira, GitHub, …) and,
 * for code hosts, commit statuses and pull request comments.
 */

import { AzureDevOpsClient } from './azure-devops.js';
import { GitHubClient } from './github.js';
import { GitLabClient } from './gitlab.js';
import { JiraClient } from './jira.js';
import { CodeHost, Integration, IntegrationError, IssueTracker } from './types.js';

const factories: Partial<Record<Integration['type'], (config: Record<string, any>) => IssueTracker>> = {
  jira: (c) => new JiraClient(c as any),
  github: (c) => new GitHubClient(c as any),
  gitlab: (c) => new GitLabClient(c as any),
  azure_devops: (c) => new AzureDevOpsClient(c as any),
};

const hosts: Partial<Record<Integration['type'], (config: Record<string, any>) => CodeHost | null>> = {
  github: (c) => new GitHubClient(c as any),
  gitlab: (c) => new GitLabClient(c as any),
  // Azure DevOps reports to commits only when a repository is configured (work items need none)
  azure_devops: (c) => (c.repository ? new AzureDevOpsClient(c as any) : null),
};

export function registerCodeHost(type: Integration['type'], factory: (config: Record<string, any>) => CodeHost | null): void {
  hosts[type] = factory;
}

/** Code host of an integration (commit statuses, pull request comments), or null for trackers like Jira. */
export function codeHostFor(integration: Pick<Integration, 'type' | 'config'>): CodeHost | null {
  const f = hosts[integration.type];
  return f ? f(integration.config) : null;
}

export function registerTracker(type: Integration['type'], factory: (config: Record<string, any>) => IssueTracker): void {
  factories[type] = factory;
}

/** Issue tracker of an integration (its config must be decrypted). */
export function trackerFor(integration: Pick<Integration, 'type' | 'config'>): IssueTracker {
  const f = factories[integration.type];
  if (!f) throw new IntegrationError(`${integration.type} does not support issues yet`, 400);
  return f(integration.config);
}
