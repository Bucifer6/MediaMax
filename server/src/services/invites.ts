import crypto from 'node:crypto';
import type { AcceptInviteRequest, AuthResponse, CreateInviteRequest, Invite, InvitePreview, InviteTemplate, User } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { badRequest, forbidden } from '../util/errors.js';
import { nowIso, parseJson } from '../util/misc.js';
import { getSettings } from './settings.js';
import { getBranding } from './branding.js';
import { createUser, issueToken } from './auth.js';
import { logActivity } from './activity.js';

const DEFAULT_TEMPLATE: InviteTemplate = {
  libraryIds: null, maxContentRating: null, allowLiveTv: true, allowDownloads: true, allowTranscode: true, allowDvr: false, allowRemote: true, maxStreams: 2,
};

const baseUrl = (origin: string) => (getSettings().publicUrl?.replace(/\/+$/, '') || origin);

function toInvite(r: Row, origin: string): Invite {
  return {
    code: r.code, url: `${baseUrl(origin)}/invite/${r.code}`, note: r.note ?? null, createdBy: r.created_by, createdAt: r.created_at,
    expiresAt: r.expires_at ?? null, maxUses: r.max_uses ?? null, uses: r.uses, template: { ...DEFAULT_TEMPLATE, ...parseJson<Partial<InviteTemplate>>(r.template, {}) },
  };
}

export const listInvites = (origin: string) => db.all('SELECT * FROM invites ORDER BY created_at DESC').map((r) => toInvite(r, origin));

export function createInvite(admin: User, req: CreateInviteRequest, origin: string): Invite {
  // 10 chars from a 32-symbol alphabet ≈ 50 bits: unguessable, still easy to type.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const code = Array.from(crypto.randomBytes(10), (b) => alphabet[b % alphabet.length]).join('');
  const days = req.expiresInDays === null ? null : Math.max(1, Math.min(365, req.expiresInDays ?? 7));
  const t = { ...DEFAULT_TEMPLATE, ...(req.template ?? {}) };
  db.insert('invites', {
    code, note: req.note?.slice(0, 200) ?? null, created_by: admin.id, created_at: nowIso(),
    expires_at: days === null ? null : new Date(Date.now() + days * 86400000).toISOString(),
    max_uses: req.maxUses === null ? null : Math.max(1, Math.min(1000, req.maxUses ?? 1)), template: JSON.stringify(t),
  });
  logActivity('invite.create', `Invite link created${req.note ? ` (${req.note})` : ''}`, { userId: admin.id, userName: admin.displayName });
  return toInvite(db.get('SELECT * FROM invites WHERE code = ?', code)!, origin);
}

export function deleteInvite(code: string) {
  db.run('DELETE FROM invites WHERE code = ?', code);
}

function usable(r: Row | undefined): string | null {
  if (!r) return 'This invite link is not valid.';
  if (r.expires_at && Date.parse(r.expires_at) < Date.now()) return 'This invite link has expired.';
  if (r.max_uses != null && r.uses >= r.max_uses) return 'This invite link has already been used.';
  return null;
}

export function previewInvite(code: string): InvitePreview {
  const problem = usable(db.get('SELECT * FROM invites WHERE code = ?', String(code ?? '').toLowerCase()));
  return { valid: !problem, serverName: getBranding().serverName, message: problem };
}

export function acceptInvite(code: string, req: AcceptInviteRequest, remoteAddr?: string): AuthResponse {
  const r = db.get('SELECT * FROM invites WHERE code = ?', String(code ?? '').toLowerCase());
  const problem = usable(r);
  if (problem) throw forbidden(problem);
  if (typeof req.username !== 'string' || (req.displayName != null && typeof req.displayName !== 'string')) throw badRequest('Invalid username');
  if (typeof req.password !== 'string' || req.password.length < 8) throw badRequest('Choose a password of at least 8 characters');
  const t = { ...DEFAULT_TEMPLATE, ...parseJson<Partial<InviteTemplate>>(r!.template, {}) };
  // Validate library ids still exist.
  const libIds = t.libraryIds ? t.libraryIds.filter((id) => db.get('SELECT 1 FROM libraries WHERE id = ?', id)) : null;
  const user = db.tx(() => {
    const u = createUser({
      username: req.username, displayName: req.displayName, password: req.password, isAdmin: false,
      libraryIds: libIds, maxContentRating: t.maxContentRating, allowLiveTv: t.allowLiveTv, allowDownloads: t.allowDownloads,
      allowTranscode: t.allowTranscode, allowDvr: t.allowDvr, allowRemote: t.allowRemote, maxStreams: t.maxStreams,
      ...(t.requestPermissions ? { requestPermissions: t.requestPermissions } : {}),
    });
    // Atomic use counter (guards against two people racing the last use).
    const upd = db.run('UPDATE invites SET uses = uses + 1 WHERE code = ? AND (max_uses IS NULL OR uses < max_uses)', r!.code);
    if (!upd.changes) throw forbidden('This invite link has already been used.');
    return u;
  });
  logActivity('invite.accept', `${user.displayName} joined with an invite link`, { userId: user.id, userName: user.displayName });
  return issueToken(user.id, req, remoteAddr);
}
