/** Lyrics editor / offsets and karaoke stems endpoints (see docs/API.md → Lyrics & karaoke). */
import type { Lyrics, SaveLyricsRequest, SaveLyricsResponse, StemsStatus, TrackStems } from '@mediamax/shared';
import { API_BASE, getToken, http, withToken } from './client';

const enc = encodeURIComponent;

export const karaokeApi = {
  lyrics: (id: string, signal?: AbortSignal) => http.get<Lyrics>(`/items/${enc(id)}/lyrics`, undefined, signal),
  saveLyrics: (id: string, body: SaveLyricsRequest) => http.put<SaveLyricsResponse>(`/items/${enc(id)}/lyrics`, body),
  deleteLyrics: (id: string) => http.del<{ ok: true }>(`/items/${enc(id)}/lyrics`),
  setOffset: (id: string, offsetMs: number) => http.put<{ offsetMs: number }>(`/items/${enc(id)}/lyrics/offset`, { offsetMs }),

  stemsStatus: () => http.get<StemsStatus>('/stems/status'),
  downloadOrt: () => http.post<NonNullable<StemsStatus['ortDownload']>>('/stems/ort/download'),
  downloadModel: () => http.post<{ ready: boolean; started?: boolean; downloading?: { received: number; total: number } }>('/stems/model/download'),
  cancelModel: () => http.post<{ ok: true }>('/stems/model/cancel'),
  trackStems: (id: string) => http.get<TrackStems>(`/items/${enc(id)}/stems`),
  /** Separate on the server (queued); poll trackStems() for the job's progress. */
  prepareOnServer: (id: string) => http.post<TrackStems>(`/items/${enc(id)}/stems/prepare`, {}),
  cancelOnServer: (id: string) => http.del<{ cancelled: boolean }>(`/items/${enc(id)}/stems/prepare`),
  deleteStems: (id: string) => http.del<{ ok: true }>(`/items/${enc(id)}/stems`),
  beginStems: (id: string, body: { frames: number; sampleRate: number; model: string; backend: string }) => http.post<{ token: string }>(`/items/${enc(id)}/stems/begin`, body),
  finishStems: (id: string, token: string) => http.post<TrackStems>(`/items/${enc(id)}/stems/finish`, {}, { token }),
  /** Upload one block of a stem (interleaved stereo s16le). */
  async putStemPart(id: string, token: string, stem: string, frame: number, data: Int16Array) {
    const t = getToken();
    const res = await fetch(`${API_BASE}/items/${enc(id)}/stems/part?token=${enc(token)}&stem=${enc(stem)}&frame=${frame}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
      body: new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? `Upload failed (HTTP ${res.status})`);
  },
  /** URL of the verified model file (fetched by the separation worker). */
  modelUrl: () => withToken(`${API_BASE}/stems/model`),
  ortBase: () => `${API_BASE}/stems/ort/`,
  /** Server-side mix: vocals / instrumental levels 0–100. */
  mixUrl: (id: string, vocals: number, inst = 100) => `${API_BASE}/items/${enc(id)}/karaoke.mp3?vocals=${Math.round(vocals)}&inst=${Math.round(inst)}`,
};
