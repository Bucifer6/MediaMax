import crypto from 'node:crypto';
import type { DeviceInfo } from '@mediamax/shared';
import { db } from '../db.js';
import { getSettings } from './settings.js';
import { createUser, issueToken, getUser } from './auth.js';
import { badRequest, forbidden, HttpError } from '../util/errors.js';
import { logActivity } from './activity.js';
import { logger } from '../util/log.js';

const log = logger('oidc');

export const oidcEnabled = () => {
  const o = getSettings().oidc;
  return !!(o.enabled && o.issuer && o.clientId);
};

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

let discoveryCache: { issuer: string; doc: Discovery; at: number } | null = null;

async function discover(): Promise<Discovery> {
  const issuer = (getSettings().oidc.issuer ?? '').replace(/\/+$/, '');
  if (discoveryCache && discoveryCache.issuer === issuer && Date.now() - discoveryCache.at < 3600000) return discoveryCache.doc;
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new HttpError(502, `Could not reach the SSO provider (HTTP ${res.status})`, 'sso_unavailable');
  const doc = (await res.json()) as Discovery;
  discoveryCache = { issuer, doc, at: Date.now() };
  return doc;
}

interface Pending {
  verifier: string;
  nonce: string;
  redirect: string;
  redirectUri: string;
  device: Partial<DeviceInfo>;
  expires: number;
}
const pending = new Map<string, Pending>();
const b64url = (b: Buffer) => b.toString('base64url');

/**
 * Only send tokens to the server's own origin or the Kinora app scheme. `serverOrigin` must be the
 * same origin used for the IdP redirect_uri (publicUrl when configured), so a forged Host header
 * either fails here or produces a redirect_uri the provider rejects.
 */
export function validateRedirect(redirect: string, serverOrigin: string): string {
  try {
    // The apps register kinora:// (and the legacy mediamax://) for the sign-in redirect.
    if (/^(kinora|mediamax):\/\/[\w./-]*$/i.test(redirect)) return redirect;
    const u = new URL(redirect);
    if (u.origin === new URL(serverOrigin).origin) return redirect;
  } catch {
    /* invalid */
  }
  throw badRequest('Redirect URL is not allowed');
}

export async function startLogin(baseUrl: string, redirect: string, device: Partial<DeviceInfo>): Promise<{ url: string; state: string }> {
  if (!oidcEnabled()) throw forbidden('Single sign-on is not enabled');
  const d = await discover();
  for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  const nonce = b64url(crypto.randomBytes(16));
  const redirectUri = `${baseUrl}/api/v1/auth/oidc/callback`;
  pending.set(state, { verifier, nonce, redirect, redirectUri, device, expires: Date.now() + 10 * 60000 });
  const o = getSettings().oidc;
  const scope = ['openid', 'profile', 'email', ...(o.adminGroup || o.allowedGroup ? ['groups'] : [])].join(' ');
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', o.clientId!);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', scope);
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', b64url(crypto.createHash('sha256').update(verifier).digest()));
  u.searchParams.set('code_challenge_method', 'S256');
  return { url: u.toString(), state };
}

function decodeJwtPayload(jwt: string): Record<string, any> {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('Malformed ID token');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function claimGroups(claims: Record<string, any>): string[] {
  const key = getSettings().oidc.groupsClaim || 'groups';
  const v = key.split('.').reduce<any>((o, k) => (o == null ? o : o[k]), claims);
  return Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[,\s]+/).filter(Boolean) : [];
}

function uniqueUsername(base: string): string {
  const clean = base.replace(/[^\w.@ -]/g, '').slice(0, 48) || 'user';
  let name = clean;
  for (let i = 2; db.get('SELECT 1 FROM users WHERE username = ?', name); i++) name = `${clean}${i}`;
  return name;
}

/** Complete the authorization-code exchange and return where to send the browser. */
export async function finishLogin(state: string, code: string, cookieState: string | null, remoteAddr?: string): Promise<string> {
  // The state must match the cookie set on the browser that started sign-in (prevents login CSRF / link hijacking).
  if (!cookieState || cookieState !== state) throw badRequest('Sign-in must be completed in the same browser that started it. Please try again.');
  const p = pending.get(state);
  pending.delete(state);
  if (!p || p.expires < Date.now()) throw badRequest('This sign-in link has expired. Please try again.');
  const fail = (msg: string) => `${p.redirect}#error=${encodeURIComponent(msg)}`;
  try {
    const o = getSettings().oidc;
    const d = await discover();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: o.clientId!, code_verifier: p.verifier });
    if (o.clientSecret) body.set('client_secret', o.clientSecret);
    const res = await fetch(d.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Token exchange failed (HTTP ${res.status})`);
    const tok: any = await res.json();
    // The ID token came straight from the token endpoint over TLS (OIDC Core 3.1.3.7), so we validate claims, not the signature.
    const claims = tok.id_token ? decodeJwtPayload(tok.id_token) : {};
    if (tok.id_token) {
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      // iss is required (OIDC Core 3.1.3.7): a token without one must not pass as this issuer's.
      if (typeof claims.iss !== 'string' || claims.iss.replace(/\/+$/, '') !== d.issuer.replace(/\/+$/, '')) throw new Error('ID token issuer mismatch');
      if (!aud.includes(o.clientId)) throw new Error('ID token audience mismatch');
      if (claims.nonce !== p.nonce) throw new Error('ID token nonce mismatch');
      if (claims.exp && claims.exp * 1000 < Date.now() - 60000) throw new Error('ID token expired');
    }
    if (d.userinfo_endpoint && tok.access_token) {
      const ui = await fetch(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(10000) });
      if (ui.ok) Object.assign(claims, await ui.json());
    }
    const sub = claims.sub ? `${d.issuer}|${claims.sub}` : null;
    if (!sub) throw new Error('The provider did not return a user id');
    const groups = claimGroups(claims);
    if (o.allowedGroup && !groups.includes(o.allowedGroup)) return fail('Your account is not allowed to use this server.');
    const isAdmin = !!o.adminGroup && groups.includes(o.adminGroup);
    let row = db.get('SELECT * FROM users WHERE oidc_sub = ?', sub);
    if (!row) {
      if (!o.autoCreateUsers) return fail('No Kinora account is linked to this sign-in. Ask your administrator.');
      const username = uniqueUsername(claims.preferred_username || claims.email?.split('@')[0] || claims.name || 'user');
      const u = createUser({ username, displayName: claims.name || claims.preferred_username || username, isAdmin, allowDvr: isAdmin });
      db.run('UPDATE users SET oidc_sub = ? WHERE id = ?', sub, u.id);
      logActivity('user.create', `User ${u.displayName} created via single sign-on`);
      row = db.get('SELECT * FROM users WHERE id = ?', u.id)!;
    } else if (o.adminGroup && !!row.is_admin !== isAdmin) {
      // Keep admin rights in sync with the provider's groups (never demote the last admin).
      const admins = db.get<{ n: number }>('SELECT COUNT(*) n FROM users WHERE is_admin = 1 AND disabled = 0')!.n;
      if (isAdmin || admins > 1) db.run('UPDATE users SET is_admin = ? WHERE id = ?', isAdmin, row.id);
    }
    if (getUser(row.id).disabled) return fail('This account is disabled.');
    const auth = issueToken(row.id, p.device, remoteAddr);
    return `${p.redirect}#token=${encodeURIComponent(auth.token)}`;
  } catch (e) {
    log.warn(`SSO sign-in failed: ${(e as Error).message}`);
    return fail((e as Error).message || 'Single sign-on failed');
  }
}
