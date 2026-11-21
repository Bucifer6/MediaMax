/** Movie Match, Roulette and Random marathon endpoints (see docs/FEATURES.md → "Help us decide"). */
import type {
  CreateMarathonRequest, CreateMatchRequest, MarathonNextRequest, MarathonNextResponse, MarathonState, MatchDeckResponse, MatchResult, MatchSessionState,
  MatchVote, RouletteMoodPreset, RouletteSpinRequest, RouletteSpinResponse,
} from '@mediamax/shared';
import { http } from './client';
import { stillWatchingPrefs } from '../utils/decide';

const enc = encodeURIComponent;

export const decideApi = {
  moods: () => http.get<RouletteMoodPreset[]>('/roulette/moods'),
  spin: (body: RouletteSpinRequest) => http.post<RouletteSpinResponse>('/roulette/spin', body),

  startMarathon: (body: CreateMarathonRequest) => http.post<MarathonNextResponse>('/marathon', { stillWatching: stillWatchingPrefs(), ...body }),
  marathon: (id: string) => http.get<MarathonState>(`/marathon/${enc(id)}`),
  marathonNext: (id: string, body: MarathonNextRequest) => http.post<MarathonNextResponse>(`/marathon/${enc(id)}/next`, body),
  endMarathon: (id: string) => http.del<{ ok: true }>(`/marathon/${enc(id)}`),

  createMatch: (body: CreateMatchRequest) => http.post<MatchSessionState>('/match', body),
  joinMatch: (code: string) => http.post<MatchSessionState>('/match/join', { code }),
  match: (id: string) => http.get<MatchSessionState>(`/match/${enc(id)}`),
  deck: (id: string, offset: number, limit = 20) => http.get<MatchDeckResponse>(`/match/${enc(id)}/deck`, { offset, limit }),
  vote: (id: string, itemId: string, vote: MatchVote) => http.post<{ state: MatchSessionState; match: MatchResult | null }>(`/match/${enc(id)}/vote`, { itemId, vote }),
  extend: (id: string) => http.post<MatchSessionState>(`/match/${enc(id)}/extend`),
  results: (id: string) => http.get<MatchResult[]>(`/match/${enc(id)}/results`),
  leave: (id: string) => http.post<{ ok: true }>(`/match/${enc(id)}/leave`),
  end: (id: string) => http.post<{ ok: true }>(`/match/${enc(id)}/end`),
  playOnHost: (id: string, itemId: string) => http.post<{ deviceName: string }>(`/match/${enc(id)}/play`, { itemId }),
};
