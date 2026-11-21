import type {
  Item, Pairing, PairClaimResponse, PairedTarget, PairRequest, PairStartResponse, PairStatus, RemoteAction, RemoteKey, RemoteTarget,
  SecondScreenInfo, SongIdResponse, WrappedStory,
} from '@mediamax/shared';
import { http, upload } from '../api/client';
import { realtime } from '../api/ws';

const enc = encodeURIComponent;

/** Phone ↔ TV pairing, phone remote, second screen and song ID endpoints. */
export const pairApi = {
  start: () => http.post<PairStartResponse>('/pair/start'),
  claim: (body: { code?: string; token?: string }) => http.post<PairClaimResponse>('/pair/claim', body),
  requests: () => http.get<PairRequest[]>('/pair/requests'),
  requestStatus: (id: string) => http.get<{ status: PairStatus; pairingId: string | null }>(`/pair/requests/${enc(id)}`),
  respond: (id: string, accept: boolean) => http.post<{ status: PairStatus; pairingId: string | null }>(`/pair/requests/${enc(id)}`, { accept }),
  pairings: () => http.get<Pairing[]>('/pair/pairings'),
  revoke: (id: string) => http.del<{ ok: true }>(`/pair/pairings/${enc(id)}`),
  targets: () => http.get<PairedTarget[]>('/pair/targets'),
  ownTargets: () => http.get<RemoteTarget[]>('/remote/targets'),
  now: (deviceId: string, signal?: AbortSignal) => http.get<SecondScreenInfo>(`/pair/targets/${enc(deviceId)}/now`, undefined, signal),
  browse: (deviceId: string, q: { q?: string; parentId?: string }, signal?: AbortSignal) =>
    http.get<{ items: Item[]; continueWatching?: Item[] }>(`/pair/targets/${enc(deviceId)}/browse`, q, signal),
  identifyOnTv: (deviceId: string) => http.post<SongIdResponse>(`/pair/targets/${enc(deviceId)}/identify-song`),
  identifyItem: (itemId: string, positionMs: number, audioIndex?: number | null) => http.post<SongIdResponse>(`/songid/items/${enc(itemId)}`, { positionMs, audioIndex }),
  identifyClip: (blob: Blob) => upload<SongIdResponse>('/songid/clip', blob),
  wrapped: (year: number | null, signal?: AbortSignal) => http.get<WrappedStory>('/stats/me/wrapped', { year: year ?? 'all' }, signal),
};

/** Socket helpers for the phone remote. */
export const remoteSend = {
  key: (targetDeviceId: string, key: RemoteKey, text?: string) => realtime.send({ type: 'remote.key', targetDeviceId, key, ...(text != null ? { text } : {}) }),
  command: (targetDeviceId: string, action: RemoteAction, opts: { itemId?: string; positionMs?: number; volume?: number; trackIndex?: number | null } = {}) =>
    realtime.send({ type: 'remote.command', targetDeviceId, action, ...opts }),
};

/** Ask the app shell to open the "Use your phone as remote" dialog (TV side). */
export function openPairDialog() {
  window.dispatchEvent(new CustomEvent('mm:pair-phone'));
}
