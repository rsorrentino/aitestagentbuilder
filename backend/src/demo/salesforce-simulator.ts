/**
 * A small Salesforce look-alike served at /demo/salesforce, for trying and
 * testing persona logins and permission tests without a real org.
 *
 * It mimics what the test agent relies on — not Salesforce itself:
 *   UI login (#username, #password, #Login, #error), the authenticator-app
 *   verification page (#tc, #save), /secur/frontdoor.jsp, /secur/logout.jsp,
 *   /servlet/servlet.su ("Log in as"), OAuth token endpoint (JWT bearer and
 *   password grants), /services/oauth2/singleaccess, /services/oauth2/userinfo,
 *   a handful of SOQL queries, sObject describe, and simple Lightning-like
 *   pages that honour object, field and record permissions.
 *
 * Users (password / TOTP secret):
 *   admin@acme.sim   Admin-Pass-1!   KRSXG5CTMVRXEZLU  System Administrator — UI login requires a
 *                                                      phishing-resistant method, so use JWT or Login-As
 *   rep@acme.sim     Rep-Pass-1!     JBSWY3DPEHPK3PXP  Standard User + Sales_Ops permission set (TOTP MFA)
 *   viewer@acme.sim  Viewer-Pass-1!  —                 Read Only (no MFA)
 * Connected app: GET /demo/salesforce/_sim/connected-app (consumer key, secret and private key).
 */

import crypto from 'crypto';
import { Request, Response, Router } from 'express';
import jwt from 'jsonwebtoken';
import { verifyTotp } from '../modules/salesforce/totp.js';

const ORG_ID = '00DSIM000000001AAA';

interface SimUser {
  id: string; username: string; password: string; securityToken: string; name: string;
  profile: string; permsets: string[]; totp?: string; phishingResistantOnly?: boolean; admin?: boolean;
}

export const SIM_USERS: SimUser[] = [
  { id: '005SIM0000000ADM', username: 'admin@acme.sim', password: 'Admin-Pass-1!', securityToken: 'ADMTOKEN', name: 'Ada Admin', profile: 'System Administrator', permsets: [], totp: 'KRSXG5CTMVRXEZLU', phishingResistantOnly: true, admin: true },
  { id: '005SIM0000000REP', username: 'rep@acme.sim', password: 'Rep-Pass-1!', securityToken: 'REPTOKEN', name: 'Sam Sales', profile: 'Standard User', permsets: ['Sales_Ops'], totp: 'JBSWY3DPEHPK3PXP' },
  { id: '005SIM0000000VWR', username: 'viewer@acme.sim', password: 'Viewer-Pass-1!', securityToken: 'VWRTOKEN', name: 'Val Viewer', profile: 'Read Only', permsets: [] },
];

type Crud = { read?: boolean; create?: boolean; edit?: boolean; delete?: boolean };
type Fls = Record<string, { read: boolean; edit: boolean }>;
interface PermSet { objects: Record<string, Crud>; fields: Fls; ownedByProfile: boolean }

const ALL: Crud = { read: true, create: true, edit: true, delete: true };
const PERMISSION_SETS: Record<string, PermSet> = {
  'System Administrator': {
    ownedByProfile: true,
    objects: { Account: ALL, Opportunity: ALL, Employee__c: ALL },
    fields: { 'Account.AnnualRevenue': { read: true, edit: true }, 'Opportunity.Amount': { read: true, edit: true }, 'Employee__c.Salary__c': { read: true, edit: true } },
  },
  'Standard User': {
    ownedByProfile: true,
    objects: { Account: { read: true, create: true, edit: true }, Opportunity: { read: true } },
    fields: { 'Account.AnnualRevenue': { read: true, edit: false }, 'Opportunity.Amount': { read: true, edit: false } },
  },
  'Read Only': {
    ownedByProfile: true,
    objects: { Account: { read: true }, Opportunity: { read: true } },
    fields: { 'Opportunity.Amount': { read: true, edit: false } },
  },
  Sales_Ops: {
    ownedByProfile: false,
    objects: { Opportunity: { read: true, create: true, edit: true } },
    fields: { 'Opportunity.Amount': { read: true, edit: true } },
  },
};

const OBJECTS: Record<string, { label: string; plural: string; sharing: 'public_read' | 'private'; fields: string[] }> = {
  Account: { label: 'Account', plural: 'Accounts', sharing: 'public_read', fields: ['Name', 'Industry', 'AnnualRevenue'] },
  Opportunity: { label: 'Opportunity', plural: 'Opportunities', sharing: 'private', fields: ['Name', 'StageName', 'Amount'] },
  Employee__c: { label: 'Employee', plural: 'Employees', sharing: 'private', fields: ['Name', 'Salary__c'] },
};

const RECORDS: Array<{ id: string; type: string; ownerId: string; values: Record<string, string> }> = [
  { id: '001SIM000000001AAA', type: 'Account', ownerId: '005SIM0000000REP', values: { Name: 'Acme Corp', Industry: 'Manufacturing', AnnualRevenue: '5,000,000' } },
  { id: '001SIM000000002AAA', type: 'Account', ownerId: '005SIM0000000ADM', values: { Name: 'Globex', Industry: 'Energy', AnnualRevenue: '12,000,000' } },
  { id: '006SIM000000001AAA', type: 'Opportunity', ownerId: '005SIM0000000REP', values: { Name: 'Acme renewal', StageName: 'Negotiation', Amount: '120,000' } },
  { id: '006SIM000000002AAA', type: 'Opportunity', ownerId: '005SIM0000000ADM', values: { Name: 'Globex expansion', StageName: 'Prospecting', Amount: '450,000' } },
  { id: 'a00SIM000000001AAA', type: 'Employee__c', ownerId: '005SIM0000000ADM', values: { Name: 'Jane Doe', Salary__c: '98,000' } },
];

// Connected app with a key pair generated at start-up (simulator only).
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
export const SIM_CONNECTED_APP = {
  client_id: 'SIM_CONNECTED_APP_CONSUMER_KEY',
  client_secret: 'SIM_CONNECTED_APP_SECRET',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

interface Session { userId: string; impersonatedBy?: string; expires: number }
const sessions = new Map<string, Session>();
const otps = new Map<string, { sid: string; expires: number }>();
const challenges = new Map<string, { userId: string; startUrl?: string; expires: number }>();

const newId = () => crypto.randomBytes(18).toString('base64url');
const userById = (id: string) => SIM_USERS.find((u) => u.id === id);
const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function createSession(userId: string, impersonatedBy?: string): string {
  const sid = `${ORG_ID}!${newId()}`;
  sessions.set(sid, { userId, impersonatedBy, expires: Date.now() + 2 * 3600_000 });
  return sid;
}

function sessionUser(sid?: string): { user: SimUser; session: Session } | null {
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session || session.expires < Date.now()) return null;
  const user = userById(session.userId);
  return user ? { user, session } : null;
}

// ------------------------------------------------------------------ permissions

function userPermSets(user: SimUser): string[] {
  return [user.profile, ...user.permsets];
}

export function simObjectAccess(user: SimUser, object: string): Required<Crud> {
  const out = { read: false, create: false, edit: false, delete: false };
  for (const name of userPermSets(user)) {
    const crud = PERMISSION_SETS[name]?.objects[object];
    if (!crud) continue;
    for (const k of Object.keys(out) as Array<keyof Crud>) out[k] = out[k] || !!crud[k];
  }
  return out;
}

function fieldAccess(user: SimUser, object: string, field: string): { read: boolean; edit: boolean } {
  if (field === 'Name') {
    const o = simObjectAccess(user, object);
    return { read: o.read, edit: o.edit };
  }
  const out = { read: false, edit: false };
  for (const name of userPermSets(user)) {
    const f = PERMISSION_SETS[name]?.fields[`${object}.${field}`];
    if (f) { out.read ||= f.read; out.edit ||= f.edit; }
  }
  return out;
}

function recordAccess(user: SimUser, recordId: string): { read: boolean; edit: boolean; delete: boolean } {
  const rec = RECORDS.find((r) => r.id === recordId);
  if (!rec) return { read: false, edit: false, delete: false };
  const o = simObjectAccess(user, rec.type);
  if (user.admin) return { read: o.read, edit: o.edit, delete: o.delete };
  const owner = rec.ownerId === user.id;
  const read = o.read && (owner || OBJECTS[rec.type].sharing === 'public_read');
  return { read, edit: o.edit && owner, delete: o.delete && owner };
}

// ------------------------------------------------------------------ pages

function page(base: string, title: string, body: string, who?: { user: SimUser; session: Session }): string {
  const impersonator = who?.session.impersonatedBy ? userById(who.session.impersonatedBy) : undefined;
  const header = who ? `
    ${impersonator ? `<div class="slds-notify" role="status" id="login-as-banner">Logged in as ${esc(who.user.name)} (${esc(who.user.username)}) by ${esc(impersonator.name)}. <a href="${base}/secur/logout.jsp">Log out as ${esc(who.user.name)}</a></div>` : ''}
    <header class="slds-global-header"><strong>Acme (Salesforce simulator)</strong>
      <nav aria-label="App navigation">
        <a href="${base}/lightning/page/home">Home</a>
        <a href="${base}/lightning/o/Account/list">Accounts</a>
        <a href="${base}/lightning/o/Opportunity/list">Opportunities</a>
        ${simObjectAccess(who.user, 'Employee__c').read ? `<a href="${base}/lightning/o/Employee__c/list">Employees</a>` : ''}
        ${who.user.admin && !impersonator ? `<a href="${base}/lightning/setup/SetupOneHome/home">Setup</a>` : ''}
      </nav>
      <span class="user-name" data-testid="current-user">${esc(who.user.name)}</span>
      <a href="${base}/secur/logout.jsp" id="logout">Log Out</a>
    </header>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} | Salesforce</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font-family:system-ui,sans-serif;margin:0;color:#181818;background:#f3f3f3}
 header{display:flex;gap:16px;align-items:center;background:#fff;padding:10px 16px;border-bottom:1px solid #ddd;flex-wrap:wrap}
 nav a{margin-right:12px}main{max-width:760px;margin:24px auto;background:#fff;padding:20px;border-radius:6px}
 label{display:block;margin-top:12px;font-weight:600}input{width:100%;padding:8px;margin-top:4px;box-sizing:border-box}
 .btn,button,input[type=submit]{margin-top:16px;padding:8px 16px;background:#0176d3;color:#fff;border:0;border-radius:4px;cursor:pointer;width:auto}
 .loginError{color:#c23934;margin-top:12px}.slds-notify{background:#fe9339;padding:8px 16px}
 table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:6px;text-align:left}
</style></head><body>${header}<main>${body}</main></body></html>`;
}

const denied = (base: string, who: { user: SimUser; session: Session }) => page(base, 'Insufficient Privileges', `
  <h1>Insufficient Privileges</h1>
  <p id="insufficient-privileges">You don't have access to this record. Ask your administrator for help or to request access.</p>`, who);

function loginPage(base: string, error?: string, startUrl?: string): string {
  return page(base, 'Login', `
    <h1>Log In</h1>
    <form id="login_form" method="post" action="${base}/">
      <input type="hidden" name="startURL" value="${esc(startUrl ?? '')}">
      <label for="username">Username</label><input id="username" name="username" type="email" autocomplete="username">
      <label for="password">Password</label><input id="password" name="pw" type="password" autocomplete="current-password">
      <input id="Login" class="btn" type="submit" value="Log In">
      ${error ? `<div id="error" class="loginError" role="alert">${esc(error)}</div>` : ''}
    </form>`);
}

function safeStart(startUrl: unknown): string {
  const s = String(startUrl ?? '');
  return s.startsWith('/') && !s.startsWith('//') ? s : '/lightning/page/home';
}

// ------------------------------------------------------------------ SOQL

function runSoql(q: string, caller: SimUser): any[] {
  const s = q.replace(/\s+/g, ' ').trim();
  const lit = (re: RegExp) => s.match(re)?.[1];
  const viewSetup = !!caller.admin;
  const insufficient = () => { throw Object.assign(new Error('INSUFFICIENT_ACCESS: View Setup and Configuration is required'), { status: 400 }); };

  if (/ FROM User WHERE /i.test(s)) {
    const id = lit(/WHERE Id = '([^']+)'/i);
    const username = lit(/WHERE Username = '([^']+)'/i);
    const u = SIM_USERS.find((x) => (id && x.id === id) || (username && x.username === username));
    return u ? [{ Id: u.id, Username: u.username, Name: u.name, Profile: { Name: u.profile } }] : [];
  }
  if (/FROM ObjectPermissions/i.test(s) || /FROM FieldPermissions/i.test(s)) {
    if (!viewSetup) insufficient();
    const user = userById(lit(/AssigneeId = '([^']+)'/i) ?? '');
    const object = lit(/SobjectType = '([^']+)'/i) ?? '';
    if (!user) return [];
    if (/FROM ObjectPermissions/i.test(s)) {
      return userPermSets(user).map((n) => PERMISSION_SETS[n]?.objects[object]).filter(Boolean).map((c) => ({
        PermissionsRead: !!c!.read, PermissionsCreate: !!c!.create, PermissionsEdit: !!c!.edit, PermissionsDelete: !!c!.delete,
      }));
    }
    const field = lit(/Field = '([^']+)'/i) ?? '';
    return userPermSets(user).map((n) => PERMISSION_SETS[n]?.fields[field]).filter(Boolean).map((f) => ({ PermissionsRead: f!.read, PermissionsEdit: f!.edit }));
  }
  if (/FROM PermissionSetAssignment/i.test(s)) {
    const user = userById(lit(/AssigneeId = '([^']+)'/i) ?? '');
    if (!user) return [];
    if (user.id !== caller.id && !viewSetup) insufficient();
    return user.permsets.map((n) => ({ PermissionSet: { Name: n } }));
  }
  if (/FROM UserRecordAccess/i.test(s)) {
    const user = userById(lit(/UserId = '([^']+)'/i) ?? '');
    const recordId = lit(/RecordId = '([^']+)'/i) ?? '';
    if (!user) return [];
    if (user.id !== caller.id && !viewSetup) insufficient();
    const a = recordAccess(user, recordId);
    return [{ RecordId: recordId, HasReadAccess: a.read, HasEditAccess: a.edit, HasDeleteAccess: a.delete }];
  }
  throw Object.assign(new Error(`MALFORMED_QUERY: the simulator does not support this query: ${s.slice(0, 120)}`), { status: 400 });
}

// ------------------------------------------------------------------ router

export function salesforceSimulator(): Router {
  const router = Router();
  const base = (req: Request) => `${req.protocol}://${req.get('host')}${req.baseUrl}`;
  const cookieOpts = (req: Request) => ({ httpOnly: true, sameSite: 'lax' as const, path: req.baseUrl || '/' });

  const uiUser = (req: Request) => {
    const sid = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith('sid='))?.slice(4);
    return sessionUser(sid ? decodeURIComponent(sid) : undefined);
  };
  const apiUser = (req: Request) => {
    const auth = req.headers.authorization ?? '';
    return auth.startsWith('Bearer ') ? sessionUser(auth.slice(7)) : null;
  };
  const requireUi = (req: Request, res: Response) => {
    const who = uiUser(req);
    if (!who) res.redirect(`${base(req)}/?startURL=${encodeURIComponent(req.originalUrl.slice(req.baseUrl.length))}`);
    return who;
  };
  const requireApi = (req: Request, res: Response) => {
    const who = apiUser(req);
    if (!who) res.status(401).json([{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }]);
    return who;
  };
  const startSession = (req: Request, res: Response, userId: string, startUrl: unknown, impersonatedBy?: string) => {
    res.cookie('sid', createSession(userId, impersonatedBy), cookieOpts(req));
    res.redirect(`${base(req)}${safeStart(startUrl)}`);
  };

  // --- fixtures for tests and demos
  router.get('/_sim/connected-app', (_req, res) => res.json(SIM_CONNECTED_APP));
  router.get('/_sim/users', (_req, res) => res.json(SIM_USERS.map((u) => ({
    username: u.username, password: u.password, security_token: u.securityToken, totp_secret: u.totp ?? null, profile: u.profile, permission_sets: u.permsets, id: u.id,
  }))));

  // --- UI login
  router.get('/', (req, res) => {
    if (uiUser(req)) return void res.redirect(`${base(req)}${safeStart(req.query.startURL)}`);
    res.send(loginPage(base(req), undefined, String(req.query.startURL ?? '')));
  });
  router.post('/', (req, res) => {
    const user = SIM_USERS.find((u) => u.username === String(req.body.username ?? '').trim());
    if (!user || user.password !== req.body.pw) {
      return void res.send(loginPage(base(req), "Please check your username and password. If you still can't log in, contact your Salesforce administrator.", req.body.startURL));
    }
    if (user.phishingResistantOnly) {
      return void res.send(loginPage(base(req),
        'Your Salesforce administrator requires a phishing-resistant verification method (security key or built-in authenticator) for this user. Authenticator-app codes are not accepted.',
        req.body.startURL));
    }
    if (user.totp) {
      const id = newId();
      challenges.set(id, { userId: user.id, startUrl: req.body.startURL, expires: Date.now() + 5 * 60_000 });
      return void res.redirect(`${base(req)}/_ui/identity/verification/method/TotpVerificationUi?challenge=${id}`);
    }
    startSession(req, res, user.id, req.body.startURL);
  });
  router.get('/_ui/identity/verification/method/TotpVerificationUi', (req, res) => {
    const id = String(req.query.challenge ?? '');
    if (!challenges.has(id)) return void res.redirect(`${base(req)}/`);
    res.send(page(base(req), 'Verify Your Identity', `
      <h1>Verify Your Identity</h1>
      <p>Enter the verification code from your authenticator app.</p>
      <form method="post">
        <input type="hidden" name="challenge" value="${esc(id)}">
        <label for="tc">Verification Code</label><input id="tc" name="tc" inputmode="numeric" autocomplete="one-time-code">
        <button id="save" type="submit">Verify</button>
        ${req.query.error ? '<div id="error" class="loginError" role="alert">The verification code you entered is invalid or has expired.</div>' : ''}
      </form>`));
  });
  router.post('/_ui/identity/verification/method/TotpVerificationUi', (req, res) => {
    const id = String(req.body.challenge ?? '');
    const challenge = challenges.get(id);
    const user = challenge && challenge.expires > Date.now() ? userById(challenge.userId) : undefined;
    if (!challenge || !user) return void res.redirect(`${base(req)}/`);
    if (!verifyTotp(user.totp!, String(req.body.tc ?? '').trim())) {
      return void res.redirect(`${base(req)}/_ui/identity/verification/method/TotpVerificationUi?challenge=${id}&error=1`);
    }
    challenges.delete(id);
    startSession(req, res, user.id, challenge.startUrl);
  });

  router.get('/secur/frontdoor.jsp', (req, res) => {
    let sid = String(req.query.sid ?? '');
    const otp = String(req.query.otp ?? '');
    if (otp) {
      const entry = otps.get(otp);
      otps.delete(otp); // single use
      sid = entry && entry.expires > Date.now() ? entry.sid : '';
    }
    const who = sessionUser(sid);
    if (!who) return void res.status(401).send(loginPage(base(req), 'Your session has expired. Please log in again.'));
    res.cookie('sid', sid, cookieOpts(req));
    res.redirect(`${base(req)}${safeStart(req.query.retURL)}`);
  });
  router.get('/secur/logout.jsp', (req, res) => {
    const who = uiUser(req);
    if (who) {
      const sid = (req.headers.cookie ?? '').match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
      if (sid) sessions.delete(decodeURIComponent(sid));
      if (who.session.impersonatedBy) {
        // Return to the administrator's own session.
        return void startSession(req, res, who.session.impersonatedBy, '/lightning/page/home');
      }
    }
    res.clearCookie('sid', cookieOpts(req));
    res.redirect(`${base(req)}/`);
  });
  router.get('/servlet/servlet.su', (req, res) => {
    const who = requireUi(req, res);
    if (!who) return;
    const target = userById(String(req.query.suorgadminid ?? ''));
    if (!who.user.admin || who.session.impersonatedBy || req.query.oid !== ORG_ID || !target) {
      return void res.status(403).send(denied(base(req), who));
    }
    startSession(req, res, target.id, req.query.targetURL, who.user.id);
  });

  // --- OAuth
  router.post('/services/oauth2/token', (req, res) => {
    const fail = (error: string, description: string): void => { res.status(400).json({ error, error_description: description }); };
    let user: SimUser | undefined;
    if (req.body.grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
      let claims: any;
      try {
        claims = jwt.verify(String(req.body.assertion ?? ''), publicKey.export({ type: 'spki', format: 'pem' }), { algorithms: ['RS256'] });
      } catch (e: any) {
        return fail('invalid_grant', `invalid assertion: ${e.message}`);
      }
      if (claims.iss !== SIM_CONNECTED_APP.client_id) return fail('invalid_client_id', 'client identifier invalid');
      if (claims.aud !== base(req)) return fail('invalid_grant', `audience is invalid (expected ${base(req)})`);
      user = SIM_USERS.find((u) => u.username === claims.sub);
      if (!user) return fail('invalid_grant', 'user hasn\'t approved this consumer');
    } else if (req.body.grant_type === 'password') {
      if (req.body.client_id !== SIM_CONNECTED_APP.client_id || req.body.client_secret !== SIM_CONNECTED_APP.client_secret) {
        return fail('invalid_client', 'invalid client credentials');
      }
      user = SIM_USERS.find((u) => u.username === req.body.username && `${u.password}${u.securityToken}` === req.body.password);
      if (!user) return fail('invalid_grant', 'authentication failure');
    } else {
      return fail('unsupported_grant_type', 'grant type not supported');
    }
    const sid = createSession(user.id);
    res.json({ access_token: sid, instance_url: base(req), id: `${base(req)}/id/${ORG_ID}/${user.id}`, token_type: 'Bearer', issued_at: String(Date.now()) });
  });
  router.post('/services/oauth2/singleaccess', (req, res) => {
    const who = requireApi(req, res);
    if (!who) return;
    const sid = (req.headers.authorization ?? '').slice(7);
    const otp = newId();
    otps.set(otp, { sid, expires: Date.now() + 60_000 });
    res.json({ frontdoor_uri: `${base(req)}/secur/frontdoor.jsp?otp=${otp}&retURL=${encodeURIComponent(safeStart(req.body.redirect_uri))}` });
  });
  router.get('/services/oauth2/userinfo', (req, res) => {
    const who = requireApi(req, res);
    if (!who) return;
    res.json({ user_id: who.user.id, organization_id: ORG_ID, preferred_username: who.user.username, name: who.user.name });
  });

  // --- REST API
  router.get('/services/data/:version/query', (req, res) => {
    const who = requireApi(req, res);
    if (!who) return;
    try {
      const records = runSoql(String(req.query.q ?? ''), who.user);
      res.json({ totalSize: records.length, done: true, records });
    } catch (e: any) {
      res.status(e.status ?? 400).json([{ message: e.message, errorCode: e.message.split(':')[0] }]);
    }
  });
  router.get('/services/data/:version/sobjects/:object/describe', (req, res) => {
    const who = requireApi(req, res);
    if (!who) return;
    const object = req.params.object;
    const access = simObjectAccess(who.user, object);
    if (!OBJECTS[object] || !access.read) return void res.status(404).json([{ message: 'The requested resource does not exist', errorCode: 'NOT_FOUND' }]);
    res.json({
      name: object, queryable: access.read, createable: access.create, updateable: access.edit, deletable: access.delete,
      fields: OBJECTS[object].fields.map((f) => ({ f, a: fieldAccess(who.user, object, f) })).filter((x) => x.a.read).map((x) => ({ name: x.f, updateable: x.a.edit })),
    });
  });

  // --- Lightning-like UI
  router.get('/lightning/page/home', (req, res) => {
    const who = requireUi(req, res);
    if (!who) return;
    res.send(page(base(req), 'Home', `
      <h1>Welcome, ${esc(who.user.name)}</h1>
      <p>Profile: <span id="profile-name">${esc(who.user.profile)}</span></p>
      <p>Username: ${esc(who.user.username)}</p>`, who));
  });
  router.get('/lightning/setup/SetupOneHome/home', (req, res) => {
    const who = requireUi(req, res);
    if (!who) return;
    if (!who.user.admin || who.session.impersonatedBy) return void res.send(denied(base(req), who));
    res.send(page(base(req), 'Setup', '<h1>Setup Home</h1><p>Users · Profiles · Permission Sets</p>', who));
  });
  router.get('/lightning/o/:object/list', (req, res) => {
    const who = requireUi(req, res);
    if (!who) return;
    const meta = OBJECTS[req.params.object];
    const access = meta ? simObjectAccess(who.user, req.params.object) : null;
    if (!meta || !access?.read) return void res.send(denied(base(req), who));
    const rows = RECORDS.filter((r) => r.type === req.params.object && recordAccess(who.user, r.id).read);
    res.send(page(base(req), meta.plural, `
      <h1>${meta.plural}</h1>
      ${access.create ? `<button type="button" name="New">New</button>` : ''}
      <table><thead><tr><th>Name</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><a href="${base(req)}/lightning/r/${r.type}/${r.id}/view">${esc(r.values.Name)}</a></td></tr>`).join('') || '<tr><td>No items to display.</td></tr>'}
      </tbody></table>`, who));
  });
  router.get('/lightning/r/:object/:id/view', (req, res) => {
    const who = requireUi(req, res);
    if (!who) return;
    const rec = RECORDS.find((r) => r.id === req.params.id && r.type === req.params.object);
    const access = rec ? recordAccess(who.user, rec.id) : null;
    if (!rec || !access?.read) return void res.send(denied(base(req), who));
    const fields = OBJECTS[rec.type].fields.filter((f) => fieldAccess(who.user, rec.type, f).read);
    res.send(page(base(req), rec.values.Name, `
      <h1>${esc(rec.values.Name)}</h1>
      <div class="actions">
        ${access.edit ? '<button type="button" name="Edit">Edit</button>' : ''}
        ${access.delete ? '<button type="button" name="Delete">Delete</button>' : ''}
      </div>
      <dl>${fields.map((f) => `<dt>${esc(f)}</dt><dd data-field="${esc(f)}">${esc(rec.values[f] ?? '')}</dd>`).join('')}</dl>`, who));
  });

  return router;
}
