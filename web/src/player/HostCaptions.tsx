/**
 * Captions for the Radio Host / Your DJ voice: what the host is saying, "Skip talk" and mute. Shown on Now Playing
 * (above the transport) and over the mini player while the host talks; positioned out of flow, so nothing jumps.
 */
import { useMusic } from './music';
import { Icon } from '../components/Icon';

/** Three bars that move while the host talks (static under reduced motion). */
export function VoiceBars({ live }: { live: boolean }) {
  return (
    <span className={`voice-bars ${live ? 'live' : ''}`} aria-hidden="true">
      <i /><i /><i /><i />
    </span>
  );
}

export function HostCaption({ variant }: { variant: 'np' | 'mini' }) {
  const m = useMusic();
  const h = m.host;
  if (!h.caption) return null;
  const who = m.yourDj ? 'Your DJ' : 'Radio Host';
  return (
    <div className={`host-caption host-caption-${variant}`} role="status" aria-live="polite" aria-label={`${who} says`}>
      <span className="host-who"><VoiceBars live={h.speaking} /><span>{who}</span></span>
      <p className="host-text">{h.caption}</p>
      <span className="host-actions">
        {h.speaking && (
          <button type="button" className="btn btn-xs host-skip" onClick={h.skip} title="Stop talking; the music carries on">
            <Icon name="skipFwd" size={13} /> Skip talk
          </button>
        )}
        <button
          type="button"
          className="btn-icon btn-icon-sm host-mute"
          onClick={() => h.setMuted(!h.muted)}
          aria-pressed={h.muted}
          aria-label={h.muted ? `Unmute ${who}` : `Mute ${who}`}
          title={h.muted ? `Unmute ${who}` : `Mute ${who} on this device`}
        >
          <Icon name={h.muted ? 'mute' : 'volume'} size={15} />
        </button>
      </span>
    </div>
  );
}
