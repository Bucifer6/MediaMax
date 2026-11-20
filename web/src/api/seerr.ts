import type {
  BlacklistEntry, BulkRequestAction, BulkRequestResult, BulkUpdateUsersRequest, CreateIssueRequest, DiscoverGenres, DiscoverPerson, DiscoverResponse,
  DiscoverResult, DiscoverSlider, DiscoverWatchlistEntry, EditMediaRequest, Issue, MediaRequest, NotificationAgent, NotificationAgentKindInfo,
  NotificationTestResult, RequestActivity, RequestArrChoices, RequestListQuery, RequestMediaType, RequestQuotaKind, RequestQuotaStatus, RequestTvInfo, User,
} from '@mediamax/shared';
import { http } from './client';

const enc = encodeURIComponent;

/** Requests (Overseerr parity), Discover extras, issues and notification agents. */
export const seerrApi = {
  requests: (q: RequestListQuery = {}) => http.get<MediaRequest[]>('/requests', q),
  request: (id: string) => http.get<MediaRequest>(`/requests/${enc(id)}`),
  quota: () => http.get<Record<RequestQuotaKind, RequestQuotaStatus>>('/requests/quota'),
  tv: (tmdbId: string) => http.get<RequestTvInfo>(`/requests/tv/${enc(tmdbId)}`),
  edit: (id: string, body: EditMediaRequest) => http.patch<MediaRequest>(`/requests/${enc(id)}`, body),
  approve: (id: string, body?: EditMediaRequest) => http.post<MediaRequest>(`/requests/${enc(id)}/approve`, body ?? {}),
  retry: (id: string) => http.post<MediaRequest>(`/requests/${enc(id)}/retry`),
  decline: (id: string, reason?: string) => http.post<MediaRequest>(`/requests/${enc(id)}/decline`, { reason }),
  remove: (id: string, removeFromArr = false) => http.del<{ ok: true; removedFrom: string[] }>(`/requests/${enc(id)}`, removeFromArr ? { removeFromArr: true } : undefined),
  bulk: (body: BulkRequestAction) => http.post<BulkRequestResult>('/requests/bulk', body),
  activity: (id: string) => http.get<RequestActivity[]>(`/requests/${enc(id)}/activity`),
  comment: (id: string, body: string) => http.post<RequestActivity>(`/requests/${enc(id)}/comments`, { body }),
  arrChoices: (id: string) => http.get<RequestArrChoices>(`/requests/${enc(id)}/arr-options`),

  blacklist: () => http.get<BlacklistEntry[]>('/requests/blacklist'),
  addBlacklist: (b: { mediaType: RequestMediaType; externalId: string; title?: string; reason?: string }) => http.post<BlacklistEntry>('/requests/blacklist', b),
  removeBlacklist: (type: string, id: string) => http.del<{ ok: true }>(`/requests/blacklist/${enc(type)}/${enc(id)}`),

  sliders: (hideAvailable?: boolean) => http.get<DiscoverSlider[]>('/discover/sliders', hideAvailable ? { hideAvailable: true } : undefined),
  list: (key: string, page = 1, hideAvailable?: boolean) => http.get<DiscoverResponse & { title: string }>(`/discover/list/${enc(key)}`, { page, ...(hideAvailable ? { hideAvailable: true } : {}) }),
  genres: () => http.get<DiscoverGenres>('/discover/genres'),
  person: (id: string) => http.get<DiscoverPerson>(`/discover/person/${enc(id)}`),
  people: (q: string) => http.get<{ id: string; name: string; profileUrl: string | null; knownFor: string | null }[]>('/discover/people', { q }),
  watchlist: () => http.get<DiscoverWatchlistEntry[]>('/discover/watchlist'),
  addWatchlist: (r: Pick<DiscoverResult, 'mediaType' | 'tmdbId'>) => http.post<DiscoverWatchlistEntry>('/discover/watchlist', { mediaType: r.mediaType, tmdbId: r.tmdbId }),
  removeWatchlist: (type: string, id: string) => http.del<{ ok: true }>(`/discover/watchlist/${enc(type)}/${enc(id)}`),

  issues: (q: { status?: string; mine?: boolean; kind?: string } = {}) => http.get<Issue[]>('/issues', q),
  issueCount: () => http.get<{ open: number }>('/issues/count'),
  issue: (id: string) => http.get<Issue>(`/issues/${enc(id)}`),
  createIssue: (b: CreateIssueRequest) => http.post<Issue>('/issues', b),
  commentIssue: (id: string, body: string) => http.post<Issue>(`/issues/${enc(id)}/comments`, { body }),
  resolveIssue: (id: string) => http.post<Issue>(`/issues/${enc(id)}/resolve`),
  reopenIssue: (id: string) => http.post<Issue>(`/issues/${enc(id)}/reopen`),
  deleteIssue: (id: string) => http.del<{ ok: true }>(`/issues/${enc(id)}`),

  agentKinds: () => http.get<NotificationAgentKindInfo[]>('/notify/agents/kinds'),
  testAgent: (a: Partial<NotificationAgent>) => http.post<NotificationTestResult>('/notify/agents/test', a),

  bulkUsers: (b: BulkUpdateUsersRequest) => http.patch<User[]>('/users/bulk', b),
};
