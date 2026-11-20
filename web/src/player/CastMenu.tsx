/**
 * One "Play to…" menu for every way of sending media elsewhere: Google Cast, network renderers
 * (DLNA/UPnP TVs, Sonos, Kodi — controlled by the server) and AirPlay in Safari.
 */
import { useState } from 'react';
import type { Renderer } from '@mediamax/shared';
import { Icon, type IconName } from '../components/Icon';
import { Spinner } from '../components/ui';
import type { CastHandle } from './cast';
import { useApp } from '../state/app';
import { Popover } from './controls';
import { RENDERER_KIND_LABEL, useRendererRemote, useRenderers } from './renderers';

const KIND_ICON: Record<Renderer['kind'], IconName> = { dlna: 'tv', sonos: 'volume', kodi: 'monitor' };

export function CastMenu({
  cast, airplay, media, onPlayTo, size = 22, className,
}: {
  cast: CastHandle;
  airplay?: { available: boolean; active: boolean; show: () => void };
  /** What's being played: video items can't go to audio-only renderers. */
  media: 'video' | 'audio';
  /** Hand playback to a renderer (the caller sends the item and stops local playback). */
  onPlayTo: (r: Renderer) => Promise<void>;
  size?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { renderers, loading, searched, search } = useRenderers(true);
  const remote = useRendererRemote();
  const { user } = useApp();
  const castShown = cast.available || cast.connected;
  const shown = castShown || renderers.length > 0 || !!airplay?.available;
  if (!shown) return null;
  const activeId = remote.state && remote.state.state !== 'stopped' && remote.state.state !== 'idle' ? remote.active?.id : null;
  const connectedLabel = cast.connected ? `Casting to ${cast.deviceName ?? 'device'}` : airplay?.active ? 'Playing on AirPlay' : activeId ? `Playing on ${remote.active?.name}` : 'Play to…';

  const pick = async (r: Renderer) => {
    setBusy(r.id);
    setError(null);
    try {
      await onPlayTo(r);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <span className={`cast-menu ${className ?? ''}`}>
      <button
        className={`btn-icon ${cast.connected || airplay?.active || activeId ? 'active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-label={connectedLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={connectedLabel}
      >
        <Icon name="cast" size={size} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="cast-popover">
        <div className="option-title">Play to</div>
        <div className="option-list" role="menu">
          {castShown && (
            <button className={`option cast-option ${cast.connected ? 'selected' : ''}`} role="menuitem" onClick={() => { setOpen(false); cast.toggle(); }}>
              <Icon name="cast" size={18} />
              <span className="cast-option-text">
                <span>{cast.connected ? `Stop casting to ${cast.deviceName ?? 'device'}` : 'Chromecast…'}</span>
                <small>Google Cast</small>
              </span>
            </button>
          )}
          {airplay?.available && (
            <button className={`option cast-option ${airplay.active ? 'selected' : ''}`} role="menuitem" onClick={() => { setOpen(false); airplay.show(); }}>
              <Icon name="monitor" size={18} />
              <span className="cast-option-text">
                <span>AirPlay…</span>
                <small>Apple TV and AirPlay speakers</small>
              </span>
            </button>
          )}
          {renderers.map((r) => {
            const unsupported = media === 'video' && !r.supportsVideo;
            const mine = r.id === activeId;
            const busyOther = !!r.nowPlaying && !mine && r.nowPlaying.userName !== user?.displayName;
            return (
              <button
                key={r.id}
                className={`option cast-option ${mine ? 'selected' : ''}`}
                role="menuitem"
                disabled={unsupported || busy != null}
                onClick={() => void pick(r)}
                title={unsupported ? `${r.name} plays audio only` : `Play on ${r.name}`}
              >
                {busy === r.id ? <Spinner size={18} /> : <Icon name={KIND_ICON[r.kind]} size={18} />}
                <span className="cast-option-text">
                  <span>{r.name}</span>
                  <small>
                    {RENDERER_KIND_LABEL[r.kind]}
                    {r.model ? ` · ${r.model}` : ''}
                    {unsupported ? ' · audio only' : busyOther ? ` · playing for ${r.nowPlaying!.userName}` : mine || r.nowPlaying ? ' · playing' : !r.online ? ' · offline?' : ''}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
        {error && <p className="form-error cast-error" role="alert">{error}</p>}
        <button className="option cast-search" onClick={() => void search()} disabled={loading}>
          {loading ? <Spinner size={16} /> : <Icon name="refresh" size={16} />}
          <span>{loading ? 'Searching your network…' : searched && !renderers.length ? 'No TVs or speakers found — search again' : 'Search for TVs and speakers'}</span>
        </button>
      </Popover>
    </span>
  );
}
