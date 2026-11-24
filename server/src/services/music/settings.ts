import type { MusicSettings } from '@mediamax/shared';
import { getKv, setKv, SECRET_MASK } from '../settings.js';

/** Music identification settings (Server settings → Metadata → Music identification), stored under the `music` key. */

export const DEFAULT_MUSIC_SETTINGS: MusicSettings = {
  acoustid: { apiKey: process.env.ACOUSTID_API_KEY ?? null, autoIdentify: false, autoApplyScore: 0 },
  missingHide: { singles: true, eps: false, compilations: true, live: true, other: true },
};

let cache: MusicSettings | null = null;

export function getMusicSettings(): MusicSettings {
  if (cache) return cache;
  const s = getKv<Partial<MusicSettings>>('music', {});
  cache = {
    acoustid: { ...DEFAULT_MUSIC_SETTINGS.acoustid, ...(s.acoustid ?? {}) },
    missingHide: { ...DEFAULT_MUSIC_SETTINGS.missingHide, ...(s.missingHide ?? {}) },
  };
  return cache;
}

export function publicMusicSettings(s = getMusicSettings()): MusicSettings {
  return { ...s, acoustid: { ...s.acoustid, apiKey: s.acoustid.apiKey ? SECRET_MASK : null } };
}

export function updateMusicSettings(patch: Partial<MusicSettings>): MusicSettings {
  const cur = getMusicSettings();
  const a = patch.acoustid ?? ({} as Partial<MusicSettings['acoustid']>);
  const key = a.apiKey === undefined || a.apiKey === SECRET_MASK ? cur.acoustid.apiKey : typeof a.apiKey === 'string' && a.apiKey.trim() ? a.apiKey.trim().slice(0, 100) : null;
  const score = a.autoApplyScore === undefined ? cur.acoustid.autoApplyScore : Math.max(0, Math.min(1, Number(a.autoApplyScore) || 0));
  const h: Partial<MusicSettings['missingHide']> = patch.missingHide ?? {};
  const next: MusicSettings = {
    acoustid: { apiKey: key, autoIdentify: a.autoIdentify === undefined ? cur.acoustid.autoIdentify : !!a.autoIdentify, autoApplyScore: score },
    missingHide: {
      singles: h.singles === undefined ? cur.missingHide.singles : !!h.singles,
      eps: h.eps === undefined ? cur.missingHide.eps : !!h.eps,
      compilations: h.compilations === undefined ? cur.missingHide.compilations : !!h.compilations,
      live: h.live === undefined ? cur.missingHide.live : !!h.live,
      other: h.other === undefined ? cur.missingHide.other : !!h.other,
    },
  };
  setKv('music', next);
  cache = next;
  return next;
}
