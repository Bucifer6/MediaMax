import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AcoustIdCandidate, ArtistCredit, IdentifyResponse, Item } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { Badge, Spinner } from './ui';
import { Icon } from './Icon';
import '../styles/music.css';

/** Release type labels (MusicBrainz primary / secondary types). */
const TYPE_LABEL: Record<string, string> = {
  album: 'Album', ep: 'EP', single: 'Single', live: 'Live', compilation: 'Compilation', soundtrack: 'Soundtrack', remix: 'Remix', demo: 'Demo',
  broadcast: 'Broadcast', other: 'Other', 'dj-mix': 'DJ-mix', mixtape: 'Mixtape', spokenword: 'Spoken word', interview: 'Interview', audiobook: 'Audiobook',
};
export const releaseTypeLabel = (t: string) => TYPE_LABEL[t] ?? t.replace(/\b\w/g, (c) => c.toUpperCase());

/** Badges for an album's release types ("EP", "Live", "Compilation"); plain albums show none unless `all`. */
export function ReleaseTypeBadges({ types, all = false }: { types?: string[] | null; all?: boolean }) {
  const list = (types ?? []).filter((t, i) => all || i > 0 || t !== 'album');
  if (!list.length) return null;
  return <>{list.map((t) => <Badge key={t} className="badge-outline release-badge">{releaseTypeLabel(t)}</Badge>)}</>;
}

/** "A feat. B & C" with each credited artist linking to its library page (others as plain text). */
export function ArtistCredits({ credits, fallback, className }: { credits?: ArtistCredit[] | null; fallback?: string | null; className?: string }) {
  if (!credits?.length) return fallback ? <span className={className}>{fallback}</span> : null;
  return (
    <span className={`artist-credits ${className ?? ''}`}>
      {credits.map((c, i) => (
        <Fragment key={`${c.name}-${i}`}>
          {c.artistId ? <Link to={`/item/${c.artistId}`} onClick={(e) => e.stopPropagation()}>{c.name}</Link> : <span>{c.name}</span>}
          {c.joinPhrase || (i < credits.length - 1 ? ', ' : '')}
        </Fragment>
      ))}
    </span>
  );
}

const MB = 'https://musicbrainz.org';

/** "View on MusicBrainz" / ListenBrainz / AcoustID links for an artist, album or track that has the ids. */
export function MusicBrainzLinks({ item }: { item: Item }) {
  const ids = item.externalIds ?? {};
  const links: { href: string; label: string }[] = [];
  if (item.type === 'artist' && ids.musicbrainzArtist) {
    links.push({ href: `${MB}/artist/${ids.musicbrainzArtist}`, label: 'MusicBrainz' });
    links.push({ href: `https://listenbrainz.org/artist/${ids.musicbrainzArtist}/`, label: 'ListenBrainz' });
  }
  if (item.type === 'album') {
    if (ids.musicbrainzRelease) links.push({ href: `${MB}/release/${ids.musicbrainzRelease}`, label: 'MusicBrainz release' });
    if (ids.musicbrainzReleaseGroup) links.push({ href: `${MB}/release-group/${ids.musicbrainzReleaseGroup}`, label: ids.musicbrainzRelease ? 'Release group' : 'MusicBrainz' });
  }
  if (item.type === 'track') {
    if (ids.musicbrainzRecording) links.push({ href: `${MB}/recording/${ids.musicbrainzRecording}`, label: 'MusicBrainz' });
    if (ids.musicbrainzRecording) links.push({ href: `https://listenbrainz.org/player/?recording_mbids=${ids.musicbrainzRecording}`, label: 'ListenBrainz' });
    if (ids.acoustid) links.push({ href: `https://acoustid.org/track/${ids.acoustid}`, label: 'AcoustID' });
  }
  if (!links.length) return null;
  return (
    <div className="mb-links">
      {links.map((l) => (
        <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className="chip" data-nav>
          <Icon name="external" size={13} /> {l.label === 'MusicBrainz' ? 'View on MusicBrainz' : l.label}
        </a>
      ))}
    </div>
  );
}

/** Album facts from tags / MusicBrainz: original year, label, catalogue number, barcode. */
export function AlbumFacts({ item }: { item: Item }) {
  const m = item.music;
  if (!m) return null;
  const rows: [string, string][] = [];
  if (m.originalYear && m.originalYear !== item.year) rows.push(['Originally released', String(m.originalYear)]);
  if (m.label) rows.push(['Label', m.label + (m.catalogNumber ? ` · ${m.catalogNumber}` : '')]);
  if (m.releaseStatus && m.releaseStatus !== 'official') rows.push(['Status', releaseTypeLabel(m.releaseStatus)]);
  if (m.barcode) rows.push(['Barcode', m.barcode]);
  if (!rows.length) return null;
  return <>{rows.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</>;
}

const pct = (s: number) => `${Math.round(s * 100)}%`;

/** Fix match for tracks: fingerprint the file (Chromaprint) and look it up on AcoustID; nothing is written to the file. */
export function IdentifyBySound({ item, onDone, onCancel }: { item: Item; onDone: (i: Item) => void; onCancel: () => void }) {
  const toast = useToast();
  const [res, setRes] = useState<IdentifyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.music.identifyStored(item.id).then(setRes).catch((e) => setError((e as Error).message));
  }, [item.id]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setRes(await api.music.identify(item.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const apply = async (c: AcoustIdCandidate) => {
    const key = `${c.acoustid}:${c.recordingMbid}`;
    setApplying(key);
    try {
      const updated = await api.music.applyIdentify(item.id, c);
      toast.success(`Identified as ${c.title ?? 'a MusicBrainz recording'}`);
      onDone(updated);
    } catch (e) {
      toast.error(e);
    } finally {
      setApplying(null);
    }
  };

  const credit = (c: AcoustIdCandidate) => c.artists.map((a, i) => a.name + (i < c.artists.length - 1 ? a.joinPhrase || ', ' : '')).join('');
  return (
    <div className="fm-panel identify-panel">
      <div className="fm-head">
        <button className="btn btn-sm btn-ghost" onClick={onCancel}><Icon name="arrowLeft" size={14} /> Back</button>
        <span className="muted small">Listens to the first two minutes (Chromaprint) and looks the sound up on AcoustID. The match is saved in MediaMax only — your file is never changed.</span>
      </div>
      {res && !res.available ? (
        <div className="service-note"><Icon name="info" size={18} /> <span>{res.reason}</span></div>
      ) : (
        <button className="btn btn-primary" onClick={() => void run()} disabled={busy || !res}>
          {busy ? <Spinner size={16} /> : <Icon name="audio" size={16} />} {res?.candidates.length ? 'Listen again' : 'Identify by sound'}
        </button>
      )}
      {error && <p className="small" style={{ color: 'var(--c-danger)' }}>{error}</p>}
      <div className="fm-results">
        {busy && <div className="center-pad"><Spinner /> <span className="muted">Fingerprinting…</span></div>}
        {!busy && res?.available && res.candidates.length === 0 && <p className="muted center-pad">No matches yet — press “Identify by sound”.</p>}
        {!busy && res?.candidates.map((c) => {
          const key = `${c.acoustid}:${c.recordingMbid}`;
          return (
            <button key={key} className="fm-result" onClick={() => void apply(c)} disabled={!!applying || (!c.title && !c.recordingMbid)}>
              <span className={`score-pill ${c.score >= 0.9 ? 'high' : c.score >= 0.6 ? 'mid' : 'low'}`} title="AcoustID match score">{pct(c.score)}</span>
              <span className="fm-text">
                <strong>{c.title ?? 'Unnamed recording'}</strong>
                <small className="muted">{[credit(c), c.releaseGroup ? `${c.releaseGroup.title}${c.releaseGroup.type ? ` (${releaseTypeLabel(c.releaseGroup.type)})` : ''}` : null].filter(Boolean).join(' · ') || 'No MusicBrainz data linked'}</small>
                <small className="muted mono">AcoustID {c.acoustid.slice(0, 8)}{c.recordingMbid ? ` · recording ${c.recordingMbid.slice(0, 8)}` : ''}</small>
              </span>
              <span className="spacer" />
              {applying === key ? <Spinner size={18} /> : <Icon name="check" size={16} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
