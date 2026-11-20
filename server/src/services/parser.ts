/**
 * Filename / folder-name parsing for movies, TV episodes and music.
 * Handles common naming used by Plex, Jellyfin, Emby, Kodi and scene releases.
 */

export const VIDEO_EXT = new Set(['mkv', 'mp4', 'm4v', 'avi', 'mov', 'wmv', 'ts', 'm2ts', 'mts', 'webm', 'flv', 'mpg', 'mpeg', 'vob', 'ogv', '3gp', 'divx', 'iso']);
export const AUDIO_EXT = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'wma', 'alac', 'aiff', 'ape', 'wv', 'dsf']);
export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'avif', 'bmp', 'tiff']);
export const SUB_EXT = new Set(['srt', 'vtt', 'ass', 'ssa', 'sub', 'smi']);

const JUNK = /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10\+?|hdr|dv|dovi|dolby[ .]?vision|bluray|blu-ray|bdrip|brrip|bdremux|remux|web[ .-]?dl|webrip|web|hdtv|dvdrip|dvd|hdrip|x264|x265|h\.?264|h\.?265|hevc|avc|av1|xvid|divx|aac(2\.0|5\.1)?|ac3|eac3|dts(-hd)?|truehd|atmos|ddp?5\.1|dd5\.1|5\.1|7\.1|10bit|8bit|proper|repack|extended|unrated|directors[ .]cut|imax|multi|subbed|dubbed|internal|limited|amzn|nf|dsnp|hmax|atvp|criterion)\b.*$/i;

export function ext(p: string): string {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i + 1).toLowerCase();
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? name : name.slice(0, i);
}

function cleanTitle(s: string): string {
  return s
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/[._]/g, ' ')
    .replace(JUNK, '')
    .replace(/\s+-\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface ParsedMovie {
  title: string;
  year: number | null;
  /** Edition/part tags such as "Director's Cut" or "Part 1". */
  edition: string | null;
  tmdbId: string | null;
  imdbId: string | null;
}

/** Parses "Movie Title (2010)", "Movie.Title.2010.1080p.BluRay", "Title [tmdbid-123]" etc. */
export function parseMovieName(name: string): ParsedMovie {
  let s = stripExt(name);
  const tmdb = s.match(/[[{(]tmdb(?:id)?[-=](\d+)[\]})]/i)?.[1] ?? null;
  const imdb = s.match(/\b(tt\d{7,9})\b/i)?.[1] ?? null;
  const edition = s.match(/\{edition-([^}]+)\}/i)?.[1] ?? s.match(/\b(director'?s cut|extended edition|theatrical cut|ultimate edition)\b/i)?.[1] ?? null;
  s = s.replace(/[[{(](tmdb|imdb|tvdb)(id)?[-=][^\]})]+[\]})]/gi, ' ').replace(/\{edition-[^}]+\}/gi, ' ');
  // "Title (2010)" or "Title [2010]"
  let m = s.match(/^(.*?)[\s._]*[([](\d{4})[)\]]/);
  if (m && +m[2] > 1880 && +m[2] < 2100) return { title: cleanTitle(m[1]) || cleanTitle(s), year: +m[2], edition, tmdbId: tmdb, imdbId: imdb };
  // "Title.2010.1080p"
  m = s.match(/^(.*?)[\s._-]+((?:19|20)\d{2})(?=[\s._-]|$)/);
  if (m && cleanTitle(m[1])) return { title: cleanTitle(m[1]), year: +m[2], edition, tmdbId: tmdb, imdbId: imdb };
  return { title: cleanTitle(s), year: null, edition, tmdbId: tmdb, imdbId: imdb };
}

export interface ParsedEpisode {
  season: number | null;
  episode: number | null;
  /** Multi-episode files (S01E01E02 / S01E01-E03). */
  episodeEnd: number | null;
  title: string | null;
  /** Show name guessed from the filename (fallback when folders are flat). */
  show: string | null;
  airDate: string | null;
}

export function parseEpisodeName(name: string): ParsedEpisode {
  const s = stripExt(name);
  // S01E02, S01E02E03, S01E02-E03, s1e2
  let m = s.match(/^(.*?)[\s._-]*s(\d{1,4})[\s._-]*e(\d{1,4})(?:[\s._-]*-?e?(\d{1,4}))?(.*)$/i);
  if (m) {
    const end = m[4] && +m[4] > +m[3] ? +m[4] : null;
    return { show: cleanTitle(m[1]) || null, season: +m[2], episode: +m[3], episodeEnd: end, title: epTitle(m[5]), airDate: null };
  }
  // 1x02
  m = s.match(/^(.*?)[\s._-]*\b(\d{1,2})x(\d{1,3})\b(.*)$/i);
  if (m) return { show: cleanTitle(m[1]) || null, season: +m[2], episode: +m[3], episodeEnd: null, title: epTitle(m[4]), airDate: null };
  // Daily shows: 2024-03-01 / 2024.03.01
  m = s.match(/^(.*?)[\s._-]*((?:19|20)\d{2})[.\-_ ](\d{2})[.\-_ ](\d{2})(.*)$/);
  if (m) return { show: cleanTitle(m[1]) || null, season: +m[2], episode: +(m[3] + m[4]), episodeEnd: null, title: epTitle(m[5]), airDate: `${m[2]}-${m[3]}-${m[4]}` };
  // "Episode 5" / "Ep05" / "E05"
  m = s.match(/^(.*?)[\s._-]*\b(?:episode|ep|e)[\s._-]?(\d{1,4})\b(.*)$/i);
  if (m) return { show: cleanTitle(m[1]) || null, season: null, episode: +m[2], episodeEnd: null, title: epTitle(m[3]), airDate: null };
  // Leading number: "05 - Title"
  m = s.match(/^(\d{1,3})(?:\s*[-.]\s*|\s+)(.+)$/);
  if (m) return { show: null, season: null, episode: +m[1], episodeEnd: null, title: epTitle(m[2]), airDate: null };
  return { show: null, season: null, episode: null, episodeEnd: null, title: cleanTitle(s) || null, airDate: null };
}

function epTitle(rest: string | undefined): string | null {
  if (!rest) return null;
  const t = cleanTitle(rest.replace(/^[\s._-]+/, ''));
  return t || null;
}

/** "Season 01", "S01", "Series 2", "Specials" → number. */
export function parseSeasonFolder(name: string): number | null {
  if (/^(specials?|extras?|season 0+)$/i.test(name.trim())) return 0;
  const m = name.match(/^(?:season|series|staffel|saison|temporada|s)[\s._-]*(\d{1,4})\b/i) ?? name.match(/^(\d{1,2})$/);
  return m ? +m[1] : null;
}

export function parseShowFolder(name: string): { title: string; year: number | null; tvdbId: string | null; tmdbId: string | null } {
  const tvdb = name.match(/[[{(]tvdb(?:id)?[-=](\d+)[\]})]/i)?.[1] ?? null;
  const tmdb = name.match(/[[{(]tmdb(?:id)?[-=](\d+)[\]})]/i)?.[1] ?? null;
  const cleaned = name.replace(/[[{(](tmdb|imdb|tvdb)(id)?[-=][^\]})]+[\]})]/gi, ' ');
  const m = cleaned.match(/^(.*?)\s*[([](\d{4})[)\]]/);
  if (m) return { title: cleanTitle(m[1]), year: +m[2], tvdbId: tvdb, tmdbId: tmdb };
  return { title: cleanTitle(cleaned), year: null, tvdbId: tvdb, tmdbId: tmdb };
}

/** Extras / samples that should not become library items. */
export function isExtra(relPath: string): boolean {
  return /(^|[\\/])(extras?|featurettes?|behind the scenes|deleted scenes|interviews?|scenes|shorts|trailers?|samples?|other|@eaDir|\.[^\\/]+)([\\/]|$)/i.test(relPath)
    || /[-._ ](sample|trailer)$/i.test(stripExt(relPath.split(/[\\/]/).pop() ?? ''));
}

/** Sidecar subtitle language from "Movie.en.forced.srt" style names. */
export function parseSubtitleName(file: string, videoBase: string): { language: string | null; forced: boolean; default: boolean; title: string | null } | null {
  const base = stripExt(file);
  if (!base.toLowerCase().startsWith(videoBase.toLowerCase())) return null;
  const tags = base.slice(videoBase.length).split(/[._ -]+/).filter(Boolean).map((t) => t.toLowerCase());
  let language: string | null = null;
  let forced = false;
  let def = false;
  const rest: string[] = [];
  for (const t of tags) {
    if (t === 'forced' || t === 'foreign') forced = true;
    else if (t === 'default') def = true;
    else if (t === 'sdh' || t === 'cc' || t === 'hi') rest.push('SDH');
    else if (!language && /^[a-z]{2,3}(-[a-z]{2})?$/.test(t)) language = t;
    else rest.push(t);
  }
  return { language, forced, default: def, title: rest.length ? rest.join(' ') : null };
}
