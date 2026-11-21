import type { AuthResponse, ImportConfig, ImportJob, ImportOptions, ImportPreview, ImportSource, ImportTestResult, PasswordLinkPreview, UsePasswordLinkRequest } from '@mediamax/shared';
import { http, request } from './client';
import { deviceInfo } from './device';

const enc = encodeURIComponent;

/** Admin → Import from another server (Emby, Jellyfin, Plex), plus the public set-password links it hands out. */
export const importApi = {
  config: (s: ImportSource) => http.get<ImportConfig>(`/admin/import/${s}/config`),
  saveConfig: (s: ImportSource, body: Partial<ImportConfig>) => http.put<ImportConfig>(`/admin/import/${s}/config`, body),
  test: (s: ImportSource, body: { url?: string; apiKey?: string }) => http.post<ImportTestResult>(`/admin/import/${s}/test`, body),
  preview: (s: ImportSource, opts: ImportOptions, quick: boolean) => http.get<ImportPreview>(`/admin/import/${s}/preview`, {
    quick, updateExisting: !!opts.updateExisting, mergeExisting: opts.mergeExisting !== false, includeDisabled: opts.includeDisabled !== false,
    importWatched: opts.importWatched !== false, importResume: opts.importResume !== false, importFavorites: opts.importFavorites !== false,
    importPlaylists: opts.importPlaylists !== false, importCollections: opts.importCollections !== false, importHistory: opts.importHistory !== false,
  }),
  run: (s: ImportSource, opts: ImportOptions) => http.post<ImportJob>(`/admin/import/${s}/run`, opts),
  job: () => http.get<ImportJob | null>('/admin/import/job'),
};

export const passwordLinkApi = {
  preview: (token: string) => request<PasswordLinkPreview>('GET', `/auth/password-link/${enc(token)}`, { silent401: true }),
  use: (token: string, password: string) =>
    request<AuthResponse>('POST', `/auth/password-link/${enc(token)}`, { body: { ...deviceInfo(), password } satisfies UsePasswordLinkRequest, silent401: true }),
};
