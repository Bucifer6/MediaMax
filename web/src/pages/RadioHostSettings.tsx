/**
 * Settings → Playback: the Radio Host (a presenter for anything you play) and Your DJ (commentary, play rules).
 */
import { useEffect, useRef, useState } from 'react';
import type { DjStatus } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { Field, Segmented, Switch } from '../components/ui';
import { Icon } from '../components/Icon';
import { EnforcedChips, openPlayRules, useDjPrefsSave, useRulePresets } from '../components/PlayRules';
import { createHostVoice, deviceVoices, type HostVoice } from '../player/radioHost';
import { DEVICE_VOICE, radioHostPrefs, yourDjCommentary, type HostChattiness, type RadioHostCategories, type DjRules, type YourDjCommentary } from '../player/djTypes';
import { rulesSummary } from '../player/djRules';
import { useMusic } from '../player/music';
import '../styles/yourdj.css';

const LEVELS: { value: HostChattiness; label: string; title: string }[] = [
  { value: 'off', label: 'Off', title: 'No host' },
  { value: 'intros', label: 'Just intros', title: 'A few words about the next song, now and then' },
  { value: 'light', label: 'Light', title: 'Intros, plus the occasional fact, time or weather' },
  { value: 'chatty', label: 'Chatty', title: 'More often, with a short break every so often' },
];
const CATEGORIES: { key: keyof RadioHostCategories; label: string; hint: string }[] = [
  { key: 'announce', label: 'Song announcements', hint: '“That was… up next…” around the songs.' },
  { key: 'facts', label: 'Music facts', hint: 'From your library’s own details (and online facts, if your admin allows them).' },
  { key: 'jokes', label: 'Jokes', hint: 'A light one now and then, never twice in a row.' },
  { key: 'weather', label: 'Weather', hint: 'Needs a location set by your admin.' },
  { key: 'time', label: 'Time checks', hint: 'Near the top and bottom of the hour.' },
  { key: 'stats', label: 'Your listening stats', hint: '“Your most played this month…” (Your DJ’s own picks don’t count).' },
];
const COMMENTARY: { value: YourDjCommentary; label: string }[] = [{ value: 'off', label: 'Off' }, { value: 'intros', label: 'Intros' }, { value: 'full', label: 'Full' }];

function useDjStatus() {
  const [s, setS] = useState<DjStatus | null>(null);
  useEffect(() => {
    api.dj.status().then(setS).catch(() => setS(null));
  }, []);
  return s;
}

/** Device voices load asynchronously in most browsers. */
function useDeviceVoices() {
  const [list, setList] = useState(deviceVoices);
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const up = () => setList(deviceVoices());
    window.speechSynthesis.addEventListener?.('voiceschanged', up);
    up();
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', up);
  }, []);
  return list;
}

export function RadioHostSettings() {
  const { user } = useApp();
  const save = useDjPrefsSave();
  const status = useDjStatus();
  const m = useMusic();
  const host = radioHostPrefs(user?.preferences);
  const voices = useDeviceVoices();
  const on = host.chattiness !== 'off';
  const serverVoice = !!status?.ai?.serverVoice;
  const sample = useRef<HostVoice | null>(null);
  const [playing, setPlaying] = useState(false);
  const set = (patch: Partial<typeof host>) => {
    const next = { ...host, ...patch };
    void save({ radioHost: { ...next, enabled: next.chattiness !== 'off' } });
  };
  const hear = async () => {
    sample.current?.stop();
    if (playing) return setPlaying(false);
    const ctl = new AbortController();
    const text = `Hi${user?.displayName ? `, ${user.displayName.split(' ')[0]}` : ''}. This is your Radio Host. I'll keep it short and only talk over the intros.`;
    const v = await createHostVoice({ id: 'sample', kind: 'frontsell', text, placement: 'gap', maxMs: 8000, audioUrl: null, durationMs: null }, host.voice === null || host.voice === undefined ? DEVICE_VOICE : host.voice, ctl.signal);
    if (!v) return;
    sample.current = v;
    setPlaying(true);
    void v.play(0.9).catch(() => {}).finally(() => setPlaying(false));
  };
  useEffect(() => () => sample.current?.stop(), []);
  return (
    <div className="settings-card host-settings" id="radio-host">
      <h2><Icon name="antenna" size={20} /> Radio Host</h2>
      <p className="muted">Like listening to the radio, without the commercials: a host who introduces songs, shares a fact, the time or the weather now and then. Works with anything you play: albums, playlists, mixes and Endless. Talks over song intros with the music turned down, never over the vocals.</p>
      <Segmented label="Radio Host" value={host.chattiness} onChange={(v) => set({ chattiness: v })} options={LEVELS} className="host-levels" />
      <div className={`switch-group host-cats ${on ? '' : 'is-off'}`} aria-disabled={!on}>
        {CATEGORIES.map((c) => (
          <Switch key={c.key} checked={host.categories[c.key]} disabled={!on || (c.key === 'weather' && status?.ai?.weather === false)} onChange={(v) => set({ categories: { ...host.categories, [c.key]: v } })} label={c.label}
            hint={c.key === 'weather' && status?.ai?.weather === false ? 'Your admin hasn’t set a weather location.' : c.hint} />
        ))}
      </div>
      <div className="form-row">
        <Field label="Voice" hint={serverVoice ? `Automatic uses ${status?.ai?.hostName || 'the server'}’s voice and falls back to this device’s.` : 'Your server has no voice set up, so this device’s own voice speaks.'}>
          <span className="host-voice-row">
            <select className="select" value={host.voice ?? ''} onChange={(e) => set({ voice: e.target.value || null })} disabled={!on && !m.yourDj}>
              <option value="">{serverVoice ? 'Automatic (server voice)' : 'Automatic (this device)'}</option>
              <option value={DEVICE_VOICE}>This device’s voice</option>
              {voices.length > 0 && (
                <optgroup label="Device voices">
                  {voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </optgroup>
              )}
            </select>
            <button type="button" className="btn btn-sm" onClick={() => void hear()} disabled={!voices.length && !('speechSynthesis' in window)}>
              <Icon name={playing ? 'stop' : 'play'} size={14} /> {playing ? 'Stop' : 'Hear it'}
            </button>
          </span>
        </Field>
      </div>
      <Switch checked={m.host.muted} onChange={(v) => m.host.setMuted(v)} label="Mute the host on this device" hint="Keeps your choice above for your other devices." />
    </div>
  );
}

export function YourDjSettings() {
  const { user } = useApp();
  const save = useDjPrefsSave();
  const { active, prefs } = useRulePresets();
  const commentary = yourDjCommentary(user?.preferences);
  const [enforced, setEnforced] = useState<DjRules>({});
  useEffect(() => {
    api.dj.rules().then((r) => setEnforced(r.enforced ?? {})).catch(() => setEnforced({}));
  }, []);
  return (
    <div className="settings-card" id="your-dj">
      <h2><Icon name="sparkles" size={20} /> Your DJ</h2>
      <p className="muted">One tap on Home for a set picked from your own library, in themed segments with a reason for every song. “Switch it up” changes direction; you can also ask for something.</p>
      <div className="form-row">
        <Field label="DJ commentary" hint={commentary === 'off' ? 'No talking; a caption when you switch.' : commentary === 'intros' ? 'A few words when a new segment starts.' : 'Intros, plus a little between songs.'}>
          <Segmented label="DJ commentary" value={commentary} onChange={(v) => void save({ yourDj: { commentary: v } })} options={COMMENTARY} />
        </Field>
      </div>
      <div className="rules-settings-row">
        <div>
          <strong>Play rules</strong>
          <p className="muted small">{active ? `${active.name}: ${rulesSummary(active.rules, 3)}` : 'Everything in your music library.'} {prefs.presets.length ? `${prefs.presets.length} preset${prefs.presets.length > 1 ? 's' : ''} saved.` : ''} Used by Your DJ, Mix and Endless.</p>
        </div>
        <button type="button" className="btn" onClick={() => openPlayRules()}><Icon name="filter" size={15} /> Play rules</button>
      </div>
      <EnforcedChips rules={enforced} />
    </div>
  );
}
