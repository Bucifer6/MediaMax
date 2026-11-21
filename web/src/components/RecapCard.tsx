import { useEffect, useState } from 'react';
import type { RecapResponse } from '@mediamax/shared';
import { aiApi } from '../api/ai';
import { Icon } from './Icon';
import { Spinner } from './ui';

const dismissKey = (r: RecapResponse) => `mm.recap.dismissed.${r.episodes.at(-1)?.id ?? ''}`;
const isDismissed = (r: RecapResponse) => {
  try {
    return localStorage.getItem(dismissKey(r)) === '1';
  } catch {
    return false;
  }
};

/**
 * "Previously on…": a dismissible glass card for the episode about to be played, built only from the episodes this
 * viewer already watched (never later ones). Shown on the episode page and at the start of playback.
 * `onPlayClip` plays the episode's own recap segment when it has one.
 */
export function RecapCard({ itemId, variant = 'page', onPlayClip, onClose }: {
  itemId: string;
  variant?: 'page' | 'player';
  onPlayClip?: (clip: NonNullable<RecapResponse['clip']>) => void;
  onClose?: () => void;
}) {
  const [recap, setRecap] = useState<RecapResponse | null>(null);
  const [hidden, setHidden] = useState(false);
  const [forcing, setForcing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRecap(null);
    setHidden(false);
    aiApi.recap(itemId).then((r) => !cancelled && setRecap(r)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  const close = () => {
    setHidden(true);
    try {
      if (recap) localStorage.setItem(dismissKey(recap), '1');
    } catch {
      /* private mode */
    }
    onClose?.();
  };

  // On the page, offer a manual recap even without a break (if there is anything watched before this episode).
  if (!recap || hidden) return null;
  if (!recap.available) {
    if (variant !== 'page' || recap.daysSinceLastWatched == null) return null;
    return (
      <button className="btn btn-glass btn-sm recap-ask" data-nav disabled={forcing} onClick={() => {
        setForcing(true);
        aiApi.recap(itemId, true).then(setRecap).catch(() => {}).finally(() => setForcing(false));
      }}>
        {forcing ? <Spinner size={14} /> : <Icon name="chapters" size={14} />} Recap the story so far
      </button>
    );
  }
  if (variant === 'player' && isDismissed(recap)) return null;
  const why = recap.reason === 'new-season' ? 'New season' : recap.daysSinceLastWatched != null ? `It's been ${recap.daysSinceLastWatched} days` : null;
  return (
    <section className={`recap-card recap-${variant}`} aria-label="Previously on">
      <header className="recap-head">
        <div>
          <h2><Icon name="chapters" size={18} /> Previously on{recap.showTitle ? ` ${recap.showTitle}` : ''}…</h2>
          {why && <span className="muted">{why} · only what you've already watched</span>}
        </div>
        <button className="btn-icon" onClick={close} aria-label="Dismiss recap" data-nav><Icon name="x" size={18} /></button>
      </header>
      {recap.text ? <p className="recap-text">{recap.text}</p> : (
        <ul className="recap-list">{recap.bullets.map((b) => <li key={b}>{b}</li>)}</ul>
      )}
      <div className="row-gap">
        {recap.clip && onPlayClip && (
          <button className="btn btn-glass" onClick={() => onPlayClip(recap.clip!)} data-nav>
            <Icon name="play" size={16} /> Play the recap clip ({Math.max(1, Math.round((recap.clip.endMs - recap.clip.startMs) / 1000))} s)
          </button>
        )}
        {variant === 'player' && <button className="btn btn-primary" onClick={close} data-nav autoFocus>Continue</button>}
        {recap.by === 'llm' && <span className="muted recap-by" title="Summarised by the AI model from the episode descriptions">AI summary</span>}
      </div>
    </section>
  );
}
