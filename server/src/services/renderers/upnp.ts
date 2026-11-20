import type { RendererPlayState } from '@mediamax/shared';
import type { DriverStatus, LoadMedia, RendererDriver } from './driver.js';
import type { DeviceDescription, ServiceRef } from './ssdp.js';
import { deviceFetch } from './lan.js';
import { didlLite, formatHms, parseHms, soapEnvelope, soapFault, xmlText } from './xml.js';

export class UpnpError extends Error {
  constructor(message: string, readonly code: number | null) {
    super(message);
  }
}

const STATE: Record<string, RendererPlayState> = {
  PLAYING: 'playing', PAUSED_PLAYBACK: 'paused', PAUSED_RECORDING: 'paused', TRANSITIONING: 'buffering', STOPPED: 'stopped', NO_MEDIA_PRESENT: 'idle',
};

/**
 * DLNA / UPnP AV MediaRenderer control: AVTransport, RenderingControl and ConnectionManager over
 * SOAP. Sonos zone players are UPnP renderers too; for them `loadQueue` uses the device queue
 * (AddURIToQueue + x-rincon-queue) and volume goes to the group.
 */
export class UpnpDriver implements RendererDriver {
  readonly host: string;

  constructor(readonly desc: DeviceDescription) {
    this.host = new URL(desc.avTransport!.controlUrl).hostname;
  }

  async call(svc: ServiceRef | null, action: string, args: [string, string | number][] = []): Promise<string> {
    if (!svc) throw new UpnpError(`The device has no service for ${action}`, null);
    const res = await deviceFetch(svc.controlUrl, this.host, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${svc.serviceType}#${action}"` },
      body: soapEnvelope(svc.serviceType, action, args),
      timeoutMs: 6000,
    });
    const text = (await res.text()).slice(0, 1024 * 1024);
    const fault = soapFault(text);
    if (!res.ok || fault) throw new UpnpError(`${action} failed: ${fault?.description ?? `HTTP ${res.status}`}${fault?.code ? ` (${fault.code})` : ''}`, fault?.code ?? null);
    return text;
  }

  private avt(action: string, args: [string, string | number][] = []) {
    return this.call(this.desc.avTransport, action, [['InstanceID', 0], ...args]);
  }

  async sinkProtocols(): Promise<string> {
    if (!this.desc.connectionManager) return '';
    const xml = await this.call(this.desc.connectionManager, 'GetProtocolInfo');
    return xmlText(xml, 'Sink') ?? '';
  }

  private uriFor(m: LoadMedia): string {
    // Sonos plays endless HTTP streams (our MP3 transcodes) only as radio.
    if (this.desc.isSonos && !m.seekable && m.mime === 'audio/mpeg') return m.url.replace(/^https?:\/\//, 'x-rincon-mp3radio://');
    return m.url;
  }

  async load(m: LoadMedia): Promise<void> {
    // Some renderers refuse a new URI while playing.
    await this.avt('Stop').catch(() => undefined);
    await this.avt('SetAVTransportURI', [['CurrentURI', this.uriFor(m)], ['CurrentURIMetaData', didlLite(m.didl)]]);
    await this.play();
    if (m.startMs > 1000 && m.seekable) await this.seekWhenReady(m.startMs);
  }

  /** Renderers reject Seek while TRANSITIONING, so wait for PLAYING first (up to ~8 s). */
  private async seekWhenReady(ms: number) {
    for (let i = 0; i < 16; i++) {
      const st = await this.status().catch(() => null);
      if (st?.state === 'playing' || st?.state === 'paused') {
        await this.seek(ms).catch(() => undefined);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async loadQueue(items: LoadMedia[], startIndex: number): Promise<void> {
    if (!this.desc.isSonos || !this.desc.rinconId) {
      await this.load(items[startIndex]);
      return;
    }
    await this.avt('Stop').catch(() => undefined);
    await this.avt('RemoveAllTracksFromQueue');
    for (const m of items) {
      await this.avt('AddURIToQueue', [['EnqueuedURI', this.uriFor(m)], ['EnqueuedURIMetaData', didlLite(m.didl)], ['DesiredFirstTrackNumberEnqueued', 0], ['EnqueueAsNext', 0]]);
    }
    await this.avt('SetAVTransportURI', [['CurrentURI', `x-rincon-queue:${this.desc.rinconId}#0`], ['CurrentURIMetaData', '']]);
    await this.avt('Seek', [['Unit', 'TRACK_NR'], ['Target', startIndex + 1]]);
    await this.play();
    const start = items[startIndex]?.startMs ?? 0;
    if (start > 1000) await this.seekWhenReady(start);
  }

  play() {
    return this.avt('Play', [['Speed', 1]]).then(() => undefined);
  }

  pause() {
    return this.avt('Pause').then(() => undefined);
  }

  stop() {
    return this.avt('Stop').then(() => undefined);
  }

  seek(ms: number) {
    return this.avt('Seek', [['Unit', 'REL_TIME'], ['Target', formatHms(ms)]]).then(() => undefined);
  }

  next() {
    return this.avt('Next').then(() => undefined);
  }

  previous() {
    return this.avt('Previous').then(() => undefined);
  }

  async status(): Promise<DriverStatus> {
    const t = await this.avt('GetTransportInfo');
    const p = await this.avt('GetPositionInfo');
    const raw = xmlText(t, 'CurrentTransportState') ?? '';
    const track = Number(xmlText(p, 'Track'));
    return {
      state: STATE[raw.toUpperCase()] ?? 'idle',
      positionMs: parseHms(xmlText(p, 'RelTime')),
      durationMs: parseHms(xmlText(p, 'TrackDuration')) || null,
      uri: xmlText(p, 'TrackURI') || null,
      track: Number.isFinite(track) && track > 0 ? track : null,
    };
  }

  async getVolume(): Promise<{ volume: number | null; muted: boolean }> {
    if (this.desc.isSonos && this.desc.groupRenderingControl) {
      const v = await this.call(this.desc.groupRenderingControl, 'GetGroupVolume', [['InstanceID', 0]]);
      const m = await this.call(this.desc.groupRenderingControl, 'GetGroupMute', [['InstanceID', 0]]).catch(() => '');
      return { volume: Number(xmlText(v, 'CurrentVolume')) || 0, muted: xmlText(m, 'CurrentMute') === '1' };
    }
    if (!this.desc.renderingControl) return { volume: null, muted: false };
    const v = await this.call(this.desc.renderingControl, 'GetVolume', [['InstanceID', 0], ['Channel', 'Master']]);
    const m = await this.call(this.desc.renderingControl, 'GetMute', [['InstanceID', 0], ['Channel', 'Master']]).catch(() => '');
    const n = Number(xmlText(v, 'CurrentVolume'));
    return { volume: Number.isFinite(n) ? n : null, muted: xmlText(m, 'CurrentMute') === '1' };
  }

  async setVolume(v: number) {
    const vol = Math.max(0, Math.min(100, Math.round(v)));
    if (this.desc.isSonos && this.desc.groupRenderingControl) {
      await this.call(this.desc.groupRenderingControl, 'SnapshotGroupVolume', [['InstanceID', 0]]).catch(() => undefined);
      await this.call(this.desc.groupRenderingControl, 'SetGroupVolume', [['InstanceID', 0], ['DesiredVolume', vol]]);
      return;
    }
    await this.call(this.desc.renderingControl, 'SetVolume', [['InstanceID', 0], ['Channel', 'Master'], ['DesiredVolume', vol]]);
  }

  async setMuted(m: boolean) {
    if (this.desc.isSonos && this.desc.groupRenderingControl) {
      await this.call(this.desc.groupRenderingControl, 'SetGroupMute', [['InstanceID', 0], ['DesiredMute', m ? 1 : 0]]);
      return;
    }
    await this.call(this.desc.renderingControl, 'SetMute', [['InstanceID', 0], ['Channel', 'Master'], ['DesiredMute', m ? 1 : 0]]);
  }
}
