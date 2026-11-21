/**
 * Movie Match — group swipe. `/match` starts or joins a session, `/match/join/:code` joins from the QR code,
 * `/match/:id` is the session: the same deck for everyone, swipe right = yes, left = no, up = super like
 * (touch drag with spring physics, buttons, keyboard / TV D-pad). "It's a match!" arrives over the WebSocket for
 * every device at once, with confetti and "Play on…" the device that hosts the session.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Item, MatchContentKind, MatchResult, MatchRule, MatchSessionState, MatchVote, ServerEvent } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { decideApi } from '../api/decide';
import { errorMessage, mediaUrl } from '../api/client';
import { realtime } from '../api/ws';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useServerEvent } from '../hooks';
import { Icon } from '../components/Icon';
import { Avatar, EmptyState, Img, PageLoader, Switch, useConfirm } from '../components/ui';
import { QrCode } from '../components/QrCode';
import { Confetti } from '../components/decide/Confetti';
import { dragHint, dragTransform, flyOut, joinUrl, keyVote, normalizeCode, swipeVote } from '../utils/decide';
import { formatDuration } from '../utils/format';
import { playLink } from '../utils/items';
import '../styles/decide.css';

const HOST_KEY = (id: string) => `mm.matchHost.${id}`;
const isTv = () => document.documentElement.classList.contains('tv');
const markHost = (id: string) => {
  try {
    sessionStorage.setItem(HOST_KEY(id), '1');
  } catch {
    /* storage blocked */
  }
};
const isHostDevice = (id: string) => {
  try {
    return sessionStorage.getItem(HOST_KEY(id)) === '1';
  } catch {
    return false;
  }
};

/* ------------------------------ start / join ------------------------------ */

export default function MatchPage() {
  const { id, code } = useParams();
  if (code) return <JoinByCode code={code} />;
  if (id) return <MatchSession id={id} />;
  return <MatchStart />;
}

function JoinByCode({ code }: { code: string }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    decideApi.joinMatch(normalizeCode(code)).then((s) => navigate(`/match/${s.id}`, { replace: true })).catch((e) => setError(errorMessage(e)));
  }, [code, navigate]);
  if (error) return <div className="page"><EmptyState icon="alert" title="Couldn't join" message={error} action={<Link to="/match" className="btn btn-primary">Back</Link>} /></div>;
  return <PageLoader />;
}

function MatchStart() {
  const { libraries } = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const [kind, setKind] = useState<MatchContentKind>('movies');
  const [libIds, setLibIds] = useState<string[]>([]);
  const [genres, setGenres] = useState<string[]>([]);
  const [allGenres, setAllGenres] = useState<string[]>([]);
  const [maxRuntime, setMaxRuntime] = useState<number | null>(null);
  const [unwatched, setUnwatched] = useState(true);
  const [rule, setRule] = useState<MatchRule>('all');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const libs = libraries.filter((l) => (kind === 'movies' ? l.type === 'movies' : kind === 'shows' ? l.type === 'shows' : l.type === 'movies' || l.type === 'shows'));

  useEffect(() => {
    api.items.genres(libIds.length === 1 ? libIds[0] : undefined).then(setAllGenres).catch(() => undefined);
  }, [libIds]);

  const start = async () => {
    setBusy(true);
    try {
      const s = await decideApi.createMatch({ kind, libraryIds: libIds, genres, maxRuntimeMin: maxRuntime, unwatchedByAll: unwatched, rule });
      markHost(s.id);
      navigate(`/match/${s.id}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const join = async () => {
    setBusy(true);
    try {
      const s = await decideApi.joinMatch(normalizeCode(code));
      navigate(`/match/${s.id}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page match-start">
      <header className="page-head">
        <div>
          <h1><Icon name="together" size={28} className="page-icon" /> Movie Match</h1>
          <p className="muted">Everyone swipes the same picks on their phone. When you all say yes, it's a match.</p>
        </div>
      </header>
      <div className="match-start-grid">
        <section className="card-surface match-form">
          <h2>Start a session</h2>
          <div className="segmented" role="tablist" aria-label="What to match">
            {(['movies', 'shows', 'both'] as const).map((k) => (
              <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'active' : ''} onClick={() => { setKind(k); setLibIds([]); }}>
                {k === 'movies' ? 'Movies' : k === 'shows' ? 'Shows' : 'Both'}
              </button>
            ))}
          </div>
          {libs.length > 1 && (
            <div className="match-chips" role="group" aria-label="Libraries">
              {libs.map((l) => {
                const on = libIds.includes(l.id);
                return <button key={l.id} className={`chip ${on ? 'active' : ''}`} aria-pressed={on} onClick={() => setLibIds(on ? libIds.filter((x) => x !== l.id) : [...libIds, l.id])}>{l.name}</button>;
              })}
            </div>
          )}
          {allGenres.length > 0 && (
            <details className="match-genres">
              <summary>Genres{genres.length ? ` · ${genres.length}` : ' · any'}</summary>
              <div className="match-chips">
                {allGenres.map((g) => {
                  const on = genres.includes(g);
                  return <button key={g} className={`chip chip-sm ${on ? 'active' : ''}`} aria-pressed={on} onClick={() => setGenres(on ? genres.filter((x) => x !== g) : [...genres, g])}>{g}</button>;
                })}
              </div>
            </details>
          )}
          <label className="field-inline">
            <span>Max runtime</span>
            <select className="select" value={maxRuntime ?? ''} onChange={(e) => setMaxRuntime(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Any length</option>
              {[90, 105, 120, 150].map((m) => <option key={m} value={m}>Under {formatDuration(m * 60000)}</option>)}
            </select>
          </label>
          <label className="field-inline">
            <span>It's a match when</span>
            <select className="select" value={rule} onChange={(e) => setRule(e.target.value as MatchRule)}>
              <option value="all">Everyone says yes</option>
              <option value="majority">Most people say yes</option>
            </select>
          </label>
          <Switch checked={unwatched} onChange={setUnwatched} label="Only things nobody in the group has seen" />
          <p className="muted small">The strictest profile in the group sets the age rating — kids profiles only ever see what they're allowed to.</p>
          <button className="btn btn-primary btn-lg" onClick={start} disabled={busy} data-nav><Icon name="play" size={18} /> Start matching</button>
        </section>
        <section className="card-surface match-form">
          <h2>Join a session</h2>
          <p className="muted">Scan the QR code on the TV, or type the code.</p>
          <input className="input match-code-input" value={code} onChange={(e) => setCode(normalizeCode(e.target.value))} placeholder="CODE" aria-label="Session code" autoCapitalize="characters" autoComplete="off" inputMode="text"
            onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && join()} />
          <button className="btn btn-lg" onClick={join} disabled={busy || code.length !== 6}><Icon name="together" size={18} /> Join</button>
        </section>
      </div>
    </div>
  );
}

/* --------------------------------- session -------------------------------- */

function MatchSession({ id }: { id: string }) {
  const { user } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [state, setState] = useState<MatchSessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [cards, setCards] = useState<Item[]>([]);
  const [deckOffset, setDeckOffset] = useState(0);
  const [found, setFound] = useState<MatchResult | null>(null);
  const [tab, setTab] = useState<'swipe' | 'results'>('swipe');
  const loadingDeck = useRef(false);
  const host = state?.hostUserId === user?.id;
  const hostDevice = isHostDevice(id);
  const lastMatches = useRef<MatchResult[]>([]);
  if (state?.matches) lastMatches.current = state.matches;

  const loadDeck = useCallback(async (from: number) => {
    if (loadingDeck.current) return;
    loadingDeck.current = true;
    try {
      const d = await decideApi.deck(id, from, 20);
      setCards(d.cards.filter((c) => !d.myVotes[c.id]));
      setDeckOffset(d.offset + d.cards.length);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      loadingDeck.current = false;
    }
  }, [id]);

  const refresh = useCallback(async () => {
    try {
      const s = await decideApi.match(id);
      setState(s);
      return s;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    }
  }, [id]);

  useEffect(() => {
    void refresh().then((s) => s && loadDeck(s.myCursor));
    const t = window.setInterval(() => void refresh(), 20000);
    const off = realtime.onStatus((open) => open && void refresh());
    return () => {
      window.clearInterval(t);
      off();
    };
  }, [refresh, loadDeck]);

  useServerEvent((ev: ServerEvent) => {
    if (ev.type === 'match.state' && ev.session.id === id) setState(ev.session);
    else if (ev.type === 'match.found' && ev.sessionId === id) setFound(ev.match);
    else if (ev.type === 'match.ended' && ev.sessionId === id) setEnded(ev.reason === 'host' ? 'The host ended the session.' : 'This session timed out.');
    // The TV that hosts the session starts a match when someone taps "Play on…".
    else if (ev.type === 'remote.command' && ev.action === 'playItem' && ev.itemId && hostDevice) navigate(playLink({ id: ev.itemId }, { fromStart: true }));
  });

  // Keep the local queue topped up (the server extends the deck as people near the end).
  useEffect(() => {
    if (!state || cards.length > 4 || loadingDeck.current) return;
    if (deckOffset < state.deckSize) {
      const from = Math.max(state.myCursor, deckOffset);
      decideApi.deck(id, from, 20).then((d) => {
        setCards((c) => [...c, ...d.cards.filter((x) => !d.myVotes[x.id] && !c.some((y) => y.id === x.id))]);
        setDeckOffset(d.offset + d.cards.length);
      }).catch(() => undefined);
    }
  }, [state, cards.length, deckOffset, id]);

  const vote = useCallback(async (item: Item, v: MatchVote) => {
    setCards((c) => c.filter((x) => x.id !== item.id));
    try {
      const r = await decideApi.vote(id, item.id, v);
      setState(r.state);
      if (r.match) setFound(r.match);
    } catch (e) {
      toast.error(e);
    }
  }, [id, toast]);

  const playOnHost = async (m: MatchResult) => {
    try {
      const r = await decideApi.playOnHost(id, m.itemId);
      toast.success(`Starting on ${r.deviceName}`);
      setFound(null);
    } catch (e) {
      toast.error(e);
    }
  };

  const leave = async () => {
    if (host) {
      if (!(await confirm({ title: 'End this session?', message: 'Everyone will see the results and the session closes.', confirmLabel: 'End session', danger: true }))) return;
      await decideApi.end(id).catch(() => undefined);
    } else await decideApi.leave(id).catch(() => undefined);
    navigate('/match');
  };

  if (ended || (error && !state)) {
    const results = lastMatches.current;
    return (
      <div className="page match-ended">
        <EmptyState icon="together" title={ended ? 'Session over' : "Can't open this session"} message={ended ?? error} action={<Link to="/match" className="btn btn-primary">New session</Link>} />
        {results.length > 0 && <ResultsList results={results} onPlayHere={(m) => navigate(playLink({ id: m.itemId }, { fromStart: true }))} />}
      </div>
    );
  }
  if (!state) return <PageLoader />;

  const link = joinUrl(window.location.origin, state.code);
  const doneCount = state.members.filter((m) => m.done).length;

  return (
    <div className={`page match-session ${isTv() ? 'is-tv' : ''}`}>
      <aside className="match-lobby card-surface">
        <div className="match-code-block">
          <small className="eyebrow">Join with code</small>
          <div className="match-code" aria-label={`Code ${state.code.split('').join(' ')}`}>{state.code}</div>
          <div className="match-qr"><QrCode value={link} size={isTv() ? 200 : 140} label="Scan to join" /></div>
          <small className="muted match-link">{link.replace(/^https?:\/\//, '')}</small>
        </div>
        <ul className="match-members" aria-label="Who's matching">
          {state.members.map((m) => (
            <li key={m.userId} className={`match-member ${m.online ? 'online' : 'offline'}`}>
              <Avatar name={m.displayName} url={m.avatarUrl} size={isTv() ? 48 : 36} />
              <span className="match-member-name">{m.displayName}{m.isHost && <small className="muted"> · host</small>}</span>
              <small className={`match-member-status ${m.done ? 'done' : ''}`}>{!m.online ? 'away' : m.done ? 'done' : `swiping… ${m.voted}/${state.deckSize}`}</small>
            </li>
          ))}
        </ul>
        <p className="muted small">{state.members.length < 2 ? 'Waiting for someone to join…' : `${doneCount} of ${state.members.length} done · ${state.settings.rule === 'all' ? 'everyone must say yes' : 'majority wins'}`}</p>
        <button className="btn btn-ghost btn-sm" onClick={leave}><Icon name={host ? 'x' : 'logout'} size={14} /> {host ? 'End session' : 'Leave'}</button>
      </aside>

      <main className="match-main">
        <div className="segmented match-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'swipe'} className={tab === 'swipe' ? 'active' : ''} onClick={() => setTab('swipe')}>Swipe</button>
          <button role="tab" aria-selected={tab === 'results'} className={tab === 'results' ? 'active' : ''} onClick={() => setTab('results')}>Matches{state.matches.length ? ` · ${state.matches.length}` : ''}</button>
        </div>
        {tab === 'swipe' ? (
          <SwipeDeck cards={cards} onVote={vote} done={state.myCursor >= state.deckSize && !cards.length} onMore={() => decideApi.extend(id).then(setState).catch(toast.error)} />
        ) : (
          <ResultsList results={state.matches} hostName={state.hostDeviceOnline && !hostDevice ? state.hostDeviceName : null} onPlayOnHost={playOnHost} onPlayHere={(m) => navigate(playLink({ id: m.itemId }, { fromStart: true }))} />
        )}
      </main>

      {found && (
        <MatchReveal
          match={found}
          hostName={state.hostDeviceOnline && !hostDevice ? state.hostDeviceName : null}
          onPlayOnHost={() => playOnHost(found)}
          onPlayHere={() => navigate(playLink({ id: found.itemId }, { fromStart: true }))}
          onKeepSwiping={() => setFound(null)}
        />
      )}
    </div>
  );
}

/* ---------------------------------- deck ---------------------------------- */

function SwipeDeck({ cards, onVote, done, onMore }: { cards: Item[]; onVote: (item: Item, v: MatchVote) => void; done: boolean; onMore: () => void }) {
  const top = cards[0];
  const cardRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; t: number; lx: number; ly: number; lt: number; id: number } | null>(null);
  const [hint, setHint] = useState<{ vote: MatchVote | null; strength: number }>({ vote: null, strength: 0 });
  const [leaving, setLeaving] = useState(false);

  const fling = useCallback((v: MatchVote) => {
    const el = cardRef.current;
    if (!top || leaving) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!el || reduce) return onVote(top, v);
    setLeaving(true);
    const w = el.offsetWidth;
    const o = flyOut(v, w, el.offsetHeight);
    el.style.transition = 'transform 320ms cubic-bezier(.2,.7,.3,1), opacity 320ms';
    el.style.transform = `translate3d(${o.x}px, ${o.y}px, 0) rotate(${o.rot}deg)`;
    el.style.opacity = '0';
    setHint({ vote: v, strength: 1 });
    window.setTimeout(() => {
      setLeaving(false);
      setHint({ vote: null, strength: 0 });
      onVote(top, v);
    }, 300);
  }, [top, leaving, onVote]);

  // Reset the transform for every new top card.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    el.style.transition = 'none';
    el.style.transform = '';
    el.style.opacity = '';
  }, [top?.id]);

  // Keyboard and TV D-pad: ← no, → yes, ↑ super like.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (document.querySelector('[role="dialog"]')) return;
      // On TV only while the deck has focus (so the D-pad can still reach the rest of the page).
      if (isTv() && !deckRef.current?.contains(document.activeElement)) return;
      const v = keyVote(e.key);
      if (!v) return;
      e.preventDefault();
      fling(v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fling]);

  useEffect(() => {
    if (isTv()) deckRef.current?.focus({ preventScroll: true });
  }, []);

  const onDown = (e: ReactPointerEvent) => {
    if (leaving || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const now = performance.now();
    drag.current = { x: e.clientX, y: e.clientY, t: now, lx: e.clientX, ly: e.clientY, lt: now, id: e.pointerId };
    if (cardRef.current) cardRef.current.style.transition = 'none';
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    const el = cardRef.current;
    if (!d || !el || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    el.style.transform = dragTransform(dx, dy, el.offsetWidth);
    const now = performance.now();
    if (now - d.lt > 16) {
      d.lx = e.clientX;
      d.ly = e.clientY;
      d.lt = now;
    }
    setHint(dragHint(dx, dy, el.offsetWidth));
  };
  const onUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    const el = cardRef.current;
    drag.current = null;
    if (!d || !el) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const dt = Math.max(1, performance.now() - d.lt);
    const v = swipeVote({ dx, dy, vx: (e.clientX - d.lx) / dt, vy: (e.clientY - d.ly) / dt, width: el.offsetWidth });
    if (v) return fling(v);
    // Spring back (slight overshoot).
    el.style.transition = 'transform 420ms cubic-bezier(.34,1.56,.64,1)';
    el.style.transform = '';
    setHint({ vote: null, strength: 0 });
  };

  if (!top) {
    return (
      <div className="match-deck-empty">
        <EmptyState icon={done ? 'checkCircle' : 'together'} title={done ? "You're through the deck" : 'Loading cards…'} message={done ? 'Waiting for the others. Want more cards?' : undefined}
          action={done ? <button className="btn btn-primary" onClick={onMore}><Icon name="plus" size={16} /> More cards</button> : undefined} />
      </div>
    );
  }

  return (
    <div className="match-deck-wrap">
      <div className="match-deck" ref={deckRef} tabIndex={0} data-own-arrows="all" aria-label={`${top.title}. Right arrow: yes. Left arrow: no. Up arrow: super like.`}>
        {cards.slice(1, 3).reverse().map((c, i, arr) => (
          <div key={c.id} className="match-card under" style={{ transform: `scale(${1 - (arr.length - i) * 0.04}) translateY(${(arr.length - i) * 10}px)` }}>
            <Img src={c.posterUrl} width={420} alt="" />
          </div>
        ))}
        <div key={top.id} ref={cardRef} className="match-card top" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <Img src={top.posterUrl} width={480} alt="" fallback={<span className="match-card-fallback">{top.title}</span>} />
          <span className="match-stamp yes" style={{ opacity: hint.vote === 'yes' ? hint.strength : 0 }}>YES</span>
          <span className="match-stamp no" style={{ opacity: hint.vote === 'no' ? hint.strength : 0 }}>NOPE</span>
          <span className="match-stamp super" style={{ opacity: hint.vote === 'super' ? hint.strength : 0 }}>SUPER</span>
          <div className="match-card-info">
            <strong>{top.title}</strong>
            <small>{[top.year, top.contentRating, top.durationMs ? formatDuration(top.durationMs) : top.type === 'show' ? `${top.childCount} seasons` : null, top.communityRating ? `★ ${top.communityRating.toFixed(1)}` : null].filter(Boolean).join(' · ')}</small>
            {top.overview && <p>{top.overview}</p>}
          </div>
        </div>
      </div>
      <div className="match-buttons">
        <button className="match-btn no" onClick={() => fling('no')} aria-label="No" title="No (←)"><Icon name="x" size={30} /></button>
        <button className="match-btn super" onClick={() => fling('super')} aria-label="Super like" title="Super like (↑)"><Icon name="starFill" size={26} /></button>
        <button className="match-btn yes" onClick={() => fling('yes')} aria-label="Yes" title="Yes (→)"><Icon name="heartFill" size={28} /></button>
      </div>
    </div>
  );
}

/* --------------------------------- results -------------------------------- */

function ResultsList({ results, hostName, onPlayOnHost, onPlayHere }: { results: MatchResult[]; hostName?: string | null; onPlayOnHost?: (m: MatchResult) => void; onPlayHere: (m: MatchResult) => void }) {
  const max = useMemo(() => Math.max(1, ...results.map((r) => r.enthusiasm)), [results]);
  if (!results.length) return <EmptyState icon="heart" title="No matches yet" message="Keep swiping — matches show up here, most loved first." />;
  return (
    <ol className="match-results">
      {results.map((m, i) => (
        <li key={m.itemId} className="match-result">
          <span className="match-rank">{i + 1}</span>
          <Link to={`/item/${m.itemId}`} className="match-result-poster"><Img src={m.posterUrl} width={90} alt="" /></Link>
          <div className="match-result-body">
            <strong>{m.title}</strong> {m.year && <span className="muted">({m.year})</span>}
            <div className="match-enthusiasm" aria-label={`${m.yes} yes, ${m.superLikes} super likes`}>
              <span style={{ width: `${Math.max(8, (m.enthusiasm / max) * 100)}%` }} />
            </div>
            <small className="muted">{m.superLikes ? `${m.superLikes} super like${m.superLikes > 1 ? 's' : ''} · ` : ''}{m.yes} yes{m.no ? ` · ${m.no} no` : ''}</small>
          </div>
          <div className="match-result-actions">
            {hostName && onPlayOnHost && <button className="btn btn-primary btn-sm" onClick={() => onPlayOnHost(m)}><Icon name="cast" size={14} /> {hostName}</button>}
            <button className="btn btn-sm" onClick={() => onPlayHere(m)}><Icon name="play" size={14} /> Play</button>
          </div>
        </li>
      ))}
    </ol>
  );
}

function MatchReveal({ match, hostName, onPlayOnHost, onPlayHere, onKeepSwiping }: { match: MatchResult; hostName: string | null; onPlayOnHost: () => void; onPlayHere: () => void; onKeepSwiping: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.btn-primary')?.focus();
    navigator.vibrate?.([60, 40, 120]);
  }, [match.itemId]);
  return (
    <div className="match-reveal" role="dialog" aria-modal="true" aria-labelledby="match-reveal-title" ref={ref}
      onKeyDown={(e) => e.key === 'Escape' && onKeepSwiping()}>
      {match.backdropUrl && <div className="match-reveal-bg" style={{ backgroundImage: `url("${mediaUrl(match.backdropUrl, 1280)}")` }} />}
      <Confetti fireKey={match.itemId} />
      <div className="match-reveal-body">
        <h2 id="match-reveal-title" className="match-reveal-title">It's a match!</h2>
        <div className="match-reveal-poster"><Img src={match.posterUrl} width={300} alt="" /></div>
        <p className="match-reveal-name">{match.title}{match.year ? ` (${match.year})` : ''}</p>
        <div className="row-gap match-reveal-actions">
          {hostName ? (
            <button className="btn btn-primary btn-lg" onClick={onPlayOnHost}><Icon name="cast" size={18} /> Play on {hostName}</button>
          ) : (
            <button className="btn btn-primary btn-lg" onClick={onPlayHere}><Icon name="play" size={18} /> Play now</button>
          )}
          {hostName && <button className="btn btn-glass btn-lg" onClick={onPlayHere}><Icon name="play" size={18} /> Play here</button>}
          <button className="btn btn-ghost btn-lg" onClick={onKeepSwiping}>Keep swiping</button>
        </div>
      </div>
    </div>
  );
}
