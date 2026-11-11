/**
 * Salesforce OAuth flows that act as a specific user, and the bridge from an
 * access token to a browser (UI) session.
 *
 *   JWT bearer flow     — a connected app / External Client App with a
 *                         certificate; the user (sub) must be pre-authorized.
 *                         Works for users whose UI login requires
 *                         phishing-resistant MFA (e.g. administrators).
 *   Username-password   — legacy; blocked by default in newer orgs.
 *   UI bridge           — single-use frontdoor URL (POST /services/oauth2/singleaccess),
 *                         falling back to /secur/frontdoor.jsp?sid=<token>.
 */

import jwt from 'jsonwebtoken';

export interface TokenResult {
  accessToken: string;
  instanceUrl: string;
  identityUrl?: string;
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

async function tokenRequest(loginUrl: string, form: Record<string, string>): Promise<TokenResult> {
  const res = await fetch(`${trimSlash(loginUrl)}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const reason = body.error_description || body.error || `HTTP ${res.status}`;
    throw new Error(`Salesforce token request failed: ${reason}${hintFor(String(body.error ?? ''), String(body.error_description ?? ''))}`);
  }
  return { accessToken: body.access_token, instanceUrl: trimSlash(body.instance_url), identityUrl: body.id };
}

function hintFor(error: string, description: string): string {
  const text = `${error} ${description}`.toLowerCase();
  if (text.includes('user hasn\'t approved') || text.includes('not approved')) {
    return ' — pre-authorize the user: connected app → "Admin approved users are pre-authorized", and assign its profile or permission set';
  }
  if (text.includes('invalid_client') || text.includes('client identifier')) return ' — check the connected app consumer key (client_id)';
  if (text.includes('invalid_grant') && text.includes('audience')) return ' — the JWT audience must be https://login.salesforce.com (production) or https://test.salesforce.com (sandbox)';
  if (text.includes('authentication failure')) return ' — wrong username/password, or the password flow is blocked in this org';
  return '';
}

/** OAuth 2.0 JWT bearer flow for `username`. */
export async function jwtBearerToken(opts: {
  loginUrl: string;
  clientId: string;
  privateKeyPem: string;
  username: string;
  audience?: string;
}): Promise<TokenResult> {
  const audience = opts.audience || audienceFor(opts.loginUrl);
  const assertion = jwt.sign({}, opts.privateKeyPem, {
    algorithm: 'RS256',
    issuer: opts.clientId,
    subject: opts.username,
    audience,
    expiresIn: 180,
  });
  return tokenRequest(opts.loginUrl, {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
}

/** OAuth username-password flow (legacy). The security token is appended to the password. */
export async function passwordToken(opts: {
  loginUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  securityToken?: string;
}): Promise<TokenResult> {
  return tokenRequest(opts.loginUrl, {
    grant_type: 'password',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    username: opts.username,
    password: `${opts.password}${opts.securityToken ?? ''}`,
  });
}

/**
 * JWT audience: production and Developer Edition use login.salesforce.com,
 * sandboxes test.salesforce.com. Any other login URL (My Domain, simulator)
 * is used as-is.
 */
export function audienceFor(loginUrl: string): string {
  const host = new URL(loginUrl).hostname;
  if (/\.sandbox\.my\.salesforce\.com$/.test(host) || host === 'test.salesforce.com') return 'https://test.salesforce.com';
  if (/\.my\.salesforce\.com$/.test(host) || host === 'login.salesforce.com') return 'https://login.salesforce.com';
  return trimSlash(loginUrl);
}

/** URL that opens a UI session for an access token, landing on `retUrl`. */
export async function uiBridgeUrl(instanceUrl: string, accessToken: string, retUrl: string, mode: 'auto' | 'single_access' | 'sid' = 'auto'): Promise<string> {
  const base = trimSlash(instanceUrl);
  if (mode !== 'sid') {
    try {
      const res = await fetch(`${base}/services/oauth2/singleaccess`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ redirect_uri: retUrl }).toString(),
        signal: AbortSignal.timeout(20_000),
      });
      const body: any = await res.json().catch(() => ({}));
      if (res.ok && body.frontdoor_uri) return String(body.frontdoor_uri);
      if (mode === 'single_access') throw new Error(`UI bridge request failed: ${body.error_description || body.message || `HTTP ${res.status}`}`);
    } catch (error) {
      if (mode === 'single_access') throw error;
    }
  }
  return `${base}/secur/frontdoor.jsp?sid=${encodeURIComponent(accessToken)}&retURL=${encodeURIComponent(retUrl)}`;
}
