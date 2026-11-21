/**
 * Entry points for the "help us decide" features: a slim bar on Home and in Search ("Can't decide? Spin" and
 * "Movie Match"), and the Roulette / Shuffle play buttons for movie and TV library pages.
 */
import { Link, useNavigate } from 'react-router-dom';
import type { Library } from '@mediamax/shared';
import { decideApi } from '../../api/decide';
import { useToast } from '../../state/toast';
import { Icon } from '../Icon';
import { filtersToParams, marathonPlayLink } from '../../utils/decide';
import '../../styles/decide.css';

export function DecideBar({ className = '' }: { className?: string }) {
  return (
    <div className={`decide-bar ${className}`} role="group" aria-label="Help me decide">
      <Link to="/roulette" className="chip decide-chip" data-nav><Icon name="shuffle" size={15} /> Can't decide? Spin</Link>
      <Link to="/match" className="chip decide-chip" data-nav><Icon name="together" size={15} /> Movie Match</Link>
    </div>
  );
}

/** Roulette + Shuffle play (Random marathon) for a movie or TV library, keeping the page's genre filter. */
export function LibraryDecideButtons({ library, genre }: { library: Library | undefined; genre?: string }) {
  const navigate = useNavigate();
  const toast = useToast();
  if (!library || (library.type !== 'movies' && library.type !== 'shows')) return null;
  const kind = library.type === 'shows' ? 'series' : 'movie';
  const filters = { kind, libraryIds: [library.id], genres: genre ? [genre] : [] } as const;
  const shuffle = async () => {
    try {
      const r = await decideApi.startMarathon({ ...filters, genres: [...filters.genres], libraryIds: [...filters.libraryIds], randomEpisode: kind === 'series' });
      if (!r.item) return toast.error('Nothing to play here yet');
      navigate(marathonPlayLink(r.item.id, r.marathon.id));
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="row-gap library-decide">
      <Link to={`/roulette?${filtersToParams({ ...filters, libraryIds: [...filters.libraryIds], genres: [...filters.genres] }).toString()}`} className="btn btn-ghost" title="Can't decide? Spin"><Icon name="shuffle" size={16} /> Roulette</Link>
      <button className="btn btn-ghost" onClick={shuffle} title="Play random titles back to back"><Icon name="play" size={16} /> Shuffle play</button>
    </div>
  );
}
