import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Item, MediaSource, UserItemData } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { withToken } from '../api/client';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync, useServerEvent } from '../hooks';
import { usePlayItem, useMusic } from '../player/music';
import { Icon } from '../components/Icon';
import { Badge, Dropdown, EmptyState, ErrorState, Img, Modal, ProgressBar, Skeleton, StarRating, Tabs, useConfirm, type MenuItem } from '../components/ui';
import { Row } from '../components/Row';
import { canWatchlist, PosterCard, WatchlistButton } from '../components/Cards';
import { SmartListModal } from '../components/SmartListModal';
import { BookmarksSection } from '../components/Bookmarks';
import { AddToContainerModal, EditMetadataModal, UploadArtworkModal } from '../components/ItemModals';
import { RatingBadges } from '../components/RatingBadges';
import { MediaRangeBadge, rangeDetails } from '../components/HdrBadge';
import { AudioBadges, audioFormat, channelText } from '../components/AudioBadge';
import { ArrItemActions } from '../components/ArrItemActions';
import { ReportIssueButton } from '../components/ReportIssue';
import { canSearchSubtitles, SubtitleSearchModal } from '../components/SubtitleSearch';
import { formatBitrate, formatBytes, formatClock, formatDate, formatDuration, languageName } from '../utils/format';
import { episodeCode, hasAudioResume, isAudio, isResumable, isVideo, itemLink, playLink, progressPct } from '../utils/items';

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

function MediaInfo({ media }: { media: MediaSource[] }) {
  return (
    <section className="media-info">
      <h2 className="section-title">Media info</h2>
      {media.map((m, i) => (
        <div key={m.id} className="media-card">
          {media.length > 1 && <h3>Version {i + 1}</h3>}
          <dl className="kv">
            <dt>Container</dt><dd>{m.container?.toUpperCase() ?? '—'}</dd>
            <dt>Video</dt><dd>{[m.videoCodec?.toUpperCase(), m.width && m.height ? `${m.width}×${m.height}` : null, m.resolutionLabel, m.videoRange && m.videoRange.hdrFormat !== 'sdr' ? null : m.hdr ? 'HDR' : null].filter(Boolean).join(' · ') || '—'}</dd>
            {m.videoRange && m.videoRange.hdrFormat !== 'sdr' && <><dt>HDR</dt><dd><MediaRangeBadge media={m} /> {rangeDetails(m.videoRange)}</dd></>}
            <dt>Bitrate</dt><dd>{formatBitrate(m.bitrate)}</dd>
            <dt>Size</dt><dd>{formatBytes(m.size)}</dd>
            <dt>Duration</dt><dd>{formatClock(m.durationMs)}</dd>
          </dl>
          {m.audioStreams.length > 0 && (
            <>
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
            </>
          )}
          {m.subtitleStreams.length > 0 && (
            <>
              <h4>Subtitles</h4>
              <ul className="stream-list">
                {m.subtitleStreams.map((s) => (
                  <li key={s.index}>
                    <Icon name="subtitles" size={14} /> {s.title || languageName(s.language)} · {s.codec.toUpperCase()} {s.forced && <Badge tone="muted">Forced</Badge>} {s.external && <Badge tone="muted">External</Badge>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ))}
    </section>
  );
}

function CastRow({ item }: { item: Item }) {
  const navigate = useNavigate();
  if (!item.people.length) return null;
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
function EpisodeList({ seasonId }: { seasonId: string }) {
  const play = usePlayItem();
  const eps = useAsync(() => api.items.children(seasonId, { sort: 'index', order: 'asc', limit: 500 }), [seasonId]);
  useServerEvent((ev) => {
    if (ev.type === 'userdata.updated') eps.setData((d) => d && { ...d, items: d.items.map((i) => (i.id === ev.itemId ? { ...i, userData: ev.userData } : i)) });
  });
  if (eps.loading && !eps.data) {
    return <div className="episode-list">{[0, 1, 2, 3].map((i) => <div key={i} className="episode"><Skeleton className="episode-thumb" /><div style={{ flex: 1 }}><Skeleton h={18} w="40%" /><Skeleton h={14} w="90%" style={{ marginTop: 10 }} /></div></div>)}</div>;
  }
  if (eps.error) return <ErrorState message={eps.error} onRetry={eps.reload} />;
  if (!eps.data?.items.length) return <EmptyState icon="shows" title="No episodes" />;
  return (
    <div className="episode-list">
      {eps.data.items.map((ep) => {
        const pct = progressPct(ep);
        return (
          <div key={ep.id} className={`episode ${ep.userData.played ? 'played' : ''}`}>
            <button className="episode-thumb" onClick={() => play(ep)} aria-label={`Play ${ep.title}`} data-nav>
              <Img src={ep.thumbUrl ?? ep.backdropUrl} width={360} fallback={<Icon name="shows" size={24} />} />
              <span className="episode-play"><Icon name="play" size={22} /></span>
              {pct > 0 && !ep.userData.played && <ProgressBar value={pct} className="card-progress" />}
              {ep.userData.played && <span className="card-badge card-watched"><Icon name="check" size={13} /></span>}
            </button>
            <div className="episode-body">
              <Link to={itemLink(ep)} className="episode-title">
                <span className="episode-num">{ep.index ?? '?'}</span> {ep.title}
              </Link>
              <div className="episode-meta muted">
                {[formatDuration(ep.durationMs), ep.releaseDate ? formatDate(ep.releaseDate) : null].filter(Boolean).join(' · ')}
              </div>
              {ep.overview && <p className="episode-overview">{ep.overview}</p>}
            </div>
          </div>
        );
      })}
    </div>
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

function SeasonsBody({ show }: { show: Item }) {
  const seasons = useAsync(() => api.items.children(show.id, { sort: 'index', order: 'asc', limit: 200 }), [show.id]);
  const [active, setActive] = useState<string | null>(null);
  const list = seasons.data?.items ?? [];
  useEffect(() => {
    if (!list.length || active) return;
    const firstUnplayed = list.find((s) => (s.index ?? 0) > 0 && !s.userData.played) ?? list.find((s) => (s.index ?? 0) > 0) ?? list[0];
    setActive(firstUnplayed!.id);
  }, [list, active]);
  if (seasons.loading && !seasons.data) return <Skeleton h={40} w={320} />;
  if (!list.length) return <EmptyState icon="shows" title="No seasons yet" />;
  return (
    <section className="seasons">
      <Tabs
        className="season-tabs"
        value={active ?? list[0]!.id}
        onChange={setActive}
        tabs={list.map((s) => ({
          value: s.id,
          label: (
            <>
              {s.title || (s.index === 0 ? 'Specials' : `Season ${s.index}`)}
              {s.userData.unplayedCount ? <span className="tab-count">{s.userData.unplayedCount}</span> : null}
            </>
          ),
        }))}
      />
      {active && <EpisodeList seasonId={active} />}
    </section>
  );
}

/* ---------------- Tracks ---------------- */
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
              <button
                className="track-main"
                onClick={() => (isAudio(t) ? music.playQueue(audioList, audioList.indexOf(t)) : play(t))}
                data-nav
              >
                <span className="track-num">
                  {isCurrent && music.playing ? <span className="eq"><i /><i /><i /></span> : <span className="track-idx">{ordered ? t.index ?? i + 1 : i + 1}</span>}
                  <Icon name="play" size={14} className="track-playicon" />
                </span>
                {!ordered && (
                  <span className="track-art"><Img src={t.posterUrl ?? t.thumbUrl} width={64} fallback={<Icon name="music" size={14} />} /></span>
                )}
                <span className="track-title">
                  <span>{t.title}</span>
                  {parent.type === 'audiobook' ? (progressPct(t) > 0 && !t.userData.played ? <small>{Math.round(progressPct(t))}% listened</small> : t.userData.played ? <small>Finished</small> : null) : (parent.type !== 'album' || t.grandparentTitle !== parent.parentTitle) && <small>{[t.grandparentTitle, parent.type !== 'album' ? t.parentTitle : null].filter(Boolean).join(' · ')}</small>}
                </span>
                {showDisc && <span className="muted track-disc">Disc {t.parentIndex}</span>}
                <span className="track-dur">{t.durationMs ? formatClock(t.durationMs) : ''}</span>
              </button>
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

/* ---------------- Page ---------------- */
export function ItemPage() {
  const { itemId = '' } = useParams();
  const { user, features } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const play = usePlayItem();
  const res = useAsync(() => api.items.get(itemId), [itemId]);
  const [modal, setModal] = useState<null | 'edit' | 'art' | 'playlist' | 'collection' | 'trailer' | 'photo' | 'subs' | 'smart'>(null);
  const item = res.data;
  const isSeries = item?.id === itemId && (item.type === 'show' || item.type === 'season' || item.type === 'audiobook' || item.type === 'podcast');
  // Next-up episode of a show/season (server: in progress → next unwatched → first).
  const nextUp = useAsync(
    async () => ({ forId: itemId, ep: isSeries ? await api.items.next(itemId).catch(() => null) : null }),
    [itemId, isSeries, item?.userData.played, item?.userData.unplayedCount],
  );

  useServerEvent((ev) => {
    if (ev.type === 'userdata.updated' && ev.itemId === itemId) res.setData((d) => d && { ...d, userData: ev.userData });
  });

  if (res.loading && !item) {
    return (
      <div className="detail">
        <div className="detail-backdrop skeleton" />
        <div className="detail-main">
          <Skeleton className="detail-poster" />
          <div className="detail-info">
            <Skeleton h={48} w="60%" />
            <Skeleton h={18} w="40%" style={{ marginTop: 16 }} />
            <Skeleton h={80} w="90%" style={{ marginTop: 24 }} />
          </div>
        </div>
      </div>
    );
  }
  if (res.error || !item) return <div className="page"><ErrorState message={res.error ?? 'Not found'} onRetry={res.reload} /></div>;

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
  // Thumbs map onto the 0–10 rating: up = 10, down = 2 (stars still work for people who prefer them).
  const thumbsUp = item.userData.rating != null && item.userData.rating >= 8;
  const thumbsDown = item.userData.rating != null && item.userData.rating <= 4;
  const nextEp = nextUp.data?.forId === item.id && ['episode', 'bookpart', 'podcastepisode'].includes(nextUp.data.ep?.type ?? '') ? nextUp.data.ep : null;
  const nextIsAudio = !!nextEp && isAudio(nextEp);
  const nextResumable = !!nextEp && isResumable(nextEp);
  const playLabel = resumable
    ? `Resume ${formatClock(item.userData.positionMs)}`
    : nextEp
      ? item.type === 'audiobook'
        ? nextResumable ? `Resume ${nextEp.title}` : (nextEp.index ?? 1) > 1 ? `Continue · ${nextEp.title}` : 'Start listening'
        : `${nextResumable ? 'Resume' : 'Play'} ${episodeCode(nextEp) || nextEp.title}`
      : item.type === 'show' || item.type === 'season' ? 'Play next' : 'Play';
  const downloadItems: MenuItem[] = (['original', '1080p', '720p', '480p'] as const).map((q) => ({
    label: q === 'original' ? 'Original file' : `${q} (MP4)`,
    icon: 'download',
    onClick: () => startDownload(withToken(api.playback.downloadUrl(item.id, q))),
  }));
  const square = ['album', 'artist', 'track', 'playlist', 'photo', 'audiobook', 'bookpart', 'podcast', 'podcastepisode'].includes(item.type);
  const isAdmin = !!user?.isAdmin;
  const canDownload = features.downloads && user?.allowDownloads && (isVideo(item) || isAudio(item)) && !item.media?.[0]?.remote;

  const adminItems: MenuItem[] = isAdmin
    ? [
        { label: 'Edit metadata', icon: 'edit', onClick: () => setModal('edit') },
        { label: 'Upload artwork', icon: 'upload', onClick: () => setModal('art') },
        { label: 'Refresh metadata', icon: 'refresh', onClick: refresh },
        { label: 'Add to collection', icon: 'collection', onClick: () => setModal('collection') },
        { divider: true, label: '' },
        { label: 'Remove from library', icon: 'trash', danger: true, onClick: remove },
      ]
    : [];
  const containerOwned = item.type === 'playlist' || (item.type === 'collection' && isAdmin);
  const subtitleItems: MenuItem[] = canSearchSubtitles(item) ? [{ label: 'Find subtitles online…', icon: 'subtitles', onClick: () => setModal('subs') }] : [];

  const crumbs: { label: string; to: string }[] = [];
  if (item.type === 'episode') {
    if (item.grandparentId) crumbs.push({ label: item.grandparentTitle ?? 'Show', to: `/item/${item.grandparentId}` });
    if (item.parentId) crumbs.push({ label: item.parentTitle ?? `Season ${item.parentIndex}`, to: `/item/${item.parentId}` });
  } else if (item.type === 'season' && item.parentId) crumbs.push({ label: item.parentTitle ?? 'Show', to: `/item/${item.parentId}` });
  else if ((item.type === 'album' || item.type === 'track') && item.parentId) crumbs.push({ label: item.parentTitle ?? 'Artist', to: `/item/${item.parentId}` });
  else if ((item.type === 'bookpart' || item.type === 'podcastepisode') && item.parentId) crumbs.push({ label: item.parentTitle ?? (item.type === 'bookpart' ? 'Audiobook' : 'Podcast'), to: `/item/${item.parentId}` });

  const directors = item.people.filter((p) => p.kind === 'director').map((p) => p.name);
  const writers = item.people.filter((p) => p.kind === 'writer' && !/^(author|narrator)$/i.test(p.role ?? '')).map((p) => p.name);
  const authors = item.type === 'audiobook' || item.type === 'bookpart'
    ? Array.from(new Set([...item.people.filter((p) => /^author$/i.test(p.role ?? '')).map((p) => p.name), ...(item.people.some((p) => /^author$/i.test(p.role ?? '')) || !item.parentTitle || item.type === 'bookpart' ? [] : [item.parentTitle])]))
    : [];
  const narrators = item.people.filter((p) => /^narrator$/i.test(p.role ?? '')).map((p) => p.name);

  return (
    <div className={`detail detail-${item.type}`}>
      <div className="detail-backdrop">
        <Img src={item.backdropUrl ?? (item.type === 'episode' ? item.thumbUrl : null) ?? item.posterUrl} width={1920} className={item.backdropUrl ? '' : 'blurred'} />
        <div className="detail-shade" />
      </div>
      <div className="detail-main">
        <div className={`detail-poster ${square ? 'square' : item.type === 'episode' || item.type === 'video' ? 'landscape' : ''}`}>
          <Img src={item.type === 'episode' || item.type === 'video' ? item.thumbUrl ?? item.posterUrl : item.posterUrl ?? item.thumbUrl} width={400} alt={item.title} fallback={<Icon name={item.type === 'audiobook' || item.type === 'bookpart' ? 'book' : item.type === 'podcast' || item.type === 'podcastepisode' ? 'podcast' : square ? 'music' : item.type === 'show' || item.type === 'season' || item.type === 'episode' ? 'shows' : 'film'} size={40} />} />
          {item.type === 'photo' && <button className="detail-poster-zoom" onClick={() => setModal('photo')} aria-label="View full size"><Icon name="fullscreen" /></button>}
        </div>
        <div className="detail-info">
          {crumbs.length > 0 && (
            <nav className="crumbs">
              {crumbs.map((c) => (
                <Link key={c.to} to={c.to}>{c.label}</Link>
              ))}
            </nav>
          )}
          {item.logoUrl && item.type !== 'episode' ? (
            <Img src={item.logoUrl} width={600} className="detail-logo" alt={item.title} fallback={<h1 className="detail-title">{item.title}</h1>} />
          ) : (
            <h1 className="detail-title">{item.title}</h1>
          )}
          {item.originalTitle && item.originalTitle !== item.title && <p className="muted detail-orig">{item.originalTitle}</p>}
          <div className="detail-meta">
            {item.type === 'episode' && <span>{episodeCode(item)}</span>}
            {item.year && <span>{item.year}</span>}
            {item.contentRating && <Badge className="badge-outline">{item.contentRating}</Badge>}
            {item.durationMs && item.type !== 'show' ? <span>{formatDuration(item.durationMs)}</span> : null}
            {item.type === 'show' && item.childCount > 0 && <span>{item.childCount} season{item.childCount > 1 ? 's' : ''}</span>}
            {(item.type === 'album' || item.type === 'playlist' || item.type === 'collection') && item.childCount > 0 && <span>{item.childCount} items</span>}
            {item.type === 'audiobook' && item.childCount > 1 && <span>{item.childCount} parts</span>}
            {item.type === 'audiobook' && item.series?.name && (
              <Link className="detail-series" to={seriesLink(item)}>
                <Icon name="book" size={14} /> {item.series.index != null ? `Book ${item.series.index} of ` : ''}{item.series.name}
              </Link>
            )}
            {item.type === 'podcast' && item.childCount > 0 && <span>{item.childCount} episodes</span>}
            {item.type === 'podcastepisode' && item.releaseDate && <span>{formatDate(item.releaseDate)}</span>}
            {item.smart && <Badge tone="accent"><Icon name="wand" size={12} /> Smart</Badge>}
            {item.communityRating != null && (
              <span className="detail-rating"><Icon name="starFill" size={14} /> {item.communityRating.toFixed(1)}</span>
            )}
            <RatingBadges ratings={item.ratings} />
            <MediaBadges media={item.media} />
          </div>
          {item.genres.length > 0 && (
            <div className="genre-chips">
              {item.genres.map((g) => (
                <Link key={g} className="chip" to={item.libraryId ? `/library/${item.libraryId}?genre=${encodeURIComponent(g)}` : `/search?q=${encodeURIComponent(g)}`}>{g}</Link>
              ))}
            </div>
          )}

          <div className="detail-actions">
            {playable && (
              <button className="btn btn-primary btn-lg" onClick={() => (nextEp && !nextIsAudio ? navigate(playLink(nextEp)) : play(item))} data-nav autoFocus title={nextEp ? nextEp.title : undefined}>
                <Icon name="play" size={20} /> {playLabel}
              </button>
            )}
            {resumable && isVideo(item) && (
              <button className="btn btn-glass btn-lg" onClick={() => navigate(playLink(item, { fromStart: true }))} data-nav>
                <Icon name="refresh" size={18} /> From start
              </button>
            )}
            {(item.type === 'album' || item.type === 'artist' || item.type === 'playlist') && (
              <button className="btn btn-glass btn-lg" onClick={() => play(item, { shuffle: true })} data-nav>
                <Icon name="shuffle" size={18} /> Shuffle
              </button>
            )}
            {features.music && ['album', 'artist', 'playlist', 'track'].includes(item.type) && (
              <button className="btn btn-glass btn-lg" onClick={() => navigate(`/dj?seed=${encodeURIComponent(item.id)}`)} data-nav title="An automatic, beat-matched mix starting from this">
                <Icon name="music" size={18} /> DJ mix
              </button>
            )}
            {item.smart && containerOwned && (
              <button className="btn btn-glass btn-lg" onClick={() => setModal('smart')} data-nav>
                <Icon name="wand" size={18} /> Edit rules
              </button>
            )}
            {item.trailerUrl && (
              <button className="btn btn-glass btn-lg" onClick={() => setModal('trailer')} data-nav>
                <Icon name="video" size={18} /> Trailer
              </button>
            )}
            {canWatchlist(item) && <WatchlistButton item={item} />}
            {item.type !== 'photo' && item.type !== 'playlist' && item.type !== 'collection' && (
              <button className={`btn-round ${item.userData.played ? 'active' : ''}`} onClick={togglePlayed} title={item.userData.played ? 'Mark unwatched' : 'Mark watched'} data-nav>
                <Icon name="check" />
              </button>
            )}
            <button className={`btn-round ${item.userData.favorite ? 'active fav' : ''}`} onClick={toggleFav} title={item.userData.favorite ? 'Remove from favourites' : 'Add to favourites'} data-nav>
              <Icon name={item.userData.favorite ? 'heartFill' : 'heart'} />
            </button>
            {item.type !== 'playlist' && item.type !== 'collection' && (
              <button className="btn-round" onClick={() => setModal('playlist')} title="Add to playlist" data-nav>
                <Icon name="plus" />
              </button>
            )}
            {canDownload && (isVideo(item) ? (
              <Dropdown
                trigger={({ onClick }) => <button className="btn-round" onClick={onClick} title="Download" aria-label="Download" data-nav><Icon name="download" /></button>}
                items={downloadItems}
              />
            ) : (
              <a className="btn-round" href={withToken(api.playback.downloadUrl(item.id))} download title="Download" data-nav>
                <Icon name="download" />
              </a>
            ))}
            {(adminItems.length > 0 || containerOwned || subtitleItems.length > 0) && (
              <Dropdown
                trigger={({ onClick }) => <button className="btn-round" onClick={onClick} title="More" aria-label="More" data-nav><Icon name="more" /></button>}
                items={[
                  ...subtitleItems,
                  ...(subtitleItems.length && (containerOwned || adminItems.length) ? [{ divider: true, label: '' }] : []),
                  ...(containerOwned ? [{ label: `Delete ${item.type}`, icon: 'trash' as const, danger: true, onClick: deleteContainer }] : []),
                  ...(containerOwned && adminItems.length ? [{ divider: true, label: '' }] : []),
                  ...adminItems,
                ]}
              />
            )}
            <ReportIssueButton item={item} round />
          </div>
          <ArrItemActions item={item} />

          {resumable && (
            <div className="detail-progress">
              <ProgressBar value={pct} />
              <span className="muted">{formatDuration((item.durationMs ?? 0) - item.userData.positionMs)} left</span>
            </div>
          )}

          <div className="detail-rate">
            <span className="muted">Your rating</span>
            {!['photo', 'playlist', 'collection'].includes(item.type) && (
              <span className="thumbs" role="group" aria-label="Thumbs rating">
                <button className={`thumb ${thumbsUp ? 'active' : ''}`} onClick={() => rate(thumbsUp ? null : 10)} aria-pressed={thumbsUp} title={thumbsUp ? 'Remove rating' : 'I like this'} data-nav>
                  <Icon name="thumbUp" size={18} />
                </button>
                <button className={`thumb down ${thumbsDown ? 'active' : ''}`} onClick={() => rate(thumbsDown ? null : 2)} aria-pressed={thumbsDown} title={thumbsDown ? 'Remove rating' : 'Not for me'} data-nav>
                  <Icon name="thumbDown" size={18} />
                </button>
              </span>
            )}
            <StarRating value={item.userData.rating} onChange={rate} size={20} />
            {(item.type === 'movie' || item.type === 'show') && (
              <button className={`btn btn-sm not-interested ${item.userData.notInterested ? 'active' : ''}`} onClick={notInterested} aria-pressed={item.userData.notInterested} title="Hide from your recommendations" data-nav>
                <Icon name={item.userData.notInterested ? 'eye' : 'ban'} size={14} /> {item.userData.notInterested ? 'Show in recommendations' : 'Not interested'}
              </button>
            )}
          </div>

          {item.tagline && <p className="detail-tagline">{item.tagline}</p>}
          {item.overview && <p className="detail-overview">{item.overview}</p>}

          <dl className="detail-credits">
            {authors.length > 0 && (<><dt>Author</dt><dd>{authors.join(', ')}</dd></>)}
            {narrators.length > 0 && (<><dt>Narrated by</dt><dd>{narrators.join(', ')}</dd></>)}
            {directors.length > 0 && (<><dt>Director</dt><dd>{directors.join(', ')}</dd></>)}
            {writers.length > 0 && (<><dt>Writers</dt><dd>{writers.slice(0, 4).join(', ')}</dd></>)}
            {item.studios.length > 0 && (<><dt>Studio</dt><dd>{item.studios.slice(0, 3).join(', ')}</dd></>)}
            {item.releaseDate && (<><dt>Released</dt><dd>{formatDate(item.releaseDate)}</dd></>)}
            {item.userData.lastPlayedAt && (<><dt>Last played</dt><dd>{formatDate(item.userData.lastPlayedAt)}</dd></>)}
          </dl>
        </div>
      </div>

      <div className="detail-sections">
        {item.type === 'show' && <SeasonsBody show={item} />}
        {item.type === 'season' && <EpisodeList seasonId={item.id} />}
        {item.type === 'podcast' && <PodcastEpisodes podcast={item} />}
        {item.type === 'audiobook' && item.childCount !== 1 && <TrackList parent={item} />}
        {(item.chapters?.length ?? 0) > 0 && <ChaptersSection item={item} />}
        {(item.type === 'audiobook' || item.type === 'bookpart') && <BookmarksSection item={item} />}
        {item.type === 'audiobook' && item.series?.name && <SeriesRow item={item} />}
        {(item.type === 'album' || item.type === 'playlist') && <TrackList key={item.smart ? JSON.stringify(item.smart) : 'manual'} parent={item} removable={item.type === 'playlist' && !item.smart} onRemove={removeFromContainer} />}
        {item.type === 'artist' && <ChildrenGrid parent={item} title="Albums" />}
        {item.type === 'collection' && <ChildrenGrid key={item.smart ? JSON.stringify(item.smart) : 'manual'} parent={item} removable={isAdmin && !item.smart} onRemove={removeFromContainer} />}
        <CastRow item={item} />
        {item.media && item.media.length > 0 && <MediaInfo media={item.media} />}
        {!['playlist', 'collection', 'track', 'photo', 'season', 'bookpart', 'podcastepisode'].includes(item.type) && <SimilarRow item={item} />}
      </div>

      {item.smart && containerOwned && (item.type === 'collection' || item.type === 'playlist') && (
        <SmartListModal open={modal === 'smart'} onClose={() => setModal(null)} kind={item.type} item={item} onSaved={(i) => res.setData((d) => (d ? { ...d, ...i, userData: i.userData ?? d.userData } : i))} />
      )}
      <AddToContainerModal open={modal === 'playlist'} onClose={() => setModal(null)} items={[item]} kind="playlist" />
      <AddToContainerModal open={modal === 'collection'} onClose={() => setModal(null)} items={[item]} kind="collection" />
      {isAdmin && <EditMetadataModal open={modal === 'edit'} onClose={() => setModal(null)} item={item} onUpdated={(i) => res.setData({ ...item, ...i })} />}
      {isAdmin && <UploadArtworkModal open={modal === 'art'} onClose={() => setModal(null)} item={item} onUpdated={(i) => res.setData({ ...item, ...i })} />}
      {canSearchSubtitles(item) && (
        <SubtitleSearchModal open={modal === 'subs'} onClose={() => setModal(null)} item={item} onUpdated={(i) => res.setData((d) => (d ? { ...d, ...i, userData: i.userData ?? d.userData } : i))} />
      )}
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
