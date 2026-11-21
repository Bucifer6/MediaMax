import { useState } from 'react';
import type { LbRecommendationList, LbRecommendedTrack, ListenBrainzStatus } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { useMusic } from '../player/music';
import { Row } from './Row';
import { Img, Spinner, Switch, useConfirm } from './ui';
import { Icon } from './Icon';
import '../styles/music.css';

/** Settings → Connected services: ListenBrainz token (write-only), self-hosted server URL, scrobbling and love/hate feedback. */
export function ListenBrainzCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const status = useAsync(() => api.listenbrainz.status(), []);
  const [token, setToken] = useState('');
  const [server, setServer] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const st: ListenBrainzStatus | undefined = status.data;

  const save = async (body: Parameters<typeof api.listenbrainz.save>[0], ok?: string) => {
    setBusy(true);
    try {
      status.setData(await api.listenbrainz.save(body));
      if (ok) toast.success(ok);
      setToken('');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const connect = (e: React.FormEvent) => {
    e.preventDefault();
    void save({ token: token.trim() || undefined, serverUrl: server ?? st?.serverUrl ?? null }, 'Connected to ListenBrainz');
  };
  const disconnect = async () => {
    if (!(await confirm({ title: 'Disconnect ListenBrainz?', message: 'Kinora forgets your token and stops sending listens. Listens waiting to be sent are dropped.', confirmLabel: 'Disconnect', danger: true }))) return;
    try {
      status.setData(await api.listenbrainz.disconnect());
      toast.success('ListenBrainz disconnected');
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="settings-card service-card" id="listenbrainz">
      <div className="service-head">
        <span className="service-logo lb-logo" aria-hidden="true">LB</span>
        <div>
          <h2>ListenBrainz</h2>
          <p className="muted">Open-source listen history from the MetaBrainz Foundation. Kinora sends what you play (with MusicBrainz ids) and shows your weekly playlists.</p>
        </div>
      </div>
      {status.loading && !st ? <Spinner size={18} /> : st?.connected ? (
        <>
          <p>Connected as <strong>{st.username ?? 'your account'}</strong>{st.serverUrl ? <> on <span className="mono small">{st.serverUrl}</span></> : null}.</p>
          {st.lastError && <div className="service-note warn"><Icon name="alert" size={18} /> <span>{st.lastError}</span></div>}
          {st.pending > 0 && (
            <div className="service-note"><Icon name="clock" size={18} /> <span>{st.pending} listen{st.pending === 1 ? '' : 's'} waiting to be sent — they go out automatically when ListenBrainz is reachable.</span>
              <button className="btn btn-sm" onClick={async () => status.setData(await api.listenbrainz.flush())}>Send now</button>
            </div>
          )}
          <Switch checked={st.scrobble} onChange={(v) => void save({ scrobble: v })} label="Submit listens" hint="“Playing now” when a track starts; a listen after half the track or 4 minutes. Includes Subsonic apps and DJ mixes." disabled={busy} />
          <Switch checked={st.feedback} onChange={(v) => void save({ feedback: v })} label="Send loves and hates" hint="Favourites and 4★+ ratings become “love”, 1★ becomes “hate” (tracks with a MusicBrainz id)." disabled={busy} />
          <form className="lb-token-row" onSubmit={connect}>
            <input className="input" type="password" autoComplete="off" placeholder="•••• (replace token)" value={token} onChange={(e) => setToken(e.target.value)} aria-label="New user token" />
            <button className="btn" disabled={busy || !token.trim()}>Replace token</button>
          </form>
          <div className="row-gap">
            <button className="btn btn-ghost btn-danger" onClick={() => void disconnect()}><Icon name="x" size={16} /> Disconnect</button>
          </div>
        </>
      ) : (
        <form className="lb-connect" onSubmit={connect}>
          <label className="field">
            <span className="field-label">User token</span>
            <input className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste your token" />
            <span className="field-hint">Find it on listenbrainz.org → your profile → Settings → <em>User token</em>. It is stored on this server and never shown again.</span>
          </label>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAdvanced((v) => !v)}><Icon name={showAdvanced ? 'chevronUp' : 'chevronDown'} size={14} /> Self-hosted server</button>
          {showAdvanced && (
            <label className="field">
              <span className="field-label">API URL</span>
              <input className="input" value={server ?? ''} onChange={(e) => setServer(e.target.value)} placeholder="https://api.listenbrainz.org" />
              <span className="field-hint">Leave empty for listenbrainz.org.</span>
            </label>
          )}
          <button className="btn btn-primary" disabled={busy || !token.trim()}>{busy ? <Spinner size={16} /> : <Icon name="link" size={16} />} Connect ListenBrainz</button>
        </form>
      )}
    </div>
  );
}

const KIND_ORDER: LbRecommendationList['kind'][] = ['weekly-jams', 'daily-jams', 'weekly-exploration', 'cf', 'other'];

/** Music library page: "From ListenBrainz" — the user's generated playlists matched to library tracks. */
export function ListenBrainzRow() {
  const toast = useToast();
  const music = useMusic();
  const res = useAsync(() => api.listenbrainz.recommendations(), []);
  const [tab, setTab] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [requested, setRequested] = useState<Record<string, boolean>>({});
  const data = res.data;
  if (!data?.connected) return null;
  const lists = [...data.lists].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)).filter((l) => l.tracks.length);
  if (!lists.length) {
    return data.error ? <p className="muted small lb-error"><Icon name="alert" size={14} /> ListenBrainz: {data.error}</p> : null;
  }
  const list = lists.find((l) => l.id === tab) ?? lists[0];
  const inLib = list.tracks.filter((t) => t.item);
  const missing = list.tracks.filter((t) => !t.item);
  const play = (t?: LbRecommendedTrack) => {
    const items = inLib.map((x) => x.item!);
    if (items.length) music.playQueue(items, t ? Math.max(0, items.findIndex((x) => x.id === t.item!.id)) : 0);
  };
  const saveAsPlaylist = async () => {
    setSaving(true);
    try {
      const r = await api.listenbrainz.saveAsPlaylist(list.id);
      toast.success(`Saved ${r.count} tracks as a playlist`);
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };
  const requestArtist = async (t: LbRecommendedTrack) => {
    const mbid = t.artistMbids[0];
    if (!mbid) return;
    try {
      await api.requests.create({ mediaType: 'artist', externalId: mbid, title: t.artist });
      setRequested((s) => ({ ...s, [mbid]: true }));
      toast.success(`Requested ${t.artist}`);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <section className="lb-row">
      <div className="lb-row-head">
        <h2 className="section-title"><span className="lb-mark" aria-hidden="true">LB</span> From ListenBrainz</h2>
        <div className="chip-row">
          {lists.map((l) => (
            <button key={l.id} className={`chip ${l.id === list.id ? 'active' : ''}`} onClick={() => setTab(l.id)} data-nav>{shortTitle(l)}</button>
          ))}
        </div>
        <span className="spacer" />
        <button className="btn btn-sm btn-primary" onClick={() => play()} disabled={!inLib.length} data-nav><Icon name="play" size={14} /> Play {inLib.length}</button>
        <button className="btn btn-sm" onClick={() => void saveAsPlaylist()} disabled={!inLib.length || saving} data-nav>{saving ? <Spinner size={14} /> : <Icon name="playlist" size={14} />} Save as playlist</button>
      </div>
      <p className="muted small">{inLib.length} of {list.tracks.length} in your library</p>
      {inLib.length > 0 && (
        <Row title="" className="lb-tracks">
          {inLib.map((t) => (
            <button key={t.item!.id} className="lb-track" onClick={() => play(t)} data-nav title={`${t.title} — ${t.artist}`}>
              <span className="lb-track-art"><Img src={t.item!.posterUrl} width={200} fallback={<Icon name="music" size={22} />} /><span className="lb-track-play"><Icon name="play" size={18} /></span></span>
              <strong>{t.item!.title}</strong>
              <small className="muted">{t.item!.music?.displayArtist ?? t.item!.grandparentTitle ?? t.artist}</small>
            </button>
          ))}
        </Row>
      )}
      {missing.length > 0 && (
        <details className="lb-missing">
          <summary>{missing.length} not in your library</summary>
          <ul>
            {missing.slice(0, 30).map((t, i) => (
              <li key={`${t.recordingMbid}-${i}`}>
                <span><strong>{t.title || 'Unknown track'}</strong> <span className="muted">— {t.artist || 'Unknown artist'}</span></span>
                {data.canRequest && t.artistMbids[0] && (requested[t.artistMbids[0]] ? <span className="muted small"><Icon name="check" size={14} /> Requested</span> : (
                  <button className="btn btn-sm btn-ghost" onClick={() => void requestArtist(t)}><Icon name="plus" size={14} /> Request artist</button>
                ))}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function shortTitle(l: LbRecommendationList): string {
  if (l.kind === 'weekly-jams') return 'Weekly Jams';
  if (l.kind === 'weekly-exploration') return 'Weekly Exploration';
  if (l.kind === 'daily-jams') return 'Daily Jams';
  if (l.kind === 'cf') return 'Recommended';
  return l.title;
}
