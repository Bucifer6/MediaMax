/**
 * Your DJ on Now Playing: the segment and the per-track reason, the DJ button ("Switch it up"), typed requests with
 * suggestion chips, commentary (Off / Intros / Full) and the play rules in use.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMusic } from './music';
import { reasonLabel, segmentKindLabel, segmentOf } from './yourDj';
import { yourDjCommentary, type YourDjCommentary } from './djTypes';
import { rulesSummary } from './djRules';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { Icon } from '../components/Icon';
import { Segmented, Spinner } from '../components/ui';
import { openPlayRules, useDjPrefsSave, useRulePresets } from '../components/PlayRules';
import { VoiceBars } from './HostCaptions';
import '../styles/yourdj.css';

/** The Your DJ mark: a disc with a spark, in a ring that carries the brand gradient. */
export function DjMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className="yd-mark">
      <circle cx="16" cy="16" r="11.5" stroke="currentColor" strokeWidth="2.2" opacity="0.9" />
      <circle cx="16" cy="16" r="3.2" fill="currentColor" />
      <path d="M24.5 3.5l1.1 2.6 2.6 1.1-2.6 1.1-1.1 2.6-1.1-2.6-2.6-1.1 2.6-1.1z" fill="currentColor" />
    </svg>
  );
}

/** The prominent DJ button: one tap switches to a different segment. */
export function DjButton({ size = 'md', withLabel = false }: { size?: 'md' | 'lg'; withLabel?: boolean }) {
  const m = useMusic();
  const busy = m.yourDj?.busy === 'switch' || m.yourDj?.busy === 'request';
  return (
    <button
      type="button"
      className={`yd-button yd-button-${size} ${busy ? 'busy' : ''} ${withLabel ? 'with-label' : ''}`}
      onClick={() => void m.djSwitch()}
      disabled={!m.yourDj || busy}
      aria-label="Switch it up: Your DJ plays something different"
      title="Switch it up"
    >
      <span className="yd-ring" aria-hidden="true" />
      <span className="yd-core">{busy ? <Spinner size={size === 'lg' ? 22 : 18} /> : <DjMark size={size === 'lg' ? 28 : 22} />}</span>
      {withLabel && <span className="yd-button-label">Switch it up</span>}
    </button>
  );
}

/** "Throwback · big for you in 2019" for the current track (null when the DJ didn't pick it). */
export function useReasonLabel(): string | null {
  const m = useMusic();
  return reasonLabel(m.yourDj, m.current?.id);
}

/** Under the artwork: the segment, why this song, the DJ button and a like. */
export function YourDjStrip() {
  const m = useMusic();
  const seg = segmentOf(m.yourDj, m.current?.id) ?? (m.yourDj ? m.yourDj.segments[m.yourDj.segmentId] ?? null : null);
  const reason = useReasonLabel();
  const [loved, setLoved] = useState<string | null>(null);
  if (!m.yourDj || !seg) return null;
  const t = m.current;
  const isLoved = !!t && (loved === t.id || !!t.userData?.favorite);
  return (
    <section className="yd-strip" aria-label="Your DJ">
      <div className="yd-strip-text">
        <span className="yd-eyebrow"><DjMark size={14} /> Your DJ · {segmentKindLabel(seg.kind)}</span>
        <h2 className="yd-segment">{seg.title}</h2>
        {m.host.caption ? (
          // The DJ talking: its words right here, next to its button (captions).
          <p className="yd-says" role="status" aria-live="polite">
            <VoiceBars live={m.host.speaking} />
            <span>{m.host.caption}</span>
            {m.host.speaking && <button type="button" className="btn btn-xs yd-skip" onClick={m.host.skip}>Skip talk</button>}
          </p>
        ) : reason && <p className="yd-reason">{reason}</p>}
      </div>
      <div className="yd-strip-actions">
        {t && (
          <button type="button" className={`btn-icon yd-love ${isLoved ? 'active' : ''}`} aria-pressed={isLoved} aria-label={isLoved ? 'Liked' : 'Like this song'} title="More like this"
            onClick={() => {
              if (isLoved) return;
              setLoved(t.id);
              m.djLove(t);
            }}>
            <Icon name={isLoved ? 'heartFill' : 'heart'} size={22} />
          </button>
        )}
        <DjButton size="lg" withLabel />
      </div>
    </section>
  );
}

const COMMENTARY: { value: YourDjCommentary; label: string; title: string }[] = [
  { value: 'off', label: 'Off', title: 'No talking (captions only when you switch)' },
  { value: 'intros', label: 'Intros', title: 'Only when a new segment starts' },
  { value: 'full', label: 'Full', title: 'Intros, plus a few words between songs' },
];

/** Suggestion chips (from history and the time of day); cached for the session. */
let chipCache: { at: number; chips: string[] } | null = null;
function useSuggestions(enabled: boolean) {
  const [chips, setChips] = useState<string[]>(chipCache?.chips ?? []);
  useEffect(() => {
    if (!enabled) return;
    if (chipCache && Date.now() - chipCache.at < 10 * 60_000) return;
    let off = false;
    api.dj.suggestions()
      .then((r) => {
        const c = (r.chips ?? []).filter(Boolean).slice(0, 3);
        chipCache = { at: Date.now(), chips: c };
        if (!off) setChips(c);
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [enabled]);
  return chips;
}

/** Side panel (desktop) / tab (phones): requests, commentary and play rules. */
export function YourDjPanel() {
  const m = useMusic();
  const { user } = useApp();
  const save = useDjPrefsSave();
  const { prefs, setPrefs, active } = useRulePresets();
  const commentary = yourDjCommentary(user?.preferences);
  const chips = useSuggestions(!!m.yourDj);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const dj = m.yourDj;
  if (!dj) return null;
  const seg = segmentOf(dj, m.current?.id) ?? dj.segments[dj.segmentId];
  const busy = dj.busy === 'request';
  const submit = (e?: FormEvent, value = text) => {
    e?.preventDefault();
    const q = value.trim();
    if (!q || dj.busy) return;
    void m.djRequest(q);
    setText('');
  };
  return (
    <div className="yd-panel">
      <div className="np-panel-head">
        <h2>Your DJ</h2>
        {seg && <span className="np-panel-sub">{seg.title}</span>}
      </div>
      <div className="np-panel-scroll yd-panel-body">
        <form className="yd-request" onSubmit={submit} role="search" aria-label="Ask Your DJ">
          <Icon name="sparkles" size={16} className="yd-request-icon" />
          <input
            ref={input}
            className="yd-request-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ask for something… “90s hip hop”, “something calmer”"
            aria-label="Request"
            disabled={busy}
            enterKeyHint="go"
          />
          <button type="submit" className="btn-icon btn-icon-sm yd-request-go" disabled={!text.trim() || busy} aria-label="Ask">
            {busy ? <Spinner size={16} /> : <Icon name="chevronRight" size={18} />}
          </button>
        </form>
        {chips.length > 0 && (
          <div className="yd-chips" role="group" aria-label="Suggestions">
            {chips.map((c) => (
              <button key={c} type="button" className="chip chip-sm yd-chip" disabled={!!dj.busy} onClick={() => submit(undefined, c)}>{c}</button>
            ))}
          </div>
        )}
        {dj.message && (
          <p className="yd-message" role="status">
            <span>{dj.message}</span>
            <button type="button" className="btn-icon btn-icon-sm" onClick={m.djDismiss} aria-label="Dismiss"><Icon name="x" size={14} /></button>
          </p>
        )}

        <div className="yd-setting">
          <span className="yd-setting-label">DJ commentary</span>
          <Segmented label="DJ commentary" value={commentary} onChange={(v) => void save({ yourDj: { commentary: v } })} options={COMMENTARY} />
        </div>

        <div className="yd-setting">
          <span className="yd-setting-label">Play rules</span>
          <div className="yd-rules-row">
            <select
              className="select select-sm"
              value={prefs.activePresetId ?? ''}
              onChange={(e) => void setPrefs({ ...prefs, activePresetId: e.target.value || null })}
              aria-label="Play rules in use"
            >
              <option value="">Everything</option>
              {prefs.presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button type="button" className="btn btn-sm btn-ghost on-media" onClick={() => openPlayRules()}><Icon name="filter" size={14} /> Edit</button>
          </div>
          <small className="yd-setting-hint">{active ? rulesSummary(active.rules, 3) : 'Your whole library'}. Changes apply from the next song.</small>
        </div>

        <div className="yd-setting yd-setting-row">
          <span className="yd-setting-label">DJ voice</span>
          <button type="button" className={`btn btn-sm ${m.host.muted ? '' : 'btn-ghost'} on-media`} onClick={() => m.host.setMuted(!m.host.muted)} aria-pressed={m.host.muted}>
            <Icon name={m.host.muted ? 'mute' : 'volume'} size={14} /> {m.host.muted ? 'Muted on this device' : 'Mute'}
          </button>
        </div>
      </div>
    </div>
  );
}
