import type { RequestStatus } from '@mediamax/shared';

export const REQUEST_STATUS_TONE: Record<RequestStatus, 'primary' | 'success' | 'warning' | 'danger' | 'accent' | 'muted'> = {
  pending: 'warning',
  approved: 'primary',
  processing: 'accent',
  available: 'success',
  declined: 'muted',
  failed: 'danger',
};

export const REQUESTS_CHANGED = 'mm:requests-changed';

/** Tell the nav badge (and anyone else listening) that requests changed. */
export const notifyRequestsChanged = () => window.dispatchEvent(new CustomEvent(REQUESTS_CHANGED));

/** "1, 2, 4-6" → [1,2,4,5,6]; null when the text can't be parsed. */
export function parseSeasons(text: string): number[] | null {
  const out = new Set<number>();
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d{1,3})(?:-(\d{1,3}))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (b < a || b - a > 100) return null;
    for (let n = a; n <= b; n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

/** May this user approve/decline/edit requests and manage issues? */
export const canManageRequests = (u: { isAdmin: boolean; requestPermissions?: { manageRequests: boolean } } | null | undefined) =>
  !!u && (u.isAdmin || !!u.requestPermissions?.manageRequests);

export const ISSUES_CHANGED = 'mm:issues-changed';
export const notifyIssuesChanged = () => window.dispatchEvent(new CustomEvent(ISSUES_CHANGED));
