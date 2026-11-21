import { useEffect, useState } from 'react';
import type { AskResponse } from '@mediamax/shared';
import { aiApi } from '../api/ai';
import { CardSkeleton, PosterCard } from './Cards';
import { EmptyState } from './ui';
import { Icon } from './Icon';

/** Example questions shown before anything is typed (English and Romanian). */
export const ASK_EXAMPLES = [
  "Something funny under 90 minutes we haven't seen",
  'Romanian comedies from the 2000s',
  'Like Inception but lighter',
  'Filme de groază din anii 80',
  'Seriale polițiste bine cotate',
];

/**
 * "Ask" results: what the question was understood as (removable chips) and the matching titles. Used by the search
 * page in normal and TV mode; the server applies the viewer's library access and parental limits.
 */
export function AskResults({ q, onPick }: { q: string; onPick?: (q: string) => void }) {
  const [res, setRes] = useState<AskResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (opts: { filter?: AskResponse['filter']; remove?: string[] }, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    aiApi.ask(q, { ...opts, limit: 60 }, signal)
      .then(setRes)
      .catch((e) => (e as Error).name !== 'AbortError' && setError((e as Error).message))
      .finally(() => !signal?.aborted && setLoading(false));
  };
  useEffect(() => {
    if (!q) {
      setRes(null);
      return;
    }
    const ctrl = new AbortController();
    run({}, ctrl.signal);
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  // Removing a chip re-runs the same understanding minus that part (the model is not asked again).
  const removeChip = (key: string) => res && run({ filter: res.filter, remove: [key] });

  if (!q) {
    return (
      <div className="ask-examples">
        <p className="muted">Ask in your own words — English or Romanian. For example:</p>
        <div className="ask-chips">
          {ASK_EXAMPLES.map((e) => <button key={e} className="ask-example" data-nav onClick={() => onPick?.(e)}><Icon name="sparkles" size={14} /> {e}</button>)}
        </div>
      </div>
    );
  }
  if (loading && !res) return <div className="grid grid-poster">{Array.from({ length: 12 }).map((_, i) => <CardSkeleton key={i} />)}</div>;
  if (error) return <EmptyState icon="alert" title="Ask failed" message={error} />;
  if (!res) return null;
  return (
    <div className={`ask-results ${loading ? 'dim' : ''}`}>
      {res.chips.length > 0 && (
        <div className="ask-understood" aria-label="Understood as">
          <span className="muted"><Icon name="sparkles" size={14} /> Understood as:</span>
          <div className="ask-chips">
            {res.chips.map((c) => (
              <button key={c.key} className="ask-chip" data-nav onClick={() => removeChip(c.key)} aria-label={`Remove ${c.label}`} title="Remove">
                {c.label} <Icon name="x" size={12} />
              </button>
            ))}
          </div>
          {res.by === 'llm' && <span className="ask-by muted" title="Understood by the AI model">AI</span>}
        </div>
      )}
      {res.items.length === 0 ? (
        <EmptyState icon="search" title="Nothing matches all of that" message={res.chips.length ? 'Remove a chip above to widen the search.' : 'Try describing it differently.'} />
      ) : (
        <div className="grid grid-poster">
          {res.items.map((it) => <PosterCard key={it.id} item={it} width="100%" />)}
        </div>
      )}
    </div>
  );
}
