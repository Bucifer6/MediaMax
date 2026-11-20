import type {
  ChannelMatch, CreateEpgSourceRequest, EpgGuideChannel, EpgPreset, EpgSource, MatchingResponse, Program, SdHeadend, SdStatus,
  SetChannelMatchRequest, UpdateEpgSourceRequest,
} from '@mediamax/shared';
import { http } from './client';

const enc = encodeURIComponent;

/** TV guide providers and channel ↔ guide matching (admin). */
export const epgApi = {
  sources: () => http.get<EpgSource[]>('/livetv/epg-sources'),
  create: (body: CreateEpgSourceRequest) => http.post<EpgSource>('/livetv/epg-sources', body),
  update: (id: string, body: UpdateEpgSourceRequest) => http.patch<EpgSource>(`/livetv/epg-sources/${enc(id)}`, body),
  remove: (id: string) => http.del<{ ok: true }>(`/livetv/epg-sources/${enc(id)}`),
  refresh: (id: string) => http.post<{ ok: true }>(`/livetv/epg-sources/${enc(id)}/refresh`),
  presets: () => http.get<EpgPreset[]>('/livetv/epg-presets'),
  sdStatus: (id: string) => http.get<SdStatus>(`/livetv/epg-sources/${enc(id)}/sd/status`),
  sdHeadends: (id: string, country: string, postalcode: string) => http.get<SdHeadend[]>(`/livetv/epg-sources/${enc(id)}/sd/headends`, { country, postalcode }),
  sdAddLineup: (id: string, lineup: string) => http.put<{ status: SdStatus; changesRemaining: number | null }>(`/livetv/epg-sources/${enc(id)}/sd/lineups/${enc(lineup)}`),
  sdRemoveLineup: (id: string, lineup: string) => http.del<{ status: SdStatus; changesRemaining: number | null }>(`/livetv/epg-sources/${enc(id)}/sd/lineups/${enc(lineup)}`),
  guideChannels: (q: string, epgSourceId?: string, signal?: AbortSignal) => http.get<EpgGuideChannel[]>('/livetv/epg-channels', { q, epgSourceId, limit: 30 }, signal),
  preview: (epgSourceId: string, epgChannelId: string, offsetHours = 0, signal?: AbortSignal) =>
    http.get<{ now: Program | null; next: Program | null; upcoming: Program[] }>('/livetv/epg-preview', { epgSourceId, epgChannelId, offsetHours }, signal),
  matching: (q: { filter?: string; sourceId?: string; search?: string; offset?: number; limit?: number }, signal?: AbortSignal) => http.get<MatchingResponse>('/livetv/matching', q, signal),
  setMatch: (channelId: string, body: SetChannelMatchRequest) => http.put<ChannelMatch>(`/livetv/channels/${enc(channelId)}/match`, body),
  acceptAll: (sourceId?: string) => http.post<{ accepted: number }>('/livetv/matching/accept-all', { sourceId }),
  rematch: () => http.post<{ ok: true }>('/livetv/matching/rematch'),
};
