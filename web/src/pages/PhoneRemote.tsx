import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Item, PairedTarget, RemoteKey, RemotePlayerState, RemoteTarget, SecondScreenInfo } from '@mediamax/shared';
import { Icon, type IconName } from '../components/Icon';
import { Img, Spinner, Tabs } from '../components/ui';
import { useDebounced, useServerEvent } from '../hooks';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { formatClock } from '../utils/format';
import { pairApi, remoteSend } from '../remote/api';
import { classifyGesture, estimatePosition, swipeSteps, textDiff, trickplayTile } from '../remote/gesture';
import { SongId } from '../remote/SongId';
import '../remote/remote.css';

interface Target {
  id: string;
  name: string;
  ownerName: string | null;
  /** QR-paired: the touch-pad and keyboard work (remote.key). */
  paired: boolean;
  pairingId: string | null;
  crossUser: boolean;
  online: boolean;
  state: RemotePlayerState | null;
}

function merge(own: RemoteTarget[], paired: PairedTarget[]): Target[] {
  const out = new Map<string, Target>();
  for (const t of own) out.set(t.id, { id: t.id, name: t.deviceName, ownerName: null, paired: false, pairingId: null, crossUser: false, online: true, state: t.state });
  for (const p of paired) {
    const prev = out.get(p.id);
    out.set(p.id, { id: p.id, name: p.deviceName, ownerName: p.crossUser ? p.ownerName : null, paired: true, pairingId: p.pairingId, crossUser: p.crossUser, online: p.online || !!prev, state: p.state ?? prev?.state ?? null });
  }
  return [...out.values()].sort((a, b) => Number(b.paired) - Number(a.paired) || Number(b.online) - Number(a.online));
}

type Tab = 'remote' | 'now' | 'browse';

/** Phone remote for a TV: touch-pad + buttons + keyboard, second screen while it plays, and "Play on TV". */
export default function PhoneRemotePage() {
  const { deviceId } = useParams();
  const navigate = useNavigate();
  const { wsOpen } = useApp();
  const [own, setOwn] = useState<RemoteTarget[]>([]);
  const [paired, setPaired] = useState<PairedTarget[]>([]);
  const [loaded, setLoaded] = useState(false);
  const received = useRef(new Map<string, number>());

  const load = useCallback(async () => {
    const [o, p] = await Promise.all([pairApi.ownTargets().catch(() => []), pairApi.targets().catch(() => [])]);
    const now = Date.now();
    [...o, ...p].forEach((t) => received.current.set(t.id, now));
    setOwn(o);
    setPaired(p);
    setLoaded(true);
  }, []);
  useEffect(() => {
    void load();
  }, [load, wsOpen]);
  useServerEvent((ev) => {
    // The push includes this phone itself; the GET leaves it out.
    if (ev.type === 'remote.targets') void load();
    else if (ev.type === 'pair.targets') {
      const now = Date.now();
      ev.targets.forEach((t) => received.current.set(t.id, now));
      setPaired(ev.targets);
    } else if (ev.type === 'pair.updated' && ev.status === 'revoked') void load();
  });

  const targets = useMemo(() => merge(own, paired), [own, paired]);
  const target = deviceId ? targets.find((t) => t.id === deviceId) ?? null : null;
  useEffect(() => {
    // No device chosen: go straight to the only / first paired TV.
    if (!deviceId && loaded) {
      const first = targets.find((t) => t.paired && t.online);
      if (first && targets.filter((t) => t.paired).length === 1) navigate(`/remote/${encodeURIComponent(first.id)}`, { replace: true });
    }
  }, [deviceId, loaded, targets, navigate]);

  if (!deviceId || (!target && loaded)) {
    return (
      <div className="phone-shell">
        <header className="phone-top">
          <Link to="/" className="btn-icon" aria-label="Home"><Icon name="arrowLeft" /></Link>
          <strong>Remote</strong>
          <span />
        </header>
        <main className="remote-pick">
          {!loaded ? <Spinner /> : (
            <>
              {deviceId && <p className="pair-error">That TV isn’t available any more.</p>}
              <h2>Choose a TV</h2>
              {targets.length === 0 && <p className="muted">No TVs yet. On the TV choose “Use your phone as remote” and scan the code.</p>}
              <ul className="remote-targets">
                {targets.map((t) => (
                  <li key={t.id}>
                    <Link to={`/remote/${encodeURIComponent(t.id)}`} className="remote-target">
                      <Icon name="tv" size={22} />
                      <span>
                        <strong>{t.name}</strong>
                        <small className="muted">{[t.ownerName && `${t.ownerName}’s TV`, t.paired ? 'Paired' : 'Your device', t.online ? (t.state?.title ? `Playing ${t.state.title}` : 'Online') : 'Offline'].filter(Boolean).join(' · ')}</small>
                      </span>
                      <Icon name="chevronRight" size={18} />
                    </Link>
                  </li>
                ))}
              </ul>
              <Link to="/pair" className="btn btn-primary btn-lg pair-cta"><Icon name="link" size={18} /> Pair a TV</Link>
            </>
          )}
        </main>
      </div>
    );
  }
  if (!target) return <div className="phone-shell"><Spinner /></div>;
  return <RemoteFor target={target} receivedAt={received.current.get(target.id) ?? Date.now()} onRevoked={() => void load()} />;
}

function RemoteFor({ target, receivedAt, onRevoked }: { target: Target; receivedAt: number; onRevoked: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>(() => (target.state?.itemId ? 'now' : 'remote'));
  const st = target.state;
  const [, force] = useState(0);
  useEffect(() => {
    if (!st || st.paused) return;
    const t = window.setInterval(() => force((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [st]);
  const pos = estimatePosition(st, receivedAt);

  const cmd = (action: Parameters<typeof remoteSend.command>[1], opts?: Parameters<typeof remoteSend.command>[2]) => {
    if (!target.online) {
      toast.show('The TV is offline');
      return;
    }
    remoteSend.command(target.id, action, opts);
    navigator.vibrate?.(8);
  };
  const key = (k: RemoteKey, text?: string) => {
    if (!target.paired) {
      toast.show('Pair this TV by QR code to use the touch-pad and keyboard');
      return;
    }
    remoteSend.key(target.id, k, text);
    navigator.vibrate?.(8);
  };
  const seekBy = (ms: number) => cmd('seek', { positionMs: Math.max(0, pos + ms) });
  const volume = st?.volume ?? 50;

  const unpair = async () => {
    if (!target.pairingId) return;
    await pairApi.revoke(target.pairingId).catch((e) => toast.error(e));
    onRevoked();
    navigate('/remote', { replace: true });
  };

  return (
    <div className="phone-shell">
      <header className="phone-top">
        <Link to="/remote" className="btn-icon" aria-label="All TVs"><Icon name="arrowLeft" /></Link>
        <span className="phone-top-title">
          <strong>{target.name}</strong>
          <small className={target.online ? 'ok' : 'muted'}>{target.online ? (target.crossUser ? `${target.ownerName}’s TV · guest` : 'Connected') : 'Offline'}</small>
        </span>
        {target.pairingId ? <button className="btn-icon" onClick={() => void unpair()} aria-label="Unpair"><Icon name="x" /></button> : <span />}
      </header>
      <Tabs<Tab>
        className="phone-tabs"
        value={tab}
        onChange={setTab}
        tabs={[{ value: 'remote', label: 'Remote' }, { value: 'now', label: 'Now playing' }, { value: 'browse', label: 'Browse' }]}
      />
      {st?.itemId && tab !== 'now' && (
        <button className="mini-now" onClick={() => setTab('now')}>
          <Img src={st.posterUrl} width={60} alt="" fallback={<Icon name="film" size={18} />} />
          <span><strong>{st.title}</strong><small className="muted">{formatClock(pos)} / {st.durationMs ? formatClock(st.durationMs) : '--:--'}</small></span>
          <Icon name={st.paused ? 'play' : 'pause'} size={20} />
        </button>
      )}
      <main className="phone-main">
        {tab === 'remote' && (
          <RemotePad
            paired={target.paired}
            playing={!!st?.itemId}
            onKey={key}
            onTogglePlay={() => (st?.itemId ? cmd('togglePause') : key('playPause'))}
            onSeek={seekBy}
            onVolume={(d) => cmd('setVolume', { volume: Math.max(0, Math.min(100, volume + d)) })}
            volume={st?.volume ?? null}
          />
        )}
        {tab === 'now' && <SecondScreen target={target} pos={pos} cmd={cmd} />}
        {tab === 'browse' && <Browse target={target} onPlay={(it) => { cmd('playItem', { itemId: it.id }); toast.success(`Playing ${it.title} on ${target.name}`); setTab('now'); }} />}
      </main>
    </div>
  );
}

function PadButton({ icon, label, onClick, big }: { icon: IconName; label: string; onClick: () => void; big?: boolean }) {
  return (
    <button className={`pad-btn ${big ? 'pad-btn-big' : ''}`} onClick={onClick} aria-label={label}>
      <Icon name={icon} size={big ? 30 : 22} />
      <small>{label}</small>
    </button>
  );
}

function RemotePad({ paired, playing, onKey, onTogglePlay, onSeek, onVolume, volume }: {
  paired: boolean; playing: boolean; onKey: (k: RemoteKey, text?: string) => void; onTogglePlay: () => void; onSeek: (ms: number) => void; onVolume: (d: number) => void; volume: number | null;
}) {
  const start = useRef<{ x: number; y: number; t: number; lx: number; ly: number; emitted: boolean } | null>(null);
  const [flash, setFlash] = useState<RemoteKey | null>(null);
  const show = (k: RemoteKey) => {
    setFlash(k);
    window.setTimeout(() => setFlash((f) => (f === k ? null : f)), 220);
  };
  const emit = (k: RemoteKey) => {
    onKey(k);
    show(k);
  };
  const [text, setText] = useState('');
  const sent = useRef('');
  const onText = (v: string) => {
    setText(v);
    const d = textDiff(sent.current, v);
    for (let i = 0; i < Math.min(d.backspaces, 50); i++) onKey('backspace');
    if (d.text) onKey('text', d.text);
    sent.current = v;
  };

  return (
    <div className="remote-pad">
      <div
        className={`touchpad ${paired ? '' : 'is-disabled'} ${flash ? `flash-${flash}` : ''}`}
        role="application"
        aria-label="Touch-pad: swipe to move, tap to select"
        tabIndex={0}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          start.current = { x: e.clientX, y: e.clientY, t: Date.now(), lx: e.clientX, ly: e.clientY, emitted: false };
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s) return;
          const step = swipeSteps(e.clientX - s.lx, e.clientY - s.ly);
          if (!step) return;
          for (let i = 0; i < Math.min(step.n, 3); i++) emit(step.key);
          s.lx = e.clientX;
          s.ly = e.clientY;
          s.emitted = true;
        }}
        onPointerUp={(e) => {
          const s = start.current;
          start.current = null;
          if (!s) return;
          if (s.emitted) {
            // Finish a swipe that moved less than a full step since the last emit.
            const k = classifyGesture(e.clientX - s.lx, e.clientY - s.ly, 0);
            if (k && k !== 'ok') emit(k);
            return;
          }
          const k = classifyGesture(e.clientX - s.x, e.clientY - s.y, Date.now() - s.t);
          if (k) emit(k);
        }}
        onPointerCancel={() => { start.current = null; }}
        onKeyDown={(e) => {
          const map: Record<string, RemoteKey> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'ok', Backspace: 'back', Escape: 'back' };
          const k = map[e.key];
          if (k) {
            e.preventDefault();
            emit(k);
          }
        }}
      >
        <span className="touchpad-hint">{paired ? 'Swipe to move · tap to select' : 'Pair this TV by QR code to use the touch-pad'}</span>
        <span className="touchpad-dot" aria-hidden="true" />
      </div>
      <div className="pad-row">
        <PadButton icon="arrowLeft" label="Back" onClick={() => onKey('back')} />
        <PadButton icon="home" label="Home" onClick={() => onKey('home')} />
        <PadButton icon="info" label="Info" onClick={() => onKey('info')} />
      </div>
      <div className="pad-row pad-transport">
        <PadButton icon="rewind10" label="−10 s" onClick={() => (playing ? onSeek(-10_000) : onKey('rewind'))} />
        <PadButton icon={playing ? 'pause' : 'play'} label="Play / pause" big onClick={onTogglePlay} />
        <PadButton icon="forward10" label="+10 s" onClick={() => (playing ? onSeek(10_000) : onKey('forward'))} />
      </div>
      <div className="pad-row pad-volume">
        <PadButton icon="volumeLow" label="Volume −" onClick={() => onVolume(-10)} />
        <span className="pad-volume-value" aria-live="polite">{volume == null ? '—' : `${volume}%`}</span>
        <PadButton icon="volume" label="Volume +" onClick={() => onVolume(10)} />
      </div>
      <form className="pad-keyboard" onSubmit={(e) => { e.preventDefault(); onKey('submit'); setText(''); sent.current = ''; }}>
        <Icon name="keyboard" size={18} />
        <input
          className="input"
          value={text}
          disabled={!paired}
          onChange={(e) => onText(e.target.value)}
          placeholder="Type on the TV (search, sign-in…)"
          autoCapitalize="none"
          autoCorrect="off"
          enterKeyHint="search"
          aria-label="Type on the TV"
        />
      </form>
    </div>
  );
}

function SecondScreen({ target, pos, cmd }: { target: Target; pos: number; cmd: (a: Parameters<typeof remoteSend.command>[1], o?: Parameters<typeof remoteSend.command>[2]) => void }) {
  const st = target.state;
  const [info, setInfo] = useState<SecondScreenInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => {
    setInfo(null);
    setErr(null);
    if (!st?.itemId) return;
    const ac = new AbortController();
    pairApi.now(target.id, ac.signal).then(setInfo, (e) => (e as Error).name !== 'AbortError' && setErr((e as Error).message));
    return () => ac.abort();
  }, [target.id, st?.itemId]);

  if (!st?.itemId) {
    return <div className="ss-empty"><Icon name="tv" size={40} /><h3>Nothing playing</h3><p className="muted">Start something from Browse, or with the touch-pad.</p></div>;
  }
  const dur = st.durationMs ?? info?.item.durationMs ?? 0;
  const shown = drag ?? pos;
  const tile = drag != null && info?.trickplay ? trickplayTile(info.trickplay, drag) : null;
  const item = info?.item;
  const chapters = item?.chapters ?? [];
  const people = (item?.people?.length ? item.people : info?.show?.people ?? []).slice(0, 16);
  return (
    <div className="second-screen">
      <section className="ss-now" style={item?.backdropUrl ? { ['--ss-bg' as string]: `url("${item.backdropUrl}?w=800")` } : undefined}>
        <div className="ss-poster"><Img src={st.posterUrl} width={200} alt="" fallback={<Icon name="film" size={28} />} /></div>
        <div className="ss-title">
          <strong>{st.title}</strong>
          {st.subtitle && <span className="muted">{st.subtitle}</span>}
        </div>
      </section>
      <section className="ss-scrub">
        {tile && (
          <div className="ss-trick" style={{ width: tile.w, height: tile.h, backgroundImage: `url("${tile.url}")`, backgroundPosition: `-${tile.x}px -${tile.y}px`, left: `clamp(0px, calc(${(drag! / Math.max(1, dur)) * 100}% - ${tile.w / 2}px), calc(100% - ${tile.w}px))` }}>
            <span>{formatClock(drag!)}</span>
          </div>
        )}
        <input
          type="range"
          className="ss-range"
          min={0}
          max={Math.max(1, dur)}
          step={1000}
          value={Math.min(shown, dur || shown)}
          aria-label="Position"
          onChange={(e) => setDrag(Number(e.target.value))}
          onPointerUp={() => { if (drag != null) cmd('seek', { positionMs: drag }); setDrag(null); }}
          onKeyUp={() => { if (drag != null) cmd('seek', { positionMs: drag }); setDrag(null); }}
        />
        <div className="ss-times"><span>{formatClock(shown)}</span><span>{dur ? `−${formatClock(Math.max(0, dur - shown))}` : ''}</span></div>
        <div className="ss-transport">
          <button className="btn-icon" onClick={() => cmd('seek', { positionMs: Math.max(0, pos - 10_000) })} aria-label="Back 10 seconds"><Icon name="rewind10" size={26} /></button>
          <button className="btn btn-primary ss-play" onClick={() => cmd('togglePause')} aria-label={st.paused ? 'Play' : 'Pause'}><Icon name={st.paused ? 'play' : 'pause'} size={28} /></button>
          <button className="btn-icon" onClick={() => cmd('seek', { positionMs: pos + 10_000 })} aria-label="Forward 10 seconds"><Icon name="forward10" size={26} /></button>
          {st.nextItemId && <button className="btn-icon" onClick={() => cmd('next')} aria-label="Next episode"><Icon name="next" size={24} /></button>}
        </div>
        {st.skip && <button className="btn btn-glass ss-skip" onClick={() => cmd('skipSegment')}>{st.skip.label} <Icon name="skipFwd" size={16} /></button>}
      </section>

      {((st.audioTracks?.length ?? 0) > 1 || (st.subtitleTracks?.length ?? 0) > 0) && (
        <section className="ss-card ss-tracks">
          {(st.audioTracks?.length ?? 0) > 1 && (
            <label>
              <span><Icon name="audio" size={16} /> Audio</span>
              <select className="input" value={st.audioIndex ?? ''} onChange={(e) => cmd('setAudioTrack', { trackIndex: Number(e.target.value) })}>
                {st.audioTracks!.map((t) => <option key={t.index} value={t.index}>{t.label}</option>)}
              </select>
            </label>
          )}
          {(st.subtitleTracks?.length ?? 0) > 0 && (
            <label>
              <span><Icon name="subtitles" size={16} /> Subtitles</span>
              <select className="input" value={st.subtitleIndex ?? 'off'} onChange={(e) => cmd('setSubtitleTrack', { trackIndex: e.target.value === 'off' ? null : Number(e.target.value) })}>
                <option value="off">Off</option>
                {st.subtitleTracks!.map((t) => <option key={t.index} value={t.index}>{t.label}</option>)}
              </select>
            </label>
          )}
        </section>
      )}

      <SongId identify={() => pairApi.identifyOnTv(target.id)} />

      {chapters.length > 0 && (
        <section className="ss-card">
          <h3><Icon name="chapters" size={18} /> Chapters</h3>
          <ol className="ss-chapters">
            {chapters.map((c, i) => {
              const active = pos >= c.startMs && pos < c.endMs;
              return (
                <li key={i}>
                  <button className={active ? 'active' : ''} onClick={() => cmd('seek', { positionMs: c.startMs })}>
                    <span>{c.title || `Chapter ${i + 1}`}</span><small className="muted">{formatClock(c.startMs)}</small>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {people.length > 0 && (
        <section className="ss-card">
          <h3><Icon name="users" size={18} /> Cast &amp; crew</h3>
          <ul className="ss-people">
            {people.map((p, i) => (
              <li key={`${p.name}-${i}`}>
                <div className="ss-person-img"><Img src={p.imageUrl} width={120} alt="" fallback={<Icon name="user" size={22} />} /></div>
                <strong>{p.name}</strong>
                <small className="muted">{p.role || p.kind}</small>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(info?.episodes.length ?? 0) > 0 && (
        <section className="ss-card">
          <h3><Icon name="shows" size={18} /> {info!.show?.title ?? 'Episodes'}</h3>
          <ol className="ss-episodes">
            {info!.episodes.map((e) => (
              <li key={e.id}>
                <button className={e.id === st.itemId ? 'active' : ''} onClick={() => e.id !== st.itemId && cmd('playItem', { itemId: e.id })}>
                  <span className="ss-ep-n">{e.index ?? ''}</span>
                  <span className="ss-ep-t">{e.title}</span>
                  {e.id === st.itemId ? <Icon name="play" size={14} /> : e.durationMs ? <small className="muted">{Math.round(e.durationMs / 60000)} min</small> : null}
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
      {info?.next && info.next.id !== st.itemId && (
        <section className="ss-card ss-next">
          <h3><Icon name="next" size={18} /> Up next</h3>
          <button className="ss-next-btn" onClick={() => cmd('playItem', { itemId: info.next!.id })}>
            <Img src={info.next.thumbUrl ?? info.next.posterUrl} width={240} alt="" fallback={<Icon name="film" size={20} />} />
            <span><strong>{info.next.title}</strong><small className="muted">{info.next.grandparentTitle ?? ''}</small></span>
          </button>
        </section>
      )}
      {err && <p className="muted">{err}</p>}
    </div>
  );
}

function Browse({ target, onPlay }: { target: Target; onPlay: (it: Item) => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [stack, setStack] = useState<Item[]>([]);
  const [data, setData] = useState<{ items: Item[]; continueWatching?: Item[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const parent = stack[stack.length - 1];
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    pairApi.browse(target.id, parent ? { parentId: parent.id } : { q: dq }, ac.signal)
      .then(setData, () => undefined)
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, [target.id, dq, parent]);
  const open = (it: Item) => (it.type === 'show' || it.type === 'season' ? setStack((s) => [...s, it]) : onPlay(it));
  const row = (it: Item) => (
    <li key={it.id}>
      <button className="browse-row" onClick={() => open(it)}>
        <Img src={it.posterUrl ?? it.thumbUrl} width={90} alt="" fallback={<Icon name="film" size={18} />} />
        <span>
          <strong>{it.type === 'episode' && it.index != null ? `${it.index}. ` : ''}{it.title}</strong>
          <small className="muted">{[it.year, it.type === 'show' ? 'Series' : it.type === 'season' ? 'Season' : null].filter(Boolean).join(' · ')}</small>
        </span>
        <Icon name={it.type === 'show' || it.type === 'season' ? 'chevronRight' : 'play'} size={18} />
      </button>
    </li>
  );
  return (
    <div className="browse">
      {parent ? (
        <button className="btn btn-ghost btn-sm" onClick={() => setStack((s) => s.slice(0, -1))}><Icon name="chevronLeft" size={16} /> {parent.title}</button>
      ) : (
        <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${target.crossUser ? `${target.ownerName}’s` : 'your'} library`} aria-label="Search" />
      )}
      {loading && !data ? <Spinner /> : (
        <>
          {!parent && !dq && (data?.continueWatching?.length ?? 0) > 0 && (
            <>
              <h3>Continue watching</h3>
              <ul className="browse-list">{data!.continueWatching!.map(row)}</ul>
            </>
          )}
          {!parent && !dq && <h3>Recently added</h3>}
          <ul className="browse-list">{data?.items.map(row)}</ul>
          {data && !data.items.length && <p className="muted">Nothing found.</p>}
        </>
      )}
    </div>
  );
}
