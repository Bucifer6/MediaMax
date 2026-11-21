import { useEffect, useState } from 'react';
import type { SubtitleProviderInfo, SubtitleSettings, SubtitleToolsReport } from '@mediamax/shared';
import { http } from '../api/client';
import { Badge, Field, Spinner, Switch } from '../components/ui';
import { Icon } from '../components/Icon';

export const SUBTITLE_DEFAULTS: SubtitleSettings = {
  providers: [{ id: 'opensubtitles', enabled: true }, { id: 'subsro', enabled: true }],
  subsRo: { apiKey: null, baseUrl: 'https://api.subs.ro/v1.0' },
  languages: [],
  sync: false,
  minScore: 0,
  saveMode: 'data',
};

/** "ro, en ,fr" → ["ro","en","fr"] */
function parseLanguages(text: string): string[] {
  return Array.from(new Set(text.split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)));
}

/** Detected external tools, shown like the hardware detection: found (with path) or missing (with what it enables). */
function ToolsStatus() {
  const [tools, setTools] = useState<SubtitleToolsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (refresh = false) => {
    setBusy(true);
    http.get<SubtitleToolsReport>('/admin/subtitles/tools', refresh ? { refresh: '1' } : {}).then(setTools).catch(() => setTools(null)).finally(() => setBusy(false));
  };
  useEffect(() => load(), []);
  const rows: { key: keyof SubtitleToolsReport; name: string; what: string }[] = [
    { key: 'alass', name: 'alass', what: 'Re-times downloaded subtitles to the video' },
    { key: 'unrar', name: 'unrar', what: 'Opens RAR subtitle archives' },
    { key: 'sevenZip', name: '7-Zip (7z)', what: 'Opens RAR and 7z archives' },
  ];
  return (
    <section className="hwd">
      <div className="hwd-bar">
        <div>
          <strong>Subtitle tools</strong>
          <div className="muted hwd-sub">Optional programs found on the server’s PATH. ZIP archives always work.</div>
        </div>
        <button type="button" className="btn" onClick={() => load(true)} disabled={busy}>
          {busy ? <Spinner size={16} /> : <Icon name="refresh" size={16} />} Check again
        </button>
      </div>
      <ul className="subtools-list">
        {rows.map((r) => {
          const found = tools?.[r.key] ?? null;
          return (
            <li key={r.key}>
              <Icon name={found ? 'checkCircle' : 'x'} size={16} />
              <span><strong>{r.name}</strong> <span className="muted">— {r.what}</span></span>
              {tools == null ? <Badge tone="muted">Unknown</Badge> : found ? <Badge tone="success"><span title={found}>Found</span></Badge> : <Badge tone="muted">Not found</Badge>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Server settings → Subtitles: providers (order + enable), Subs.ro, languages, matching, sync and storage. */
export function SubtitleSettingsPanel({ value, onChange }: { value: SubtitleSettings | undefined; onChange: (v: SubtitleSettings) => void }) {
  const v: SubtitleSettings = { ...SUBTITLE_DEFAULTS, ...(value ?? {}), subsRo: { ...SUBTITLE_DEFAULTS.subsRo, ...(value?.subsRo ?? {}) } };
  const set = (p: Partial<SubtitleSettings>) => onChange({ ...v, ...p });
  const [infos, setInfos] = useState<SubtitleProviderInfo[] | null>(null);
  const [langText, setLangText] = useState<string | null>(null);
  useEffect(() => {
    http.get<SubtitleProviderInfo[]>('/admin/subtitles/providers').then(setInfos).catch(() => setInfos(null));
  }, []);

  // Rows in the configured order, then any provider the server knows that isn't listed yet (new plugins).
  const ordered = [...v.providers];
  for (const i of infos ?? []) if (!ordered.some((o) => o.id === i.id)) ordered.push({ id: i.id, enabled: true });
  const info = (id: string) => infos?.find((i) => i.id === id);
  const label = (id: string) => info(id)?.name ?? (id === 'opensubtitles' ? 'OpenSubtitles' : id === 'subsro' ? 'Subs.ro' : id);
  const move = (i: number, d: -1 | 1) => {
    const next = [...ordered];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    set({ providers: next });
  };
  const toggle = (id: string, enabled: boolean) => set({ providers: ordered.map((p) => (p.id === id ? { ...p, enabled } : p)) });

  return (
    <div className="form-grid">
      <h3 className="section-title">Providers</h3>
      <p className="muted">Searches ask every enabled provider at once; results are ranked by how well their release matches your file, and the order below breaks ties.</p>
      <ul className="subproviders-list">
        {ordered.map((p, i) => {
          const inf = info(p.id);
          return (
            <li key={p.id} className="subproviders-row">
              <span className="subproviders-order">
                <button type="button" className="btn-icon" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${label(p.id)} up`}><Icon name="chevronUp" size={16} /></button>
                <button type="button" className="btn-icon" onClick={() => move(i, 1)} disabled={i === ordered.length - 1} aria-label={`Move ${label(p.id)} down`}><Icon name="chevronDown" size={16} /></button>
              </span>
              <span className="subproviders-name">
                <strong>{label(p.id)}</strong>
                {inf && !inf.builtin && <Badge tone="muted">Plugin</Badge>}
                {inf && !inf.configured && <Badge tone="warning">Needs API key</Badge>}
                {!inf && infos && <Badge tone="muted">Not installed</Badge>}
              </span>
              <Switch checked={p.enabled} onChange={(on) => toggle(p.id, on)} label={<span className="sr-only">Enable {label(p.id)}</span>} />
            </li>
          );
        })}
      </ul>

      <h3 className="section-title">Subs.ro</h3>
      <p className="muted">Romanian subtitles. Ask Subs.ro for an API key and paste it here; downloads arrive as ZIP (sometimes RAR) archives and are unpacked automatically.</p>
      <div className="form-row">
        <Field label="API key">
          <input className="input mono" type="password" value={v.subsRo.apiKey ?? ''} onChange={(e) => set({ subsRo: { ...v.subsRo, apiKey: e.target.value.trim() || null } })} autoComplete="new-password" spellCheck={false} />
        </Field>
        <Field label="API address" hint="Change only if Subs.ro moves its API.">
          <input className="input mono" value={v.subsRo.baseUrl} onChange={(e) => set({ subsRo: { ...v.subsRo, baseUrl: e.target.value } })} spellCheck={false} />
        </Field>
      </div>

      <h3 className="section-title">Automatic downloads</h3>
      <Field label="Languages" hint="Two-letter codes in order of preference, comma separated (e.g. ro, en). The “Download missing subtitles” task fetches each missing one for new media. Leave empty to turn off.">
        <input
          className="input"
          value={langText ?? v.languages.join(', ')}
          onChange={(e) => { setLangText(e.target.value); set({ languages: parseLanguages(e.target.value) }); }}
          onBlur={() => setLangText(null)}
          placeholder="ro, en"
          spellCheck={false}
        />
      </Field>
      <Field label={`Minimum match score: ${v.minScore}`} hint="0 takes the best result whatever it is. 30 needs at least the same source (WEB-DL, BluRay…); 70 needs the same release group and source. File-hash matches score 100.">
        <input type="range" min={0} max={100} step={5} value={v.minScore} onChange={(e) => set({ minScore: Number(e.target.value) })} />
      </Field>

      <h3 className="section-title">After download</h3>
      <p className="muted">Every subtitle is converted to UTF-8 (Windows-1250, ISO-8859-2 and ISO-8859-16 are detected), Romanian ş/ţ are fixed to ș/ț, garbled “º/þ” text is repaired, and subtitle-site adverts are removed.</p>
      <Switch checked={v.sync} onChange={(sync) => set({ sync })} label="Sync downloaded subtitles" hint="Re-time each download against the video with alass (needs alass on the server, see below). The original is kept if syncing fails." />
      <Field label="Save to">
        <select className="input" value={v.saveMode} onChange={(e) => set({ saveMode: e.target.value === 'sidecar' ? 'sidecar' : 'data' })}>
          <option value="data">Kinora’s data folder (works with read-only libraries)</option>
          <option value="sidecar">Next to the video, e.g. Movie.ro.srt (falls back to the data folder if read-only)</option>
        </select>
      </Field>
      <ToolsStatus />
    </div>
  );
}
