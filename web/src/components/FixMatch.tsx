import { useEffect, useState } from 'react';
import type { Item, MatchCandidate, MatchSearchResponse, MetadataProviderId } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { Spinner } from './ui';
import { Icon } from './Icon';
import '../styles/metadata.css';

const NAMES: Record<MetadataProviderId, string> = {
  tmdb: 'TMDB', tvdb: 'TheTVDB', musicbrainz: 'MusicBrainz', audnexus: 'Audnexus (ASIN)', googlebooks: 'Google Books', openlibrary: 'Open Library',
  fanart: 'fanart.tv', audiodb: 'TheAudioDB', lrclib: 'LRCLIB', omdb: 'OMDb',
};

/** Items whose match can be fixed (seasons/episodes follow their show). */
export const canFixMatch = (item: Item) => ['movie', 'show', 'artist', 'album', 'audiobook'].includes(item.type);

/**
 * "Fix match": search the provider for this type (TMDB / TheTVDB / MusicBrainz / Audnexus…), pick the right result,
 * and the server re-fetches the item from it, replacing unlocked fields that came from the wrong match.
 */
export function FixMatchPanel({ item, onDone, onCancel }: { item: Item; onDone: (i: Item) => void; onCancel: () => void }) {
  const toast = useToast();
  const isBook = item.type === 'audiobook';
  const [provider, setProvider] = useState<MetadataProviderId | undefined>(undefined);
  const [query, setQuery] = useState(isBook && item.externalIds && (item.externalIds as Record<string, string>).asin ? (item.externalIds as Record<string, string>).asin : item.title);
  const [year, setYear] = useState(item.type === 'movie' || item.type === 'show' ? item.year?.toString() ?? '' : '');
  const [res, setRes] = useState<MatchSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);

  const search = async (p = provider) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.metadata.searchMatch(item.id, { provider: p, q: query.trim() || undefined, year: year ? Number(year) : '' });
      setRes(r);
      setProvider(r.provider);
    } catch (e) {
      setError((e as Error).message);
      setRes(null);
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void search(); }, [item.id]);

  const pick = async (c: MatchCandidate) => {
    setApplying(c.id);
    try {
      const updated = await api.metadata.applyMatch(item.id, { provider: c.provider, id: c.id });
      toast.success(`Matched to ${c.title}${c.year ? ` (${c.year})` : ''}`);
      onDone(updated);
    } catch (e) {
      toast.error(e);
    } finally {
      setApplying(null);
    }
  };

  return (
    <div className="fm-panel">
      <div className="fm-head">
        <button className="btn btn-sm btn-ghost" onClick={onCancel}><Icon name="arrowLeft" size={14} /> Back</button>
        <span className="muted small">Pick the right entry; unlocked fields and downloaded artwork are replaced with its data. Local and locked artwork stays.</span>
      </div>
      {res && res.providers.length > 1 && (
        <div className="segmented" role="tablist">
          {res.providers.map((p) => (
            <button key={p} className={p === provider ? 'active' : ''} onClick={() => { setProvider(p); void search(p); }}>{NAMES[p]}</button>
          ))}
        </div>
      )}
      <form className="fm-search" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={provider === 'audnexus' ? 'ASIN, e.g. B08G9PRS1K' : 'Title'} aria-label="Search" />
        {(item.type === 'movie' || item.type === 'show') && (
          <input className="input fm-year" type="number" value={year} onChange={(e) => setYear(e.target.value)} placeholder="Year" aria-label="Year" />
        )}
        <button className="btn btn-primary" disabled={loading}>{loading ? <Spinner size={16} /> : <Icon name="search" size={16} />} Search</button>
      </form>
      {provider === 'audnexus' && <p className="muted small">Audnexus can only look books up by Audible ASIN (the B0… code in an Audible URL). Use Google Books or Open Library to search by title.</p>}
      {error && <p className="small" style={{ color: 'var(--c-danger)' }}>{error}</p>}
      <div className="fm-results">
        {loading && !res ? (
          <div className="center-pad"><Spinner /></div>
        ) : res && !res.results.length ? (
          <p className="muted center-pad">No results — try another title{provider === 'audnexus' ? ' or ASIN' : ''}.</p>
        ) : (
          res?.results.map((c) => (
            <button key={`${c.provider}:${c.id}`} className="fm-result" onClick={() => void pick(c)} disabled={!!applying}>
              <span className="fm-art">{c.imageUrl ? <img src={c.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} /> : <Icon name="image" size={18} />}</span>
              <span className="fm-text">
                <strong>{c.title}{c.year ? ` (${c.year})` : ''}</strong>
                {c.subtitle && <small className="muted">{c.subtitle}</small>}
                {c.overview && <p>{c.overview}</p>}
                <small className="muted mono">{NAMES[c.provider]} · {c.id}</small>
              </span>
              <span className="spacer" />
              {applying === c.id ? <Spinner size={18} /> : <Icon name="check" size={16} />}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
