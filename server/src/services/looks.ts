import type { HomeRowConfig, StarterLook } from '@mediamax/shared';
import { getBranding, updateBranding } from './branding.js';
import { BUILTIN_THEMES } from './themes.js';
import { notFound } from '../util/errors.js';

const row = (id: string, type: HomeRowConfig['type'], title = '', extra: Partial<HomeRowConfig> = {}): HomeRowConfig => ({ id, type, title, enabled: true, limit: 20, ...extra });

/** Starter looks: apply in one click from the Branding Studio, then fine-tune anything. */
export const STARTER_LOOKS: StarterLook[] = [
  {
    id: 'cinema', name: 'Home Cinema', themeId: 'cinema',
    description: 'Big artwork carousel, continue watching and next up first, plus action and comedy rows. For a movie-and-TV household.',
    homeRows: [row('hero', 'hero', '', { limit: 10 }), row('continue', 'continue', 'Continue Watching'), row('nextup', 'nextup', 'Next Up'), row('top10', 'top10', '', { limit: 10 }), row('recommended', 'recommended'), row('watchlist', 'watchlist', 'My List'), row('recent', 'library-recent'), row('because', 'because'), row('g-action', 'genre', 'Action & Adventure', { genre: 'Action' }), row('g-comedy', 'genre', 'Comedy', { genre: 'Comedy' }), row('favorites', 'favorites', 'Your Favourites')],
    features: {},
  },
  {
    id: 'family', name: 'Family & Kids', themeId: 'kids',
    description: 'Bright, friendly theme with big posters, a profile picker on the sign-in screen, and animation and family rows up front.',
    homeRows: [row('hero', 'hero', '', { limit: 6 }), row('continue', 'continue', 'Keep Watching'), row('recommended', 'recommended', 'Picked for you'), row('g-anim', 'genre', 'Cartoons & Animation', { genre: 'Animation' }), row('g-family', 'genre', 'Family Favourites', { genre: 'Family' }), row('favorites', 'favorites', 'Our Favourites'), row('recent', 'library-recent')],
    features: { profilePicker: true },
  },
  {
    id: 'music', name: 'Music Lover', themeId: 'velvet',
    description: 'Music first: favourites and new additions on top, genre rows, and the DJ ready to go.',
    homeRows: [row('continue', 'continue', 'Jump Back In'), row('favorites', 'favorites', 'Loved Tracks & Albums'), row('recent', 'library-recent'), row('g-pop', 'genre', 'Pop', { genre: 'Pop' }), row('g-rock', 'genre', 'Rock', { genre: 'Rock' }), row('g-electronic', 'genre', 'Electronic', { genre: 'Electronic' })],
    features: { music: true },
  },
  {
    id: 'livetv', name: 'Live TV & IPTV', themeId: 'stadium',
    description: 'What\'s on now and your favourite channels at the top, recordings next. For IPTV and sports fans.',
    homeRows: [row('live-now', 'live-now', 'On Now'), row('fav-ch', 'favorite-channels', 'Your Channels'), row('recordings', 'recordings', 'Recent Recordings'), row('continue', 'continue', 'Continue Watching'), row('recent', 'library-recent')],
    features: { liveTv: true, dvr: true, iptvVod: true },
  },
  {
    id: 'minimal', name: 'Minimal', themeId: 'slate',
    description: 'No hero banner, compact cards and just the essentials. Fast on older TVs and small screens.',
    homeRows: [row('continue', 'continue', 'Continue'), row('nextup', 'nextup', 'Next Up'), row('recent', 'library-recent')],
    features: {},
  },
  {
    id: 'accessible', name: 'Easy to See', themeId: 'contrast',
    description: 'High-contrast theme with a very legible font, large cards and a simple home screen.',
    homeRows: [row('continue', 'continue', 'Continue Watching'), row('nextup', 'nextup', 'Next Up'), row('favorites', 'favorites', 'Favourites'), row('recent', 'library-recent')],
    features: {},
  },
];

export function listLooks(): StarterLook[] {
  return STARTER_LOOKS;
}

export function applyLook(id: string) {
  const look = STARTER_LOOKS.find((l) => l.id === id);
  if (!look) throw notFound('Starter look not found');
  const cur = getBranding();
  return updateBranding({ baseThemeId: look.themeId, homeRows: look.homeRows, features: { ...cur.features, ...look.features } });
}

// Keep looks honest: every theme they reference must exist.
for (const l of STARTER_LOOKS) if (!BUILTIN_THEMES.some((t) => t.id === l.themeId)) throw new Error(`Starter look ${l.id} references unknown theme ${l.themeId}`);
