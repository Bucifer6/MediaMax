import type {
  ArrCalendarEntry, ArrHealthResponse, ArrItemInfo, ArrListResponse, ArrOptions, ArrQueueItem, ArrSearchRequest, ArrTestRequest, ArrWantedEntry,
  ArrWebhookInfo, DiscoverResponse, RequestOptions,
} from '@mediamax/shared';
import { http } from './client';

const enc = encodeURIComponent;

/** *arr suite endpoints (kept apart from endpoints.ts). */
export const arrApi = {
  test: (body: ArrTestRequest) => http.post<ArrOptions>('/arr/test', body),
  webhook: () => http.get<ArrWebhookInfo>('/arr/webhook'),
  regenerateWebhook: () => http.post<ArrWebhookInfo>('/arr/webhook/regenerate'),
  queue: () => http.get<ArrListResponse<ArrQueueItem>>('/arr/queue'),
  calendar: (days = 14) => http.get<ArrListResponse<ArrCalendarEntry>>('/arr/calendar', { days }),
  wanted: () => http.get<ArrListResponse<ArrWantedEntry>>('/arr/wanted'),
  health: () => http.get<ArrHealthResponse>('/arr/health'),
  search: (instanceId: string, body: ArrSearchRequest) => http.post<{ ok: true; command: string; commandId: number | null }>(`/arr/${enc(instanceId)}/search`, body),
  item: (itemId: string) => http.get<ArrItemInfo>(`/arr/item/${enc(itemId)}`),
  bazarr: (itemId: string) => http.post<{ ok: true; message: string }>(`/arr/item/${enc(itemId)}/subtitles`),
  requestOptions: () => http.get<RequestOptions>('/requests/options'),
  discover: (kind: 'music' | 'books', q: string, signal?: AbortSignal) => http.get<DiscoverResponse>('/discover/arr', { kind, q }, signal),
};
