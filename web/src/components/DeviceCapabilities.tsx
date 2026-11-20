import { Fragment, useEffect, useState } from "react";
import { initCapabilities, type VideoCaps } from '../player/capabilities';
import { detectDeviceProfile } from '../player/deviceProfile';
import { REMOTE_HELP } from '../tv/spatial';
import { RangeBadge } from './HdrBadge';

/** Settings → Playback: what this device's player (our hls.js/MSE engine) can play, and the TV remote keys. */
export function DeviceCapabilitiesCard() {
  const [caps, setCaps] = useState<VideoCaps | null>(null);
  useEffect(() => {
    let alive = true;
    void initCapabilities().then((c) => alive && setCaps(c));
    return () => { alive = false; };
  }, []);
  const profile = caps ? detectDeviceProfile() : null;
  const r = caps?.videoRange;
  const tv = typeof document !== 'undefined' && document.documentElement.classList.contains('tv');
  return (
    <div className="settings-card">
      <h2>This device</h2>
      {!caps ? <p className="muted">Checking what this device can play…</p> : (
        <dl className="kv">
          <dt>HDR</dt>
          <dd>
            {r?.hdr10 || r?.hlg || r?.dolbyVision ? (
              <span className="media-badges">
                {r.dolbyVision && <RangeBadge format="dolbyvision" label={`Dolby Vision ${r.dolbyVisionProfiles?.join(', ') ?? ''}`} />}
                {r.hdr10Plus && <RangeBadge format="hdr10plus" />}
                {r.hdr10 && <RangeBadge format="hdr10" />}
                {r.hlg && <RangeBadge format="hlg" />}
              </span>
            ) : 'SDR only — HDR videos are tone-mapped by the server'}
            {r?.hdrDisplay ? ' · HDR display' : ''}
          </dd>
          <dt>Video codecs</dt><dd>{profile?.videoCodecs?.join(', ').toUpperCase() || '—'}{caps.tenBitCodecs.length ? ` · 10-bit: ${caps.tenBitCodecs.join(', ').toUpperCase()}` : ''}</dd>
          <dt>Audio codecs</dt><dd>{profile?.audioCodecs?.join(', ').toUpperCase() || '—'}</dd>
          <dt>Max resolution</dt><dd>{caps.maxHeight ? `${caps.maxHeight}p` : profile?.maxWidth ? `${profile.maxWidth} px wide` : '—'}</dd>
          <dt>Player</dt><dd>{profile?.player === 'html5' ? 'MediaMax player (hls.js / Media Source Extensions)' : `MediaMax player on ${caps.platform === 'tizen' ? 'Samsung Tizen' : caps.platform === 'webos' ? 'LG webOS' : caps.platform} (hls.js / MSE)`}</dd>
        </dl>
      )}
      {tv && (
        <>
          <h3>Remote control</h3>
          <dl className="kv remote-help">
            {REMOTE_HELP.map((k) => <Fragment key={k.keys}><dt>{k.keys}</dt><dd>{k.action}</dd></Fragment>)}
          </dl>
        </>
      )}
    </div>
  );
}
