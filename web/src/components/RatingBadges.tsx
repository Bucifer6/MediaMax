import type { ItemRatings } from '@mediamax/shared';
import '../styles/metadata.css';

/** IMDb / Rotten Tomatoes / Metacritic / TMDB ratings (from OMDb and TMDB) as compact badges. */
export function RatingBadges({ ratings }: { ratings?: ItemRatings | null }) {
  if (!ratings) return null;
  const { imdb, rottenTomatoes: rt, metacritic: mc, tmdb } = ratings;
  if (imdb == null && rt == null && mc == null && tmdb == null) return null;
  return (
    <span className="rating-badges">
      {imdb != null && <span className="rating-badge imdb" title="IMDb rating"><span className="rb-src">IMDb</span>{imdb.toFixed(1)}</span>}
      {rt != null && <span className={`rating-badge rt ${rt < 60 ? 'rotten' : ''}`} title="Rotten Tomatoes (Tomatometer)"><span className="rb-src">RT</span>{rt}%</span>}
      {mc != null && <span className={`rating-badge mc ${mc < 40 ? 'bad' : mc < 61 ? 'mixed' : ''}`} title="Metacritic Metascore"><span className="rb-src">MC</span>{mc}</span>}
      {tmdb != null && imdb == null && <span className="rating-badge tmdb" title="TMDB user score"><span className="rb-src">TMDB</span>{tmdb.toFixed(1)}</span>}
    </span>
  );
}
