/**
 * Bandwidth probe for the native apps' "Auto" quality: a timed download from GET /playback/bandwidth-test, remembered
 * per server for 10 minutes. The estimate is sent as `measuredBandwidth`; with `adaptive: true` the server answers a
 * transcode with a multi-variant HLS master playlist, which AVPlayer (iOS/tvOS) and ExoPlayer (Android/Android TV)
 * then adapt over natively while playing (renditions are encoded lazily on the server).
 *
 * React Native's fetch can't stream the body, so latency is cancelled out by timing two sizes:
 * throughput = (big − small) bytes / (t_big − t_small).
 */
import type { MediaMaxClient } from '@/api/client';
import { getJSON, setJSON } from '@/api/storage';

const KEY = 'mm.bandwidth';
const FRESH_MS = 10 * 60 * 1000;
const memory = new Map<string, { bps: number; at: number }>();

async function timed(api: MediaMaxClient, bytes: number, signal: AbortSignal): Promise<{ bytes: number; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(api.absolute(`/api/v1/playback/bandwidth-test?bytes=${bytes}&_=${t0}`), { headers: api.headers(false), signal });
  if (!res.ok) throw new Error(`bandwidth test ${res.status}`);
  const buf = await res.arrayBuffer();
  return { bytes: buf.byteLength, ms: Math.max(1, Date.now() - t0) };
}

export async function rememberedBandwidth(api: MediaMaxClient): Promise<number | null> {
  const m = memory.get(api.baseUrl);
  if (m && Date.now() - m.at < FRESH_MS) return m.bps;
  const all = await getJSON<Record<string, { bps: number; at: number }>>(KEY, {});
  const s = all[api.baseUrl];
  if (s && Date.now() - s.at < FRESH_MS) {
    memory.set(api.baseUrl, s);
    return s.bps;
  }
  return null;
}

async function remember(api: MediaMaxClient, bps: number) {
  const entry = { bps: Math.round(bps), at: Date.now() };
  memory.set(api.baseUrl, entry);
  const all = await getJSON<Record<string, { bps: number; at: number }>>(KEY, {});
  all[api.baseUrl] = entry;
  await setJSON(KEY, all).catch(() => undefined);
}

/** Throughput in bits/s (remembered value when fresh), or null when the probe fails / times out. */
export async function measureBandwidth(api: MediaMaxClient, timeoutMs = 2500): Promise<number | null> {
  const known = await rememberedBandwidth(api);
  if (known) return known;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const small = await timed(api, 64 * 1024, ctrl.signal);
    // Size the second request from the first (≈ 0.6 s of transfer), 256 KB … 12 MB.
    const guess = (small.bytes * 8 * 1000) / small.ms;
    const size = Math.max(256 * 1024, Math.min(12 * 1024 * 1024, Math.round((guess / 8) * 0.6)));
    const big = await timed(api, size, ctrl.signal);
    const dt = big.ms - small.ms;
    const bps = dt > 20 ? ((big.bytes - small.bytes) * 8 * 1000) / dt : (big.bytes * 8 * 1000) / big.ms;
    await remember(api, bps);
    return bps;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
