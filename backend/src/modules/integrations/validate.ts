/**
 * Validation of integration configs (plain, before encryption).
 */

import { REDACTED } from '../../infra/security/secrets.js';
import { IntegrationType } from './types.js';
import { validateTriggers } from './triggers.js';

const httpUrl = (v: any) => {
  try {
    return /^https?:$/.test(new URL(String(v)).protocol);
  } catch {
    return false;
  }
};

export function validateIntegration(type: IntegrationType, config: any, partial: boolean): string[] {
  const errors: string[] = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['config must be an object'];
  const secret = (k: string) => typeof config[k] === 'string' && config[k] !== '' && (partial || config[k] !== REDACTED);
  switch (type) {
    case 'jira':
      if (!httpUrl(config.base_url)) errors.push('config.base_url must be the Jira URL, e.g. https://acme.atlassian.net');
      if (config.deployment !== undefined && !['cloud', 'server'].includes(config.deployment)) errors.push('config.deployment must be cloud or server');
      if ((config.deployment ?? (/\.atlassian\.net/i.test(String(config.base_url)) ? 'cloud' : 'server')) === 'cloud' && !config.email) {
        errors.push('config.email is required for Jira Cloud (the account the API token belongs to)');
      }
      if (!secret('api_token')) errors.push('config.api_token is required (Jira Cloud API token, or a Data Center personal access token)');
      if (config.project_key !== undefined && config.project_key !== '' && !/^[A-Z][A-Z0-9_]{0,19}$/.test(String(config.project_key))) errors.push('config.project_key must be a Jira project key such as SHOP');
      if (config.defects?.enabled === true && !config.project_key) errors.push('config.project_key is required to file bugs (config.defects.enabled)');
      break;
    case 'github':
      if (!/^[\w.-]+\/[\w.-]+$/.test(String(config.repository ?? ''))) errors.push('config.repository must be owner/name');
      if (!secret('token')) errors.push('config.token is required (a fine-grained personal access token or GitHub App token)');
      if (config.api_url !== undefined && config.api_url !== '' && !httpUrl(config.api_url)) errors.push('config.api_url must be a URL (GitHub Enterprise Server: https://github.example.com/api/v3)');
      break;
    case 'gitlab':
      if (!String(config.project ?? '').trim()) errors.push('config.project must be the project path (group/name) or numeric id');
      if (!secret('token')) errors.push('config.token is required (a project or personal access token)');
      if (config.base_url !== undefined && config.base_url !== '' && !httpUrl(config.base_url)) errors.push('config.base_url must be a URL (self-managed GitLab)');
      break;
    case 'azure_devops':
      if (!httpUrl(config.organization_url)) errors.push('config.organization_url must be https://dev.azure.com/<organization>');
      if (!String(config.project ?? '').trim()) errors.push('config.project is required');
      if (!secret('pat')) errors.push('config.pat is required (personal access token)');
      if (Array.isArray(config.triggers) && config.triggers.length && !String(config.repository ?? '').trim()) errors.push('config.repository (the Azure Repos repository) is required for triggers');
      if (Array.isArray(config.triggers) && config.triggers.some((t: any) => t?.event === 'deployment_status')) errors.push('config.triggers: Azure DevOps supports push and pull_request triggers (start deployment tests from the release pipeline)');
      break;
  }
  if (type !== 'jira') errors.push(...validateTriggers(config.triggers));
  if (type !== 'jira' && config.webhook_secret !== undefined && config.webhook_secret !== '' && config.webhook_secret !== REDACTED && String(config.webhook_secret).length < 16) {
    errors.push('config.webhook_secret must be at least 16 characters');
  }
  for (const k of ['commit_status', 'pr_comment']) if (config[k] !== undefined && typeof config[k] !== 'boolean') errors.push(`config.${k} must be true or false`);
  const d = config.defects;
  if (d !== undefined) {
    if (typeof d !== 'object' || Array.isArray(d)) errors.push('config.defects must be an object');
    else {
      if (d.categories !== undefined && (!Array.isArray(d.categories) || d.categories.some((c: any) => !['app_bug', 'test_bug', 'environment', 'unknown'].includes(c)))) {
        errors.push('config.defects.categories must list app_bug, test_bug, environment or unknown');
      }
      if (d.agents !== undefined && !Array.isArray(d.agents)) errors.push('config.defects.agents must be a list of agent ids');
    }
  }
  return errors;
}
