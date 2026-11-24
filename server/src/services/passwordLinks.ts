import type { AuthResponse, PasswordLinkPreview, UsePasswordLinkRequest } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { newToken, sha256 } from '../util/ids.js';
import { badRequest, forbidden } from '../util/errors.js';
import { nowIso } from '../util/misc.js';
import { getSettings } from './settings.js';
import { getBranding } from './branding.js';
import { hashSecret, issueToken } from './auth.js';
import { logActivity } from './activity.js';

/**
 * One-time "choose your password" links for accounts an admin created without a password the user knows (e.g. users
 * imported from Emby, whose password hashes can't be carried over). Only the SHA-256 of the token is stored; using a
 * link sets the password, signs the account's other sessions out and signs the user in.
 */

export const passwordLinkUrl = (token: string, origin: string) => `${getSettings().publicUrl?.replace(/\/+$/, '') || origin}/set-password/${token}`;

/** Create a link (any earlier unused link of the same purpose for this user stops working). Returns the raw token. */
export function createPasswordLink(userId: string, purpose: string, createdBy: string | null, days = 30): { token: string; expiresAt: string } {
  const token = newToken();
  const expiresAt = new Date(Date.now() + Math.max(1, Math.min(365, Math.round(days))) * 86400000).toISOString();
  db.tx(() => {
    db.run('DELETE FROM password_links WHERE user_id = ? AND purpose = ? AND used_at IS NULL', userId, purpose);
    db.insert('password_links', { token_hash: sha256(token), user_id: userId, purpose, created_by: createdBy, created_at: nowIso(), expires_at: expiresAt, used_at: null });
  });
  return { token, expiresAt };
}

/** The user has already used a link of this purpose (i.e. chose their own password). */
export const passwordLinkUsed = (userId: string, purpose: string) => !!db.get('SELECT 1 FROM password_links WHERE user_id = ? AND purpose = ? AND used_at IS NOT NULL', userId, purpose);

function lookup(token: string): { row: Row | undefined; user: Row | undefined; problem: string | null } {
  const row = typeof token === 'string' && token.length >= 20 && token.length <= 100 ? db.get('SELECT * FROM password_links WHERE token_hash = ?', sha256(token)) : undefined;
  const user = row ? db.get('SELECT * FROM users WHERE id = ?', row.user_id) : undefined;
  let problem: string | null = null;
  if (!row || !user) problem = 'This link is not valid.';
  else if (row.used_at) problem = 'This link has already been used.';
  else if (Date.parse(row.expires_at) < Date.now()) problem = 'This link has expired.';
  else if (user.disabled) problem = 'This account is disabled.';
  // A link must never get around a second factor the account already has.
  else if (user.totp_enabled) problem = 'This account already has two-factor sign-in; sign in normally or ask an administrator.';
  return { row, user, problem };
}

export function previewPasswordLink(token: string): PasswordLinkPreview {
  const { user, problem } = lookup(token);
  return { valid: !problem, serverName: getBranding().serverName, username: problem ? null : user!.username, displayName: problem ? null : user!.display_name, message: problem };
}

export async function usePasswordLink(token: string, req: UsePasswordLinkRequest, remoteAddr?: string): Promise<AuthResponse> {
  const { row, user, problem } = lookup(token);
  if (problem) throw forbidden(problem);
  if (!req?.password || typeof req.password !== 'string' || req.password.length < 8) throw badRequest('Choose a password of at least 8 characters');
  const hash = await hashSecret(req.password);
  // Re-checked after the await (the account may have been disabled or given 2FA meanwhile).
  const recheck = lookup(token).problem;
  if (recheck) throw forbidden(recheck);
  db.tx(() => {
    // Atomic: two tabs racing the same link can't both use it.
    const upd = db.run('UPDATE password_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', nowIso(), row!.token_hash);
    if (!upd.changes) throw forbidden('This link has already been used.');
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, user!.id);
    db.run('DELETE FROM devices WHERE user_id IN (SELECT id FROM users WHERE id = ? OR parent_user_id = ?)', user!.id, user!.id);
  });
  logActivity('user.password', `${user!.display_name} chose a password with a set-password link`, { userId: user!.id, userName: user!.display_name });
  return issueToken(user!.id, req, remoteAddr);
}
