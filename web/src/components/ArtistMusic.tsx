import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { DiscographyResponse, Item, MissingRelease, RelatedArtist } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { usePlayItem } from '../player/music';
import { PosterCard } from './Cards';
import { Badge, EmptyState, Img, Skeleton, Spinner } from './ui';
import { Icon } from './Icon';
import { ArtistCredits, ReleaseTypeBadges, releaseTypeLabel } from './MusicBits';
import { formatClock } from '../utils/format';
import '../styles/music.css';

/** Artist page: the library's albums grouped by release type (with a type filter), "Appears on" and "Missing from your library". */
export function ArtistDiscography({ artist }: { artist: Item }) {
  const { user } = useApp();
  const res = useAsync(() => api.music.discography(artist.id), [artist.id]);
  const [type, setType] = useState<string>('all');
  if (res.loading && !res.data) return <section><Skeleton h={28} w={160} style={{ marginBottom: 14 }} /><Skeleton h={220} /></section>;
  const d = res.data;
  if (!d) return <EmptyState icon="music" title="Couldn't load the discography" message={res.error ?? undefined} />;
  const sections = d.sections.filter((s) => type === 'all' || s.type === type);
  return (
    <>
      <section className="disco">
        <div className="disco-head">
          <h2 className="section-title">Discography</h2>
          {d.sections.length > 1 && (
            <div className="chip-row" role="tablist" aria-label="Release type">
              <button className={`chip ${type === 'all' ? 'active' : ''}`} onClick={() => setType('all')} data-nav>All</button>
              {d.sections.map((s) => (
                <button key={s.type} className={`chip ${type === s.type ? 'active' : ''}`} onClick={() => setType(s.type)} data-nav>
                  {s.label} <span className="chip-count">{s.items.length}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {!d.sections.length && <EmptyState icon="music" title="No albums in the library yet" />}
        {sections.map((s) => (
          <div key={s.type} className="disco-section">
            {(d.sections.length > 1 || s.type !== 'album') && <h3 className="disco-title">{s.label}</h3>}
            <div className="grid grid-square">
              {s.items.map((a) => (
                <div key={a.id} className="grid-cell">
                  <PosterCard item={a} width="100%" />
                  <div className="disco-badges"><ReleaseTypeBadges types={a.music?.releaseTypes} /></div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>
      {d.appearsOn.length > 0 && type === 'all' && <AppearsOn tracks={d.appearsOn} />}
      <MissingAlbums d={d} isAdmin={!!user?.isAdmin} />
    </>
  );
}

function AppearsOn({ tracks }: { tracks: Item[] }) {
  const play = usePlayItem();
  return (
    <section className="appears-on">
      <h2 className="section-title">Appears on</h2>
      <ol className="tracklist compact">
        {tracks.slice(0, 20).map((t) => (
          <li key={t.id} className="track">
            <div className="track-main">
              <button className="track-hit" onClick={() => play(t)} aria-label={`Play ${t.title}`} data-nav />
              <span className="track-art"><Img src={t.posterUrl} width={64} fallback={<Icon name="music" size={14} />} /></span>
              <span className="track-title">
                <span>{t.title}</span>
                <small className="track-credits">
                  <ArtistCredits credits={t.music?.credits} fallback={t.music?.displayArtist ?? t.grandparentTitle} />
                  {t.parentId && <> · <Link to={`/item/${t.parentId}`}>{t.parentTitle}</Link></>}
                </small>
              </span>
              <span className="track-dur">{t.durationMs ? formatClock(t.durationMs) : ''}</span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const HIDDEN_LABEL: Record<string, string> = { single: 'singles', ep: 'EPs', compilation: 'compilations', live: 'live albums', other: 'other releases' };

function MissingAlbums({ d, isAdmin }: { d: DiscographyResponse; isAdmin: boolean }) {
  const toast = useToast();
  const [state, setState] = useState<Record<string, string>>({});
  if (!d.artistMbid) {
    return isAdmin ? (
      <p className="muted small disco-hint"><Icon name="info" size={14} /> Match this artist on MusicBrainz (Edit → Fix match, or tag the files with MusicBrainz Picard) to see albums missing from your library.</p>
    ) : null;
  }
  if (d.missingError) return <p className="muted small disco-hint"><Icon name="alert" size={14} /> MusicBrainz is unavailable right now ({d.missingError}).</p>;
  if (!d.missing.length) return null;
  const request = async (m: MissingRelease) => {
    setState((s) => ({ ...s, [m.releaseGroupMbid]: 'busy' }));
    try {
      const r = await api.requests.create({ mediaType: 'album', externalId: m.releaseGroupMbid, title: m.title });
      setState((s) => ({ ...s, [m.releaseGroupMbid]: r.status }));
      toast.success(r.status === 'pending' ? `Requested ${m.title}` : `${m.title} sent to Lidarr`);
    } catch (e) {
      setState((s) => ({ ...s, [m.releaseGroupMbid]: '' }));
      toast.error(e);
    }
  };
  return (
    <section className="missing-albums">
      <h2 className="section-title">Missing from your library <Badge tone="muted">{d.missing.length}</Badge></h2>
      <p className="muted small">From MusicBrainz{d.hiddenTypes.length ? ` · hiding ${d.hiddenTypes.map((t) => HIDDEN_LABEL[t] ?? t).join(', ')}` : ''}.</p>
      <div className="grid grid-square">
        {d.missing.map((m) => {
          const st = state[m.releaseGroupMbid] ?? m.requestStatus ?? '';
          return (
            <div key={m.releaseGroupMbid} className="missing-card">
              <a className="missing-art" href={`https://musicbrainz.org/release-group/${m.releaseGroupMbid}`} target="_blank" rel="noopener noreferrer" aria-label={`${m.title} on MusicBrainz`}>
                <img src={m.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
                <Icon name="music" size={28} className="missing-fallback" />
              </a>
              <div className="missing-text">
                <strong title={m.title}>{m.title}</strong>
                <span className="muted small">{[m.year, releaseTypeLabel((m.secondaryTypes[0] ?? m.primaryType ?? 'album').toLowerCase())].filter(Boolean).join(' · ')}</span>
              </div>
              {d.canRequest && (
                st && st !== 'busy' ? (
                  <Badge tone={st === 'available' ? 'success' : 'accent'} className="missing-status">{st === 'pending' ? 'Requested' : st === 'available' ? 'Available' : 'In Lidarr'}</Badge>
                ) : (
                  <button className="btn btn-sm" onClick={() => void request(m)} disabled={st === 'busy'} data-nav>
                    {st === 'busy' ? <Spinner size={14} /> : <Icon name={isAdmin ? 'download' : 'plus'} size={14} />} {isAdmin ? 'Monitor in Lidarr' : 'Request'}
                  </button>
                )
              )}
            </div>
          );
        })}
      </div>
      {!d.canRequest && isAdmin && <p className="muted small">Add a Lidarr server (Settings → Requests) to request missing albums.</p>}
    </section>
  );
}

/** Members / Member of / Collaborations / Related (MusicBrainz) and Similar artists (ListenBrainz). */
export function RelatedArtists({ artist }: { artist: Item }) {
  const toast = useToast();
  const { user } = useApp();
  const res = useAsync(() => (artist.externalIds.musicbrainzArtist ? api.music.related(artist.id) : Promise.resolve(null)), [artist.id]);
  const [requested, setRequested] = useState<Record<string, boolean>>({});
  if (!artist.externalIds.musicbrainzArtist) return null;
  if (res.loading && !res.data) return <Skeleton h={120} />;
  const r = res.data;
  if (!r) return null;
  const canRequest = !!user && (user.isAdmin || user.requestPermissions?.music !== 'none');
  const request = async (a: RelatedArtist) => {
    if (!a.mbid) return;
    try {
      await api.requests.create({ mediaType: 'artist', externalId: a.mbid, title: a.name });
      setRequested((s) => ({ ...s, [a.mbid!]: true }));
      toast.success(`Requested ${a.name}`);
    } catch (e) {
      toast.error(e);
    }
  };
  const rows: [string, RelatedArtist[]][] = [['Members', r.members], ['Member of', r.memberOf], ['Collaborations', r.collaborations], ['Related', r.related], ['Similar artists', r.similar]];
  if (!rows.some(([, l]) => l.length)) return null;
  return (
    <section className="related-artists">
      {rows.filter(([, l]) => l.length).map(([title, list]) => (
        <div key={title} className="related-group">
          <h2 className="section-title">{title}</h2>
          <div className="related-list">
            {list.map((a) => (a.itemId ? (
              <Link key={`${title}-${a.mbid ?? a.name}`} to={`/item/${a.itemId}`} className="related-chip in-library" data-nav>
                <span className="related-avatar"><Img src={a.posterUrl} width={96} fallback={<Icon name="user" size={18} />} /></span>
                <span className="related-text"><strong>{a.name}</strong>{a.detail && <small>{a.detail}</small>}</span>
              </Link>
            ) : (
              <div key={`${title}-${a.mbid ?? a.name}`} className="related-chip not-in-library" title="Not in your library">
                <span className="related-avatar"><Icon name="user" size={18} /></span>
                <span className="related-text"><strong>{a.name}</strong>{a.detail && <small>{a.detail}</small>}</span>
                {canRequest && a.mbid && (requested[a.mbid] ? <Icon name="check" size={16} /> : (
                  <button className="btn-icon" onClick={() => void request(a)} aria-label={`Request ${a.name}`} title="Request in Lidarr" data-nav><Icon name="plus" size={16} /></button>
                ))}
              </div>
            )))}
          </div>
        </div>
      ))}
    </section>
  );
}
