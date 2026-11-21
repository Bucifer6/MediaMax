import type { AskFilter, AskResponse, RecapResponse } from './types';
import type { MediaMaxClient as ApiClient } from './client';

/** Ask (natural-language search) and "Previously on…" recaps. The server applies library access and ratings. */
export const aiFeatures = (api: ApiClient) => api.get<{ ask: boolean; recaps: boolean; askUsesModel: boolean; recapsUseModel: boolean }>('/ai/features');

export const askLibrary = (api: ApiClient, q: string, opts: { filter?: AskFilter; remove?: string[]; limit?: number } = {}, signal?: AbortSignal) =>
  api.post<AskResponse>('/ask', { q, limit: 60, ...opts }, { signal });

export const getRecap = (api: ApiClient, itemId: string, force = false) =>
  api.get<RecapResponse>(`/items/${encodeURIComponent(itemId)}/recap`, force ? { force: 1 } : undefined);
