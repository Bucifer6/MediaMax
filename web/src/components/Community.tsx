/**
 * Detail-page additions from outside services:
 *  - CompanyLogos: studio / network logos (TMDB) linking to that studio's or network's Discover list;
 *  - EpisodeRatingsGrid: season × episode ratings, colour-coded (IMDb through OMDb, else TMDB);
 *  - TraktComments: Trakt community comments and reviews, spoilers blurred until tapped.
 * Each hides itself when there is nothing to show (no TMDB data, no Trakt app on the server…).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { EpisodeRatings, Item, TraktComment } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { itemLink } from '../utils/items';
import { relativeTime } from '../utils/format';
import { Img } from './ui';
import { useApp } from '../state/app';
import '../styles/community.css';

export function CompanyLogos({ item }: { item: Item }) {
  const { features } = useApp();
  const list = item.companies ?? [];
  if (!list.length) return null;
  const body = (c: (typeof list)[number]) => (c.logoUrl ? <Img src={c.logoUrl} width={160} alt={c.name} /> : <span>{c.name}</span>);
  return (
    <p className="company-logos">
      {list.map((c) => (features.requests ? (
        <Link key={`${c.kind}-${c.id}`} to={`/discover?list=${c.kind}-${encodeURIComponent(c.id)}`} className="company-logo" title={c.name}>{body(c)}</Link>
      ) : (
        <span key={`${c.kind}-${c.id}`} className="company-logo" title={c.name}>{body(c)}</span>
      )))}
    </p>
  );
}

/** Colour bands of the ratings grid (0–10). */
export function ratingBand(r: number | null): string {
  if (r == null) return 'none';
  if (r >= 9) return 'great';
  if (r >= 8) return 'good';
  if (r >= 7) return 'ok';
  if (r >= 6) return 'meh';
  return 'bad';
}

export function EpisodeRatingsGrid({ showId }: { showId: string }) {
  const [data, setData] = useState<EpisodeRatings | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    api.community.episodeRatings(showId, ctrl.signal).then(setData).catch(() => setData(null));
    return () => ctrl.abort();
  }, [showId]);
  if (!data?.seasons.length || !data.seasons.some((s) => s.episodes.some((e) => e.rating != null))) return null;
  // Cells are placed by episode number, so a season with gaps still shows its last episodes.
  const maxEp = Math.min(60, Math.max(...data.seasons.flatMap((s) => s.episodes.map((e) => e.episode))));
  return (
    <section className="tp-ratings-grid" aria-labelledby="tp-ratings-h">
      <div className="tp-section-head">
        <h2 className="tp-h2" id="tp-ratings-h">Episode ratings</h2>
        <span className="muted small">{data.source === 'imdb' ? 'IMDb' : 'TMDB'}</span>
      </div>
      <div className="ratings-grid-scroll">
        <table className="ratings-grid">
          <thead>
            <tr><th scope="col">S</th>{Array.from({ length: maxEp }, (_, i) => <th key={i} scope="col">{i + 1}</th>)}</tr>
          </thead>
          <tbody>
            {data.seasons.map((s) => (
              <tr key={s.season}>
                <th scope="row">{s.season}</th>
                {Array.from({ length: maxEp }, (_, i) => {
                  const e = s.episodes.find((x) => x.episode === i + 1);
                  if (!e) return <td key={i} className="rg-empty" />;
                  const label = `S${s.season} E${e.episode}${e.title ? ` · ${e.title}` : ''}: ${e.rating != null ? e.rating.toFixed(1) : 'no rating'}`;
                  const cell = e.rating != null ? e.rating.toFixed(1) : '–';
                  return (
                    <td key={i} className={`rg-${ratingBand(e.rating)}`} title={label}>
                      {e.itemId ? <Link to={itemLink({ id: e.itemId, type: 'episode' } as Item)} aria-label={label}>{cell}</Link> : <span aria-label={label}>{cell}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function TraktComments({ item }: { item: Item }) {
  const [list, setList] = useState<TraktComment[] | null>(null);
  const [sort, setSort] = useState<'likes' | 'newest'>('likes');
  const [shown, setShown] = useState<Set<number>>(new Set());
  const [all, setAll] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    api.community.comments(item.id, sort, ctrl.signal).then(setList).catch(() => setList([]));
    return () => ctrl.abort();
  }, [item.id, sort]);
  if (!list?.length) return null;
  const visible = all ? list : list.slice(0, 6);
  return (
    <section className="tp-comments" aria-labelledby="tp-comments-h">
      <div className="tp-section-head">
        <h2 className="tp-h2" id="tp-comments-h">Comments on Trakt</h2>
        <div className="segmented segmented-sm" role="radiogroup" aria-label="Sort comments">
          {(['likes', 'newest'] as const).map((s) => (
            <button key={s} role="radio" aria-checked={sort === s} className={sort === s ? 'active' : ''} onClick={() => setSort(s)}>{s === 'likes' ? 'Most liked' : 'Newest'}</button>
          ))}
        </div>
      </div>
      <ul className="comment-list">
        {visible.map((c) => {
          const hidden = c.spoiler && !shown.has(c.id);
          return (
            <li key={c.id} className={`comment ${c.review ? 'review' : ''}`}>
              <div className="comment-head">
                <strong>{c.user}</strong>
                {c.rating != null && <span className="badge">★ {c.rating}/10</span>}
                {c.review && <span className="badge badge-accent">Review</span>}
                <span className="muted small">{c.createdAt ? relativeTime(c.createdAt) : ''} · {c.likes} likes</span>
              </div>
              {hidden ? (
                <button className="comment-spoiler" onClick={() => setShown((s) => new Set(s).add(c.id))}>Contains spoilers · show</button>
              ) : (
                <p className="comment-text">{c.comment}</p>
              )}
            </li>
          );
        })}
      </ul>
      {list.length > visible.length && <button className="btn btn-ghost btn-sm" onClick={() => setAll(true)}>Show all {list.length}</button>}
    </section>
  );
}
