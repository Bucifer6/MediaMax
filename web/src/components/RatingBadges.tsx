import type { ItemRatings } from '@mediamax/shared';
import '../styles/metadata.css';

/** IMDb / Rotten Tomatoes / Metacritic / TMDB ratings (from OMDb and TMDB) as compact badges. */
export function RatingBadges({ ratings }: { ratings?: ItemRatings | null }) {
  if (!ratings) return null;
  const { imdb, rottenTomatoes: rt, metacritic: mc, tmdb, audience, trakt, letterboxd, mal } = ratings;
  if ([imdb, rt, mc, tmdb, audience, trakt, letterboxd, mal].every((v) => v == null)) return null;
  return (
    <span className="rating-badges">
      {imdb != null && <span className="rating-badge imdb" title="IMDb rating"><span className="rb-src">IMDb</span>{imdb.toFixed(1)}</span>}
      {rt != null && <span className={`rating-badge rt ${rt < 60 ? 'rotten' : ''}`} title="Rotten Tomatoes (Tomatometer)"><span className="rb-src">RT</span>{rt}%</span>}
      {mc != null && <span className={`rating-badge mc ${mc < 40 ? 'bad' : mc < 61 ? 'mixed' : ''}`} title="Metacritic Metascore"><span className="rb-src">MC</span>{mc}</span>}
      {audience != null && <span className={`rating-badge rt-aud ${audience < 60 ? 'rotten' : ''}`} title="Rotten Tomatoes audience score"><span className="rb-src">🍿</span>{audience}%</span>}
      {tmdb != null && imdb == null && <span className="rating-badge tmdb" title="TMDB user score"><span className="rb-src">TMDB</span>{tmdb.toFixed(1)}</span>}
      {trakt != null && <span className="rating-badge trakt" title="Trakt rating"><span className="rb-src">Trakt</span>{trakt}%</span>}
      {letterboxd != null && <span className="rating-badge lb" title="Letterboxd average"><span className="rb-src">LB</span>{letterboxd.toFixed(1)}</span>}
      {mal != null && <span className="rating-badge mal" title="MyAnimeList score"><span className="rb-src">MAL</span>{mal.toFixed(1)}</span>}
    </span>
  );
}
