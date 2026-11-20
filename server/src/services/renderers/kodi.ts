import type { DriverStatus, LoadMedia, RendererDriver } from './driver.js';
import { deviceFetch } from './lan.js';

export interface KodiTarget {
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
}

interface KodiTime { hours: number; minutes: number; seconds: number; milliseconds: number }
const toMs = (t: KodiTime | undefined | null) => (t ? ((t.hours * 60 + t.minutes) * 60 + t.seconds) * 1000 + (t.milliseconds ?? 0) : null);
const toTime = (ms: number): KodiTime => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return { hours: Math.floor(s / 3600), minutes: Math.floor((s % 3600) / 60), seconds: s % 60, milliseconds: Math.max(0, Math.floor(ms)) % 1000 };
};

export class KodiError extends Error {}

/** Kodi over JSON-RPC (HTTP POST /jsonrpc, optional basic auth). Kodi plays nearly everything, so it gets the original file. */
export class KodiDriver implements RendererDriver {
  private seq = 0;
  private lastUrl: string | null = null;

  constructor(readonly t: KodiTarget) {}

  async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const host = this.t.host.includes(':') ? `[${this.t.host}]` : this.t.host;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.t.username) headers.Authorization = `Basic ${Buffer.from(`${this.t.username}:${this.t.password ?? ''}`).toString('base64')}`;
    const res = await deviceFetch(`http://${host}:${this.t.port}/jsonrpc`, this.t.host, {
      method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.seq, method, params }), timeoutMs: 6000,
    });
    if (res.status === 401) throw new KodiError('Kodi rejected the username or password');
    if (!res.ok) throw new KodiError(`Kodi returned HTTP ${res.status}`);
    const j = (await res.json()) as { result?: T; error?: { message?: string; code?: number } };
    if (j.error) throw new KodiError(`Kodi: ${j.error.message ?? 'error'} (${method})`);
    return j.result as T;
  }

  private async playerId(): Promise<number | null> {
    const players = await this.rpc<{ playerid: number; type: string }[]>('Player.GetActivePlayers');
    return (players.find((p) => p.type === 'video') ?? players.find((p) => p.type === 'audio') ?? players[0])?.playerid ?? null;
  }

  /** Check the connection (used when an admin adds Kodi). Returns the device name. */
  async probe(): Promise<string> {
    await this.rpc('JSONRPC.Ping');
    const r = await this.rpc<{ name?: string }>('Application.GetProperties', { properties: ['name'] }).catch(() => ({} as { name?: string }));
    const host = await this.rpc<{ 'System.FriendlyName'?: string }>('XBMC.GetInfoLabels', { labels: ['System.FriendlyName'] }).catch(() => ({} as Record<string, string>));
    return host['System.FriendlyName'] || r.name || 'Kodi';
  }

  async load(m: LoadMedia): Promise<void> {
    this.lastUrl = m.url;
    await this.rpc('Player.Open', { item: { file: m.url } });
    // Wait for the player to start, then seek and add the subtitle.
    let pid: number | null = null;
    for (let i = 0; i < 20 && pid == null; i++) {
      pid = await this.playerId().catch(() => null);
      if (pid == null) await new Promise((r) => setTimeout(r, 400));
    }
    if (pid == null) return;
    if (m.startMs > 1000 && m.seekable) await this.seek(m.startMs).catch(() => undefined);
    if (m.subtitleUrl) await this.rpc('Player.AddSubtitle', { playerid: pid, subtitle: m.subtitleUrl }).catch(() => undefined);
  }

  async play() {
    const pid = await this.playerId();
    if (pid != null) await this.rpc('Player.PlayPause', { playerid: pid, play: true });
  }

  async pause() {
    const pid = await this.playerId();
    if (pid != null) await this.rpc('Player.PlayPause', { playerid: pid, play: false });
  }

  async stop() {
    const pid = await this.playerId();
    if (pid != null) await this.rpc('Player.Stop', { playerid: pid });
  }

  async seek(ms: number) {
    const pid = await this.playerId();
    if (pid == null) return;
    try {
      await this.rpc('Player.Seek', { playerid: pid, value: { time: toTime(ms) } }); // Kodi 19+
    } catch {
      await this.rpc('Player.Seek', { playerid: pid, value: toTime(ms) }); // Kodi 18
    }
  }

  async status(): Promise<DriverStatus> {
    const pid = await this.playerId();
    if (pid == null) return { state: 'stopped', positionMs: null, durationMs: null, uri: null, track: null };
    const p = await this.rpc<{ time?: KodiTime; totaltime?: KodiTime; speed?: number }>('Player.GetProperties', { playerid: pid, properties: ['time', 'totaltime', 'speed'] });
    const item = await this.rpc<{ item?: { file?: string } }>('Player.GetItem', { playerid: pid, properties: ['file'] }).catch(() => ({} as { item?: { file?: string } }));
    return {
      state: p.speed === 0 ? 'paused' : 'playing',
      positionMs: toMs(p.time),
      durationMs: toMs(p.totaltime) || null,
      uri: item.item?.file ?? this.lastUrl,
      track: null,
    };
  }

  async getVolume() {
    const r = await this.rpc<{ volume?: number; muted?: boolean }>('Application.GetProperties', { properties: ['volume', 'muted'] });
    return { volume: typeof r.volume === 'number' ? r.volume : null, muted: !!r.muted };
  }

  async setVolume(v: number) {
    await this.rpc('Application.SetVolume', { volume: Math.max(0, Math.min(100, Math.round(v))) });
  }

  async setMuted(m: boolean) {
    await this.rpc('Application.SetMute', { mute: m });
  }

  async notify(title: string, message: string, imageUrl?: string | null) {
    await this.rpc('GUI.ShowNotification', { title, message, ...(imageUrl ? { image: imageUrl } : {}), displaytime: 5000 });
  }
}
