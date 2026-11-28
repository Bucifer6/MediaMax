import { USER_AGENT } from '../../../util/userAgent.js';
/**
 * Schedules Direct JSON API client (API version 20141201).
 *
 * Follows SD's published client rules:
 *  - one token per 24 hours: the token is cached in the guide source's state and only renewed when it is
 *    older than ~23 h or the server says it expired (code 4006);
 *  - schedules are fetched only for station/dates whose md5 changed (POST /schedules/md5 first);
 *  - programmes are fetched only when their md5 changed;
 *  - at most 5000 stations / programme ids per request, requests are sequential (no parallel hammering);
 *  - a descriptive User-Agent on every request.
 */
import crypto from 'node:crypto';

export const SD_DEFAULT_BASE = 'https://json.schedulesdirect.org/20141201';
/** Overridable for tests and self-hosted mirrors. */
export const sdBase = () => (process.env.MEDIAMAX_SD_URL || SD_DEFAULT_BASE).replace(/\/+$/, '');
export const SD_USER_AGENT = `${USER_AGENT} (self-hosted media server)`;
export const SD_BATCH = 5000;
export const SD_ARTWORK_BATCH = 500;
const TOKEN_TTL_MS = 23 * 3600000;

export const sha1Hex = (s: string) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');

export class SdError extends Error {
  constructor(readonly code: number, message: string, readonly status = 0) {
    super(message);
  }
}

export interface SdTokenState {
  token?: string | null;
  tokenAt?: number | null;
}

export interface SdStationMapEntry {
  stationID: string;
  channel?: string;
  atscMajor?: number;
  atscMinor?: number;
  uhfVhf?: number;
  channelMajor?: number;
  channelMinor?: number;
}

export interface SdStation {
  stationID: string;
  name?: string;
  callsign?: string;
  affiliate?: string;
  logo?: { URL?: string };
  stationLogo?: { URL?: string }[];
}

export interface SdLineupDetail {
  map: SdStationMapEntry[];
  stations: SdStation[];
  metadata?: { lineup?: string; modified?: string; transport?: string };
}

export interface SdAiring {
  programID: string;
  airDateTime: string;
  duration: number;
  md5: string;
  new?: boolean;
  liveTapeDelay?: string;
}

export interface SdProgram {
  programID: string;
  md5?: string;
  titles?: { title120?: string }[];
  episodeTitle150?: string;
  descriptions?: { description1000?: { description: string }[]; description100?: { description: string }[] };
  genres?: string[];
  originalAirDate?: string;
  metadata?: { Gracenote?: { season?: number; episode?: number } }[];
  hasImageArtwork?: boolean;
  code?: number;
}

export class SdClient {
  constructor(
    private readonly o: {
      username: string;
      passwordHash: string;
      getToken: () => SdTokenState;
      saveToken: (t: SdTokenState) => void;
      base?: string;
    },
  ) {}

  /** Number of HTTP requests made (for tests and logs). */
  requests = 0;
  private get base() {
    return (this.o.base ?? sdBase()).replace(/\/+$/, '');
  }

  async token(force = false): Promise<string> {
    const t = this.o.getToken();
    if (!force && t.token && t.tokenAt && Date.now() - t.tokenAt < TOKEN_TTL_MS) return t.token;
    if (!this.o.username || !this.o.passwordHash) throw new SdError(4003, 'Schedules Direct username and password are required');
    const r = await this.raw<{ code: number; message?: string; token?: string }>('POST', '/token', { username: this.o.username, password: this.o.passwordHash }, null);
    if (r.code !== 0 || !r.token) throw new SdError(r.code, `Schedules Direct login failed: ${r.message ?? `code ${r.code}`}`);
    this.o.saveToken({ token: r.token, tokenAt: Date.now() });
    return r.token;
  }

  private async raw<T>(method: string, path: string, body: unknown, token: string | null): Promise<T> {
    this.requests++;
    const res = await fetch(this.base + path, {
      method,
      headers: { 'User-Agent': SD_USER_AGENT, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(180000),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new SdError(-1, `Schedules Direct returned HTTP ${res.status} (not JSON)`, res.status);
    }
    if (!res.ok || (json && !Array.isArray(json) && typeof json.code === 'number' && json.code !== 0 && path !== '/token')) {
      const code = typeof json?.code === 'number' ? json.code : -1;
      throw new SdError(code, `Schedules Direct: ${json?.message ?? json?.response ?? `HTTP ${res.status}`}${code > 0 ? ` (code ${code})` : ''}`, res.status);
    }
    return json as T;
  }

  /** Authenticated request; on TOKEN_EXPIRED / INVALID_TOKEN (4006/4005) renew once and retry. */
  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const tok = await this.token();
    try {
      return await this.raw<T>(method, path, body, tok);
    } catch (e) {
      if (e instanceof SdError && (e.code === 4006 || e.code === 4005)) return this.raw<T>(method, path, body, await this.token(true));
      throw e;
    }
  }

  status() {
    return this.req<{
      account?: { expires?: string; maxLineups?: number; messages?: { msgID?: string; message?: string }[] };
      lineups?: { lineup: string; modified?: string; uri?: string; isDeleted?: boolean; name?: string; transport?: string; location?: string }[];
      lastDataUpdate?: string;
      systemStatus?: { date?: string; status?: string; message?: string }[];
      notifications?: unknown[];
    }>('GET', '/status');
  }

  headends(country: string, postalcode: string) {
    return this.req<{ headend: string; transport: string; location: string; lineups: { name: string; lineup: string; uri?: string }[] }[]>(
      'GET', `/headends?country=${encodeURIComponent(country)}&postalcode=${encodeURIComponent(postalcode)}`);
  }

  addLineup(lineup: string) {
    return this.req<{ response?: string; code: number; changesRemaining?: number; message?: string }>('PUT', `/lineups/${encodeURIComponent(lineup)}`);
  }

  removeLineup(lineup: string) {
    return this.req<{ response?: string; code: number; changesRemaining?: number; message?: string }>('DELETE', `/lineups/${encodeURIComponent(lineup)}`);
  }

  async lineups() {
    try {
      const r = await this.req<{ lineups?: { lineup: string; name: string; transport: string; location: string; isDeleted?: boolean }[] }>('GET', '/lineups');
      return r.lineups ?? [];
    } catch (e) {
      if (e instanceof SdError && e.code === 4102) return []; // NO_LINEUPS
      throw e;
    }
  }

  lineup(lineup: string) {
    return this.req<SdLineupDetail>('GET', `/lineups/${encodeURIComponent(lineup)}`);
  }

  /** station → date → md5, in batches of 5000 stations. */
  async scheduleMd5(stationIds: string[], dates: string[]): Promise<Record<string, Record<string, { code: number; md5: string; lastModified?: string }>>> {
    const out: Record<string, Record<string, { code: number; md5: string }>> = {};
    for (let i = 0; i < stationIds.length; i += SD_BATCH) {
      const body = stationIds.slice(i, i + SD_BATCH).map((stationID) => ({ stationID, date: dates }));
      Object.assign(out, await this.req<Record<string, Record<string, { code: number; md5: string }>>>('POST', '/schedules/md5', body));
    }
    return out;
  }

  /** Schedules for the given station → dates, in batches of 5000 stations. */
  async schedules(want: Map<string, string[]>): Promise<{ stationID: string; programs?: SdAiring[]; metadata?: { md5?: string; startDate?: string }; code?: number }[]> {
    const entries = [...want.entries()];
    const out: any[] = [];
    for (let i = 0; i < entries.length; i += SD_BATCH) {
      const body = entries.slice(i, i + SD_BATCH).map(([stationID, date]) => ({ stationID, date }));
      out.push(...(await this.req<any[]>('POST', '/schedules', body)));
    }
    return out;
  }

  /** Programme details, in batches of 5000 ids. */
  async programs(ids: string[]): Promise<SdProgram[]> {
    const out: SdProgram[] = [];
    for (let i = 0; i < ids.length; i += SD_BATCH) out.push(...(await this.req<SdProgram[]>('POST', '/programs', ids.slice(i, i + SD_BATCH))));
    return out;
  }

  /** Artwork for programme roots (first 10 characters of a programID), in batches of 500. */
  async artwork(roots: string[]): Promise<{ programID: string; data?: { uri: string; width?: string | number; height?: string | number; category?: string; aspect?: string }[] | { errorCode?: number } }[]> {
    const out: any[] = [];
    for (let i = 0; i < roots.length; i += SD_ARTWORK_BATCH) out.push(...(await this.req<any[]>('POST', '/metadata/programs/', roots.slice(i, i + SD_ARTWORK_BATCH))));
    return out;
  }
}

/** "7.1" for antenna maps, the cable channel otherwise. */
export function sdChannelNumber(m: SdStationMapEntry): string | null {
  if (m.atscMajor != null) return `${m.atscMajor}.${m.atscMinor ?? 0}`;
  if (m.channelMajor != null) return `${m.channelMajor}.${m.channelMinor ?? 0}`;
  if (m.channel) return m.channel.replace(/^0+(?=\d)/, '');
  if (m.uhfVhf != null) return String(m.uhfVhf);
  return null;
}

/** Choose a 16:9 or 4:3 image (banner/iconic) from SD artwork; only absolute URLs are usable without a token. */
export function pickArtwork(data: { uri: string; width?: string | number; height?: string | number; category?: string; aspect?: string }[]): string | null {
  const usable = data.filter((d) => /^https?:\/\//.test(d.uri));
  const pref = ['Iconic', 'Banner-L1', 'Banner-L2', 'Banner', 'Logo'];
  const rank = (c?: string) => {
    const i = pref.indexOf(c ?? '');
    return i < 0 ? 99 : i;
  };
  usable.sort((a, b) => rank(a.category) - rank(b.category) || Number(b.width ?? 0) - Number(a.width ?? 0));
  const best = usable.find((d) => d.aspect === '16x9' || d.aspect === '4x3') ?? usable[0];
  return best?.uri ?? null;
}

export function sdEpisodeNum(p: SdProgram): string | null {
  const g = p.metadata?.find((m) => m.Gracenote)?.Gracenote;
  if (g?.season && g?.episode) return `S${String(g.season).padStart(2, '0')}E${String(g.episode).padStart(2, '0')}`;
  if (g?.episode) return `E${g.episode}`;
  return null;
}
