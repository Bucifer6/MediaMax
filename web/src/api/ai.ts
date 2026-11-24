import type { AiHealthResponse, AiProviderTestResponse, AiStatus, AskFilter, DjRules, AskResponse, AutoSubtitleJob, AutoSubtitleStatus, RecapResponse, WhisperModelSize } from '@mediamax/shared';
import { http, request } from './client';

const enc = encodeURIComponent;
type Ok = { ok: true };

export interface AiFeatures { ask: boolean; recaps: boolean; askUsesModel: boolean; recapsUseModel: boolean }
export type WhisperModels = Record<WhisperModelSize, { file: string; mb: number; note: string }>;

/** Admin → AI, Ask and recaps. */
export const aiApi = {
  status: () => http.get<AiStatus>('/ai/status'),
  test: () => http.post<{ ok: true; reply: string; ms: number; usage: AiStatus['usage'] }>('/ai/test'),
  features: () => http.get<AiFeatures>('/ai/features'),
  subtitles: () => http.get<AutoSubtitleStatus & { models: WhisperModels }>('/ai/subtitles'),
  queueSubtitle: (itemId: string, language: string) => http.post<AutoSubtitleJob>('/ai/subtitles/queue', { itemId, language }),
  runSubtitles: () => http.post<Ok>('/ai/subtitles/run'),
  stopSubtitles: () => http.post<Ok>('/ai/subtitles/stop'),
  removeJob: (id: string) => http.del<Ok>(`/ai/subtitles/jobs/${enc(id)}`),
  clearJobs: (status: 'done' | 'error' | 'skipped' | 'all' = 'all') => http.post<Ok>('/ai/subtitles/clear', { status }),
  downloadWhisper: (what: 'binary' | 'model', model?: WhisperModelSize) => http.post<Ok>('/ai/whisper/download', { what, model }),
  buildEmbeddings: () => http.post<Ok>('/ai/embeddings/build'),
  ask: (q: string, opts: { filter?: AskFilter; remove?: string[]; limit?: number } = {}, signal?: AbortSignal) =>
    request<AskResponse>('POST', '/ask', { body: { q, ...opts }, signal }),
  /** Provider chains: health and the fallback log (admin). */
  health: () => http.get<AiHealthResponse>('/ai/health'),
  testProvider: (kind: 'llm' | 'tts', providerId: string) => http.post<AiProviderTestResponse>('/ai/providers/test', { kind, providerId }),
  /** Admin-enforced DJ restrictions for one user ({} = none). */
  djRestrictions: (userId: string) => http.get<DjRules>(`/users/${enc(userId)}/dj-restrictions`),
  setDjRestrictions: (userId: string, rules: DjRules) => http.put<DjRules>(`/users/${enc(userId)}/dj-restrictions`, rules),
  recap: (itemId: string, force = false) => http.get<RecapResponse>(`/items/${enc(itemId)}/recap`, force ? { force: 1 } : undefined),
};
