import { useCallback, useEffect, useState } from 'react';
import type { AiSettings, AiStatus, AutoSubtitleJob, AutoSubtitleSettings, AutoSubtitleStatus, WhisperModelSize } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { aiApi, type WhisperModels } from '../api/ai';
import { useToast } from '../state/toast';
import { Badge, Field, PageLoader, ProgressBar, Spinner, Switch } from '../components/ui';
import { Icon } from '../components/Icon';
import { formatBytes, formatDateTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';
import { LLM_PRESETS } from './AiDjSettings';

const AI_DEFAULTS: AiSettings = {
  llm: { provider: 'none', url: null, model: null, apiKey: null, maxRequestsPerDay: 300 },
  features: { dj: true, ask: true, recaps: true, autoSubtitles: false },
  autoSubtitles: { engine: 'whisper-cpp', whisperPath: null, model: 'base', modelPath: null, threads: 0, apiUrl: null, apiModel: null, apiKey: null, languages: [], windowStart: '01:00', windowEnd: '07:00', translate: true, libraryIds: [] },
  ask: { embeddings: false, embeddingSource: 'local', embeddingModel: null },
  recaps: { minGapDays: 7, maxEpisodes: 3 },
};

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

  const reload = useCallback(() => {
    aiApi.status().then(setStatus).catch(() => {});
    aiApi.subtitles().then(setSubs).catch(() => {});
  }, []);
  useEffect(() => {
    api.admin.settings().then((s) => setAi({ ...AI_DEFAULTS, ...(s.ai ?? {}) })).catch((e) => toast.error(e));
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
  const setSub = (p: Partial<AutoSubtitleSettings>) => set({ autoSubtitles: { ...ai.autoSubtitles, ...p } });
  const llmPreset = LLM_PRESETS.find((p) => p.provider === ai.llm.provider && (p.provider === 'none' || p.url === ai.llm.url))?.id ?? 'custom';
  const curLlm = LLM_PRESETS.find((p) => p.id === llmPreset);
  const a = ai.autoSubtitles;

  const save = async () => {
    setBusy('save');
    try {
      const s = await api.admin.saveSettingsPatch({ ai });
      setAi({ ...AI_DEFAULTS, ...(s.ai ?? {}) });
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
  const testLlm = () => run('test', async () => {
    const r = await aiApi.test();
    toast.success(`The model answered in ${r.ms} ms${r.usage.max ? ` · ${r.usage.used}/${r.usage.max} calls today` : ''}`);
  }, 'Model test finished');
  const tag = (t: string) => <span className={`ai-tag ai-tag-${t.replace(' ', '-')}`}>{t}</span>;
  const dl = subs?.download;

  return (
    <div className="ai-admin">
      <AdminHeader title="AI" help="admin-ai" subtitle="One language model for the AI DJ, Ask, recaps and subtitle translation. Everything works without one; a model makes it smarter."
        actions={<button className="btn btn-primary" onClick={() => void save()} disabled={busy === 'save'}>{busy === 'save' ? <Spinner size={16} /> : 'Save'}</button>} />

      <section className="settings-card">
        <h2><Icon name="sparkles" size={18} /> Language model</h2>
        <div className="ai-presets" role="radiogroup" aria-label="Language model">
          {LLM_PRESETS.map((p) => (
            <button key={p.id} role="radio" aria-checked={llmPreset === p.id} className={`ai-preset ${llmPreset === p.id ? 'active' : ''}`}
              onClick={() => setLlm({ provider: p.provider, url: p.url, model: p.model, apiKey: p.key ? ai.llm.apiKey : null })}>
              <strong>{p.label}</strong> {tag(p.tag)}
            </button>
          ))}
        </div>
        {curLlm && <p className="field-hint">{curLlm.note}</p>}
        {ai.llm.provider !== 'none' && (
          <>
            <div className="form-row">
              <Field label="API URL"><input className="input mono" value={ai.llm.url ?? ''} onChange={(e) => setLlm({ url: e.target.value || null })} /></Field>
              <Field label="Model" hint="For Romanian translation pick a model that writes good Romanian (e.g. a 7-8B+ model or a hosted one)."><input className="input mono" value={ai.llm.model ?? ''} onChange={(e) => setLlm({ model: e.target.value || null })} /></Field>
            </div>
            <div className="form-row">
              <Field label="API key" hint="Only for hosted services. Stored on the server; never shown again.">
                <input className="input mono" type="password" autoComplete="off" value={ai.llm.apiKey ?? ''} placeholder={curLlm?.key ? 'Paste your key' : 'Not needed'} onChange={(e) => setLlm({ apiKey: e.target.value || null })} />
              </Field>
              <Field label="Daily limit (model calls, all features)" hint={`Keeps free tiers free; over it every feature uses its built-in fallback. 0 = no limit.${status ? ` Today: ${status.usage.used}${status.usage.max ? `/${status.usage.max}` : ''}.` : ''}`}>
                <input className="input" type="number" min={0} value={ai.llm.maxRequestsPerDay} onChange={(e) => setLlm({ maxRequestsPerDay: Math.max(0, Number(e.target.value) || 0) })} />
              </Field>
            </div>
            <div><button className="btn" onClick={() => void testLlm()} disabled={!!busy}>{busy === 'test' ? <Spinner size={16} /> : <Icon name="zap" size={16} />} Test the model (save first)</button></div>
            {curLlm?.key && <p className="field-hint">A hosted service receives: DJ requests with song titles, Ask queries, the summaries of episodes being recapped, and subtitle lines being translated. Nothing else from your library.</p>}
          </>
        )}
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
              <Field label="whisper.cpp program (optional)" hint="Empty = the downloaded copy, else whisper-cli on the PATH. Older builds call it main(.exe).">
                <input className="input mono" value={a.whisperPath ?? ''} placeholder={'C:\\whisper\\whisper-cli.exe'} onChange={(e) => setSub({ whisperPath: e.target.value || null })} />
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
