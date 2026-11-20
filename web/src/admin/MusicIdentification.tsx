import { useEffect, useState } from 'react';
import type { MusicSettings, MusicSettingsResponse } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { Badge, Field, Skeleton, Spinner, Switch } from '../components/ui';
import { Icon } from '../components/Icon';
import { SecretInput } from './MetadataSettings';
import '../styles/music.css';

/**
 * Server settings → Metadata → Music identification: AcoustID key (write-only) + automatic identification of untagged
 * tracks, and which release types "Missing from your library" leaves out on artist pages.
 */
export function MusicIdentificationSettings() {
  const toast = useToast();
  const [resp, setResp] = useState<MusicSettingsResponse | null>(null);
  const [s, setS] = useState<MusicSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (r: MusicSettingsResponse) => {
    setResp(r);
    setS(r.settings);
    setDirty(false);
  };
  useEffect(() => {
    api.music.settings().then(apply).catch((e) => setError((e as Error).message));
  }, []);
  if (error) return <p className="muted small"><Icon name="alert" size={14} /> {error}</p>;
  if (!resp || !s) return <Skeleton h={200} />;

  const setA = (patch: Partial<MusicSettings['acoustid']>) => { setS({ ...s, acoustid: { ...s.acoustid, ...patch } }); setDirty(true); };
  const setH = (patch: Partial<MusicSettings['missingHide']>) => { setS({ ...s, missingHide: { ...s.missingHide, ...patch } }); setDirty(true); };
  const save = async () => {
    setSaving(true);
    try {
      apply(await api.music.saveSettings(s));
      toast.success('Music settings saved');
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };
  const runNow = async () => {
    try {
      await api.music.identifyUntagged();
      toast.success('Identifying untagged tracks in the background (Server settings → Tasks shows progress)');
    } catch (e) {
      toast.error(e);
    }
  };
  const fp = resp.fingerprinter;
  return (
    <div className="music-id-settings" id="music-identification">
      <h3 className="md-h">Music identification</h3>
      <p className="muted small">
        MusicBrainz ids in your files (tag them with <a href="https://picard.musicbrainz.org" target="_blank" rel="noopener noreferrer">MusicBrainz Picard</a>) are used directly.
        For untagged files, MediaMax can identify the music by its sound with <a href="https://acoustid.org" target="_blank" rel="noopener noreferrer">AcoustID</a>. Matches are saved in MediaMax only — files are never modified.
      </p>
      <div className="md-card">
        <div className="md-card-head">
          <strong>AcoustID</strong>
          <Badge tone={fp.available ? 'success' : 'warning'}>{fp.available ? fp.detail : 'No fingerprinter'}</Badge>
          {resp.untagged > 0 && <Badge tone="muted">{resp.untagged.toLocaleString()} untagged track{resp.untagged === 1 ? '' : 's'}</Badge>}
        </div>
        {!fp.available && <p className="muted small"><Icon name="info" size={14} /> {fp.detail}. The Docker image includes it.</p>}
        <Field label="Application API key" hint={<>Free: sign in at acoustid.org, then <a href="https://acoustid.org/new-application" target="_blank" rel="noopener noreferrer">register an application</a> and copy its API key. 3 lookups per second; only fingerprints and durations are sent.</>}>
          <SecretInput value={s.acoustid.apiKey} onChange={(v) => setA({ apiKey: v })} label="AcoustID API key" />
        </Field>
        <Switch checked={s.acoustid.autoIdentify} onChange={(v) => setA({ autoIdentify: v })} label="Identify untagged tracks automatically" hint="After each music scan and daily: tracks with no MusicBrainz id and no artist or title tag." />
        <Field label="Apply matches automatically from score" hint="0 = always ask (Fix match → Identify by sound). 0.9 or higher is a safe automatic threshold.">
          <input className="input" type="number" min={0} max={1} step={0.05} value={s.acoustid.autoApplyScore} onChange={(e) => setA({ autoApplyScore: Math.max(0, Math.min(1, Number(e.target.value) || 0)) })} />
        </Field>
        <button className="btn btn-sm" onClick={() => void runNow()} disabled={!fp.available || !s.acoustid.apiKey || dirty}><Icon name="audio" size={14} /> Identify untagged tracks now</button>
      </div>
      <div className="md-card">
        <div className="md-card-head"><strong>“Missing from your library” on artist pages</strong></div>
        <p className="muted small">Release groups from MusicBrainz that aren't in the library. Hide:</p>
        <div className="music-hide-grid">
          <Switch checked={s.missingHide.singles} onChange={(v) => setH({ singles: v })} label="Singles" />
          <Switch checked={s.missingHide.eps} onChange={(v) => setH({ eps: v })} label="EPs" />
          <Switch checked={s.missingHide.compilations} onChange={(v) => setH({ compilations: v })} label="Compilations" />
          <Switch checked={s.missingHide.live} onChange={(v) => setH({ live: v })} label="Live albums" />
          <Switch checked={s.missingHide.other} onChange={(v) => setH({ other: v })} label="Soundtracks, remixes, demos and other" />
        </div>
      </div>
      <div className="row-gap">
        <button className="btn btn-primary" onClick={() => void save()} disabled={!dirty || saving}>{saving ? <Spinner size={16} /> : <Icon name="check" size={16} />} Save music settings</button>
      </div>
    </div>
  );
}
