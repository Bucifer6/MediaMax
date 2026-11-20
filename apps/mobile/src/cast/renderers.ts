/**
 * "Play to" network renderers (DLNA/UPnP TVs, Sonos, Kodi). The server discovers and controls
 * them; the app just lists them and sends play / control requests. Pure JS, works in every build.
 */
import type { MediaMaxClient } from '@/api/client';
import type { Renderer, RendererAction, RendererCommandRequest, RendererPlayRequest, RendererState } from '@/api/types';

const enc = encodeURIComponent;

export const listRenderers = (api: MediaMaxClient) => api.get<Renderer[]>('/renderers');
export const discoverRenderers = (api: MediaMaxClient) => api.post<Renderer[]>('/renderers/discover', {}, { timeoutMs: 15000 });
export const rendererState = (api: MediaMaxClient, id: string) => api.get<RendererState>(`/renderers/${enc(id)}/state`);
export const playOnRenderer = (api: MediaMaxClient, id: string, body: RendererPlayRequest) => api.post<RendererState>(`/renderers/${enc(id)}/play`, body, { timeoutMs: 30000 });
export const rendererCommand = (api: MediaMaxClient, id: string, action: RendererAction, body: RendererCommandRequest = {}) =>
  api.post<RendererState>(`/renderers/${enc(id)}/${action}`, body);

export const RENDERER_KIND_LABEL: Record<Renderer['kind'], string> = { dlna: 'DLNA', sonos: 'Sonos', kodi: 'Kodi' };
export const RENDERER_ICON = { dlna: 'tv-outline', sonos: 'musical-notes-outline', kodi: 'desktop-outline' } as const;
