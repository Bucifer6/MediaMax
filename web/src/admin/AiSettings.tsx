import { useCallback, useEffect, useState } from 'react';
import type { AiHealthResponse, AiLlmProvider, AiSettings, AiStatus, AiTtsProvider, AutoSubtitleJob, AutoSubtitleSettings, AutoSubtitleStatus, WhisperModelSize } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { aiApi, type WhisperModels } from '../api/ai';
import { useToast } from '../state/toast';
import { Badge, Field, PageLoader, ProgressBar, Spinner, Switch } from '../components/ui';
import { Icon } from '../components/Icon';
import { formatBytes, formatDateTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';
import { LLM_PRESETS, ProviderChainEditor, TTS_PRESETS, llmFromPreset, ttsFromPreset } from './AiDjSettings';
import '../styles/ai-chain.css';

const AI_DEFAULTS: AiSettings = {
  llm: { provider: 'none', url: null, model: null, apiKey: null, maxRequestsPerDay: 300 },
  features: { dj: true, ask: true, recaps: true, autoSubtitles: false },
  autoSubtitles: { engine: 'whisper-cpp', whisperPath: null, model: 'base', modelPath: null, threads: 0, apiUrl: null, apiModel: null, apiKey: null, languages: [], windowStart: '01:00', windowEnd: '07:00', translate: true, libraryIds: [] },
  ask: { embeddings: false, embeddingSource: 'local', embeddingModel: null },
  recaps: { minGapDays: 7, maxEpisodes: 3 },
  llmProviders: [],
  ttsProviders: [],
  weatherLocation: null,
  onlineFacts: false,
  djTrackCooldownDays: 7,
};

function FallbackLog({ health }: { health: AiHealthResponse | null }) {
  const name = (id: string) => (id === 'builtin' ? 'built-in' : health?.providers.find((p) => p.id === id)?.name ?? id);
  if (!health?.events.length) return <p className="muted">No fallbacks yet. When a provider fails or runs out of quota, the switch to the next one is listed here (listeners never see it).</p>;
  return (
    <div className="table-wrap">
      <table className="table ai-fallback-log">
        <thead><tr><th>Time</th><th>Feature</th><th>From → to</th><th>Reason</th></tr></thead>
        <tbody>
          {health.events.slice(0, 50).map((e, i) => (
            <tr key={`${e.at}-${i}`}>
              <td>{formatDateTime(e.at)}</td>
              <td>{e.feature}</td>
              <td>{name(e.from)} → {name(e.to)}</td>
              <td className="muted">{e.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const eta = (s: number | null) => (s == null ? '' : s < 90 ? `~${Math.max(1, Math.round(s))} s left` : s < 5400 ? `~${Math.round(s / 60)} min left` : `~${(s / 3600).toFixed(1)} h left`);
const langList = (t: string) => Array.from(new Set(t.split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)));

function JobRow({ j, onRemove }: { j: AutoSubtitleJob; onRemove?: () => void }) {
  const tone = j.status === 'done' ? 'success' : j.status === 'error' ? 'danger' : j.status === 'skipped' ? 'warning' : j.status === 'running' ? 'primary' : 'muted';
  return (
    <li className="ai-job">
      <div className="ai-job-main">
        <strong>{j.title}</strong>
        <span className="muted">
          {j.language.toUpperCase()}
          {j.spokenLanguage && j.spokenLanguage !== j.language ? ` · from ${j.spokenLanguage.toUpperCase()}${j.translated ? ' (translated)' : ''}` : ''}
          {j.cues ? ` · ${j.cues} lines` : ''}
          {j.finishedAt ? ` · ${formatDateTime(j.finishedAt)}` : ''}
        </span>
        {j.status === 'running' && (
          <>
            <ProgressBar value={j.progress} />
            <span className="muted">{j.phase} {eta(j.etaSeconds)}</span>
          </>
        )}
        {j.status === 'queued' && j.progress > 0 && <span className="muted">{j.progress}% done · {j.phase ?? 'waiting'}</span>}
        {j.error && <span className={j.status === 'error' ? 'form-error' : 'muted'}>{j.error}</span>}
      </div>
      <Badge tone={tone}>{j.status}</Badge>
      {onRemove && <button className="btn-icon" onClick={onRemove} aria-label="Remove from the list"><Icon name="x" size={16} /></button>}
    </li>
  );
}

function SubtitleQueue({ status, reload }: { status: AutoSubtitleStatus; reload: () => void }) {
  const toast = useToast();
  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      if (msg) toast.success(msg);
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="ai-queue">
      <div className="row-gap">
        <Badge tone={status.inWindow ? 'success' : 'muted'}>{status.inWindow ? 'Inside the night window' : 'Outside the night window'}</Badge>
        <button className="btn btn-sm" onClick={() => void act(aiApi.runSubtitles, 'Started — one title at a time')} disabled={!status.enabled || !status.engine.ready || !!status.running}><Icon name="play" size={14} /> Run now</button>
        {status.running && <button className="btn btn-sm" onClick={() => void act(aiApi.stopSubtitles, 'Stopping after the current step; it resumes later')}><Icon name="stop" size={14} /> Stop</button>}
        {status.recent.length > 0 && <button className="btn btn-sm" onClick={() => void act(() => aiApi.clearJobs('all'))}><Icon name="trash" size={14} /> Clear failed & skipped</button>}
      </div>
      {status.running && <ul className="ai-jobs"><JobRow j={status.running} /></ul>}
      <h4>Queue <span className="muted">{status.queued.length}</span></h4>
      {status.queued.length ? (
        <ul className="ai-jobs">{status.queued.slice(0, 20).map((j) => <JobRow key={j.id} j={j} onRemove={() => void act(() => aiApi.removeJob(j.id))} />)}</ul>
      ) : <p className="muted">Nothing waiting. The task queues titles that still lack your languages after the download task.</p>}
      <h4>Done recently</h4>
      {status.recent.length ? <ul className="ai-jobs">{status.recent.slice(0, 30).map((j) => <JobRow key={j.id} j={j} />)}</ul> : <p className="muted">No generated subtitles yet.</p>}
    </div>
  );
}

export function AiSettingsAdmin() {
  const toast = useToast();
  const [ai, setAi] = useState<AiSettings | null>(null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [subs, setSubs] = useState<(AutoSubtitleStatus & { models: WhisperModels }) | null>(null);
  const [langText, setLangText] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [health, setHealth] = useState<AiHealthResponse | null>(null);
  const [saved, setSaved] = useState<{ llm: Set<string>; tts: Set<string> }>({ llm: new Set(), tts: new Set() });
  const loaded = (x: AiSettings) => {
    setAi({ ...AI_DEFAULTS, ...x });
    setSaved({ llm: new Set((x.llmProviders ?? []).map((p) => p.id)), tts: new Set((x.ttsProviders ?? []).map((p) => p.id)) });
  };

  const reload = useCallback(() => {
    aiApi.status().then(setStatus).catch(() => {});
    aiApi.subtitles().then(setSubs).catch(() => {});
    aiApi.health().then(setHealth).catch(() => {});
  }, []);
  useEffect(() => {
    api.admin.settings().then((s) => loaded(s.ai ?? AI_DEFAULTS)).catch((e) => toast.error(e));
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Live progress while a job or a download runs.
  useEffect(() => {
    const busyNow = !!subs?.running || subs?.download.state === 'downloading';
    const t = setInterval(reload, busyNow ? 3000 : 20000);
    return () => clearInterval(t);
  }, [subs?.running, subs?.download.state, reload]);

  if (!ai) return <PageLoader />;
  const set = (p: Partial<AiSettings>) => setAi({ ...ai, ...p });
  const setLlm = (p: Partial<AiSettings['llm']>) => set({ llm: { ...ai.llm, ...p } });
  const loc = ai.weatherLocation ?? null;
  const setSub = (p: Partial<AutoSubtitleSettings>) => set({ autoSubtitles: { ...ai.autoSubtitles, ...p } });
  const a = ai.autoSubtitles;

  const save = async () => {
    setBusy('save');
    try {
      const s = await api.admin.saveSettingsPatch({ ai });
      loaded(s.ai ?? AI_DEFAULTS);
      toast.success('AI settings saved');
      reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const run = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(msg);
      reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const tag = (t: string) => <span className={`ai-tag ai-tag-${t.replace(' ', '-')}`}>{t}</span>;
  const dl = subs?.download;

  return (
    <div className="ai-admin">
      <AdminHeader title="AI" help="admin-ai" subtitle="One language model for the AI DJ, Ask, recaps and subtitle translation. Everything works without one; a model makes it smarter."
        actions={<button className="btn btn-primary" onClick={() => void save()} disabled={busy === 'save'}>{busy === 'save' ? <Spinner size={16} /> : 'Save'}</button>} />

      <section className="settings-card">
        <h2><Icon name="sparkles" size={18} /> Language models</h2>
        <p className="muted">
          An ordered fallback chain: each request tries the first enabled model; if it fails, times out or runs out of quota it rests for a while
          (1 → 5 → 15 → 60 min, or what the service asks) and the next one answers. After the last one every feature uses its built-in rules and templates.
          Nothing is ever shown to listeners; the switches are logged below.
        </p>
        <ProviderChainEditor<AiLlmProvider> kind="llm" list={ai.llmProviders ?? []} onChange={(llmProviders) => set({ llmProviders })} health={health?.providers ?? []} savedIds={saved.llm}
          presets={LLM_PRESETS.map((p) => ({ id: p.id, label: p.label, group: p.group, note: p.note, make: () => llmFromPreset(p) }))} />
        <div className="form-row">
          <Field label="Daily limit (model calls, all features and providers)" hint={`Keeps free tiers free; over it every feature uses its built-in fallback. 0 = no limit.${status ? ` Today: ${status.usage.used}${status.usage.max ? `/${status.usage.max}` : ''}.` : ''}`}>
            <input className="input" type="number" min={0} value={ai.llm.maxRequestsPerDay} onChange={(e) => setLlm({ maxRequestsPerDay: Math.max(0, Number(e.target.value) || 0) })} />
          </Field>
        </div>
        {(ai.llmProviders ?? []).some((p) => p.enabled && !/localhost|127\.0\.0\.1|^http:\/\/(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(p.url)) && (
          <p className="field-hint">A hosted service receives: DJ requests and host talking points with song titles, Ask queries, the summaries of episodes being recapped, and subtitle lines being translated. Nothing else from your library.</p>
        )}
      </section>

      <section className="settings-card">
        <h2><Icon name="volume" size={18} /> Voices (text to speech)</h2>
        <p className="muted">Used by the DJ and the Radio Host, in order, with the same quiet fallback. After the last voice each device speaks with its own built-in voice. Clips are cached on the server.</p>
        <ProviderChainEditor<AiTtsProvider> kind="tts" list={ai.ttsProviders ?? []} onChange={(ttsProviders) => set({ ttsProviders })} health={health?.providers ?? []} savedIds={saved.tts}
          presets={TTS_PRESETS.map((p) => ({ id: p.id, label: p.label, group: p.group, note: p.note, make: () => ttsFromPreset(p) }))} />
      </section>

      <section className="settings-card">
        <h2><Icon name="activity" size={18} /> Provider fallback log</h2>
        <FallbackLog health={health} />
      </section>

      <section className="settings-card">
        <h2><Icon name="music" size={18} /> Radio host & Your DJ</h2>
        <p className="muted">Both are off by default and make no outside requests unless you turn them on here.</p>
        <div className="form-row">
          <Field label="Weather location (name)" hint="For the host's weather slot. Empty = no weather.">
            <input className="input" value={loc?.name ?? ''} placeholder="e.g. Bucharest" onChange={(e) => set({ weatherLocation: e.target.value || loc ? { name: e.target.value, lat: loc?.lat ?? 0, lon: loc?.lon ?? 0 } : null })} />
          </Field>
          <Field label="Latitude"><input className="input" type="number" step="0.01" min={-90} max={90} value={loc?.lat ?? ''} disabled={!loc} onChange={(e) => loc && set({ weatherLocation: { ...loc, lat: Number(e.target.value) } })} /></Field>
          <Field label="Longitude"><input className="input" type="number" step="0.01" min={-180} max={180} value={loc?.lon ?? ''} disabled={!loc} onChange={(e) => loc && set({ weatherLocation: { ...loc, lon: Number(e.target.value) } })} /></Field>
          {loc && <div className="ai-chain-keyrm"><button className="btn btn-sm btn-ghost" onClick={() => set({ weatherLocation: null })}><Icon name="x" size={14} /> No weather</button></div>}
        </div>
        <p className="field-hint">
          Weather comes from <a href="https://open-meteo.com" target="_blank" rel="noreferrer">Open-Meteo</a> (no key; data under CC BY 4.0, free for non-commercial use), at most twice an hour, rounded to about 1 km.
        </p>
        <Switch checked={!!ai.onlineFacts} onChange={(v) => set({ onlineFacts: v })} label="Online music facts (MusicBrainz, Wikidata)"
          hint="Artist origins, start years and short descriptions for the host. Looked up by artist name at most once a second, cached for 30 days; no personal data is sent. Off: only facts from your own library." />
        <div className="form-row">
          <Field label="Your DJ: replay a track it played after" hint="Anti-repeat cooldown for tracks Your DJ chose (small libraries relax it automatically).">
            <select className="input" value={ai.djTrackCooldownDays ?? 7} onChange={(e) => set({ djTrackCooldownDays: Number(e.target.value) })}>
              {[0, 1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d === 0 ? 'No cooldown' : `${d} day${d === 1 ? '' : 's'}`}</option>)}
            </select>
          </Field>
        </div>
      </section>

      <section className="settings-card">
        <h2><Icon name="zap" size={18} /> Features</h2>
        <div className="switch-group">
          <Switch checked={ai.features.ask} onChange={(v) => set({ features: { ...ai.features, ask: v } })} label="Ask (natural-language search)" hint="“Something funny under 90 minutes we haven't seen”, “comedii românești din anii 2000”. Works without a model." />
          <Switch checked={ai.features.recaps} onChange={(v) => set({ features: { ...ai.features, recaps: v } })} label="“Previously on…” recaps" hint="Spoiler-safe recap when someone returns to a series. Without a model it lists the last watched episodes." />
          <Switch checked={ai.features.autoSubtitles} onChange={(v) => set({ features: { ...ai.features, autoSubtitles: v } })} label="Automatic subtitles (speech-to-text)" hint="Last resort when no subtitle can be downloaded. Heavy on the CPU: runs at night only." />
          <Switch checked={ai.features.dj} onChange={(v) => set({ features: { ...ai.features, dj: v } })} label="Let the AI DJ use the model" hint="Off: the DJ keeps its built-in understanding and template lines." />
        </div>
      </section>

      <section className="settings-card">
        <h2><Icon name="subtitles" size={18} /> Automatic subtitles</h2>
        <p className="muted">
          Titles that still have no subtitle in your languages after the “Download missing subtitles” task get one generated from the dialogue,
          labelled <strong>Auto-generated (AI)</strong>. If the film speaks another language it is translated line by line by the language model
          (English needs no model: whisper translates to English itself).
        </p>
        <div className="ai-presets" role="radiogroup" aria-label="Speech-to-text engine">
          <button role="radio" aria-checked={a.engine === 'whisper-cpp'} className={`ai-preset ${a.engine === 'whisper-cpp' ? 'active' : ''}`} onClick={() => setSub({ engine: 'whisper-cpp' })}><strong>whisper.cpp on this server</strong> {tag('free')}</button>
          <button role="radio" aria-checked={a.engine === 'api'} className={`ai-preset ${a.engine === 'api' ? 'active' : ''}`} onClick={() => setSub({ engine: 'api' })}><strong>Speech-to-text API</strong> {tag('free')}</button>
        </div>
        {a.engine === 'whisper-cpp' ? (
          <>
            <div className="form-row">
              <Field label="Model" hint={subs?.models[a.model]?.note}>
                <select className="input" value={a.model} onChange={(e) => setSub({ model: e.target.value as WhisperModelSize })}>
                  {(['tiny', 'base', 'small', 'medium'] as const).map((m) => <option key={m} value={m}>{m} ({subs?.models[m]?.mb ?? '?'} MB)</option>)}
                </select>
              </Field>
              <Field label="CPU threads" hint="0 = half the cores, so playback and transcoding stay smooth.">
                <input className="input" type="number" min={0} max={64} value={a.threads} onChange={(e) => setSub({ threads: Math.max(0, Number(e.target.value) || 0) })} />
              </Field>
            </div>
            <div className="form-row">
              <Field label="whisper.cpp program" hint="The downloaded copy, else whisper-cli on the PATH. To use another one, set the VIBE_WHISPER environment variable to its path and restart Vibe (programs can't be chosen here, for security).">
                <input className="input mono" value="Downloaded copy or PATH" readOnly disabled />
              </Field>
              <Field label="Own model file (optional)" hint="A ggml .bin of your own (e.g. a quantised large-v3-turbo); overrides the model above.">
                <input className="input mono" value={a.modelPath ?? ''} onChange={(e) => setSub({ modelPath: e.target.value || null })} />
              </Field>
            </div>
            <div className="row-gap">
              <button className="btn" onClick={() => void run('bin', () => aiApi.downloadWhisper('binary'), 'Downloading whisper.cpp…')} disabled={!!busy || dl?.state === 'downloading'}><Icon name="download" size={16} /> Download whisper.cpp (Windows)</button>
              <button className="btn" onClick={() => void run('model', () => aiApi.downloadWhisper('model', a.model), `Downloading the ${a.model} model…`)} disabled={!!busy || dl?.state === 'downloading'}><Icon name="download" size={16} /> Download the {a.model} model</button>
            </div>
            {dl && dl.state !== 'idle' && (
              <p className={dl.state === 'error' ? 'form-error' : 'muted'} role="status">
                {dl.state === 'downloading' ? <>Downloading {dl.what}: {formatBytes(dl.received)}{dl.total ? ` of ${formatBytes(dl.total)}` : ''}</> : dl.state === 'ready' ? <>Downloaded {dl.what}.</> : <>Download failed: {dl.error}</>}
              </p>
            )}
          </>
        ) : (
          <div className="form-row">
            <Field label="API URL" hint="OpenAI-compatible, e.g. a self-hosted faster-whisper server (http://localhost:8000/v1) or https://api.openai.com/v1.">
              <input className="input mono" value={a.apiUrl ?? ''} onChange={(e) => setSub({ apiUrl: e.target.value || null })} />
            </Field>
            <Field label="Model"><input className="input mono" value={a.apiModel ?? ''} placeholder="whisper-1" onChange={(e) => setSub({ apiModel: e.target.value || null })} /></Field>
            <Field label="API key"><input className="input mono" type="password" autoComplete="off" value={a.apiKey ?? ''} placeholder="Not needed for self-hosted" onChange={(e) => setSub({ apiKey: e.target.value || null })} /></Field>
          </div>
        )}
        {subs && (
          subs.engine.ready
            ? <p className="muted"><Icon name="checkCircle" size={14} /> Ready{subs.engine.binary ? ` · ${subs.engine.binary}` : ''}</p>
            : <ul className="ai-problems">{subs.engine.problems.map((p) => <li key={p}><Icon name="alert" size={14} /> {p}</li>)}</ul>
        )}
        <div className="form-row">
          <Field label="Languages to generate" hint="ISO codes, e.g. “ro, en”. Empty = the languages from Server settings → Subtitles.">
            <input className="input" value={langText ?? a.languages.join(', ')} placeholder="ro, en" onChange={(e) => setLangText(e.target.value)} onBlur={() => {
              if (langText != null) setSub({ languages: langList(langText) });
              setLangText(null);
            }} />
          </Field>
          <Field label="Night window starts"><input className="input" type="time" value={a.windowStart} onChange={(e) => setSub({ windowStart: e.target.value || '01:00' })} /></Field>
          <Field label="and ends"><input className="input" type="time" value={a.windowEnd} onChange={(e) => setSub({ windowEnd: e.target.value || '07:00' })} /></Field>
        </div>
        <Switch checked={a.translate} onChange={(v) => setSub({ translate: v })} label="Translate with the language model when the film speaks another language" hint={status?.llmConfigured ? 'Uses the model above, in batches; timing never leaves the server.' : 'Needs a language model above; without one such titles are skipped.'} />
        {subs && <SubtitleQueue status={subs} reload={reload} />}
      </section>

      <section className="settings-card">
        <h2><Icon name="search" size={18} /> Ask</h2>
        <Switch checked={ai.ask.embeddings} onChange={(v) => set({ ask: { ...ai.ask, embeddings: v } })} label="Semantic matching of plots and taglines"
          hint="Finds films by description (“that heist film with red jumpsuits”). Built in the background by the “Build search embeddings” task." />
        {ai.ask.embeddings && (
          <div className="form-row">
            <Field label="Embeddings from">
              <select className="input" value={ai.ask.embeddingSource} onChange={(e) => set({ ask: { ...ai.ask, embeddingSource: e.target.value as 'local' | 'api' } })}>
                <option value="local">This server (small English model, ~25 MB, CPU)</option>
                <option value="api">The language-model server (multilingual models)</option>
              </select>
            </Field>
            {ai.ask.embeddingSource === 'api' && (
              <Field label="Embedding model" hint="e.g. nomic-embed-text or bge-m3 on Ollama (good with Romanian), text-embedding-3-small on OpenAI.">
                <input className="input mono" value={ai.ask.embeddingModel ?? ''} onChange={(e) => set({ ask: { ...ai.ask, embeddingModel: e.target.value || null } })} />
              </Field>
            )}
          </div>
        )}
        {status?.embeddings && ai.ask.embeddings && (
          <div className="row-gap">
            <span className="muted">{status.embeddings.count.toLocaleString()} of {status.embeddings.total.toLocaleString()} titles embedded{status.embeddings.error ? ` · ${status.embeddings.error}` : ''}</span>
            <button className="btn btn-sm" onClick={() => void run('emb', aiApi.buildEmbeddings, 'Building embeddings in the background')} disabled={!!busy}><Icon name="refresh" size={14} /> Build now (save first)</button>
          </div>
        )}
      </section>

      <section className="settings-card">
        <h2><Icon name="chapters" size={18} /> Recaps</h2>
        <div className="form-row">
          <Field label="Offer a recap after a break of" hint="Also offered at the start of a new season.">
            <select className="input" value={ai.recaps.minGapDays} onChange={(e) => set({ recaps: { ...ai.recaps, minGapDays: Number(e.target.value) } })}>
              {[3, 5, 7, 10, 14, 30].map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </Field>
          <Field label="Episodes to recap">
            <select className="input" value={ai.recaps.maxEpisodes} onChange={(e) => set({ recaps: { ...ai.recaps, maxEpisodes: Number(e.target.value) } })}>
              {[1, 2, 3].map((d) => <option key={d} value={d}>The last {d}</option>)}
            </select>
          </Field>
        </div>
      </section>
    </div>
  );
}
