/**
 * The adapter for an integration type. GitHub, GitLab and Azure DevOps adapters
 * register here as they are added.
 */

import { JiraClient } from './jira.js';
import { Integration, IntegrationError, IssueTracker } from './types.js';

const factories: Partial<Record<Integration['type'], (config: Record<string, any>) => IssueTracker>> = {
  jira: (c) => new JiraClient(c as any),
};

export function registerTracker(type: Integration['type'], factory: (config: Record<string, any>) => IssueTracker): void {
  factories[type] = factory;
}

/** Issue tracker of an integration (its config must be decrypted). */
export function trackerFor(integration: Pick<Integration, 'type' | 'config'>): IssueTracker {
  const f = factories[integration.type];
  if (!f) throw new IntegrationError(`${integration.type} does not support issues yet`, 400);
  return f(integration.config);
}
