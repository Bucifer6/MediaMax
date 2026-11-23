import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { HeroStyle, HomeRow, Item } from '@mediamax/shared';
import { useApp } from '../state/app';
import { usePlayItem } from '../player/music';
import { formatDuration } from '../utils/format';
import { isIptvLibrary, isResumable, itemLink, itemSubtitle, landscapeFor, posterFor, progressPct } from '../utils/items';
import { canWatchlist, WatchlistButton } from './Cards';
import { Icon } from './Icon';
import { Img, ProgressBar } from './ui';
import { DecideBar } from './decide/DecideBar';

function Metadata({ item }: { item: Item }) {
  return <div className="programme-meta">{[item.year, item.genres[0], formatDuration(item.durationMs)].filter(Boolean).map((value, i) => <span key={i}>{value}</span>)}</div>;
}

/** The library index exposes actions beside the title rather than hiding them over artwork. */
export function CatalogueEntry({ item }: { item: Item }) {
  const play = usePlayItem();
  return (
    <article className="catalogue-entry">
      <Link to={itemLink(item)} className="catalogue-cover" aria-label={`Details for ${item.title}`} data-nav>
        <Img src={posterFor(item)} width={180} alt="" fallback={<Icon name="film" size={24} />} />
      </Link>
      <div className="catalogue-copy">
        <Link to={itemLink(item)} className="catalogue-title" data-nav>{item.title}</Link>
        <Metadata item={item} />
        {item.overview && <p>{item.overview}</p>}
      </div>
      <div className="catalogue-actions">
        {item.type !== 'photo' && <button className="btn programme-play" onClick={() => play(item)} aria-label={`${isResumable(item) ? 'Resume' : 'Play'} ${item.title}`} data-nav><Icon name="play" size={15} />{isResumable(item) ? 'Resume' : 'Play'}</button>}
        {canWatchlist(item) && <WatchlistButton item={item} variant="detail" />}
      </div>
    </article>
  );
}

function ViewingBoard({ rows }: { rows: HomeRow[] }) {
  const play = usePlayItem();
  const items = [...new Map(rows.flatMap((row) => row.items).map((item) => [item.id, item])).values()];
  return (
    <section className="viewing-board" aria-labelledby="viewing-heading">
      <div className="programme-rule"><span>Your viewing</span><span>{items.length} {items.length === 1 ? 'title' : 'titles'}</span></div>
      <h2 id="viewing-heading">Pick up the story.</h2>
      {items.length ? <div className="viewing-entries">{items.map((item) => {
        const remaining = item.durationMs && item.userData?.positionMs ? item.durationMs - item.userData.positionMs : null;
        return (
          <article className="viewing-entry" key={item.id}>
            <Link to={itemLink(item)} className="viewing-art" aria-label={`Details for ${item.title}`} data-nav><Img src={landscapeFor(item)} width={160} alt="" /></Link>
            <div className="viewing-copy">
              <Link to={itemLink(item)} data-nav>{item.type === 'episode' ? item.grandparentTitle ?? item.title : item.title}</Link>
              <small>{item.type === 'episode' ? itemSubtitle(item) : remaining && remaining > 60000 ? `${Math.round(remaining / 60000)} minutes left` : itemSubtitle(item)}</small>
              {progressPct(item) > 0 && <ProgressBar value={progressPct(item)} />}
            </div>
            <button className="viewing-play" onClick={() => play(item)} aria-label={`${isResumable(item) ? 'Resume' : 'Play'} ${item.title}`} data-nav><Icon name="play" size={15} /></button>
          </article>
        );
      })}</div> : <p className="programme-note">The next chapter starts here. Your unfinished films and next episodes will appear as you watch.</p>}
      <Link to="/my-list" className="programme-text-link" data-nav>Open your saved list</Link>
    </section>
  );
}

function FeatureStory({ items, style }: { items: Item[]; style: HeroStyle }) {
  const [selected, setSelected] = useState(0);
  const play = usePlayItem();
  const list = style === 'static' ? items.slice(0, 1) : items.slice(0, 8);
  const item = list[Math.min(selected, list.length - 1)];
  if (!item || style === 'none') return null;
  return (
    <section className="feature-story" aria-label="In focus">
      <div className="programme-rule"><span>In focus</span><span>{item.genres.slice(0, 2).join(' / ')}</span></div>
      <div className="feature-heading" aria-live="polite">
        <h2>{item.title}</h2>
        <Metadata item={item} />
      </div>
      <Link to={itemLink(item)} className="feature-photograph" aria-label={`More about ${item.title}`} data-nav>
        <Img src={item.backdropUrl ?? item.thumbUrl ?? item.posterUrl} width={1600} alt={item.title} fallback={<span>{item.title}</span>} />
        {item.tagline && <span className="feature-caption">{item.tagline}</span>}
      </Link>
      <div className="feature-bottom">
        <p className="feature-description">{item.overview || 'Find your next story in your own collection.'}</p>
        <div className="feature-actions">
          <button className="btn programme-play" onClick={() => play(item)} data-nav><Icon name="play" size={16} />{isResumable(item) ? 'Resume screening' : 'Start screening'}</button>
          <Link to={itemLink(item)} className="programme-text-link" data-nav>Details</Link>
          {canWatchlist(item) && <WatchlistButton key={item.id} item={item} variant="detail" />}
        </div>
      </div>
      {list.length > 1 && <div className="feature-switcher" role="group" aria-label="Choose a featured title">{list.map((entry, index) => (
        <button key={entry.id} type="button" aria-pressed={index === Math.min(selected, list.length - 1)} onClick={() => setSelected(index)} data-nav><span>{entry.title}</span><small>{entry.year}</small></button>
      ))}</div>}
    </section>
  );
}

function StorySection({ row, link }: { row: HomeRow; link?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!row.items.length) return null;
  return (
    <section className="story-section">
      <header className="story-section-head"><h2>{row.title || 'From the collection'}</h2><div>{link && <Link className="programme-text-link" to={link} data-nav>Browse collection</Link>}<span>{row.items.length} titles</span></div></header>
      <div className="story-grid">{(expanded ? row.items : row.items.slice(0, 5)).map((item, index) => (
        <article className="story-tile" key={item.id}>
          <Link to={itemLink(item)} className="story-art" data-nav><Img src={landscapeFor(item)} width={index === 0 ? 1000 : 500} alt={item.title} fallback={<Icon name="film" size={28} />} /></Link>
          {row.type === 'top10' && <span className="programme-kicker">Rank {index + 1}</span>}
          <Link to={itemLink(item)} className="story-title" data-nav>{item.title}</Link>
          <Metadata item={item} />
        </article>
      ))}</div>
      {row.items.length > 5 && <button className="programme-text-link story-more" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} data-nav>{expanded ? 'Show fewer titles' : `Show all ${row.items.length} titles`}</button>}
    </section>
  );
}

export function Programme({ rows, heroStyle, renderRow, linkFor }: { rows: HomeRow[]; heroStyle: HeroStyle; renderRow: (row: HomeRow) => ReactNode; linkFor: (row: HomeRow) => string | undefined }) {
  const { user, libraries, features } = useApp();
  const [viewingFirst, setViewingFirst] = useState(() => {
    try { return localStorage.getItem('mm.programme.viewingFirst') === '1'; } catch { return false; }
  });
  const toggleOrder = () => setViewingFirst((value) => {
    try { localStorage.setItem('mm.programme.viewingFirst', value ? '0' : '1'); } catch { /* session only */ }
    return !value;
  });
  const featured = rows.find((row) => row.type === 'hero');
  const watching = rows.filter((row) => row.type === 'continue' || row.type === 'nextup');
  const browse = rows.filter((row) => !['hero', 'continue', 'nextup'].includes(row.type));
  const available = libraries.filter((library) => !isIptvLibrary(library.type) && (features.music || library.type !== 'music') && (features.photos || library.type !== 'photos'));
  return (
    <div className={`programme ${viewingFirst ? 'viewing-first' : ''}`}>
      <header className="programme-masthead">
        <div><span className="programme-kicker">A private picture house</span><h1>The programme<span>.</span></h1></div>
        <div className="programme-introduction"><p>Good stories deserve<br />your undivided attention.</p><small>{user?.displayName ? `Selected for ${user.displayName}.` : 'Your collection, at your pace.'}</small><button className="programme-text-link" aria-label="Prioritize my viewing" aria-pressed={viewingFirst} onClick={toggleOrder} data-nav>{viewingFirst ? 'Feature first' : 'Put my viewing first'}</button></div>
      </header>
      <div className={`programme-spread ${!featured?.items.length || heroStyle === 'none' ? 'without-feature' : ''}`}>
        {featured && heroStyle !== 'none' && <FeatureStory items={featured.items} style={heroStyle} />}
        <aside className="programme-margin" aria-label="Your programme">
          <ViewingBoard rows={watching} />
          <nav className="collection-directory" aria-label="Browse your libraries"><div className="programme-rule"><span>The collection</span><span>{available.length} libraries</span></div>{available.map((library) => <Link to={`/library/${library.id}`} key={library.id} data-nav><span>{library.name}</span><small>{library.itemCount.toLocaleString()}</small></Link>)}</nav>
          <div className="programme-chance"><span className="programme-kicker">An open mind</span><h2>Let the evening<br />surprise you.</h2><DecideBar /></div>
        </aside>
      </div>
      {browse.map((row) => ['live-now', 'favorite-channels', 'upcoming'].includes(row.type) ? <div className="programme-special" key={row.id}>{renderRow(row)}</div> : <StorySection key={row.id} row={row} link={linkFor(row)} />)}
      <footer className="programme-colophon"><span>End of programme.</span><Link to="/my-list" data-nav>Your next story might already be saved.</Link></footer>
    </div>
  );
}
