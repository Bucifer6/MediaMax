import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { DjEnergyCurve, DjMixRequest, DjMixTrack, DjPhrase, DjPhraseType, DjStatus, DjTransitionPreference, Item } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { useMusic } from '../player/music';
import { djEngine, type DeckState, type DjOptions, type DjState } from '../player/djEngine';
import { transitionLabel, type KeyLockMode } from '../player/djMixer';
import { Icon } from '../components/Icon';
import { Badge, Field, Img, Spinner, Switch } from '../components/ui';
import { formatClock, formatDuration } from '../utils/format';
import { HelpLink } from '../components/HelpLink';

const CURVES: { value: DjEnergyCurve; label: string; hint: string }[] = [
  { value: 'steady', label: 'Steady', hint: 'Holds the vibe of the first track' },
  { value: 'build', label: 'Build', hint: 'Starts mellow and climbs' },
  { value: 'peak', label: 'Peak time', hint: 'Builds to a peak, then eases off' },
  { value: 'wave', label: 'Waves', hint: 'Rises and falls in cycles' },
  { value: 'chill', label: 'Chill', hint: 'Low energy throughout' },
];
const LENGTHS: { value: number | 'continuous'; label: string }[] = [
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' },
  { value: 90, label: '90 min' },
  { value: 'continuous', label: 'Non-stop' },
];

function useDj(): DjState {
  const [s, setS] = useState<DjState>(() => djEngine().snapshot());
  useEffect(() => djEngine().subscribe(setS), []);
  return s;
}

const KEY_LABEL: Record<string, string> = { perfect: 'Same key', compatible: 'Harmonic', energy: 'Energy boost', clash: 'Key change', unknown: 'Key ?' };
const PHRASE_LABEL: Record<DjPhraseType, string> = { intro: 'Intro', verse: 'Verse', buildup: 'Build', drop: 'Drop', breakdown: 'Breakdown', outro: 'Outro' };
const TRANSITIONS: { value: DjTransitionPreference; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Picks per pair of songs' },
  { value: 'smooth', label: 'Smooth', hint: 'Long blends and filter fades' },
  { value: 'energetic', label: 'Energetic', hint: 'Bass swaps and echo-outs' },
  { value: 'minimal', label: 'Minimal', hint: 'Short, plain crossfades' },
];

/** Song structure under a deck's progress bar: one coloured block per phrase, mix-out marker on top. */
function PhraseStrip({ phrases, durationMs }: { phrases: DjPhrase[]; durationMs: number }) {
  if (!phrases.length || durationMs <= 0) return null;
  return (
    <div className="dj-phrases" aria-label="Song structure">
      {phrases.map((p, i) => (
        <i
          key={i}
          className={`dj-phrase dj-phrase-${p.type}`}
          style={{ left: `${(p.startMs / durationMs) * 100}%`, width: `${(Math.max(0, Math.min(durationMs, p.endMs) - p.startMs) / durationMs) * 100}%`, opacity: 0.45 + 0.55 * p.energy }}
          title={`${PHRASE_LABEL[p.type]} · ${p.bars} bars`}
        >
          {i === 0 || phrases[i - 1].type !== p.type ? <span>{PHRASE_LABEL[p.type]}</span> : null}
        </i>
      ))}
    </div>
  );
}

function Meta({ t }: { t: DjMixTrack }) {
  const a = t.analysis;
  return (
    <span className="dj-meta">
      {a?.bpm ? <span title="Tempo">{Math.round(a.bpm)} BPM</span> : <span className="muted">— BPM</span>}
      {a?.camelot ? <span className="dj-key" title={a.key ?? ''}>{a.camelot}</span> : null}
      {a ? <span className="dj-energy" title={`Energy ${Math.round(a.energy * 100)}%`}><i style={{ width: `${Math.round(a.energy * 100)}%` }} /></span> : null}
    </span>
  );
}

function Deck({ d, side, live, mixOutMs }: { d: DeckState; side: 'A' | 'B'; live: boolean; mixOutMs: number | null }) {
  const t = d.track;
  const dur = d.durationMs || t?.analysis?.durationMs || 0;
  return (
    <div className={`dj-deck ${live ? 'live' : ''} ${t ? '' : 'empty'}`} style={{ ['--deck-gain' as string]: d.gain }}>
      <div className="dj-deck-label">Deck {side}{live && <span className="live-dot" />}</div>
      {t ? (
        <>
          <div className="dj-deck-main">
            <Img src={t.item.posterUrl} alt="" className="dj-art" width={160} />
            <div className="dj-deck-info">
              <strong className="dj-title">{t.item.title}</strong>
              <span className="muted">{t.item.grandparentTitle}</span>
              <Meta t={t} />
              {Math.abs(d.rate - 1) > 0.001 && <span className="dj-rate">{d.rate > 1 ? '+' : ''}{((d.rate - 1) * 100).toFixed(1)}% tempo</span>}
            </div>
          </div>
          <div className="dj-progress" aria-label={`${formatClock(d.positionMs)} of ${formatClock(dur)}`}>
            <i style={{ width: `${dur ? Math.min(100, (d.positionMs / dur) * 100) : 0}%` }} />
            {live && mixOutMs != null && dur > 0 && <b className="dj-mixmark" style={{ left: `${Math.min(100, (mixOutMs / dur) * 100)}%` }} title="Mix point" />}
          </div>
          {t.analysis?.phrases?.length ? <PhraseStrip phrases={t.analysis.phrases} durationMs={dur} /> : null}
          <div className="dj-times muted"><span>{formatClock(d.positionMs)}</span>{d.loading ? <Spinner size={14} /> : null}<span>{formatClock(dur)}</span></div>
        </>
      ) : (
        <div className="dj-deck-idle muted">Waiting for the next track…</div>
      )}
    </div>
  );
}

const VOICE_KEY = 'mm.dj.voice';
const readVoice = () => {
  try {
    return localStorage.getItem(VOICE_KEY) !== '0';
  } catch {
    return true;
  }
};

/** AI DJ: describe the mix in your own words. */
function AskTheDj({ onAsk, ai, nowArtist }: { onAsk: (prompt: string) => Promise<void>; ai: NonNullable<DjStatus['ai']>; nowArtist: string | null }) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const examples = [
    'Chilled Sunday morning', '90s party bangers, all night', 'Workout, fast, 45 minutes', 'Late-night jazz',
    ...(nowArtist ? [`Something like ${nowArtist}`] : ['Feel-good songs from my favourites']),
  ];
  const ask = async (p: string) => {
    if (!p.trim() || busy) return;
    setBusy(true);
    try {
      await onAsk(p.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="dj-ask">
      <div className="dj-ask-head">
        <span className="dj-ai-badge"><Icon name="sparkles" size={14} /> AI DJ</span>
        <h2>What do you feel like?</h2>
        <p className="muted">Describe it in your own words — a mood, an era, an artist, how long. {ai.hostName} builds the mix{ai.llm ? '' : ' (built-in understanding; an admin can connect a free AI model for more)'}.</p>
      </div>
      <form className="dj-ask-form" onSubmit={(e) => { e.preventDefault(); void ask(prompt); }}>
        <input className="input input-lg" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. chilled 90s house for a Sunday morning" maxLength={500} aria-label="Describe your mix" />
        <button className="btn btn-primary btn-lg" disabled={!prompt.trim() || busy}>{busy ? <Spinner size={18} /> : <Icon name="play" size={18} />} Play it</button>
      </form>
      <div className="chip-row" aria-label="Examples">
        {examples.map((x) => <button key={x} className="chip" onClick={() => void ask(x)} disabled={busy}>{x}</button>)}
      </div>
    </section>
  );
}

function Setup({ onStart, seed }: { onStart: (req: DjMixRequest, continuous: boolean) => Promise<void>; seed: Item | null }) {
  const [curve, setCurve] = useState<DjEnergyCurve>('steady');
  const [length, setLength] = useState<number | 'continuous'>('continuous');
  const [harmonic, setHarmonic] = useState(true);
  const [genres, setGenres] = useState<string[]>([]);
  const [bpmMin, setBpmMin] = useState('');
  const [bpmMax, setBpmMax] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Item | null>(seed);
  const [busy, setBusy] = useState(false);
  useEffect(() => setPicked(seed), [seed]);
  // Genres from music libraries only (movie/TV genres would just be noise here).
  const allGenres = useAsync(async () => {
    const libs = (await api.libraries.list()).filter((l) => l.type === 'music');
    const lists = await Promise.all(libs.map((l) => api.items.genres(l.id).catch(() => [] as string[])));
    return [...new Set(lists.flat())].sort((a, b) => a.localeCompare(b));
  }, []);
  const results = useAsync(async () => {
    if (q.trim().length < 2) return [] as Item[];
    const r = await api.items.search(q.trim(), 20);
    return r.items.filter((i) => ['track', 'album', 'artist', 'playlist'].includes(i.type)).slice(0, 8);
  }, [q]);

  const start = async () => {
    setBusy(true);
    try {
      await onStart({
        seedItemId: picked?.id, curve, harmonic, genres: genres.length ? genres : undefined,
        durationMin: length === 'continuous' ? 20 : length,
        bpmMin: bpmMin ? Number(bpmMin) : undefined, bpmMax: bpmMax ? Number(bpmMax) : undefined,
      }, length === 'continuous');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dj-setup">
      <section>
        <h2 className="section-title">Start from</h2>
        {picked ? (
          <div className="dj-seed">
            <Img src={picked.posterUrl} alt="" className="dj-seed-art" width={96} />
            <div><strong>{picked.title}</strong><div className="muted">{picked.type}{picked.grandparentTitle || picked.parentTitle ? ` · ${picked.grandparentTitle ?? picked.parentTitle}` : ''}</div></div>
            <button className="btn btn-ghost btn-sm" onClick={() => setPicked(null)}>Change</button>
          </div>
        ) : (
          <>
            <input className="input" placeholder="A song, album, artist or playlist — or leave empty to start from your favourites" value={q} onChange={(e) => setQ(e.target.value)} />
            {!!results.data?.length && (
              <ul className="dj-results">
                {results.data.map((i) => (
                  <li key={i.id}><button onClick={() => { setPicked(i); setQ(''); }}><Img src={i.posterUrl} alt="" width={64} /><span><strong>{i.title}</strong><small className="muted">{i.type}{i.grandparentTitle ? ` · ${i.grandparentTitle}` : i.parentTitle ? ` · ${i.parentTitle}` : ''}</small></span></button></li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
      <section>
        <h2 className="section-title">Energy</h2>
        <div className="dj-curves" role="radiogroup" aria-label="Energy curve">
          {CURVES.map((c) => (
            <button key={c.value} role="radio" aria-checked={curve === c.value} className={`dj-curve ${curve === c.value ? 'active' : ''}`} onClick={() => setCurve(c.value)}>
              <CurveIcon curve={c.value} />
              <strong>{c.label}</strong>
              <small>{c.hint}</small>
            </button>
          ))}
        </div>
      </section>
      <section className="dj-options">
        <div className="field">
          <span className="field-label" id="dj-length">Length</span>
          <div className="chip-row" role="radiogroup" aria-labelledby="dj-length">
            {LENGTHS.map((l) => <button key={String(l.value)} role="radio" aria-checked={length === l.value} className={`chip ${length === l.value ? 'active' : ''}`} onClick={() => setLength(l.value)}>{l.label}</button>)}
          </div>
        </div>
        {!!allGenres.data?.length && (
          <div className="field">
            <span className="field-label" id="dj-genres">Genres <small className="muted">· none selected = your whole music library</small></span>
            <div className="chip-row" role="group" aria-labelledby="dj-genres">
              {allGenres.data.slice(0, 40).map((g) => {
                const on = genres.includes(g);
                return <button key={g} aria-pressed={on} className={`chip ${on ? 'active' : ''}`} onClick={() => setGenres(on ? genres.filter((x) => x !== g) : [...genres, g])}>{g}</button>;
              })}
            </div>
          </div>
        )}
        <div className="form-row">
          <Field label="Min BPM"><input className="input" type="number" min={50} max={220} placeholder="Any" value={bpmMin} onChange={(e) => setBpmMin(e.target.value)} /></Field>
          <Field label="Max BPM"><input className="input" type="number" min={50} max={220} placeholder="Any" value={bpmMax} onChange={(e) => setBpmMax(e.target.value)} /></Field>
        </div>
        <Switch checked={harmonic} onChange={setHarmonic} label="Harmonic mixing" hint="Prefer songs in compatible keys (Camelot wheel) so blends sound musical." />
      </section>
      <MixerSettings />
      <button className="btn btn-primary btn-lg dj-start" onClick={() => void start()} disabled={busy}>
        {busy ? <Spinner size={18} /> : <Icon name="play" size={18} />} Start the mix
      </button>
    </div>
  );
}

/** DJ settings: transition feel, tempo matching with key lock, what happens to the tempo after a transition. */
function MixerSettings() {
  const engine = djEngine();
  const [o, setO] = useState<DjOptions>(() => engine.getOptions());
  const support = engine.keyLockSupport();
  const set = (patch: Partial<DjOptions>) => {
    engine.setOptions(patch);
    setO(engine.getOptions());
  };
  const keyLockHint = !support.native && !support.worklet
    ? 'This browser can\'t change tempo without changing pitch, so tracks play at their own tempo (plain crossfades).'
    : o.keyLock === 'worklet' || (!support.native && support.worklet)
      ? 'Kinora\'s own WSOLA time-stretch (AudioWorklet).'
      : 'The browser\'s built-in pitch-preserving playback.';
  return (
    <section className="dj-options dj-mixer-settings">
      <div className="field">
        <span className="field-label" id="dj-transitions">Transitions</span>
        <div className="chip-row" role="radiogroup" aria-labelledby="dj-transitions">
          {TRANSITIONS.map((x) => (
            <button key={x.value} role="radio" aria-checked={o.transitions === x.value} className={`chip ${o.transitions === x.value ? 'active' : ''}`} title={x.hint} onClick={() => set({ transitions: x.value })}>{x.label}</button>
          ))}
        </div>
        <small className="muted">{TRANSITIONS.find((x) => x.value === o.transitions)?.hint}. Mixes start on phrase boundaries (outro → intro) when the songs have been analysed.</small>
      </div>
      <div className="form-row">
        <Field label="Tempo matching (key lock)" hint={keyLockHint}>
          <select className="input" value={o.keyLock} onChange={(e) => set({ keyLock: e.target.value as KeyLockMode })}>
            <option value="auto">Automatic</option>
            <option value="native" disabled={!support.native}>Browser time-stretch</option>
            <option value="worklet" disabled={!support.worklet}>WSOLA (AudioWorklet)</option>
            <option value="off">Off — never change tempo</option>
          </select>
        </Field>
        <Field label="Largest tempo change" hint="Songs further apart (after half/double time) are not beat-matched.">
          <select className="input" value={o.maxStretchPct} onChange={(e) => set({ maxStretchPct: Number(e.target.value) })}>
            {[4, 6, 8, 10, 12, 16].map((n) => <option key={n} value={n}>±{n}%{n === 8 ? ' (default)' : ''}</option>)}
          </select>
        </Field>
        <Field label="After a transition">
          <select className="input" value={o.afterTransition === 'stay' ? 'stay' : String(o.glideBars)} onChange={(e) => (e.target.value === 'stay' ? set({ afterTransition: 'stay' }) : set({ afterTransition: 'glide', glideBars: Number(e.target.value) }))}>
            {[4, 8, 16, 32].map((n) => <option key={n} value={n}>Glide back to its own tempo over {n} bars</option>)}
            <option value="stay">Stay at the matched tempo</option>
          </select>
        </Field>
      </div>
    </section>
  );
}

function CurveIcon({ curve }: { curve: DjEnergyCurve }) {
  const pts = Array.from({ length: 21 }, (_, i) => {
    const p = i / 20;
    const y = curve === 'build' ? 0.25 + 0.65 * p : curve === 'peak' ? (p < 0.7 ? 0.35 + 0.6 * (p / 0.7) : 0.95 - 0.4 * ((p - 0.7) / 0.3)) : curve === 'wave' ? 0.55 + 0.3 * Math.sin(2 * Math.PI * 2 * p) : curve === 'chill' ? 0.1 : 0.75;
    return `${(p * 60).toFixed(1)},${(30 - y * 26).toFixed(1)}`;
  });
  return <svg viewBox="0 0 60 32" className="dj-curve-icon" aria-hidden="true"><polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export default function DjPage() {
  const s = useDj();
  const music = useMusic();
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useApp();
  const [sp] = useSearchParams();
  const seedId = sp.get('seed');
  const seed = useAsync(async () => (seedId ? api.items.get(seedId).catch(() => null) : null), [seedId]);
  const status = useAsync(() => api.dj.status().catch(() => null), []);
  const engine = djEngine();
  const active = s.status === 'playing' || s.status === 'paused' || s.status === 'loading';
  const live = s.decks[s.live];
  const next = s.queue[s.index + 1] ?? null;
  const upcoming = useMemo(() => s.queue.slice(s.index + 1), [s.queue, s.index]);

  const [voice, setVoiceState] = useState(readVoice);
  const ai = status.data?.ai ?? null;
  useEffect(() => engine.setVoice(voice, ai), [voice, ai, engine]);
  const setVoice = (v: boolean) => {
    setVoiceState(v);
    try {
      localStorage.setItem(VOICE_KEY, v ? '1' : '0');
    } catch {
      /* private mode */
    }
  };

  const start = async (req: DjMixRequest, continuous: boolean) => {
    try {
      music.pause();
      const o = engine.getOptions();
      req = { transitions: o.transitions, maxStretchPct: o.maxStretchPct, ...req };
      const mix = await api.dj.mix(req);
      if (!mix.tracks.length) throw new Error('No tracks matched — try fewer filters');
      // Prompt mixes come back with the resolved settings; top-ups reuse those instead of re-reading the prompt.
      await engine.start(mix, mix.request ?? req, mix.continuous ?? continuous);
    } catch (e) {
      toast.error(e);
    }
  };
  const nowArtist = music.current?.grandparentTitle ?? null;
  const love = () => {
    const it = engine.love();
    if (it) toast.success(`♥ ${it.title} — added to favourites`);
  };

  const saveAsPlaylist = async () => {
    try {
      const date = new Date().toLocaleDateString([], { day: 'numeric', month: 'short' });
      const pl = await api.playlists.create({ title: `DJ mix · ${date}`, itemIds: engine.allTrackIds() });
      toast.success('Saved as a playlist');
      navigate(`/item/${pl.id}`);
    } catch (e) {
      toast.error(e);
    }
  };

  const analysed = status.data && status.data.total > 0 ? status.data.analyzed / status.data.total : 1;

  return (
    <div className="page dj-page">
      <header className="page-head">
        <div className="page-title-wrap">
          <Icon name="music" size={28} className="page-icon" />
          <h1>DJ <HelpLink slug="dj-mode" label="DJ mode" /></h1>
        </div>
        {active && (
          <div className="row-gap">
            <button className="btn" onClick={() => void saveAsPlaylist()}><Icon name="playlist" size={16} /> Save as playlist</button>
            <button className="btn btn-ghost" onClick={() => engine.stop()}><Icon name="x" size={16} /> End mix</button>
          </div>
        )}
      </header>

      {analysed < 1 && status.data && (
        <p className="dj-analysis-note muted">
          <Icon name="info" size={14} /> {status.data.analyzed} of {status.data.total} tracks analysed for tempo and key. Unanalysed tracks still play, with simple crossfades.
          {user?.isAdmin && !status.data.running && <button className="btn btn-sm btn-ghost" onClick={() => void api.dj.analyze().then(() => toast.success('Analysis started — see Admin → Tasks'))}>Analyse now</button>}
        </p>
      )}

      {!active ? (
        <>
          {s.status === 'ended' && <p className="muted">That mix has finished. Start another below.</p>}
          {s.status === 'error' && <p className="form-error">{s.error}</p>}
          {ai?.enabled && <AskTheDj ai={ai} nowArtist={nowArtist} onAsk={(prompt) => start({ prompt }, false)} />}
          {ai?.enabled && <Switch checked={voice} onChange={setVoice} label={`DJ voice — ${ai.hostName} talks between songs`} hint={ai.serverVoice ? 'Uses the server\'s DJ voice.' : 'Uses your browser\'s built-in voice.'} />}
          {ai?.enabled && <h2 className="section-title dj-or">Or set it up yourself</h2>}
          <Setup onStart={start} seed={seed.data ?? null} />
        </>
      ) : (
        <div className="dj-booth">
          {s.summary && (
            <p className="dj-summary"><span className="dj-ai-badge"><Icon name="sparkles" size={12} /> {s.understoodBy === 'llm' ? 'AI' : 'DJ'}</span> {s.summary}</p>
          )}
          {s.hostSpeaking && <div className="dj-subtitle" role="status" aria-live="polite"><strong>{ai?.hostName ?? 'DJ'}:</strong> {s.hostSpeaking}</div>}
          <div className="dj-decks">
            <Deck d={s.decks[0]} side="A" live={s.live === 0} mixOutMs={s.live === 0 ? next?.transition?.mixOutMs ?? null : null} />
            <div className="dj-mixer">
              <div className="dj-fader" aria-label="Crossfader" role="meter" aria-valuemin={-1} aria-valuemax={1} aria-valuenow={s.crossfader}>
                <i style={{ left: `${((s.crossfader + 1) / 2) * 100}%` }} />
              </div>
              <div className="dj-controls">
                {s.status === 'paused' ? (
                  <button className="btn btn-primary btn-icon-lg" onClick={() => void engine.resume()} aria-label="Resume"><Icon name="play" size={26} /></button>
                ) : (
                  <button className="btn btn-primary btn-icon-lg" onClick={() => engine.pause()} aria-label="Pause" disabled={s.status === 'loading'}><Icon name="pause" size={26} /></button>
                )}
                <button className="btn" onClick={() => engine.mixNow()} disabled={!next || s.transitioning} title="Start the next transition now (on the next bar)"><Icon name="shuffle" size={16} /> Mix now</button>
                <button className="btn btn-ghost" onClick={() => engine.skipNext()} disabled={!next || s.transitioning} title="Skip the upcoming track (the DJ learns from skips)"><Icon name="next" size={16} /> Skip next</button>
                <button className="btn btn-ghost" onClick={love} title="Love this track (adds it to favourites and steers future mixes)"><Icon name="heart" size={16} /> Love</button>
                {ai?.enabled && <button className={`btn btn-ghost ${voice ? 'active' : ''}`} aria-pressed={voice} onClick={() => setVoice(!voice)} title="DJ voice"><Icon name={voice ? 'volume' : 'mute'} size={16} /> Voice</button>}
              </div>
              {s.transition && <Badge tone="accent">{s.transition.label}… {Math.round(s.transition.progress * 100)}%</Badge>}
              <small className="muted dj-keylock" title="Tempo matching with key lock">{s.keyLock === 'native' ? 'Key lock: browser' : s.keyLock === 'worklet' ? 'Key lock: WSOLA' : 'No tempo matching'}</small>
            </div>
            <Deck d={s.decks[1]} side="B" live={s.live === 1} mixOutMs={s.live === 1 ? next?.transition?.mixOutMs ?? null : null} />
          </div>

          <section className="dj-queue">
            <h2 className="section-title">Up next {s.continuous && <small className="muted">· non-stop {s.fetching ? '· picking more…' : ''}</small>}</h2>
            <EnergyStrip tracks={s.queue} index={s.index} />
            {upcoming.length === 0 ? (
              <p className="muted">{s.continuous ? 'Choosing the next tracks…' : 'This is the last track of the mix.'}</p>
            ) : (
              <ol className="dj-list">
                {upcoming.map((t, i) => (
                  <li key={`${t.item.id}-${i}`} className={i === 0 ? 'next' : ''}>
                    {t.transition && (
                      <div className="dj-transition">
                        <span className={`dj-style dj-style-${t.transition.style} dj-fx-${t.transition.fx ?? 'none'}`} title={t.transition.reason}>{transitionLabel(t.transition)}</span>
                        {t.transition.outPhrase && t.transition.inPhrase && <span title={t.transition.phraseAligned ? 'On phrase boundaries' : 'On the bar'}>{PHRASE_LABEL[t.transition.outPhrase]} → {PHRASE_LABEL[t.transition.inPhrase]}</span>}
                        {t.transition.style === 'blend' && Math.abs(t.transition.tempoRatio - 1) > 0.001 && <span>{t.transition.tempoRatio > 1 ? '+' : ''}{((t.transition.tempoRatio - 1) * 100).toFixed(1)}% tempo, key locked</span>}
                        <span>{KEY_LABEL[t.transition.keyMatch]}</span>
                        {t.transition.bpmDelta != null && <span>{t.transition.bpmDelta < 0.05 ? 'Same tempo' : `Δ ${t.transition.bpmDelta}% tempo`}</span>}
                        <span>{(t.transition.crossfadeMs / 1000).toFixed(0)} s</span>
                      </div>
                    )}
                    <div className="dj-row">
                      <Img src={t.item.posterUrl} alt="" className="dj-row-art" width={64} />
                      <div className="dj-row-info"><strong>{t.item.title}</strong><span className="muted">{t.item.grandparentTitle}</span></div>
                      <Meta t={t} />
                      <span className="muted dj-row-dur">{formatDuration(t.item.durationMs)}</span>
                      {i > 0 && <button className="btn-icon" aria-label={`Remove ${t.item.title}`} onClick={() => engine.removeAt(s.index + 1 + i)}><Icon name="x" size={14} /></button>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {live.track && <p className="muted dj-now">Now: {live.track.item.title} · {live.track.item.grandparentTitle}</p>}
          </section>
        </div>
      )}
    </div>
  );
}

function EnergyStrip({ tracks, index }: { tracks: DjMixTrack[]; index: number }) {
  if (tracks.length < 2) return null;
  return (
    <div className="dj-strip" aria-label="Energy of the mix">
      {tracks.map((t, i) => (
        <i key={`${t.item.id}-${i}`} className={i < index ? 'past' : i === index ? 'now' : ''} style={{ height: `${Math.round(15 + (t.analysis?.energy ?? 0.4) * 85)}%` }} title={`${t.item.title}${t.analysis?.bpm ? ` · ${Math.round(t.analysis.bpm)} BPM` : ''}${t.analysis?.camelot ? ` · ${t.analysis.camelot}` : ''}`} />
      ))}
    </div>
  );
}
