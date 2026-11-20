import type { AccountProfile, AuthResponse, BuiltinAvatar, CreateProfileRequest, Profile, ProfileSettings, SwitchProfileRequest, UpdateProfileRequest } from '@mediamax/shared';
import { http, request, upload } from './client';

const enc = encodeURIComponent;

/** Account profiles ("Who's watching?"). */
export const profilesApi = {
  /** Profiles of the signed-in account (owner first) for the picker. */
  account: () => http.get<AccountProfile[]>('/auth/account/profiles'),
  /** Switch this device to another profile; returns a new session token. */
  switchTo: (id: string, pin?: string) =>
    request<AuthResponse>('POST', `/auth/profiles/${enc(id)}/switch`, { body: { pin } satisfies SwitchProfileRequest, silent401: true }),
  avatars: () => http.get<BuiltinAvatar[]>('/avatars'),
  settings: () => http.get<ProfileSettings>('/profiles/settings'),
  /** The owner's profiles (owner session), or another account's (admin, with ownerId). */
  list: (ownerId?: string) => http.get<Profile[]>(ownerId ? `/users/${enc(ownerId)}/profiles` : '/profiles'),
  create: (body: CreateProfileRequest, ownerId?: string) => http.post<Profile>(ownerId ? `/users/${enc(ownerId)}/profiles` : '/profiles', body),
  get: (id: string) => http.get<Profile>(`/profiles/${enc(id)}`),
  update: (id: string, body: UpdateProfileRequest) => http.patch<Profile>(`/profiles/${enc(id)}`, body),
  remove: (id: string) => http.del<{ ok: true }>(`/profiles/${enc(id)}`),
  uploadAvatar: (id: string, file: File) => upload<Profile>(`/profiles/${enc(id)}/avatar`, file),
  deleteAvatar: (id: string) => http.del<Profile>(`/profiles/${enc(id)}/avatar`),
};

/** Content-rating choices offered for profile limits (US film + TV, UK). */
export const RATING_CHOICES: { value: string; label: string }[] = [
  { value: 'TV-Y', label: 'TV-Y · all children' },
  { value: 'TV-Y7', label: 'TV-Y7 · 7+' },
  { value: 'G', label: 'G · general audiences' },
  { value: 'PG', label: 'PG · parental guidance' },
  { value: '12A', label: '12A / 12' },
  { value: 'PG-13', label: 'PG-13 · 13+' },
  { value: 'TV-14', label: 'TV-14 · 14+' },
  { value: '15', label: '15' },
  { value: 'R', label: 'R · 17+' },
  { value: 'TV-MA', label: 'TV-MA · mature' },
];

/** Signal to refresh profile-dependent UI after a switch or edit. */
export const PROFILES_CHANGED = 'mm:profiles-changed';
