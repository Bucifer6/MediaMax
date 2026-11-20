import type { ArtworkTarget, BuiltinProviderId, MetadataProviderConfig, MetadataProviderId, MetadataSettings } from '@mediamax/shared';
import { getKv, setKv, SECRET_MASK } from '../settings.js';
import { setDefaultCacheTtl } from './http.js';

/** Built-in metadata provider settings live in their own settings key (`metadata`), edited on Server settings → Metadata. */

export const BUILTIN_IDS: BuiltinProviderId[] = ['tvdb', 'fanart', 'audiodb', 'audnexus', 'openlibrary', 'googlebooks', 'lrclib', 'omdb', 'musicbrainz'];
export const ALL_IDS: MetadataProviderId[] = ['tmdb', ...BUILTIN_IDS];
const TARGETS: ArtworkTarget[] = ['movie', 'show', 'artist', 'album', 'audiobook'];

/** Keyless providers are on by default; the ones that need a key are off until one is entered. */
export const DEFAULT_METADATA_SETTINGS: MetadataSettings = {
  providers: {
    tvdb: { enabled: false, apiKey: process.env.TVDB_API_KEY ?? null, pin: null },
    fanart: { enabled: false, apiKey: process.env.FANART_API_KEY ?? null },
    audiodb: { enabled: false, apiKey: process.env.AUDIODB_API_KEY ?? null },
    audnexus: { enabled: true, apiKey: null },
    openlibrary: { enabled: true, apiKey: null },
    googlebooks: { enabled: true, apiKey: process.env.GOOGLE_BOOKS_API_KEY ?? null },
    lrclib: { enabled: true, apiKey: null },
    omdb: { enabled: false, apiKey: process.env.OMDB_API_KEY ?? null },
    musicbrainz: { enabled: true, apiKey: null },
  },
  // IDs first (MusicBrainz MBIDs feed fanart.tv/TheAudioDB), then art and text sources.
  order: ['tmdb', 'tvdb', 'musicbrainz', 'audnexus', 'omdb', 'fanart', 'audiodb', 'googlebooks', 'openlibrary', 'lrclib'],
  artwork: { movie: 'auto', show: 'auto', artist: 'auto', album: 'auto', audiobook: 'auto' },
  cacheTtlHours: 24 * 7,
};

let cache: MetadataSettings | null = null;

function normOrder(order: unknown): MetadataProviderId[] {
  const list = Array.isArray(order) ? order.filter((x): x is MetadataProviderId => ALL_IDS.includes(x as MetadataProviderId)) : [];
  const seen = [...new Set(list)];
  // Providers missing from a stored order (new in an update) go where the default puts them.
  for (const id of DEFAULT_METADATA_SETTINGS.order) if (!seen.includes(id)) seen.push(id);
  return seen;
}

export function getMetadataSettings(): MetadataSettings {
  if (cache) return cache;
  const stored = getKv<Partial<MetadataSettings>>('metadata', {});
  const providers = {} as MetadataSettings['providers'];
  for (const id of BUILTIN_IDS) providers[id] = { ...DEFAULT_METADATA_SETTINGS.providers[id], ...(stored.providers?.[id] ?? {}) };
  const artwork = { ...DEFAULT_METADATA_SETTINGS.artwork };
  for (const t of TARGETS) {
    const v = stored.artwork?.[t];
    if (v === 'auto' || ALL_IDS.includes(v as MetadataProviderId)) artwork[t] = v!;
  }
  cache = {
    providers,
    order: normOrder(stored.order),
    artwork,
    cacheTtlHours: Number.isFinite(stored.cacheTtlHours) ? Math.max(0, Math.min(24 * 90, Number(stored.cacheTtlHours))) : DEFAULT_METADATA_SETTINGS.cacheTtlHours,
  };
  setDefaultCacheTtl(cache.cacheTtlHours);
  return cache;
}

/** As sent to the admin UI: keys and PINs are write-only. */
export function publicMetadataSettings(s: MetadataSettings = getMetadataSettings()): MetadataSettings {
  const providers = {} as MetadataSettings['providers'];
  for (const id of BUILTIN_IDS) {
    const p = s.providers[id];
    providers[id] = { ...p, apiKey: p.apiKey ? SECRET_MASK : null, ...(p.pin !== undefined ? { pin: p.pin ? SECRET_MASK : null } : {}) };
  }
  return { ...s, providers };
}

const secret = (v: unknown, cur: string | null | undefined): string | null => {
  if (v === undefined) return cur ?? null;
  if (v === SECRET_MASK) return cur ?? null;
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null;
};

export function updateMetadataSettings(patch: Partial<MetadataSettings>): MetadataSettings {
  const cur = getMetadataSettings();
  const providers = { ...cur.providers };
  for (const id of BUILTIN_IDS) {
    const p = patch.providers?.[id] as Partial<MetadataProviderConfig> | undefined;
    if (!p) continue;
    providers[id] = {
      ...cur.providers[id],
      enabled: p.enabled !== undefined ? !!p.enabled : cur.providers[id].enabled,
      apiKey: secret(p.apiKey, cur.providers[id].apiKey),
      ...(id === 'tvdb' ? { pin: secret(p.pin, cur.providers[id].pin) } : {}),
    };
  }
  const artwork = { ...cur.artwork };
  for (const t of TARGETS) {
    const v = patch.artwork?.[t];
    if (v === 'auto' || ALL_IDS.includes(v as MetadataProviderId)) artwork[t] = v!;
  }
  const next: MetadataSettings = {
    providers,
    order: patch.order !== undefined ? normOrder(patch.order) : cur.order,
    artwork,
    cacheTtlHours: patch.cacheTtlHours !== undefined && Number.isFinite(Number(patch.cacheTtlHours)) ? Math.max(0, Math.min(24 * 90, Math.round(Number(patch.cacheTtlHours)))) : cur.cacheTtlHours,
  };
  setKv('metadata', next);
  cache = next;
  setDefaultCacheTtl(next.cacheTtlHours);
  return next;
}

/** Forget the in-memory copy (tests, backup restore). */
export const resetMetadataSettingsCache = () => (cache = null);

export function providerConfig(id: BuiltinProviderId): MetadataProviderConfig {
  return getMetadataSettings().providers[id];
}
