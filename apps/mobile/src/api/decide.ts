/** Movie Match, Roulette and Random marathon endpoints (same contract as the web app's api/decide.ts). */
import type { MediaMaxClient } from './client';
import type {
  CreateMarathonRequest, CreateMatchRequest, MarathonNextRequest, MarathonNextResponse, MatchDeckResponse, MatchResult, MatchSessionState, MatchVote,
  RouletteSpinRequest, RouletteSpinResponse,
} from './types';

const enc = encodeURIComponent;

export const decide = (api: MediaMaxClient) => ({
  spin: (body: RouletteSpinRequest) => api.request<RouletteSpinResponse>('POST', '/roulette/spin', { body }),
  startMarathon: (body: CreateMarathonRequest) => api.request<MarathonNextResponse>('POST', '/marathon', { body }),
  marathonNext: (id: string, body: MarathonNextRequest) => api.request<MarathonNextResponse>('POST', `/marathon/${enc(id)}/next`, { body }),
  endMarathon: (id: string) => api.request<{ ok: true }>('DELETE', `/marathon/${enc(id)}`),

  createMatch: (body: CreateMatchRequest) => api.request<MatchSessionState>('POST', '/match', { body }),
  joinMatch: (code: string) => api.request<MatchSessionState>('POST', '/match/join', { body: { code } }),
  match: (id: string) => api.request<MatchSessionState>('GET', `/match/${enc(id)}`),
  deck: (id: string, offset: number, limit = 20) => api.request<MatchDeckResponse>('GET', `/match/${enc(id)}/deck`, { query: { offset, limit } }),
  vote: (id: string, itemId: string, vote: MatchVote) => api.request<{ state: MatchSessionState; match: MatchResult | null }>('POST', `/match/${enc(id)}/vote`, { body: { itemId, vote } }),
  extend: (id: string) => api.request<MatchSessionState>('POST', `/match/${enc(id)}/extend`, { body: {} }),
  leave: (id: string) => api.request<{ ok: true }>('POST', `/match/${enc(id)}/leave`, { body: {} }),
  end: (id: string) => api.request<{ ok: true }>('POST', `/match/${enc(id)}/end`, { body: {} }),
  playOnHost: (id: string, itemId: string) => api.request<{ deviceName: string }>('POST', `/match/${enc(id)}/play`, { body: { itemId } }),
});

/** Code typed or scanned: upper case, unambiguous alphabet, 6 characters. */
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/[O0I1]/g, '').slice(0, 6);

/** Swipe release → vote (mirrors web/src/utils/decide.ts swipeVote). */
export function swipeVote(dx: number, dy: number, vx: number, vy: number, width: number): MatchVote | null {
  const far = Math.max(80, width * 0.28);
  if (-dy > far * 0.9 && Math.abs(dy) > Math.abs(dx) * 1.2) return 'super';
  if (vy < -0.55 && Math.abs(vy) > Math.abs(vx) && -dy > 30) return 'super';
  if (dx > far || (vx > 0.55 && dx > 30)) return 'yes';
  if (dx < -far || (vx < -0.55 && dx < -30)) return 'no';
  return null;
}

/** "Are you still watching?" rule (mirrors the server). */
export const stillWatchingDue = (s: { enabled: boolean; afterItems: number; afterMinutes: number }, items: number, ms: number) =>
  s.enabled && (items >= s.afterItems || ms >= s.afterMinutes * 60_000);
