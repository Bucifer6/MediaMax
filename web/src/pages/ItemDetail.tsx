import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { ExtraType, Item, MediaSource, UserItemData } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { ApiRequestError, withToken } from '../api/client';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync, useMediaQuery, useServerEvent } from '../hooks';
import { usePlayAsMix, usePlayItem, useMusic } from '../player/music';
import { openPlayRules } from '../components/PlayRules';
import { advancedDjEnabled } from '../player/djAccess';
import { usePlayWarmup } from '../player/warmup';
import { Icon, type IconName } from '../components/Icon';
import { Badge, Button, Dropdown, EmptyState, ErrorState, Img, Modal, Popover, ProgressBar, QualityBadges, Skeleton, StarRating, Tabs, useConfirm, type MenuItem } from '../components/ui';
import { Row } from '../components/Row';
import { canWatchlist, PosterCard, WatchlistButton } from '../components/Cards';
import { SmartListModal } from '../components/SmartListModal';
import { BookmarksSection } from '../components/Bookmarks';
import { AddToContainerModal, EditMetadataModal, UploadArtworkModal } from '../components/ItemModals';
import { RatingBadges } from '../components/RatingBadges';
import { CompanyLogos, EpisodeRatingsGrid, TraktComments } from '../components/Community';
import { MediaRangeBadge, rangeDetails } from '../components/HdrBadge';
import { AudioBadges, audioFormat, channelText } from '../components/AudioBadge';
import { ArrItemActions } from '../components/ArrItemActions';
import { AlbumFacts, ArtistCredits, MusicBrainzLinks, ReleaseTypeBadges } from '../components/MusicBits';
import { ArtistDiscography, RelatedArtists } from '../components/ArtistMusic';
import { ReportIssueDialog, useCanReportIssue } from '../components/ReportIssue';
import { canFixMatch } from '../components/FixMatch';
import { canSearchSubtitles, SubtitleSearchModal } from '../components/SubtitleSearch';
import { formatBitrate, formatBytes, formatClock, formatDate, formatDuration, languageName } from '../utils/format';
import { episodeCode, hasAudioResume, isAudio, isResumable, isVideo, itemLink, playLink, posterFor, progressPct } from '../utils/items';
import { useAmbientFrom } from '../theme/ambient';
import { POSTER_VT, previewFromState } from '../utils/viewTransition';
import { RecapCard } from '../components/RecapCard';
import '../styles/screens-detail.css';

/* ---------------- Media info ---------------- */
export function MediaBadges({ media }: { media?: MediaSource[] }) {
  const m = media?.[0];
  if (!m) return null;
  const audio = m.audioStreams.find((a) => a.default) ?? m.audioStreams[0];
  return (
    <span className="media-badges">
      {m.resolutionLabel && <Badge tone="muted" className="badge-res">{m.resolutionLabel}</Badge>}
      <MediaRangeBadge media={m} />
      {m.videoCodec && <Badge tone="muted">{m.videoCodec.toUpperCase()}</Badge>}
      {audio && (audio.atmos || audio.dtsX || audio.dtsHdMa || audio.codec === 'truehd'
        ? <AudioBadges stream={audio} />
        : <Badge tone="muted">{audioFormat(audio)} {channelText(audio)}</Badge>)}
      {m.subtitleStreams.length > 0 && <Badge tone="muted">CC</Badge>}
      {m.remote && <Badge tone="accent">IPTV</Badge>}
    </span>
  );
}

/** A version's name: its edition ("Director's Cut"), else its quality ("4K HDR"). */
function versionLabel(m: MediaSource, i: number): string {
  return m.edition || [m.resolutionLabel, m.videoRange && m.videoRange.hdrFormat !== 'sdr' ? m.videoRange.label : m.hdr ? 'HDR' : null].filter(Boolean).join(' ') || `Version ${i + 1}`;
}

/** Technical details, with a versions / editions picker when the title has more than one file. */
function MediaInfo({ media }: { media: MediaSource[] }) {
  const [sel, setSel] = useState(0);
  const m = media[Math.min(sel, media.length - 1)]!;
  return (
    <div className="tp-mediainfo">
      {media.length > 1 && (
        <div className="tp-versions">
          <div className="tp-versions-list" role="radiogroup" aria-label="Versions">
            {media.map((v, i) => (
              <button key={v.id} type="button" role="radio" aria-checked={i === sel} className={`tp-version ${i === sel ? 'active' : ''}`} onClick={() => setSel(i)}>
                <span className="tp-version-name">{versionLabel(v, i)}</span>
                <small>{[v.edition ? v.resolutionLabel : null, v.videoCodec?.toUpperCase(), formatBytes(v.size)].filter(Boolean).join(' · ')}</small>
              </button>
            ))}
          </div>
          <p className="tp-hint">The player picks the best version for this device.</p>
        </div>
      )}
      <dl className="tp-facts">
        <dt>Container</dt><dd>{m.container?.toUpperCase() ?? '—'}</dd>
        <dt>Video</dt><dd>{[m.videoCodec?.toUpperCase(), m.width && m.height ? `${m.width}×${m.height}` : null, m.resolutionLabel, m.videoRange && m.videoRange.hdrFormat !== 'sdr' ? null : m.hdr ? 'HDR' : null].filter(Boolean).join(' · ') || '—'}</dd>
        {m.videoRange && m.videoRange.hdrFormat !== 'sdr' && <><dt>HDR</dt><dd><MediaRangeBadge media={m} /> {rangeDetails(m.videoRange)}</dd></>}
        <dt>Bitrate</dt><dd>{formatBitrate(m.bitrate)}</dd>
        <dt>Size</dt><dd>{formatBytes(m.size)}</dd>
        <dt>Duration</dt><dd className="tabular">{formatClock(m.durationMs)}</dd>
      </dl>
      {m.audioStreams.length > 0 && (
        <div className="tp-streams">
          <h4>Audio</h4>
          <ul className="stream-list">
            {m.audioStreams.map((a) => (
              <li key={a.index}>
                <Icon name="audio" size={14} />
                <span>
                  {[a.title || languageName(a.language), a.title === a.formatLabel ? null : audioFormat(a), channelText(a), a.sampleRate ? `${a.sampleRate / 1000} kHz` : null, a.bitDepth && a.lossless ? `${a.bitDepth}-bit` : null, a.bitrate ? formatBitrate(a.bitrate) : null].filter(Boolean).join(' · ')}
                </span>
                <AudioBadges stream={a} channels={false} /> {a.default && <Badge tone="muted">Default</Badge>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {m.subtitleStreams.length > 0 && (
        <div className="tp-streams">
          <h4>Subtitles</h4>
          <ul className="stream-list">
            {m.subtitleStreams.map((s) => (
              <li key={s.index}>
                <Icon name="subtitles" size={14} /> {s.title || languageName(s.language)} · {s.codec.toUpperCase()} {s.forced && <Badge tone="muted">Forced</Badge>} {s.external && <Badge tone="muted">External</Badge>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CastRow({ item }: { item: Item }) {
  const navigate = useNavigate();
  if (!item.people?.length) return null;
  return (
    <Row title="Cast & crew" className="row-cast">
      {item.people.slice(0, 40).map((p, i) => (
        <button key={`${p.name}-${i}`} className="person" onClick={() => navigate(`/search?q=${encodeURIComponent(p.name)}`)} data-nav>
          <span className="person-img">
            <Img src={p.imageUrl} width={160} alt={p.name} fallback={<Icon name="user" size={30} />} />
          </span>
          <span className="person-name">{p.name}</span>
          <span className="person-role">{p.role || p.kind}</span>
        </button>
      ))}
    </Row>
  );
}

function SimilarRow({ item }: { item: Item }) {
  const sim = useAsync(() => api.items.similar(item.id, 16).catch(() => [] as Item[]), [item.id]);
  if (!sim.data?.length) return null;
  return (
    <Row title="More like this">
      {sim.data.map((s) => <PosterCard key={s.id} item={s} />)}
    </Row>
  );
}

/** Link to the library filtered to a book series (sorted by series order). */
export function seriesLink(item: Item): string {
  const name = item.series?.name ?? '';
  return item.libraryId ? `/library/${item.libraryId}?series=${encodeURIComponent(name)}` : `/search?q=${encodeURIComponent(name)}`;
}

function SeriesRow({ item }: { item: Item }) {
  const name = item.series?.name;
  const books = useAsync(
    async () => (name ? (await api.items.query({ series: name, type: 'audiobook', limit: 60 })).items : []),
    [name],
  );
  if (!name || !books.data || books.data.length < 2) return null;
  return (
    <Row title={<>More in {name}</>} link={seriesLink(item)} className="series-row">
      {books.data.map((b) => (
        <div key={b.id} className={`series-cell ${b.id === item.id ? 'current' : ''}`}>
          <PosterCard item={b} shape="square" />
          {b.series?.index != null && <span className="series-index">Book {b.series.index}</span>}
        </div>
      ))}
    </Row>
  );
}

/* ---------------- Episode list ---------------- */
function EpisodeList({ seasonId, upNextId }: { seasonId: string; upNextId?: string | null }) {
  const play = usePlayItem();
  const { user } = useApp();
  const warm = usePlayWarmup(user ?? null);
  const blurUnwatched = !!user?.preferences.blurUnwatchedEpisodes;
  const eps = useAsync(() => api.items.children(seasonId, { sort: 'index', order: 'asc', limit: 500 }), [seasonId]);
  useServerEvent((ev) => {
    if (ev.type === 'userdata.updated') eps.setData((d) => d && { ...d, items: d.items.map((i) => (i.id === ev.itemId ? { ...i, userData: ev.userData } : i)) });
  });
  if (eps.loading && !eps.data) {
    return (
      <ol className="tp-episodes" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="tp-ep">
            <Skeleton className="tp-ep-still" />
            <div className="tp-ep-body"><Skeleton h={18} w="50%" /><Skeleton h={14} w="90%" style={{ marginTop: 10 }} /><Skeleton h={14} w="70%" style={{ marginTop: 6 }} /></div>
          </li>
        ))}
      </ol>
    );
  }
  if (eps.error) return <ErrorState message={eps.error} onRetry={eps.reload} />;
  if (!eps.data?.items.length) return <EmptyState icon="shows" title="No episodes" compact />;
  return (
    <ol className="tp-episodes">
      {eps.data.items.map((ep) => {
        const pct = progressPct(ep);
        const inProgress = pct > 0 && !ep.userData.played;
        const left = inProgress && ep.durationMs ? ep.durationMs - ep.userData.positionMs : 0;
        const upNext = ep.id === upNextId;
        return (
          <li key={ep.id} className={`tp-ep ${ep.userData.played ? 'played' : ''} ${upNext ? 'up-next' : ''} ${blurUnwatched && !ep.userData.played && !inProgress ? 'spoiler' : ''}`}>
            <button className="tp-ep-still" onClick={() => play(ep)} aria-label={`${inProgress ? 'Resume' : 'Play'} episode ${ep.index ?? ''}: ${ep.title}`} data-nav {...warm.bind(ep)}>
              <Img src={ep.thumbUrl ?? ep.backdropUrl} width={480} alt="" fallback={<Icon name="shows" size={24} />} />
              <span className="tp-ep-play" aria-hidden="true"><Icon name="play" size={20} /></span>
              {ep.durationMs ? <span className="tp-ep-dur tabular">{formatDuration(ep.durationMs)}</span> : null}
              {inProgress && <ProgressBar value={pct} className="tp-ep-progress" />}
            </button>
            <div className="tp-ep-body">
              <div className="tp-ep-head">
                <Link to={itemLink(ep)} className="tp-ep-title">
                  <span className="tp-ep-num tabular">{ep.index ?? '?'}</span>
                  <span>{ep.title}</span>
                </Link>
                {ep.userData.played && <span className="tp-ep-watched" title="Watched"><Icon name="checkCircle" size={16} /><span className="sr-only">Watched</span></span>}
              </div>
              <div className="tp-ep-meta">
                {upNext && <span className="tp-ep-next">{inProgress ? 'Continue' : 'Up next'}</span>}
                {inProgress && <span className="tabular">{formatDuration(left)} left</span>}
                {ep.releaseDate && <span>{formatDate(ep.releaseDate)}</span>}
              </div>
              {ep.overview && <p className="tp-ep-overview">{ep.overview}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ---------------- Podcast episodes (newest first) ---------------- */
function PodcastEpisodes({ podcast }: { podcast: Item }) {
  const play = usePlayItem();
  const music = useMusic();
  const eps = useAsync(() => api.items.children(podcast.id, { sort: 'releaseDate', order: 'desc', limit: 500 }), [podcast.id]);
  useServerEvent((ev) => {
    if (ev.type === 'userdata.updated') eps.setData((d) => d && { ...d, items: d.items.map((i) => (i.id === ev.itemId ? { ...i, userData: ev.userData } : i)) });
  });
  if (eps.loading && !eps.data) return <div className="episode-list">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={64} style={{ marginBottom: 8 }} />)}</div>;
  if (eps.error) return <ErrorState message={eps.error} onRetry={eps.reload} />;
  if (!eps.data?.items.length) return <EmptyState icon="podcast" title="No episodes yet" message="New episodes appear here when the feed refreshes." />;
  return (
    <section className="podcast-episodes">
      <h2 className="section-title">Episodes</h2>
      <ol className="pod-ep-list">
        {eps.data.items.map((ep) => {
          const pct = progressPct(ep);
          const isCurrent = music.current?.id === ep.id;
          const left = ep.durationMs && pct > 0 && !ep.userData.played ? ep.durationMs - ep.userData.positionMs : null;
          return (
            <li key={ep.id} className={`pod-ep ${ep.userData.played ? 'played' : ''} ${isCurrent ? 'current' : ''}`}>
              <button className="pod-ep-play" onClick={() => play(ep)} aria-label={`${pct > 0 && !ep.userData.played ? 'Resume' : 'Play'} ${ep.title}`} data-nav>
                {isCurrent && music.playing ? <span className="eq"><i /><i /><i /></span> : <Icon name="play" size={18} />}
              </button>
              <div className="pod-ep-body">
                <Link to={itemLink(ep)} className="pod-ep-title">{ep.title}</Link>
                <div className="pod-ep-meta muted">
                  {ep.releaseDate && <span>{formatDate(ep.releaseDate)}</span>}
                  {ep.durationMs ? <span>{formatDuration(ep.durationMs)}</span> : null}
                  {left != null && <span className="pod-ep-left">{formatDuration(left)} left</span>}
                  {ep.userData.played && <span className="pod-ep-played"><Icon name="check" size={13} /> Played</span>}
                </div>
                {pct > 0 && !ep.userData.played && <ProgressBar value={pct} />}
                {ep.overview && <p className="pod-ep-overview">{ep.overview}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const seasonName = (s: Item) => s.title || (s.index === 0 ? 'Specials' : `Season ${s.index}`);

function SeasonsBody({ show, upNext }: { show: Item; upNext?: Item | null }) {
  const toast = useToast();
  const seasons = useAsync(() => api.items.children(show.id, { sort: 'index', order: 'asc', limit: 200 }), [show.id]);
  const [active, setActive] = useState<string | null>(null);
  // Bumped after "Mark season watched" so the episode list re-reads its watched state.
  const [epsVersion, setEpsVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const chose = useRef(false);
  const list = seasons.data?.items ?? [];
  const preferred = upNext?.parentId && list.some((s) => s.id === upNext.parentId) ? upNext.parentId : null;
  useEffect(() => {
    if (!list.length || chose.current) return;
    if (preferred) {
      setActive(preferred);
      return;
    }
    if (active) return;
    const firstUnplayed = list.find((s) => (s.index ?? 0) > 0 && !s.userData.played) ?? list.find((s) => (s.index ?? 0) > 0) ?? list[0];
    setActive(firstUnplayed!.id);
  }, [list, active, preferred]);
  if (seasons.loading && !seasons.data) return <section className="tp-seasons"><Skeleton h={36} w={320} /></section>;
  if (!list.length) return <EmptyState icon="shows" title="No seasons yet" compact />;
  const cur = list.find((s) => s.id === active) ?? list[0]!;
  const pick = (id: string) => {
    chose.current = true;
    setActive(id);
  };
  const toggleSeason = async () => {
    setBusy(true);
    try {
      const ud = await api.items.setPlayed(cur.id, !cur.userData.played);
      seasons.setData((d) => d && { ...d, items: d.items.map((s) => (s.id === cur.id ? { ...s, userData: ud } : s)) });
      setEpsVersion((v) => v + 1);
      toast.show(ud.played ? `${seasonName(cur)} marked watched` : `${seasonName(cur)} marked unwatched`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="tp-seasons" aria-labelledby="tp-episodes-h">
      <div className="tp-section-head">
        <h2 className="tp-h2" id="tp-episodes-h">Episodes</h2>
        {list.length > 1 && list.length <= 12 ? (
          <Tabs
            className="tp-season-tabs"
            variant="pills"
            value={cur.id}
            onChange={pick}
            tabs={list.map((s) => ({
              value: s.id,
              label: (
                <>
                  {seasonName(s)}
                  {s.userData.unplayedCount ? <span className="tab-count" aria-label={`${s.userData.unplayedCount} unwatched`}>{s.userData.unplayedCount}</span> : s.userData.played ? <Icon name="check" size={14} /> : null}
                </>
              ),
            }))}
          />
        ) : list.length > 12 ? (
          <select className="select tp-season-select" value={cur.id} onChange={(e) => pick(e.target.value)} aria-label="Season">
            {list.map((s) => <option key={s.id} value={s.id}>{seasonName(s)}{s.userData.unplayedCount ? ` (${s.userData.unplayedCount} unwatched)` : ''}</option>)}
          </select>
        ) : (
          <span className="tp-season-single">{seasonName(cur)}</span>
        )}
        <div className="tp-section-actions">
          <Button size="sm" variant="ghost" icon={cur.userData.played ? 'checkCircle' : 'check'} onClick={() => void toggleSeason()} loading={busy} aria-pressed={cur.userData.played}>
            {cur.userData.played ? 'Season watched' : 'Mark season watched'}
          </Button>
          <Link className="btn btn-ghost btn-sm" to={itemLink(cur)}>Season details</Link>
        </div>
      </div>
      <EpisodeList key={`${cur.id}-${epsVersion}`} seasonId={cur.id} upNextId={upNext?.id} />
    </section>
  );
}

/* ---------------- Tracks ---------------- */
/** On an album, a track's artist line shows only when it differs from the album artist (features, compilations). */
function showTrackArtist(t: Item, parent: Item): boolean {
  if (parent.type !== 'album') return true;
  const credits = t.music?.credits ?? [];
  if (credits.length > 1) return true;
  const shown = t.music?.displayArtist ?? t.grandparentTitle;
  return !!shown && shown !== parent.parentTitle;
}

function TrackList({ parent, removable, onRemove }: { parent: Item; removable?: boolean; onRemove?: (i: Item) => void }) {
  const music = useMusic();
  const play = usePlayItem();
  const ordered = parent.type === 'album' || parent.type === 'audiobook';
  const tracks = useAsync(() => api.items.children(parent.id, { sort: ordered ? 'index' : undefined, limit: 1000 }), [parent.id]);
  const [addTo, setAddTo] = useState<Item | null>(null);
  if (tracks.loading && !tracks.data) return <div className="tracklist">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} h={44} style={{ marginBottom: 6 }} />)}</div>;
  const list = tracks.data?.items ?? [];
  if (!list.length) return <EmptyState icon="music" title="Nothing here yet" />;
  const audioList = list.filter(isAudio);
  const showDisc = new Set(list.map((t) => t.parentIndex)).size > 1 && parent.type === 'album';
  return (
    <>
      <ol className="tracklist">
        {list.map((t, i) => {
          const isCurrent = music.current?.id === t.id;
          return (
            <li key={t.id} className={`track ${isCurrent ? 'current' : ''}`}>
              {/* The row is one big play button (stretched under the content) so the artist names can be real links. */}
              <div className="track-main">
                <button className="track-hit" onClick={() => (isAudio(t) ? music.playQueue(audioList, audioList.indexOf(t)) : play(t))} aria-label={`Play ${t.title}`} data-nav />
                <span className="track-num">
                  {isCurrent && music.playing ? <span className="eq"><i /><i /><i /></span> : <span className="track-idx">{ordered ? t.index ?? i + 1 : i + 1}</span>}
                  <Icon name="play" size={14} className="track-playicon" />
                </span>
                {!ordered && (
                  <span className="track-art"><Img src={t.posterUrl ?? t.thumbUrl} width={64} fallback={<Icon name="music" size={14} />} /></span>
                )}
                <span className="track-title">
                  <span>{t.title}</span>
                  {parent.type === 'audiobook' ? (progressPct(t) > 0 && !t.userData.played ? <small>{Math.round(progressPct(t))}% listened</small> : t.userData.played ? <small>Finished</small> : null) : showTrackArtist(t, parent) && (
                    <small className="track-credits">
                      <ArtistCredits credits={t.music?.credits} fallback={t.music?.displayArtist ?? t.grandparentTitle} />
                      {parent.type !== 'album' && t.parentTitle ? ` · ${t.parentTitle}` : ''}
                    </small>
                  )}
                </span>
                {showDisc && <span className="muted track-disc">Disc {t.parentIndex}{parent.music?.discTitles?.[String(t.parentIndex)] ? ` · ${parent.music.discTitles[String(t.parentIndex)]}` : ''}</span>}
                <span className="track-dur">{t.durationMs ? formatClock(t.durationMs) : ''}</span>
              </div>
              <Dropdown
                trigger={({ onClick }) => <button className="btn-icon track-more" onClick={onClick} aria-label="More"><Icon name="more" size={18} /></button>}
                items={[
                  ...(isAudio(t) ? [
                    { label: 'Play next', icon: 'next' as const, onClick: () => music.enqueue([t], true) },
                    { label: 'Add to queue', icon: 'queue' as const, onClick: () => music.enqueue([t]) },
                  ] : []),
                  { label: 'Add to playlist', icon: 'playlist', onClick: () => setAddTo(t) },
                  ...(removable ? [{ label: 'Remove', icon: 'trash' as const, danger: true, onClick: () => { onRemove?.(t); tracks.setData((d) => d && { ...d, items: d.items.filter((x) => x.id !== t.id) }); } }] : []),
                ]}
              />
            </li>
          );
        })}
      </ol>
      <AddToContainerModal open={!!addTo} onClose={() => setAddTo(null)} items={addTo ? [addTo] : []} kind="playlist" />
    </>
  );
}

function ChildrenGrid({ parent, title, removable, onRemove }: { parent: Item; title?: string; removable?: boolean; onRemove?: (i: Item) => void }) {
  const kids = useAsync(() => api.items.children(parent.id, { limit: 500, sort: parent.type === 'artist' ? 'year' : undefined, order: parent.type === 'artist' ? 'desc' : undefined }), [parent.id]);
  if (kids.loading && !kids.data) return <Skeleton h={240} />;
  const list = kids.data?.items ?? [];
  if (!list.length) return <EmptyState icon="collection" title="Nothing here yet" />;
  return (
    <section>
      {title && <h2 className="section-title">{title}</h2>}
      <div className={`grid grid-${parent.type === 'artist' ? 'square' : 'poster'}`}>
        {list.map((c) => (
          <div key={c.id} className="grid-cell">
            <PosterCard item={c} width="100%" />
            {removable && (
              <button className="btn-icon grid-remove" onClick={() => { onRemove?.(c); kids.setData((d) => d && { ...d, items: d.items.filter((x) => x.id !== c.id) }); }} aria-label="Remove">
                <Icon name="x" size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ChaptersSection({ item }: { item: Item }) {
  const music = useMusic();
  const navigate = useNavigate();
  const play = usePlayItem();
  const chapters = item.chapters ?? [];
  const playing = music.current?.id === item.id;
  const go = (ms: number) => {
    if (isVideo(item)) navigate(`/play/${item.id}?start=${Math.round(ms)}`);
    else if (playing) music.seek(ms);
    else void play(item);
  };
  return (
    <section className="chapters-section">
      <h2 className="section-title">Chapters <span className="tab-count">{chapters.length}</span></h2>
      <ol className="chapter-grid">
        {chapters.map((c, i) => (
          <li key={`${c.startMs}-${i}`}>
            <button className="chapter-item" onClick={() => go(c.startMs)} data-nav>
              <span className="chapter-num">{i + 1}</span>
              <span className="chapter-title">{c.title || `Chapter ${i + 1}`}</span>
              <small>{formatClock(c.startMs)}</small>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ---------------- Extras ---------------- */
const EXTRA_LABEL: Record<ExtraType, string> = {
  trailer: 'Trailer', featurette: 'Featurette', behindthescenes: 'Behind the scenes', deleted: 'Deleted scene',
  interview: 'Interview', scene: 'Scene', short: 'Short', other: 'Extra',
};

function ExtrasRow({ extras }: { extras: Item[] }) {
  if (!extras.length) return null;
  return (
    <Row title="Extras" className="tp-extras">
      {extras.map((e) => (
        <Link key={e.id} to={playLink(e)} className="tp-extra" data-nav>
          <span className="tp-extra-art">
            <Img src={e.thumbUrl ?? e.backdropUrl ?? e.posterUrl} width={400} alt="" fallback={<Icon name="video" size={24} />} />
            <span className="tp-ep-play" aria-hidden="true"><Icon name="play" size={20} /></span>
            {e.durationMs ? <span className="tp-ep-dur tabular">{formatClock(e.durationMs)}</span> : null}
          </span>
          <span className="tp-extra-title">{e.title}</span>
          <span className="tp-extra-kind">{EXTRA_LABEL[e.extraType ?? 'other']}</span>
        </Link>
      ))}
    </Row>
  );
}

/* ---------------- Rating popover ---------------- */
function RateButton({ item, onRate, onNotInterested }: { item: Item; onRate: (r: number | null) => void; onNotInterested: () => void }) {
  const r = item.userData.rating;
  const thumbsUp = r != null && r >= 8;
  const thumbsDown = r != null && r <= 4;
  const thumbs = !['photo', 'playlist', 'collection'].includes(item.type);
  const label = r == null ? 'Rate' : thumbsUp ? 'Liked' : thumbsDown ? 'Not for me' : `Rated ${r / 2}`;
  return (
    <Popover
      align="left"
      label="Your rating"
      className="tp-rate"
      trigger={({ onClick, open }) => (
        <button className={`btn-round on-media tp-act ${r != null ? 'active' : ''}`} onClick={onClick} aria-expanded={open} aria-haspopup="dialog" aria-label={r == null ? 'Rate this title' : `Your rating: ${label}. Change rating`} title={r == null ? 'Rate' : label} data-nav>
          <Icon name={thumbsDown ? 'thumbDown' : r != null && !thumbsUp ? 'starFill' : 'thumbUp'} />
          <span className="tp-act-label">{label}</span>
        </button>
      )}
    >
      <div className="tp-rate-panel">
        <div className="tp-rate-title">Your rating</div>
        {thumbs && (
          <div className="tp-thumbs" role="group" aria-label="Thumbs rating">
            <button className={`tp-thumb ${thumbsUp ? 'active' : ''}`} onClick={() => onRate(thumbsUp ? null : 10)} aria-pressed={thumbsUp} data-nav>
              <Icon name="thumbUp" size={18} /> I like this
            </button>
            <button className={`tp-thumb ${thumbsDown ? 'active' : ''}`} onClick={() => onRate(thumbsDown ? null : 2)} aria-pressed={thumbsDown} data-nav>
              <Icon name="thumbDown" size={18} /> Not for me
            </button>
          </div>
        )}
        <div className="tp-stars"><StarRating value={r} onChange={onRate} size={24} /></div>
        {(item.type === 'movie' || item.type === 'show') && (
          <button className={`btn btn-sm btn-ghost tp-not-interested ${item.userData.notInterested ? 'active' : ''}`} onClick={onNotInterested} aria-pressed={item.userData.notInterested} title="Hide from your recommendations" data-nav>
            <Icon name={item.userData.notInterested ? 'eye' : 'ban'} size={14} /> {item.userData.notInterested ? 'Show in recommendations' : 'Not interested'}
          </button>
        )}
      </div>
    </Popover>
  );
}

/* ---------------- Page ---------------- */
export function ItemPage() {
  const { itemId = '' } = useParams();
  const { user, features, system } = useApp();
  const playAsMix = usePlayAsMix();
  const advancedDj = advancedDjEnabled(user);
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const play = usePlayItem();
  const phone = useMediaQuery('(max-width: 700px)');
  // A missing (or, for this profile, hidden) title is "not found", not a retryable error.
  const res = useAsync(() => api.items.get(itemId).catch((e) => {
    if (e instanceof ApiRequestError && (e.status === 404 || e.status === 403)) return null;
    throw e;
  }), [itemId]);
  const [modal, setModal] = useState<null | 'edit' | 'match' | 'art' | 'playlist' | 'collection' | 'trailer' | 'photo' | 'subs' | 'smart' | 'report'>(null);
  const [expanded, setExpanded] = useState(false);
  const item = res.data;
  // The card that opened this page handed its item over (utils/viewTransition.ts): draw poster + backdrop at once.
  const preview = previewFromState(useLocation().state, itemId);
  const lit = item ?? preview;
  // The title's artwork lights the page (theme/ambient.ts).
  useAmbientFrom(lit ? lit.backdropUrl ?? lit.posterUrl ?? lit.thumbUrl : null);
  const isSeries = item?.id === itemId && (item.type === 'show' || item.type === 'season' || item.type === 'audiobook' || item.type === 'podcast');
  // Next-up episode of a show/season (server: in progress → next unwatched → first).
  const nextUp = useAsync(
    async () => ({ forId: itemId, ep: isSeries ? await api.items.next(itemId).catch(() => null) : null }),
    [itemId, isSeries, item?.userData.played, item?.userData.unplayedCount],
  );
  // Local extras (trailers, featurettes…): an Extras row, and a Trailer button when there's no online trailer.
  const hasExtras = item?.id === itemId && (item.type === 'movie' || item.type === 'show');
  const extras = useAsync(async () => (hasExtras ? api.items.extras(itemId).catch(() => [] as Item[]) : [] as Item[]), [itemId, hasExtras]);
  const canReport = useCanReportIssue(item ?? { type: 'photo' });
  useEffect(() => setExpanded(false), [itemId]);

  useServerEvent((ev) => {
    if (ev.type === 'userdata.updated' && ev.itemId === itemId) res.setData((d) => d && { ...d, userData: ev.userData });
  });
  // Instant play: warm up what the Play button plays as soon as the page is open (and again on hover / focus).
  const warm = usePlayWarmup(user ?? null);
  const warmTarget = item?.id === itemId && isVideo(item) ? item : nextUp.data?.forId === itemId && nextUp.data.ep && isVideo(nextUp.data.ep) ? nextUp.data.ep : null;
  useEffect(() => {
    if (warmTarget) warm.now(warmTarget, 'open');
  }, [warmTarget?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (res.loading && !item) {
    const art = preview ? preview.backdropUrl ?? (preview.type === 'episode' ? preview.thumbUrl : null) : null;
    return (
      <div className="detail tp tp-loading detail-loading">
        <section className="tp-hero">
          <div className={`detail-backdrop tp-backdrop ${art ? '' : 'skeleton'}`} aria-hidden="true">
            {art && <Img src={art} width={1920} />}
            <div className="tp-shade" />
          </div>
          <div className="tp-head">
            {preview ? <h1 className="tp-title">{preview.title}</h1> : <Skeleton h={52} w="60%" />}
            <Skeleton h={18} w="40%" style={{ marginTop: 16 }} />
          </div>
          <div className="tp-lower">
            <Skeleton h={48} w={180} r={999} />
            <Skeleton h={64} w="90%" style={{ marginTop: 20 }} />
          </div>
        </section>
      </div>
    );
  }
  if (res.error) return <div className="page"><ErrorState message={res.error} onRetry={res.reload} /></div>;
  if (!item) {
    return (
      <div className="page">
        <EmptyState icon="alert" title="Title not found" message="It may have been removed from the library, or it isn't available on this profile."
          action={<Link className="btn btn-primary" to="/">Go home</Link>} />
      </div>
    );
  }

  const setUD = (ud: UserItemData) => res.setData((d) => d && { ...d, userData: ud });
  const togglePlayed = async () => {
    try {
      setUD(await api.items.setPlayed(item.id, !item.userData.played));
    } catch (e) {
      toast.error(e);
    }
  };
  const toggleFav = async () => {
    try {
      setUD(await api.items.setFavorite(item.id, !item.userData.favorite));
    } catch (e) {
      toast.error(e);
    }
  };
  const rate = async (r: number | null) => {
    try {
      setUD(await api.items.rate(item.id, r));
    } catch (e) {
      toast.error(e);
    }
  };
  const notInterested = async () => {
    const on = !item.userData.notInterested;
    try {
      setUD(await api.items.setNotInterested(item.id, on));
      toast.show(on ? "Got it — we won't recommend this to you" : 'OK, it can show up in your recommendations again');
    } catch (e) {
      toast.error(e);
    }
  };
  const refresh = async () => {
    try {
      toast.show('Refreshing metadata…');
      res.setData(await api.items.refresh(item.id));
      toast.success('Metadata refreshed');
    } catch (e) {
      toast.error(e);
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: `Remove "${item.title}"?`, message: 'This removes the item from the library database. Files on disk are not deleted.', confirmLabel: 'Remove', danger: true }))) return;
    try {
      await api.items.remove(item.id);
      toast.success('Removed');
      navigate(-1);
    } catch (e) {
      toast.error(e);
    }
  };
  const removeFromContainer = async (child: Item) => {
    try {
      if (item.type === 'playlist') await api.playlists.removeItem(item.id, child.id);
      else await api.collections.removeItem(item.id, child.id);
    } catch (e) {
      toast.error(e);
    }
  };
  const deleteContainer = async () => {
    if (!(await confirm({ title: `Delete ${item.type} "${item.title}"?`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      if (item.type === 'playlist') await api.playlists.remove(item.id);
      else await api.collections.remove(item.id);
      navigate(item.type === 'playlist' ? '/playlists' : '/collections');
    } catch (e) {
      toast.error(e);
    }
  };

  const playable = isVideo(item) || isAudio(item) || ['show', 'season', 'album', 'artist', 'playlist', 'collection', 'audiobook', 'podcast'].includes(item.type);
  const resumable = (isVideo(item) || hasAudioResume(item)) && isResumable(item);
  const pct = progressPct(item);
  const nextEp = nextUp.data?.forId === item.id && ['episode', 'bookpart', 'podcastepisode'].includes(nextUp.data.ep?.type ?? '') ? nextUp.data.ep : null;
  const nextIsAudio = !!nextEp && isAudio(nextEp);
  const nextResumable = !!nextEp && isResumable(nextEp);
  const playLabel = resumable
    ? `Resume at ${formatClock(item.userData.positionMs)}`
    : nextEp
      ? item.type === 'audiobook'
        ? nextResumable ? `Resume ${nextEp.title}` : (nextEp.index ?? 1) > 1 ? `Continue · ${nextEp.title}` : 'Start listening'
        : `${nextResumable ? 'Resume' : 'Play'} ${nextEp.type === 'episode' && nextEp.index != null ? `S${nextEp.parentIndex ?? '?'} E${nextEp.index}` : nextEp.title}`
      : item.type === 'show' || item.type === 'season' ? 'Play next' : 'Play';
  const square = ['album', 'artist', 'track', 'playlist', 'photo', 'audiobook', 'bookpart', 'podcast', 'podcastepisode'].includes(item.type);
  const isAdmin = !!user?.isAdmin;
  const canDownload = features.downloads && user?.allowDownloads && (isVideo(item) || isAudio(item)) && !item.media?.[0]?.remote;
  const containerOwned = item.type === 'playlist' || (item.type === 'collection' && isAdmin);
  const canPlaylist = item.type !== 'playlist' && item.type !== 'collection';
  const canWatched = item.type !== 'photo' && item.type !== 'playlist' && item.type !== 'collection';
  const localTrailer = !item.trailerUrl ? extras.data?.find((e) => e.extraType === 'trailer') ?? null : null;
  const watchedLabel = item.type === 'season' ? ' season' : item.type === 'show' ? ' show' : '';

  const downloadItems: MenuItem[] = !canDownload ? [] : isVideo(item)
    ? (['original', '1080p', '720p', '480p'] as const).map((q) => ({
        label: q === 'original' ? 'Download original file' : `Download ${q} (MP4)`,
        icon: 'download',
        onClick: () => startDownload(withToken(api.playback.downloadUrl(item.id, q))),
      }))
    : [{ label: 'Download', icon: 'download', onClick: () => startDownload(withToken(api.playback.downloadUrl(item.id))) }];
  const adminItems: MenuItem[] = isAdmin
    ? [
        { label: 'Edit metadata', icon: 'edit', onClick: () => setModal('edit') },
        ...(canFixMatch(item) ? [{ label: item.type === 'track' ? 'Identify by sound…' : 'Fix match…', icon: 'search' as const, onClick: () => setModal('match') }] : []),
        { label: 'Upload artwork', icon: 'upload', onClick: () => setModal('art') },
        { label: 'Refresh metadata', icon: 'refresh', onClick: refresh },
        { label: 'Add to collection', icon: 'collection', onClick: () => setModal('collection') },
        { divider: true, label: '' },
        { label: 'Remove from library', icon: 'trash', danger: true, onClick: remove },
      ]
    : [];
  // On phones the quieter actions fold into More, so the action row stays four labelled buttons.
  const groups: MenuItem[][] = [
    [
      ...(phone ? [{ label: item.userData.favorite ? 'Remove from favourites' : 'Add to favourites', icon: (item.userData.favorite ? 'heartFill' : 'heart') as IconName, onClick: toggleFav }] : []),
      ...(canPlaylist ? [{ label: 'Add to playlist…', icon: 'playlist' as const, onClick: () => setModal('playlist') }] : []),
      ...(features.music && ['album', 'artist', 'playlist'].includes(item.type) ? [{ label: 'Play rules for mixes…', icon: 'filter' as const, onClick: () => openPlayRules() }] : []),
      ...(phone ? downloadItems : []),
    ],
    [
      ...(canSearchSubtitles(item) ? [{ label: 'Find subtitles online…', icon: 'subtitles' as const, onClick: () => setModal('subs') }] : []),
      ...(canReport ? [{ label: 'Report a problem…', icon: 'flag' as const, onClick: () => setModal('report') }] : []),
    ],
    containerOwned ? [{ label: `Delete ${item.type}`, icon: 'trash' as const, danger: true, onClick: deleteContainer }] : [],
    adminItems,
  ];
  const moreItems: MenuItem[] = groups.filter((g) => g.length).flatMap((g, i) => (i ? [{ divider: true, label: '' }, ...g] : g));

  const crumbs: { label: string; to: string }[] = [];
  if (item.type === 'episode') {
    if (item.grandparentId) crumbs.push({ label: item.grandparentTitle ?? 'Show', to: `/item/${item.grandparentId}` });
    if (item.parentId) crumbs.push({ label: item.parentTitle ?? `Season ${item.parentIndex}`, to: `/item/${item.parentId}` });
  } else if (item.type === 'season' && item.parentId) crumbs.push({ label: item.parentTitle ?? 'Show', to: `/item/${item.parentId}` });
  else if ((item.type === 'album' || item.type === 'track') && item.parentId) crumbs.push({ label: item.parentTitle ?? 'Artist', to: `/item/${item.parentId}` });
  else if ((item.type === 'bookpart' || item.type === 'podcastepisode') && item.parentId) crumbs.push({ label: item.parentTitle ?? (item.type === 'bookpart' ? 'Audiobook' : 'Podcast'), to: `/item/${item.parentId}` });

  const people = item.people ?? [];
  const directors = people.filter((p) => p.kind === 'director').map((p) => p.name);
  const writers = people.filter((p) => p.kind === 'writer' && !/^(author|narrator)$/i.test(p.role ?? '')).map((p) => p.name);
  const authors = item.type === 'audiobook' || item.type === 'bookpart'
    ? Array.from(new Set([...people.filter((p) => /^author$/i.test(p.role ?? '')).map((p) => p.name), ...(people.some((p) => /^author$/i.test(p.role ?? '')) || !item.parentTitle || item.type === 'bookpart' ? [] : [item.parentTitle])]))
    : [];
  const narrators = people.filter((p) => /^narrator$/i.test(p.role ?? '')).map((p) => p.name);
  const hasCredits = (item.type === 'track' && !!(item.music?.credits?.length || item.music?.displayArtist)) || item.type === 'album' || authors.length > 0 || narrators.length > 0
    || directors.length > 0 || writers.length > 0 || item.studios.length > 0 || !!item.releaseDate || !!item.userData.lastPlayedAt;
  const hasMedia = !!item.media && item.media.length > 0;

  // Artwork: a backdrop (an episode's own still first); without one, the poster blurred behind a visible poster.
  const backdrop = (item.type === 'episode' ? item.thumbUrl ?? item.backdropUrl : item.backdropUrl) ?? null;
  const showPoster = square || !backdrop;
  const posterShape = square ? 'square' : item.type === 'episode' || item.type === 'video' ? 'landscape' : 'poster';
  const metaParts: React.ReactNode[] = [
    item.type === 'episode' && episodeCode(item) ? <span key="ep">{episodeCode(item)}</span> : null,
    item.type === 'podcastepisode' && item.releaseDate ? <span key="rd">{formatDate(item.releaseDate)}</span> : item.year ? <span key="y">{item.year}</span> : null,
    item.contentRating ? <span key="cr" className="tp-cert">{item.contentRating}</span> : null,
    item.durationMs && item.type !== 'show' && item.type !== 'season' ? <span key="d">{formatDuration(item.durationMs)}</span> : null,
    item.type === 'show' && item.childCount > 0 ? <span key="s">{item.childCount} season{item.childCount > 1 ? 's' : ''}</span> : null,
    item.type === 'season' && item.childCount > 0 ? <span key="e">{item.childCount} episode{item.childCount > 1 ? 's' : ''}</span> : null,
    (item.type === 'album' || item.type === 'playlist' || item.type === 'collection') && item.childCount > 0 ? <span key="n">{item.childCount} {item.type === 'album' ? 'track' : 'item'}{item.childCount === 1 ? '' : 's'}</span> : null,
    item.type === 'audiobook' && item.childCount > 1 ? <span key="p">{item.childCount} parts</span> : null,
    item.type === 'podcast' && item.childCount > 0 ? <span key="pe">{item.childCount} episodes</span> : null,
    item.communityRating != null ? <span key="r" className="tp-score" title="Community rating"><Icon name="starFill" size={13} /> {item.communityRating.toFixed(1)}</span> : null,
  ].filter(Boolean);
  const genreLink = (g: string) => (item.libraryId ? `/library/${item.libraryId}?genre=${encodeURIComponent(g)}` : `/search?q=${encodeURIComponent(g)}`);

  const iconAct = (key: string, icon: IconName, label: string, short: string, onClick: () => void, opts: { active?: boolean; pressed?: boolean; fav?: boolean } = {}) => (
    <button key={key} className={`btn-round on-media tp-act ${opts.active ? 'active' : ''} ${opts.fav ? 'fav' : ''}`} onClick={onClick} aria-pressed={opts.pressed} aria-label={label} title={label} data-nav>
      <Icon name={icon} />
      <span className="tp-act-label" aria-hidden="true">{short}</span>
    </button>
  );

  return (
    <div className={`detail tp tp-${item.type} ${showPoster ? `tp-has-poster tp-poster-${posterShape}` : ''} ${preview ? 'from-card' : ''}`}>
      <section className="tp-hero" aria-labelledby="tp-title">
        <div className="detail-backdrop tp-backdrop" aria-hidden="true">
          <Img src={backdrop ?? item.posterUrl ?? item.thumbUrl} width={1920} className={backdrop ? '' : 'blurred'} />
          <div className="tp-shade" />
        </div>

        {showPoster && (
          <div className={`tp-poster ${posterShape}`} style={{ viewTransitionName: POSTER_VT } as React.CSSProperties}>
            {/* 260 px: the same image the poster cards load, so it is already decoded when the page opens. */}
            <Img src={item.type === 'episode' || item.type === 'video' ? item.thumbUrl ?? item.posterUrl : (system?.ratingPosterScreens?.detail && item.ratingPosterUrl) || item.posterUrl || item.thumbUrl} width={posterShape === 'landscape' ? 400 : 260} alt="" fallback={<Icon name={item.type === 'audiobook' || item.type === 'bookpart' ? 'book' : item.type === 'podcast' || item.type === 'podcastepisode' ? 'podcast' : square ? 'music' : item.type === 'show' || item.type === 'season' || item.type === 'episode' ? 'shows' : 'film'} size={40} />} />
            {item.type === 'photo' && <button className="tp-poster-zoom" onClick={() => setModal('photo')} aria-label="View full size"><Icon name="fullscreen" /></button>}
          </div>
        )}

        <div className="tp-head">
          {crumbs.length > 0 && (
            <nav className="tp-crumbs" aria-label="Breadcrumb">
              {crumbs.map((c) => <Link key={c.to} to={c.to}>{c.label}</Link>)}
            </nav>
          )}
          {item.logoUrl && item.type !== 'episode' ? (
            // The page keeps its heading when the title is shown as a logo image (screen readers, heading navigation).
            <>
              <h1 className="sr-only" id="tp-title">{item.title}</h1>
              <Img src={item.logoUrl} width={600} alt="" className="tp-logo" fallback={<div className="tp-title" aria-hidden="true">{item.title}</div>} />
            </>
          ) : (
            <h1 className="tp-title" id="tp-title">{item.title}</h1>
          )}
          {item.originalTitle && item.originalTitle !== item.title && <p className="tp-orig">{item.originalTitle}</p>}
          <div className="tp-meta">
            {metaParts.length > 0 && <span className="tp-meta-line">{metaParts}</span>}
            {item.type === 'album' && <ReleaseTypeBadges types={item.music?.releaseTypes} />}
            {item.smart && <Badge tone="accent"><Icon name="wand" size={12} /> Smart</Badge>}
            <QualityBadges media={item.media} className="tp-quality" />
            {item.media?.[0]?.remote && <Badge tone="accent">IPTV</Badge>}
            <RatingBadges ratings={item.ratings} />
          </div>
          <CompanyLogos item={item} />
          {item.genres.length > 0 && (
            <p className="tp-genres">
              {item.genres.slice(0, 4).map((g) => <Link key={g} to={genreLink(g)}>{g}</Link>)}
            </p>
          )}
          {item.type === 'audiobook' && item.series?.name && (
            <Link className="detail-series tp-series" to={seriesLink(item)}>
              <Icon name="book" size={14} /> {item.series.index != null ? `Book ${item.series.index} of ` : ''}{item.series.name}
            </Link>
          )}
          {(item.type === 'artist' || item.type === 'album' || item.type === 'track') && <MusicBrainzLinks item={item} />}
        </div>

        <div className="tp-lower">
          {/* "Previously on…" for the episode about to play (this one, or a show's next-up episode). */}
          {(item.type === 'episode' || (nextEp?.type === 'episode' && !nextIsAudio)) && (
            <RecapCard itemId={item.type === 'episode' ? item.id : nextEp!.id} onPlayClip={(c) => navigate(`/play/${encodeURIComponent(c.itemId)}?start=${c.startMs}&keeprecap=1`)} />
          )}

          <div className="tp-actions">
            {playable && (
              <button className="btn btn-play btn-lg tp-play" onClick={() => (nextEp && !nextIsAudio ? navigate(playLink(nextEp)) : play(item))} data-nav data-play autoFocus={document.documentElement.classList.contains('tv')} title={nextEp ? nextEp.title : undefined} {...warm.bind(warmTarget)}>
                <Icon name="play" size={20} /> {playLabel}
              </button>
            )}
            {(resumable && isVideo(item)) || item.trailerUrl || localTrailer || ['album', 'artist', 'playlist'].includes(item.type) || (item.smart && containerOwned) ? (
              <div className="tp-pills">
                {resumable && isVideo(item) && (
                  <button className="btn btn-glass on-media btn-lg" onClick={() => navigate(playLink(item, { fromStart: true }))} data-nav>
                    <Icon name="refresh" size={18} /> Start over
                  </button>
                )}
                {(item.trailerUrl || localTrailer) && (
                  <button className="btn btn-glass on-media btn-lg" onClick={() => (localTrailer ? navigate(playLink(localTrailer)) : setModal('trailer'))} data-nav>
                    <Icon name="video" size={18} /> Trailer
                  </button>
                )}
                {(item.type === 'album' || item.type === 'artist' || item.type === 'playlist') && (
                  <button className="btn btn-glass on-media btn-lg" onClick={() => play(item, { shuffle: true })} data-nav>
                    <Icon name="shuffle" size={18} /> Shuffle
                  </button>
                )}
                {features.music && ['album', 'artist', 'playlist'].includes(item.type) && (
                  <button className="btn btn-glass on-media btn-lg" onClick={() => void playAsMix(item)} data-nav title="Play it as one continuous mix: every song blends into the next">
                    <Icon name="music" size={18} /> Mix
                  </button>
                )}
                {features.music && advancedDj && ['album', 'artist', 'playlist', 'track'].includes(item.type) && (
                  <button className="btn btn-glass on-media btn-lg" onClick={() => navigate(`/dj?seed=${encodeURIComponent(item.id)}`)} data-nav title="An automatic, beat-matched mix starting from this">
                    <Icon name="music" size={18} /> DJ mix
                  </button>
                )}
                {item.smart && containerOwned && (
                  <button className="btn btn-glass on-media btn-lg" onClick={() => setModal('smart')} data-nav>
                    <Icon name="wand" size={18} /> Edit rules
                  </button>
                )}
              </div>
            ) : null}
            <div className="tp-acts" role="group" aria-label="Actions">
              {canWatchlist(item) && <WatchlistButton item={item} variant="hero" />}
              {canWatched && iconAct('watched', item.userData.played ? 'checkCircle' : 'check', `${item.userData.played ? 'Mark' + watchedLabel + ' unwatched' : 'Mark' + watchedLabel + ' watched'}`, 'Watched', togglePlayed, { active: item.userData.played, pressed: item.userData.played })}
              <RateButton item={item} onRate={(r) => void rate(r)} onNotInterested={() => void notInterested()} />
              {!phone && iconAct('fav', item.userData.favorite ? 'heartFill' : 'heart', item.userData.favorite ? 'Remove from favourites' : 'Add to favourites', 'Favourite', toggleFav, { pressed: item.userData.favorite, fav: item.userData.favorite })}
              {!phone && canDownload && (isVideo(item) ? (
                <Dropdown
                  align="left"
                  trigger={({ onClick, open }) => (
                    <button className="btn-round on-media tp-act" onClick={onClick} aria-label="Download" aria-expanded={open} aria-haspopup="menu" title="Download" data-nav>
                      <Icon name="download" /><span className="tp-act-label" aria-hidden="true">Download</span>
                    </button>
                  )}
                  items={downloadItems}
                />
              ) : (
                <a className="btn-round on-media tp-act" href={withToken(api.playback.downloadUrl(item.id))} download aria-label="Download" title="Download" data-nav>
                  <Icon name="download" /><span className="tp-act-label" aria-hidden="true">Download</span>
                </a>
              ))}
              {moreItems.length > 0 && (
                <Dropdown
                  align={phone ? 'right' : 'left'}
                  className="tp-more"
                  trigger={({ onClick, open }) => (
                    <button className="btn-round on-media tp-act" onClick={onClick} aria-label="More actions" aria-expanded={open} aria-haspopup="menu" title="More" data-nav>
                      <Icon name="more" /><span className="tp-act-label" aria-hidden="true">More</span>
                    </button>
                  )}
                  items={moreItems}
                />
              )}
            </div>
          </div>

          {resumable && (
            <div className="tp-progress">
              <ProgressBar value={pct} label="Watched" />
              <span className="tabular">{formatDuration((item.durationMs ?? 0) - item.userData.positionMs)} left</span>
            </div>
          )}

          {(item.tagline || item.overview) && (
            <div className={`tp-synopsis ${expanded ? 'expanded' : ''}`}>
              {item.tagline && <p className="tp-tagline">{item.tagline}</p>}
              {item.overview && <p className="tp-overview" id="tp-overview">{item.overview}</p>}
              {item.overview && item.overview.length > 240 && (
                <button className="tp-more-text" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded} aria-controls="tp-overview">
                  {expanded ? 'Less' : 'More'}
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      <div className="tp-body detail-sections">
        {item.type === 'show' && <SeasonsBody key={item.id} show={item} upNext={nextEp?.type === 'episode' ? nextEp : null} />}
        {item.type === 'show' && <EpisodeRatingsGrid showId={item.id} />}
        {item.type === 'season' && (
          <section className="tp-seasons" aria-labelledby="tp-episodes-h">
            <div className="tp-section-head"><h2 className="tp-h2" id="tp-episodes-h">Episodes</h2></div>
            <EpisodeList key={String(item.userData.played)} seasonId={item.id} upNextId={nextEp?.id} />
          </section>
        )}
        {item.type === 'podcast' && <PodcastEpisodes podcast={item} />}
        {item.type === 'audiobook' && item.childCount !== 1 && <TrackList parent={item} />}
        {(item.chapters?.length ?? 0) > 0 && <ChaptersSection item={item} />}
        {(item.type === 'audiobook' || item.type === 'bookpart') && <BookmarksSection item={item} />}
        {item.type === 'audiobook' && item.series?.name && <SeriesRow item={item} />}
        {(item.type === 'album' || item.type === 'playlist') && <TrackList key={item.smart ? JSON.stringify(item.smart) : 'manual'} parent={item} removable={item.type === 'playlist' && !item.smart} onRemove={removeFromContainer} />}
        {item.type === 'artist' && <ArtistDiscography artist={item} />}
        {item.type === 'artist' && <RelatedArtists artist={item} />}
        {item.type === 'collection' && <ChildrenGrid key={item.smart ? JSON.stringify(item.smart) : 'manual'} parent={item} removable={isAdmin && !item.smart} onRemove={removeFromContainer} />}
        <CastRow item={item} />
        {(item.type === 'movie' || item.type === 'show' || item.type === 'episode') && <TraktComments item={item} />}
        <ExtrasRow extras={extras.data ?? []} />
        {(hasCredits || hasMedia || isAdmin) && (
          <section className="tp-details" aria-labelledby="tp-details-h">
            <h2 className="tp-h2" id="tp-details-h">Details</h2>
            <div className={`tp-details-grid ${hasMedia ? 'two' : ''}`}>
              {(hasCredits || item.genres.length > 0) && (
                <dl className="tp-credits">
                  {item.type === 'track' && (item.music?.credits?.length || item.music?.displayArtist) ? (<><dt>Artist</dt><dd><ArtistCredits credits={item.music?.credits} fallback={item.music?.displayArtist} /></dd></>) : null}
                  {item.type === 'album' && <AlbumFacts item={item} />}
                  {authors.length > 0 && (<><dt>Author</dt><dd>{authors.join(', ')}</dd></>)}
                  {narrators.length > 0 && (<><dt>Narrated by</dt><dd>{narrators.join(', ')}</dd></>)}
                  {directors.length > 0 && (<><dt>Director</dt><dd>{directors.join(', ')}</dd></>)}
                  {writers.length > 0 && (<><dt>Writers</dt><dd>{writers.slice(0, 4).join(', ')}</dd></>)}
                  {item.studios.length > 0 && (<><dt>Studio</dt><dd>{item.studios.slice(0, 3).join(', ')}</dd></>)}
                  {item.genres.length > 0 && (<><dt>Genres</dt><dd className="tp-genre-links">{item.genres.map((g) => <Link key={g} to={genreLink(g)}>{g}</Link>)}</dd></>)}
                  {item.releaseDate && (<><dt>Released</dt><dd>{formatDate(item.releaseDate)}</dd></>)}
                  {item.userData.lastPlayedAt && (<><dt>Last played</dt><dd>{formatDate(item.userData.lastPlayedAt)}</dd></>)}
                </dl>
              )}
              {hasMedia && (
                <div className="tp-media">
                  <h3 className="tp-h3">{item.media!.length > 1 ? 'Versions' : 'Media info'}</h3>
                  <MediaInfo media={item.media!} />
                </div>
              )}
            </div>
            <ArrItemActions item={item} />
          </section>
        )}
        {!['playlist', 'collection', 'track', 'photo', 'season', 'bookpart', 'podcastepisode'].includes(item.type) && <SimilarRow item={item} />}
      </div>

      {item.smart && containerOwned && (item.type === 'collection' || item.type === 'playlist') && (
        <SmartListModal open={modal === 'smart'} onClose={() => setModal(null)} kind={item.type} item={item} onSaved={(i) => res.setData((d) => (d ? { ...d, ...i, userData: i.userData ?? d.userData } : i))} />
      )}
      <AddToContainerModal open={modal === 'playlist'} onClose={() => setModal(null)} items={[item]} kind="playlist" />
      <AddToContainerModal open={modal === 'collection'} onClose={() => setModal(null)} items={[item]} kind="collection" />
      {isAdmin && <EditMetadataModal open={modal === 'edit' || modal === 'match'} initialView={modal === 'match' ? 'match' : 'form'} onClose={() => setModal(null)} item={item} onUpdated={(i) => res.setData({ ...item, ...i })} />}
      {isAdmin && <UploadArtworkModal open={modal === 'art'} onClose={() => setModal(null)} item={item} onUpdated={(i) => res.setData({ ...item, ...i })} />}
      {canSearchSubtitles(item) && (
        <SubtitleSearchModal open={modal === 'subs'} onClose={() => setModal(null)} item={item} onUpdated={(i) => res.setData((d) => (d ? { ...d, ...i, userData: i.userData ?? d.userData } : i))} />
      )}
      {canReport && <ReportIssueDialog item={item} open={modal === 'report'} onClose={() => setModal(null)} />}
      <Modal open={modal === 'trailer'} onClose={() => setModal(null)} size="xl" className="trailer-modal" title={`${item.title} — Trailer`}>
        {item.trailerUrl && /youtube\.com|youtu\.be/.test(item.trailerUrl) ? (
          <iframe className="trailer-frame" src={youtubeEmbed(item.trailerUrl)} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen title="Trailer" />
        ) : (
          item.trailerUrl && <video className="trailer-frame" src={item.trailerUrl} controls autoPlay />
        )}
      </Modal>
      <Modal open={modal === 'photo'} onClose={() => setModal(null)} size="xl" className="photo-modal">
        <img src={item.posterUrl ?? item.thumbUrl ?? ''} alt={item.title} className="photo-full" />
      </Modal>
    </div>
  );
}

/** Trigger a browser download without leaving the page. */
function startDownload(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function youtubeEmbed(url: string) {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([\w-]{6,})/);
  return m ? `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1` : url;
}
