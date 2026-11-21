/**
 * Random marathon ("fall-asleep mode") and the sleep timer for the web/TV video player.
 *
 * - Marathon: the player URL carries `?marathon=<id>`. When a title ends, the server hands out the next random
 *   pick (POST /marathon/:id/next); a 10 s countdown card plays it unless cancelled.
 * - "Are you still watching?": after N titles in a row / N hours with no input (the server decides at title
 *   boundaries, this module checks mid-title). Unanswered for 60 s → playback pauses (position saved, the title is
 *   not marked watched) and the player closes.
 * - Sleep timer: 30/60/90 min, end of this title, or after N titles; the audio fades out over the last 30 s.
 *
 * State that must survive moving to the next title (counters, the sleep timer) lives in sessionStorage.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Item } from '@mediamax/shared';
import { decideApi } from '../api/decide';
import { Icon } from '../components/Icon';
import { Img } from '../components/ui';
import { OptionList, Popover } from './controls';
import { fadeFactor, marathonPlayLink, setStillWatchingPrefs, sleepMsLeft, stillWatchingDue, stillWatchingPrefs, type SleepChoice } from '../utils/decide';
import '../styles/decide.css';

const SLEEP_KEY = 'mm.sleepTimer';
const MARATHON_KEY = (id: string) => `mm.marathon.${id}`;
const COUNTDOWN_S = 10;
const ANSWER_S = 60;

interface SleepState { choice: SleepChoice; startedAt: number; itemsLeft?: number }
interface MarathonLocal { itemsSinceInput: number; lastInputAt: number }

const readJson = <T,>(store: 'local' | 'session', key: string, def: T): T => {
  try {
    const s = (store === 'local' ? localStorage : sessionStorage).getItem(key);
    return s ? { ...def, ...JSON.parse(s) } : def;
  } catch {
    return def;
  }
};
const writeJson = (store: 'local' | 'session', key: string, v: unknown) => {
  try {
    const s = store === 'local' ? localStorage : sessionStorage;
    if (v == null) s.removeItem(key);
    else s.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked */
  }
};


interface Opts {
  videoRef: RefObject<HTMLVideoElement | null>;
  item: Item | null;
  marathonId: string | null;
  ended: boolean;
  positionMs: number;
  durationMs: number;
  /** Leave the player (after stopping). */
  exit: () => void;
}

/**
 * Hook for VideoPlayer. Returns `blockAutoplay` (suppress the player's own "Up next"), the overlay to render and
 * the sleep timer button for the top bar.
 */
export function useMarathon({ videoRef, item, marathonId, ended, positionMs, durationMs, exit }: Opts): { blockAutoplay: boolean; overlay: ReactNode; sleepButton: ReactNode } {
  const navigate = useNavigate();
  const [sleep, setSleepState] = useState<SleepState | null>(() => readJson<SleepState | null>('session', SLEEP_KEY, null));
  const [menuOpen, setMenuOpen] = useState(false);
  const [next, setNext] = useState<Item | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [asking, setAsking] = useState<null | { reason: 'boundary' | 'idle'; left: number }>(null);
  const [stopped, setStopped] = useState<string | null>(null);
  const local = useRef<MarathonLocal>(marathonId ? readJson('session', MARATHON_KEY(marathonId), { itemsSinceInput: 0, lastInputAt: Date.now() }) : { itemsSinceInput: 0, lastInputAt: Date.now() });
  const baseVolume = useRef<number | null>(null);
  const handledEnd = useRef<string | null>(null);
  const sw = useRef(stillWatchingPrefs());
  const [swOn, setSwOn] = useState(sw.current.enabled);

  const setSleep = (s: SleepState | null) => {
    setSleepState(s);
    writeJson('session', SLEEP_KEY, s);
    if (!s && baseVolume.current != null && videoRef.current) {
      videoRef.current.volume = baseVolume.current;
      baseVolume.current = null;
    }
  };
  const saveLocal = useCallback(() => {
    if (marathonId) writeJson('session', MARATHON_KEY(marathonId), local.current);
  }, [marathonId]);

  // Any input counts as "still here".
  useEffect(() => {
    const onInput = () => {
      local.current = { itemsSinceInput: 0, lastInputAt: Date.now() };
      saveLocal();
    };
    window.addEventListener('keydown', onInput, true);
    window.addEventListener('pointerdown', onInput, true);
    return () => {
      window.removeEventListener('keydown', onInput, true);
      window.removeEventListener('pointerdown', onInput, true);
    };
  }, [saveLocal]);

  const stop = useCallback((why: string) => {
    const v = videoRef.current;
    if (v && !v.paused) v.pause(); // the player reports the position on pause (not marked watched)
    if (v && baseVolume.current != null) v.volume = baseVolume.current;
    baseVolume.current = null;
    setSleep(null);
    setCountdown(null);
    setAsking(null);
    setStopped(why);
    if (marathonId) void decideApi.endMarathon(marathonId).catch(() => undefined);
    window.setTimeout(exit, 2500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exit, marathonId]);

  // Sleep timer clock + audio fade.
  const remaining = durationMs > 0 ? Math.max(0, durationMs - positionMs) : null;
  useEffect(() => {
    if (!sleep || stopped) return;
    const lastTitle = sleep.choice.kind === 'items' && (sleep.itemsLeft ?? sleep.choice.count) <= 1;
    const left = lastTitle ? remaining : sleepMsLeft(sleep.choice, sleep.startedAt, Date.now(), remaining);
    const v = videoRef.current;
    if (left == null || !v) return;
    const f = fadeFactor(left);
    if (f < 1) {
      if (baseVolume.current == null) baseVolume.current = v.volume;
      v.volume = Math.max(0, baseVolume.current * f);
    }
    if (left <= 0) stop('Sleep timer — good night.');
  });
  useEffect(() => {
    if (!sleep || sleep.choice.kind !== 'minutes' || stopped) return;
    const t = window.setInterval(() => setSleepState((s) => (s ? { ...s } : s)), 1000);
    return () => window.clearInterval(t);
  }, [sleep, stopped]);

  // Mid-title idle check (e.g. 4 hours without touching anything).
  useEffect(() => {
    if (!marathonId || stopped) return;
    const t = window.setInterval(() => {
      if (asking || !videoRef.current || videoRef.current.paused) return;
      if (stillWatchingDue(sw.current, 0, Date.now() - local.current.lastInputAt)) setAsking({ reason: 'idle', left: ANSWER_S });
    }, 30000);
    return () => window.clearInterval(t);
  }, [marathonId, asking, stopped, videoRef]);

  // Title ended: sleep timer boundaries, then the marathon's next pick.
  useEffect(() => {
    if (!ended || !item || handledEnd.current === item.id || stopped) return;
    handledEnd.current = item.id;
    if (sleep?.choice.kind === 'end') return stop('Sleep timer — good night.');
    if (sleep?.choice.kind === 'items') {
      const left = (sleep.itemsLeft ?? sleep.choice.count) - 1;
      if (left <= 0) return stop('Sleep timer — good night.');
      setSleep({ ...sleep, itemsLeft: left });
    }
    if (!marathonId) return;
    local.current.itemsSinceInput += 1;
    saveLocal();
    decideApi.marathonNext(marathonId, { finishedItemId: item.id, itemsSinceInput: local.current.itemsSinceInput, msSinceInput: Date.now() - local.current.lastInputAt })
      .then((r) => {
        if (!r.item) return stop('That’s everything that matches — marathon complete.');
        setNext(r.item);
        if (r.stillWatchingCheck && sw.current.enabled) setAsking({ reason: 'boundary', left: ANSWER_S });
        else setCountdown(COUNTDOWN_S);
      })
      .catch(() => stop('Marathon ended.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended, item?.id]);

  const goNext = useCallback(() => {
    if (!next || !marathonId) return;
    setCountdown(null);
    navigate(marathonPlayLink(next.id, marathonId), { replace: true });
  }, [next, marathonId, navigate]);

  useEffect(() => {
    if (countdown == null) return;
    if (countdown <= 0) return goNext();
    const t = window.setTimeout(() => setCountdown((c) => (c == null ? c : c - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [countdown, goNext]);

  useEffect(() => {
    if (!asking) return;
    if (asking.left <= 0) return stop('Paused — nobody was watching. Your place is saved.');
    const t = window.setTimeout(() => setAsking((a) => (a ? { ...a, left: a.left - 1 } : a)), 1000);
    return () => window.clearTimeout(t);
  }, [asking, stop]);

  const stillHere = () => {
    local.current = { itemsSinceInput: 0, lastInputAt: Date.now() };
    saveLocal();
    const reason = asking?.reason;
    setAsking(null);
    if (reason === 'boundary') setCountdown(COUNTDOWN_S);
  };

  const sleepValue = !sleep ? 'off' : sleep.choice.kind === 'minutes' ? `m${sleep.choice.minutes}` : sleep.choice.kind === 'end' ? 'end' : `i${sleep.choice.count}`;
  const sleepLeft = sleep?.choice.kind === 'minutes' ? sleepMsLeft(sleep.choice, sleep.startedAt, Date.now(), null) : null;
  const sleepButton = (
    <div className="pc-menu sleep-menu">
      <button className={`btn-icon ${sleep ? 'active' : ''}`} onClick={() => setMenuOpen((o) => !o)} aria-label="Sleep timer" title="Sleep timer">
        <Icon name="clock" size={22} />
        {sleepLeft != null && <span className="sleep-badge">{Math.ceil(sleepLeft / 60000)}m</span>}
      </button>
      <Popover open={menuOpen} onClose={() => setMenuOpen(false)}>
        <OptionList<string>
          title="Sleep timer"
          value={sleepValue}
          onSelect={(v) => {
            setMenuOpen(false);
            if (v === 'off') return setSleep(null);
            if (v === 'end') return setSleep({ choice: { kind: 'end' }, startedAt: Date.now() });
            if (v[0] === 'm') return setSleep({ choice: { kind: 'minutes', minutes: Number(v.slice(1)) }, startedAt: Date.now() });
            const n = Number(v.slice(1));
            setSleep({ choice: { kind: 'items', count: n }, startedAt: Date.now(), itemsLeft: n });
          }}
          options={[
            { label: 'Off', value: 'off' },
            { label: '30 minutes', value: 'm30' },
            { label: '60 minutes', value: 'm60' },
            { label: '90 minutes', value: 'm90' },
            { label: item?.type === 'episode' ? 'End of this episode' : 'End of this film', value: 'end' },
            ...(marathonId ? [2, 3, 4].map((n) => ({ label: `After ${n} ${item?.type === 'episode' ? 'episodes' : 'films'}`, value: `i${n}` })) : []),
          ]}
        />
        <p className="sleep-note muted">Sound fades out over the last 30 seconds.</p>
        <button className="option option-action" onClick={() => { const next = { ...sw.current, enabled: !swOn }; sw.current = next; setStillWatchingPrefs(next); setSwOn(next.enabled); }}>
          <span className="option-check">{swOn && <Icon name="check" size={16} />}</span>
          <span className="option-label">Ask "Are you still watching?"<small className="muted"> after {sw.current.afterItems} titles or {Math.round(sw.current.afterMinutes / 60)} h without input</small></span>
        </button>
      </Popover>
    </div>
  );

  let overlay: ReactNode = null;
  if (stopped) {
    overlay = <div className="marathon-card marathon-stopped" role="status"><Icon name="clock" size={20} /> {stopped}</div>;
  } else if (asking) {
    overlay = (
      <div className="still-watching" role="dialog" aria-modal="true" aria-labelledby="sw-title">
        <div className="still-watching-box">
          <h2 id="sw-title">Are you still watching?</h2>
          <p className="muted">We'll pause in {asking.left} s so nothing streams all night.</p>
          <div className="row-gap">
            <button className="btn btn-primary btn-lg" autoFocus onClick={stillHere}><Icon name="play" size={18} /> Keep watching</button>
            <button className="btn btn-glass btn-lg" onClick={() => stop('Stopped. Your place is saved.')}>Stop</button>
          </div>
        </div>
      </div>
    );
  } else if (next && countdown != null) {
    overlay = (
      <div className="upnext marathon-card">
        <div className="upnext-art">
          <Img src={next.thumbUrl ?? next.backdropUrl ?? next.posterUrl} width={400} />
          <svg className="upnext-ring" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="17" />
            <circle cx="20" cy="20" r="17" className="ring-fill" style={{ strokeDashoffset: `${(countdown / COUNTDOWN_S) * 107}` }} />
          </svg>
        </div>
        <div className="upnext-body">
          <small><Icon name="shuffle" size={12} /> Random marathon · next in {countdown}s</small>
          <strong>{next.type === 'episode' ? next.grandparentTitle : next.title}</strong>
          {next.type === 'episode' && <span className="muted">S{next.parentIndex} · E{next.index} — {next.title}</span>}
          <div className="row-gap">
            <button className="btn btn-primary btn-sm" onClick={goNext} autoFocus><Icon name="play" size={14} /> Play now</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setCountdown(null); if (marathonId) void decideApi.endMarathon(marathonId).catch(() => undefined); }}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  const sleepBlocks = !!sleep && (sleep.choice.kind === 'end' || (sleep.choice.kind === 'items' && (sleep.itemsLeft ?? sleep.choice.count) <= 1));
  return { blockAutoplay: !!marathonId || sleepBlocks || !!stopped, overlay, sleepButton };
}
