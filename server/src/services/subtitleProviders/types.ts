/**
 * Subtitle provider contract. Built-in providers (OpenSubtitles, Subs.ro) and plugin providers
 * (`ctx.subtitles.registerProvider`) implement it; the registry fans searches out to the enabled ones.
 */

/** What we know about the title being searched. Ids are strings as stored in `external_ids` (imdb with its "tt"). */
export interface SubtitleQuery {
  item: { id: string; type: string; title: string; year: number | null };
  media: { id: string; path: string | null; size: number | null } | null;
  /** ISO 639-1 codes, lower case (e.g. ["ro", "en"]). Never empty. */
  languages: string[];
  /** The item's own ids (for an episode: the episode's ids, often missing). */
  imdbId: string | null;
  tmdbId: string | null;
  /** For episodes: the show's ids and title (most providers index series by the show). */
  showImdbId: string | null;
  showTmdbId: string | null;
  showTitle: string | null;
  season: number | null;
  episode: number | null;
  /** Movie title, or for an episode the show title. */
  title: string;
  year: number | null;
  /** Media file name without folders, e.g. "Show.S01E02.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv". */
  releaseName: string | null;
  /** OpenSubtitles movie hash of the media file, when it could be computed. */
  movieHash: string | null;
}

/** One search hit as a provider returns it (the registry adds provider id/name and a score). */
export interface ProviderSubtitle {
  /** Provider-specific id passed back to `download`. */
  id: string;
  /** ISO 639-1 where possible. */
  language: string;
  /** Release text (names of the releases the subtitle was made for), used for matching. */
  release: string | null;
  fileName?: string | null;
  downloads?: number;
  hearingImpaired?: boolean;
  forced?: boolean;
  aiTranslated?: boolean;
  rating?: number | null;
  /** The provider matched the media file's hash. */
  hashMatch?: boolean;
  /** Known archive type of the download, if the provider says. */
  archive?: 'zip' | 'rar' | '7z' | null;
  /** Anything else the provider needs at download time. */
  extra?: Record<string, unknown>;
}

export interface DownloadedFile {
  data: Buffer;
  /** File name as served (used to detect .zip/.rar/.srt/.ass), may be a guess. */
  fileName: string;
}

export interface SubtitleProvider {
  /** Stable id stored in settings and on downloaded files ("opensubtitles", "subsro", "<plugin>:<id>"). */
  id: string;
  name: string;
  /** False when credentials are missing: the provider is skipped silently. Default true. */
  configured?(): boolean;
  search(query: SubtitleQuery): Promise<ProviderSubtitle[]>;
  download(result: ProviderSubtitle): Promise<DownloadedFile>;
}
