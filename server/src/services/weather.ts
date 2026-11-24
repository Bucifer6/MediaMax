/**
 * Current weather for the radio host's weather slot, from Open-Meteo (no key; data CC BY 4.0, free for
 * non-commercial use). Only used when an admin set a location in Admin → AI; cached for 30 minutes (memory + DB),
 * so a whole server makes at most two requests an hour. Failures are silent (the slot is just skipped).
 */
import type { AiWeatherLocation } from '@mediamax/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { getSettings } from './settings.js';
import { logger } from '../util/log.js';

const log = logger('weather');
const TTL = 30 * 60000;

export interface Weather {
  place: string;
  tempC: number;
  description: string;
  /** e.g. rain / snow / sun, for phrasing. */
  kind: 'clear' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm';
  at: string;
}

// WMO weather interpretation codes (Open-Meteo docs).
function describe(code: number): { description: string; kind: Weather['kind'] } {
  if (code === 0) return { description: 'clear skies', kind: 'clear' };
  if (code <= 2) return { description: 'partly cloudy', kind: 'cloudy' };
  if (code === 3) return { description: 'overcast', kind: 'cloudy' };
  if (code === 45 || code === 48) return { description: 'foggy', kind: 'fog' };
  if (code >= 51 && code <= 57) return { description: 'drizzle', kind: 'rain' };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { description: 'rain', kind: 'rain' };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { description: 'snow', kind: 'snow' };
  if (code >= 95) return { description: 'thunderstorms', kind: 'storm' };
  return { description: 'mixed weather', kind: 'cloudy' };
}

export const weatherLocation = (): AiWeatherLocation | null => getSettings().ai?.weatherLocation ?? null;

let mem: { key: string; w: Weather; at: number } | null = null;
let inflight: Promise<Weather | null> | null = null;
let failedAt = 0;

/** Current weather at the configured location, or null (not configured, or unavailable right now). */
export async function currentWeather(): Promise<Weather | null> {
  const loc = weatherLocation();
  if (!loc) return null; // nothing configured: never any outbound request
  const key = `weather:${loc.lat},${loc.lon}`;
  if (mem && mem.key === key && Date.now() - mem.at < TTL) return mem.w;
  const row = db.get<{ data: string; fetched_at: string }>('SELECT data, fetched_at FROM dj_cache WHERE key = ?', key);
  if (row && Date.now() - Date.parse(row.fetched_at) < TTL) {
    try {
      const w = { ...(JSON.parse(row.data) as Weather), place: loc.name };
      mem = { key, w, at: Date.parse(row.fetched_at) };
      return w;
    } catch {
      /* refetch */
    }
  }
  if (inflight) return inflight;
  if (Date.now() - failedAt < 5 * 60000) return null;
  inflight = (async () => {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code&timezone=auto`;
      const res = await fetch(url, { headers: { 'User-Agent': `Vibe/${config.version} (self-hosted media server)`, Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { current?: { temperature_2m?: number; weather_code?: number } };
      const t = j.current?.temperature_2m;
      const c = j.current?.weather_code;
      if (typeof t !== 'number' || typeof c !== 'number') throw new Error('no current weather in the reply');
      const w: Weather = { place: loc.name, tempC: Math.round(t), ...describe(c), at: new Date().toISOString() };
      mem = { key, w, at: Date.now() };
      db.run('INSERT INTO dj_cache (key, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at', key, JSON.stringify(w), w.at);
      return w;
    } catch (e) {
      log.info(`Weather unavailable (${(e as Error).message}); the host skips the weather`);
      failedAt = Date.now(); // don't retry for a few minutes
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Tests. */
export const resetWeatherCache = () => {
  mem = null;
  failedAt = 0;
};
