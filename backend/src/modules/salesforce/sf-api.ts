/**
 * Minimal Salesforce REST client used for identity checks and permission
 * assertions, acting with a persona's access token (or UI session id).
 */

export interface SfIdentity {
  userId: string;
  organizationId?: string;
  username?: string;
  name?: string;
  profile?: string;
  permissionSets: string[];
}

export interface ObjectAccess { read: boolean; create: boolean; edit: boolean; delete: boolean; exists: boolean }
export interface FieldAccess { read: boolean; edit: boolean }
export interface RecordAccess { read: boolean; edit: boolean; delete: boolean }

const soqlString = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export class SalesforceApi {
  constructor(public instanceUrl: string, private accessToken: string, private apiVersion = 'v62.0') {
    this.instanceUrl = instanceUrl.replace(/\/+$/, '');
    if (!/^v\d+\.\d$/.test(this.apiVersion)) this.apiVersion = 'v62.0';
  }

  private async request(path: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${this.instanceUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  async get(path: string): Promise<any> {
    const { status, body } = await this.request(path);
    if (status >= 400) {
      const msg = Array.isArray(body) ? body.map((e: any) => e.message).join('; ') : body?.message ?? body?.error_description ?? '';
      throw Object.assign(new Error(`Salesforce API ${status}${msg ? `: ${msg}` : ''} (${path.split('?')[0]})`), { status });
    }
    return body;
  }

  async query<T = any>(soql: string): Promise<T[]> {
    const body = await this.get(`/services/data/${this.apiVersion}/query?q=${encodeURIComponent(soql)}`);
    return body.records ?? [];
  }

  async identity(): Promise<SfIdentity> {
    const info = await this.get('/services/oauth2/userinfo');
    const userId = String(info.user_id);
    const [user] = await this.query<any>(`SELECT Username, Name, Profile.Name FROM User WHERE Id = ${soqlString(userId)}`);
    const sets = await this.query<any>(
      `SELECT PermissionSet.Name FROM PermissionSetAssignment WHERE AssigneeId = ${soqlString(userId)} AND PermissionSet.IsOwnedByProfile = false`,
    ).catch(() => []);
    return {
      userId,
      organizationId: info.organization_id,
      username: user?.Username ?? info.preferred_username,
      name: user?.Name ?? info.name,
      profile: user?.Profile?.Name,
      permissionSets: sets.map((s: any) => s.PermissionSet?.Name).filter(Boolean),
    };
  }

  async userIdByUsername(username: string): Promise<string> {
    const [user] = await this.query<any>(`SELECT Id FROM User WHERE Username = ${soqlString(username)} AND IsActive = true`);
    if (!user) throw new Error(`No active Salesforce user with username ${username}`);
    return user.Id;
  }

  async organizationId(): Promise<string> {
    const info = await this.get('/services/oauth2/userinfo');
    return info.organization_id;
  }

  /** Object-level (CRUD) access of the current user. */
  async objectAccess(objectName: string): Promise<ObjectAccess> {
    try {
      const d = await this.get(`/services/data/${this.apiVersion}/sobjects/${encodeURIComponent(objectName)}/describe`);
      return { exists: true, read: !!d.queryable, create: !!d.createable, edit: !!d.updateable, delete: !!d.deletable };
    } catch (error: any) {
      if (error.status === 404 || error.status === 403) return { exists: false, read: false, create: false, edit: false, delete: false };
      throw error;
    }
  }

  /** Field-level security of the current user ("Object.Field"). */
  async fieldAccess(objectName: string, fieldName: string): Promise<FieldAccess> {
    let d: any;
    try {
      d = await this.get(`/services/data/${this.apiVersion}/sobjects/${encodeURIComponent(objectName)}/describe`);
    } catch (error: any) {
      if (error.status === 404 || error.status === 403) return { read: false, edit: false };
      throw error;
    }
    const field = (d.fields ?? []).find((f: any) => String(f.name).toLowerCase() === fieldName.toLowerCase());
    return { read: !!field, edit: !!field?.updateable };
  }

  /** Record-level access of a user (sharing) via UserRecordAccess. */
  async recordAccess(userId: string, recordId: string): Promise<RecordAccess> {
    const [row] = await this.query<any>(
      `SELECT RecordId, HasReadAccess, HasEditAccess, HasDeleteAccess FROM UserRecordAccess WHERE UserId = ${soqlString(userId)} AND RecordId = ${soqlString(recordId)}`,
    );
    return { read: !!row?.HasReadAccess, edit: !!row?.HasEditAccess, delete: !!row?.HasDeleteAccess };
  }
}

/** Admin-side checks for another user (needs "View Setup and Configuration"). */
export class SalesforceAdminChecks {
  constructor(private api: SalesforceApi) {}

  private assignmentFilter(userId: string): string {
    return `ParentId IN (SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = ${soqlString(userId)})`;
  }

  async identityOf(userId: string): Promise<SfIdentity> {
    const [user] = await this.api.query<any>(`SELECT Id, Username, Name, Profile.Name FROM User WHERE Id = ${soqlString(userId)}`);
    if (!user) throw new Error(`Salesforce user ${userId} not found`);
    const sets = await this.api.query<any>(
      `SELECT PermissionSet.Name FROM PermissionSetAssignment WHERE AssigneeId = ${soqlString(userId)} AND PermissionSet.IsOwnedByProfile = false`,
    );
    return { userId, username: user.Username, name: user.Name, profile: user.Profile?.Name, permissionSets: sets.map((s: any) => s.PermissionSet?.Name).filter(Boolean) };
  }

  /** Effective object permissions = OR over the profile's and all assigned permission sets. */
  async objectAccess(userId: string, objectName: string): Promise<ObjectAccess> {
    const rows = await this.api.query<any>(
      `SELECT PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete FROM ObjectPermissions WHERE SobjectType = ${soqlString(objectName)} AND ${this.assignmentFilter(userId)}`,
    );
    const any = (k: string) => rows.some((r) => r[k] === true);
    return { exists: true, read: any('PermissionsRead'), create: any('PermissionsCreate'), edit: any('PermissionsEdit'), delete: any('PermissionsDelete') };
  }

  async fieldAccess(userId: string, objectName: string, fieldName: string): Promise<FieldAccess> {
    const rows = await this.api.query<any>(
      `SELECT PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE SobjectType = ${soqlString(objectName)} AND Field = ${soqlString(`${objectName}.${fieldName}`)} AND ${this.assignmentFilter(userId)}`,
    );
    return { read: rows.some((r) => r.PermissionsRead === true), edit: rows.some((r) => r.PermissionsEdit === true) };
  }

  recordAccess(userId: string, recordId: string): Promise<RecordAccess> {
    return this.api.recordAccess(userId, recordId);
  }
}
