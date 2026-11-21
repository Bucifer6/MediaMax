import type { AuthResponse, EmbyImportConfig, EmbyImportJob, EmbyImportOptions, EmbyImportPreview, PasswordLinkPreview, UsePasswordLinkRequest } from '@mediamax/shared';
import { http, request } from './client';
import { deviceInfo } from './device';

const enc = encodeURIComponent;

/** Admin → Import from Emby, plus the public set-password links it hands out. */
export const embyImportApi = {
  config: () => http.get<EmbyImportConfig>('/admin/emby-import/config'),
  saveConfig: (body: Partial<EmbyImportConfig>) => http.put<EmbyImportConfig>('/admin/emby-import/config', body),
  test: (body: { url?: string; apiKey?: string }) => http.post<{ ok: boolean; message: string; serverName?: string; version?: string; users?: number }>('/admin/emby-import/test', body),
  preview: (opts: EmbyImportOptions) => http.get<EmbyImportPreview>('/admin/emby-import/preview', {
    updateExisting: !!opts.updateExisting, mergeExisting: opts.mergeExisting !== false, includeDisabled: opts.includeDisabled !== false,
    importWatched: opts.importWatched !== false, importResume: opts.importResume !== false, importFavorites: opts.importFavorites !== false,
    importPlaylists: opts.importPlaylists !== false, importCollections: opts.importCollections !== false,
  }),
  run: (opts: EmbyImportOptions) => http.post<EmbyImportJob>('/admin/emby-import/run', opts),
  job: () => http.get<EmbyImportJob | null>('/admin/emby-import/job'),
};

export const passwordLinkApi = {
  preview: (token: string) => request<PasswordLinkPreview>('GET', `/auth/password-link/${enc(token)}`, { silent401: true }),
  use: (token: string, password: string) =>
    request<AuthResponse>('POST', `/auth/password-link/${enc(token)}`, { body: { ...deviceInfo(), password } satisfies UsePasswordLinkRequest, silent401: true }),
};
