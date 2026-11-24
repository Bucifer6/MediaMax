/**
 * Roulette — "Can't decide? Spin". Filters (library, genres, runtime, decade, rating, unwatched, My List, moods),
 * a poster reel that accelerates and decelerates onto the pick (transform-only; reduced motion = quick fade),
 * then a reveal card with Play / Trailer / Spin again / Not this one, and "Shuffle play" (Random marathon).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Item, RouletteFilters, RouletteMood, RouletteSpinResponse } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { decideApi } from '../api/decide';
import { errorMessage, mediaUrl } from '../api/client';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { Icon } from '../components/Icon';
import { Img, Modal, Spinner, Switch } from '../components/ui';
import { filtersToParams, marathonPlayLink, paramsToFilters, planReel, reelEase, trailerEmbed } from '../utils/decide';
import { formatDuration } from '../utils/format';
import { playLink } from '../utils/items';
import '../styles/decide.css';

const MOODS: { id: RouletteMood; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { id: 'feel-good', label: 'Feel-good', icon: 'sparkles' },
  { id: 'edge', label: 'Edge of your seat', icon: 'zap' },
  { id: 'mind-bending', label: 'Mind-bending', icon: 'compass' },
  { id: 'laugh', label: 'Laugh', icon: 'heart' },
  { id: 'family', label: 'Family night', icon: 'users' },
  { id: 'short', label: 'Short & sweet', icon: 'clock' },
];
const DECADES = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020];
const RUNTIMES = [30, 45, 90, 100, 120, 150];
const CARD_W = 150;
const GAP = 14;
const SPIN_MS = 4200;

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function RoulettePage() {
  const { libraries, branding } = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => paramsToFilters(params), [params]);
  const setFilters = (patch: Partial<RouletteFilters>) => setParams(filtersToParams({ ...filters, ...patch }), { replace: true });

  const libs = libraries.filter((l) => (filters.kind === 'series' ? l.type === 'shows' : l.type === 'movies'));
  const libId = filters.libraryIds?.[0] ?? '';
  const [genres, setGenres] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    api.items.genres(libId || undefined).then((g) => live && setGenres(g)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [libId]);

  const [result, setResult] = useState<RouletteSpinResponse | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [trailer, setTrailer] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const revealRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const plan = useMemo(() => {
    if (!result?.pick) return null;
    const vw = viewportRef.current?.clientWidth ?? 900;
    return planReel(result.pick.id, result.decoys.map((d) => d.id), { cardW: CARD_W, gap: GAP, viewport: vw, laps: 3, jitter: Math.random() });
  }, [result]);
  const posterOf = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const d of result?.decoys ?? []) m.set(d.id, d.posterUrl);
    if (result?.pick) m.set(result.pick.id, result.pick.posterUrl);
    return m;
  }, [result]);
  const titleOf = useMemo(() => new Map((result?.decoys ?? []).map((d) => [d.id, d.title] as const).concat(result?.pick ? [[result.pick.id, result.pick.title]] : [])), [result]);

  // Run the reel whenever a new plan arrives.
  useEffect(() => {
    const strip = stripRef.current;
    if (!plan || !strip) return;
    cancelAnimationFrame(rafRef.current);
    if (reducedMotion()) {
      strip.style.transform = `translate3d(${plan.finalX}px,0,0)`;
      setSpinning(false);
      setRevealed(true);
      return;
    }
    const start = performance.now();
    strip.style.transform = 'translate3d(0,0,0)';
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / SPIN_MS);
      strip.style.transform = `translate3d(${(plan.finalX * reelEase(p)).toFixed(1)}px,0,0)`;
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else {
        setSpinning(false);
        window.setTimeout(() => setRevealed(true), 250);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [plan]);

  useEffect(() => {
    if (revealed) revealRef.current?.querySelector<HTMLElement>('.btn-primary')?.focus({ preventScroll: false });
  }, [revealed]);

  const spin = useCallback(async (extraExclude: string[] = []) => {
    if (spinning) return;
    setSpinning(true);
    setRevealed(false);
    setTrailer(false);
    try {
      const r = await decideApi.spin({ ...filters, excludeIds: [...excluded, ...extraExclude] });
      if (!r.pick) {
        setSpinning(false);
        setResult(r);
        return;
      }
      setResult(r);
    } catch (e) {
      setSpinning(false);
      toast.error(errorMessage(e));
    }
  }, [filters, excluded, spinning, toast]);

  const notThisOne = () => {
    if (!result?.pick) return;
    const next = [...excluded, result.pick.id];
    setExcluded(next);
    void spin([result.pick.id]);
  };

  const shufflePlay = async (first?: Item | null) => {
    try {
      const r = await decideApi.startMarathon({ ...filters, randomEpisode: filters.kind === 'series' ? true : undefined, ...({ excludeIds: excluded } as object) });
      const start = first ?? r.item;
      if (!start) return toast.error('Nothing matches these filters');
      navigate(marathonPlayLink(start.id, r.marathon.id));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const pick = result?.pick ?? null;
  const playTarget = pick ? (result?.episode ?? (pick.type === 'movie' ? pick : null)) : null;
  const activeCount = [filters.libraryIds?.length, filters.genres?.length, filters.maxRuntimeMin, filters.decade, filters.minRating, filters.unwatchedOnly, filters.fromMyList].filter(Boolean).length;

  return (
    <div className="page roulette-page">
      <header className="page-header roulette-head">
        <div className="page-header-text">
          <span className="page-header-eyebrow">Help me decide</span>
          <h1 className="page-header-title">Can't decide? Spin</h1>
          <p className="page-header-sub">Let {branding.serverName} pick something from your library.</p>
        </div>
        <div className="segmented" role="tablist" aria-label="What to spin for">
          <button role="tab" aria-selected={filters.kind === 'movie'} className={filters.kind === 'movie' ? 'active' : ''} onClick={() => setFilters({ kind: 'movie', libraryIds: [] })}><Icon name="film" size={16} /> Movie</button>
          <button role="tab" aria-selected={filters.kind === 'series'} className={filters.kind === 'series' ? 'active' : ''} onClick={() => setFilters({ kind: 'series', libraryIds: [] })}><Icon name="shows" size={16} /> Series</button>
        </div>
      </header>

      <div className="roulette-moods" role="group" aria-label="Mood">
        {MOODS.map((m) => (
          <button key={m.id} className={`chip ${filters.mood === m.id ? 'active' : ''}`} aria-pressed={filters.mood === m.id} onClick={() => setFilters({ mood: filters.mood === m.id ? null : m.id })}>
            <Icon name={m.icon} size={14} /> {m.label}
          </button>
        ))}
        <button className={`chip ${showFilters ? 'active' : ''}`} aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}>
          <Icon name="filter" size={14} /> Filters{activeCount ? ` · ${activeCount}` : ''}
        </button>
      </div>

      {showFilters && (
        <div className="roulette-filters card-surface">
          <label className="field-inline">
            <span>Library</span>
            <select className="select" value={libId} onChange={(e) => setFilters({ libraryIds: e.target.value ? [e.target.value] : [], genres: [] })}>
              <option value="">All {filters.kind === 'series' ? 'TV' : 'movie'} libraries</option>
              {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <label className="field-inline">
            <span>{filters.kind === 'series' ? 'Episode length' : 'Runtime'}</span>
            <select className="select" value={filters.maxRuntimeMin ?? ''} onChange={(e) => setFilters({ maxRuntimeMin: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Any length</option>
              {RUNTIMES.map((m) => <option key={m} value={m}>Under {formatDuration(m * 60000)}</option>)}
            </select>
          </label>
          <label className="field-inline">
            <span>Decade</span>
            <select className="select" value={filters.decade ?? ''} onChange={(e) => setFilters({ decade: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Any decade</option>
              {DECADES.map((d) => <option key={d} value={d}>{d}s</option>)}
            </select>
          </label>
          <label className="field-inline">
            <span>Rating</span>
            <select className="select" value={filters.minRating ?? ''} onChange={(e) => setFilters({ minRating: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Any rating</option>
              {[6, 7, 7.5, 8, 8.5].map((r) => <option key={r} value={r}>{r}+</option>)}
            </select>
          </label>
          <div className="roulette-switches">
            <Switch checked={!!filters.unwatchedOnly} onChange={(v) => setFilters({ unwatchedOnly: v })} label="Unwatched only" />
            <Switch checked={!!filters.fromMyList} onChange={(v) => setFilters({ fromMyList: v })} label="From My List" />
            <Switch checked={filters.weighted !== false} onChange={(v) => setFilters({ weighted: v })} label="Favour highly rated & new" hint="Never suggests anything you gave a thumbs down or marked Not interested." />
            {filters.kind === 'series' && <Switch checked={!!filters.randomEpisode} onChange={(v) => setFilters({ randomEpisode: v })} label="Random episode" hint="For sitcoms and other shows you can dip into anywhere. Off: next up, or episode 1." />}
          </div>
          {genres.length > 0 && (
            <div className="roulette-genres" role="group" aria-label="Genres">
              {genres.map((g) => {
                const on = !!filters.genres?.includes(g);
                return (
                  <button key={g} className={`chip chip-sm ${on ? 'active' : ''}`} aria-pressed={on} onClick={() => setFilters({ genres: on ? filters.genres!.filter((x) => x !== g) : [...(filters.genres ?? []), g] })}>{g}</button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="roulette-stage">
        <div className="roulette-viewport" ref={viewportRef} aria-hidden={!spinning}>
          <div className="roulette-pointer" aria-hidden="true" />
          {plan ? (
            <div className={`roulette-strip ${revealed ? 'settled' : ''}`} ref={stripRef} style={{ gap: GAP }}>
              {plan.order.map((id, i) => (
                <div key={i} className={`roulette-card ${i === plan.targetIndex && !spinning ? 'is-pick' : ''}`} style={{ width: CARD_W }}>
                  <Img src={posterOf.get(id) ?? null} width={CARD_W} alt="" fallback={<span className="roulette-card-title">{titleOf.get(id)}</span>} />
                </div>
              ))}
            </div>
          ) : (
            <div className="roulette-idle">
              {spinning ? <Spinner /> : <><Icon name="shuffle" size={44} /><p>Set a mood or some filters, then spin.</p></>}
            </div>
          )}
        </div>
        <div className="roulette-actions">
          <button className="btn btn-primary btn-lg roulette-spin" onClick={() => spin()} disabled={spinning} data-nav>
            <Icon name="shuffle" size={20} /> {result ? 'Spin again' : 'Spin'}
          </button>
          <button className="btn btn-lg" onClick={() => shufflePlay()} disabled={spinning} title="Play random titles back to back until you stop" data-nav>
            <Icon name="play" size={18} /> Shuffle play
          </button>
        </div>
        {result && !result.pick && !spinning && <p className="muted roulette-empty">Nothing matches those filters{excluded.length ? ' (or you passed on everything)' : ''}. Try loosening them.</p>}
      </div>

      {pick && revealed && (
        <div className="roulette-reveal" ref={revealRef} aria-live="polite">
          {pick.backdropUrl && <div className="roulette-reveal-bg" style={{ backgroundImage: `url("${mediaUrl(pick.backdropUrl, 1280)}")` }} />}
          <div className="roulette-reveal-body">
            <div className="roulette-reveal-poster"><Img src={pick.posterUrl} width={220} alt="" /></div>
            <div className="roulette-reveal-text">
              <small className="eyebrow">Tonight's pick</small>
              <h2>{pick.title}</h2>
              <p className="muted">
                {[pick.year, pick.contentRating, pick.durationMs ? formatDuration(pick.durationMs) : null, pick.communityRating ? `★ ${pick.communityRating.toFixed(1)}` : null, pick.genres.slice(0, 3).join(', ')].filter(Boolean).join(' · ')}
              </p>
              {result?.episode && (
                <p className="roulette-episode"><Icon name="play" size={12} /> S{result.episode.parentIndex ?? '?'} · E{result.episode.index ?? '?'} — {result.episode.title}</p>
              )}
              {pick.overview && <p className="roulette-overview">{pick.overview}</p>}
              <div className="row-gap roulette-reveal-actions">
                {playTarget && <Link to={playLink(playTarget, { fromStart: !playTarget.userData.positionMs })} className="btn btn-primary btn-lg" data-nav><Icon name="play" size={18} /> Play</Link>}
                {pick.trailerUrl && <button className="btn btn-glass btn-lg" onClick={() => setTrailer(true)} data-nav><Icon name="video" size={18} /> Trailer</button>}
                <button className="btn btn-glass" onClick={() => spin()} data-nav><Icon name="shuffle" size={16} /> Spin again</button>
                <button className="btn btn-ghost" onClick={notThisOne} data-nav><Icon name="x" size={16} /> Not this one</button>
                {playTarget && <button className="btn btn-ghost" onClick={() => shufflePlay(playTarget)} title="When it ends, keep playing random picks with these filters" data-nav><Icon name="repeat" size={16} /> Marathon</button>}
                <Link to={`/item/${pick.id}`} className="btn btn-ghost" data-nav><Icon name="info" size={16} /> Details</Link>
              </div>
            </div>
          </div>
        </div>
      )}

      <Modal open={trailer && !!pick?.trailerUrl} onClose={() => setTrailer(false)} size="xl" className="trailer-modal" title={pick ? `${pick.title} — Trailer` : 'Trailer'}>
        {pick?.trailerUrl && (trailerEmbed(pick.trailerUrl).kind === 'youtube'
          ? <iframe className="trailer-frame" src={trailerEmbed(pick.trailerUrl).src} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen title="Trailer" />
          : <video className="trailer-frame" src={pick.trailerUrl} controls autoPlay />)}
      </Modal>
    </div>
  );
}
