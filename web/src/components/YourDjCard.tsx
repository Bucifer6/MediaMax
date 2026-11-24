/**
 * The one-tap "Your DJ" card (Home, below Continue Watching / Listening, and the music library landing). Starts a
 * personal set from the listener's own library; while it plays, the card shows the segment and the DJ button.
 */
import { useEffect, useState } from 'react';
import type { DjStatus } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useMusic } from '../player/music';
import { useNowPlaying } from '../player/NowPlaying';
import { DjButton, DjMark } from '../player/YourDjPanel';
import { segmentOf } from '../player/yourDj';
import { Icon } from './Icon';
import { Spinner } from './ui';
import { openPlayRules, useRulePresets } from './PlayRules';
import '../styles/yourdj.css';

export const YOUR_DJ_ROW_ID = 'your-dj';

let statusCache: Promise<DjStatus | null> | null = null;
/** Is Your DJ available on this server (the admin can turn the AI DJ off)? Unknown = yes (it works with nothing configured). */
export function useYourDjAvailable(): boolean {
  const { libraries, features } = useApp();
  const [ok, setOk] = useState(true);
  const hasMusic = libraries.some((l) => l.type === 'music');
  useEffect(() => {
    if (!hasMusic) return;
    statusCache ??= api.dj.status().catch(() => null);
    let off = false;
    void statusCache.then((s) => !off && setOk(s?.ai?.yourDj !== false && s?.ai?.enabled !== false));
    return () => {
      off = true;
    };
  }, [hasMusic]);
  return hasMusic && features.music !== false && ok;
}

function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return 'Late night picks from your library';
  if (h < 12) return 'A morning set from your library';
  if (h < 17) return 'An afternoon set from your library';
  if (h < 22) return 'An evening set from your library';
  return 'Late night picks from your library';
}

export function YourDjCard({ compact = false }: { compact?: boolean }) {
  const m = useMusic();
  const np = useNowPlaying();
  const { active } = useRulePresets();
  const live = !!m.yourDj;
  const seg = live ? segmentOf(m.yourDj, m.current?.id) ?? m.yourDj!.segments[m.yourDj!.segmentId] : null;
  return (
    <section className={`yourdj-card ${live ? 'is-live' : ''} ${compact ? 'is-compact' : ''}`} aria-label="Your DJ">
      <div className="yourdj-card-glow" aria-hidden="true" />
      <div className="yourdj-card-mark" aria-hidden="true"><span className="yd-ring" /><span className="yd-core"><DjMark size={compact ? 24 : 30} /></span></div>
      <div className="yourdj-card-text">
        <span className="yourdj-card-eyebrow">{live ? <><span className="live-dot" aria-hidden /> Playing now</> : 'Made for you'}</span>
        <h2 className="yourdj-card-title">Your DJ</h2>
        <p className="yourdj-card-sub">
          {live && seg ? <><strong>{seg.title}</strong> · {seg.reason}</> : greeting()}
        </p>
        <button type="button" className="yourdj-card-rules" onClick={() => openPlayRules()} title="Choose what Your DJ may play">
          <Icon name="filter" size={13} /> {active ? active.name : 'Play rules: everything'}
        </button>
      </div>
      <div className="yourdj-card-actions">
        {live ? (
          <>
            <button type="button" className="btn btn-sm" onClick={() => np.show()}><Icon name="fullscreen" size={14} /> Open</button>
            <DjButton withLabel />
          </>
        ) : (
          <button type="button" className="btn btn-primary btn-lg yourdj-start" onClick={() => void m.startYourDj()} disabled={m.yourDjStarting} aria-busy={m.yourDjStarting}>
            {m.yourDjStarting ? <Spinner size={18} /> : <Icon name="play" size={18} />} {m.yourDjStarting ? 'Warming up…' : 'Play'}
          </button>
        )}
      </div>
    </section>
  );
}
