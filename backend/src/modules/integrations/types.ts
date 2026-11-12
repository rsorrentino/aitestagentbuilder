/**
 * Integrations with issue trackers and code hosts (Jira, GitHub, GitLab,
 * Azure DevOps). One project can have several; each has a type, an encrypted
 * config, and what it is used for:
 *
 *   defects:      file bugs for new failures (deduplicated by failure signature), comment
 *                 when they fail again, resolve when they pass again
 *   requirements: test cases linked to stories / issues; their latest results are shown on
 *                 the issue; stories can be imported and turned into tests by the AI
 */

export const INTEGRATION_TYPES = ['jira', 'github', 'gitlab', 'azure_devops'] as const;
export type IntegrationType = typeof INTEGRATION_TYPES[number];

/** Config keys holding secrets, per type (encrypted at rest, never returned). */
export const INTEGRATION_SECRETS: Record<IntegrationType, string[]> = {
  jira: ['api_token'],
  github: ['token', 'webhook_secret'],
  gitlab: ['token', 'webhook_secret'],
  azure_devops: ['pat', 'webhook_secret'],
};

export interface DefectPolicy {
  enabled: boolean;
  /** Triage categories that get a bug */
  categories: string[];
  /** Only runs nobody watches (schedules, CI, API) file bugs */
  onlyUnattended: boolean;
  /** Agents whose failures are filed (empty = all of the project) */
  agents: string[];
  /** Workflow transition used when the failure is fixed (e.g. "Done"); empty = comment only */
  resolveTransition?: string;
  labels: string[];
}

export interface Integration {
  id: string;
  projectId: string;
  type: IntegrationType;
  name: string;
  config: Record<string, any>;
  enabled: boolean;
  createdAt: Date;
  createdBy?: string;
}

export interface TrackerIssue {
  key: string;
  url: string;
  title: string;
  status?: string;
  type?: string;
  description?: string;
  /** Closed / done */
  resolved?: boolean;
}

export interface NewIssue {
  title: string;
  /** Plain text with blank-line separated paragraphs; URLs become links where the tracker supports it */
  body: string;
  labels: string[];
  /** Bug / Task / … (Jira, Azure DevOps) */
  issueType?: string;
}

export interface RunLink {
  /** Stable id: the same link is updated, not duplicated */
  id: string;
  url: string;
  title: string;
  passed: boolean | null;
}

/** What every issue tracker adapter offers. */
export interface IssueTracker {
  check(): Promise<{ ok: true; account: string; details?: string }>;
  search(query: string, limit?: number): Promise<TrackerIssue[]>;
  get(key: string): Promise<TrackerIssue>;
  create(issue: NewIssue): Promise<TrackerIssue>;
  comment(key: string, body: string): Promise<void>;
  /** Move to a resolved state (or close); returns false when the transition is not available */
  resolve(key: string, transition?: string): Promise<boolean>;
  /** Show (or update) a link to a test result on the issue */
  link(key: string, link: RunLink): Promise<void>;
  /** Attach a file (screenshot); trackers without attachments ignore it */
  attach(key: string, file: { name: string; data: Buffer; contentType: string }): Promise<void>;
}

export class IntegrationError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

export function defectPolicy(config: any): DefectPolicy {
  const d = config?.defects ?? {};
  const list = (v: any) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  return {
    enabled: d.enabled === true,
    categories: list(d.categories).length ? list(d.categories) : ['app_bug'],
    onlyUnattended: d.only_unattended !== false,
    agents: list(d.agents),
    ...(typeof d.resolve_transition === 'string' && d.resolve_transition.trim() ? { resolveTransition: d.resolve_transition.trim() } : {}),
    labels: list(d.labels).length ? list(d.labels) : ['atab'],
  };
}
