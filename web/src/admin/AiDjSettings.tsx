import { useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import type { AiDjSettings, AiLlmKind, AiLlmProvider, AiProviderHealth, AiTtsKind, AiTtsProvider } from '@mediamax/shared';
import { GROUP_LABEL, healthTone, moveItem, type ProviderGroup } from './aiChain';
import { api } from '../api/endpoints';
import { aiApi } from '../api/ai';
import { getToken } from '../api/client';
import { useToast } from '../state/toast';
import { Field, Spinner, Switch } from '../components/ui';
import { Icon } from '../components/Icon';

export { GROUP_LABEL, LLM_PRESETS, TTS_PRESETS, llmFromPreset, ttsFromPreset, moveItem, healthTone } from './aiChain';
export type { LlmPreset, TtsPreset, ProviderGroup } from './aiChain';

const LLM_KIND_LABEL: Record<AiLlmKind, string> = { openai: 'OpenAI-compatible', ollama: 'Ollama (native)', anthropic: 'Anthropic', gemini: 'Gemini' };
const TTS_KIND_LABEL: Record<AiTtsKind, string> = { piper: 'Piper', kokoro: 'Kokoro', openai: 'OpenAI-compatible', elevenlabs: 'ElevenLabs' };

type AnyProvider = AiLlmProvider | AiTtsProvider;

/**
 * An ordered provider chain (language models or voices): drag or up/down to reorder, enable/disable, edit, test.
 * Keys are write-only: the server only says whether one is stored.
 */
export function ProviderChainEditor<P extends AnyProvider>({ kind, list, onChange, health, presets, savedIds }: {
  kind: 'llm' | 'tts';
  list: P[];
  onChange: (list: P[]) => void;
  health: AiProviderHealth[];
  presets: { id: string; label: string; group: ProviderGroup; note: string; make: () => P }[];
  /** Providers already saved on the server (only those can be tested). */
  savedIds: Set<string>;
}) {
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const set = (i: number, patch: Partial<Omit<AiLlmProvider, 'kind'> & Omit<AiTtsProvider, 'kind'>> & { kind?: AiLlmKind | AiTtsKind }) => onChange(list.map((p, j) => (j === i ? ({ ...p, ...patch } as P) : p)));

  const test = async (p: P) => {
    setTesting(p.id);
    try {
      const r = await aiApi.testProvider(kind, p.id);
      if (!r.ok) toast.show(`${p.name}: ${r.error ?? 'no reply'}`, 'error');
      else if (kind === 'tts' && r.sample) {
        await new Audio(`${r.sample}?token=${encodeURIComponent(getToken() ?? '')}`).play().catch(() => {});
        toast.success(`${p.name} answered in ${r.ms} ms`);
      } else toast.success(`${p.name} answered in ${r.ms} ms${r.sample ? `: “${r.sample}”` : ''}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setTesting(null);
    }
  };

  const onDrop = (e: DragEvent, to: number) => {
    e.preventDefault();
    if (drag != null) onChange(moveItem(list, drag, to));
    setDrag(null);
  };

  return (
    <div className="ai-chain">
      {list.length === 0 && <p className="muted">{kind === 'llm' ? 'No language model: every feature uses its built-in rules and template lines.' : 'No server voice: each device speaks with its own voice.'}</p>}
      <ol className="ai-chain-list">
        {list.map((p, i) => {
          const h = health.find((x) => x.id === p.id && x.kind === kind);
          const tone = healthTone(p, h);
          const isOpen = open === p.id;
          const tp = p as AiTtsProvider;
          return (
            <li key={p.id} className={`ai-chain-item ${p.enabled ? '' : 'off'} ${drag === i ? 'dragging' : ''}`} draggable
              onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, i)} onDragEnd={() => setDrag(null)}>
              <div className="ai-chain-row">
                <span className="ai-chain-grip" aria-hidden><Icon name="drag" size={16} /></span>
                <span className="ai-chain-pos">{i + 1}</span>
                <span className={`ai-dot ai-dot-${tone}`} title={tone === 'ok' ? 'Working' : tone === 'cooling' ? `Cooling down until ${new Date(h!.cooldownUntil!).toLocaleTimeString()}` : tone === 'error' ? `Last error: ${h?.lastError}` : p.enabled ? 'Not used yet' : 'Off'} />
                <button className="ai-chain-name" onClick={() => setOpen(isOpen ? null : p.id)} aria-expanded={isOpen}>
                  <strong>{p.name}</strong>
                  <span className="muted"> · {kind === 'llm' ? LLM_KIND_LABEL[(p as AiLlmProvider).kind] : TTS_KIND_LABEL[tp.kind]}{p.model ? ` · ${p.model}` : ''}</span>
                  {p.paid && <span className="ai-tag ai-tag-cheap">paid</span>}
                </button>
                <span className="ai-chain-stats muted">{h ? `${h.calls24h} calls / 24 h` : ''}</span>
                <Switch checked={p.enabled} onChange={(v) => set(i, { enabled: v })} label={<span className="sr-only">Enabled</span>} />
                <button className="btn-icon" onClick={() => onChange(moveItem(list, i, i - 1))} disabled={i === 0} aria-label="Move up"><Icon name="chevronUp" size={16} /></button>
                <button className="btn-icon" onClick={() => onChange(moveItem(list, i, i + 1))} disabled={i === list.length - 1} aria-label="Move down"><Icon name="chevronDown" size={16} /></button>
              </div>
              {tone === 'error' || tone === 'cooling' ? <p className="ai-chain-error">{h?.lastError}{h?.lastErrorAt ? ` · ${new Date(h.lastErrorAt).toLocaleString()}` : ''}</p> : null}
              {isOpen && (
                <div className="ai-chain-body form-grid">
                  <div className="form-row">
                    <Field label="Name"><input className="input" value={p.name} maxLength={80} onChange={(e) => set(i, { name: e.target.value })} /></Field>
                    <Field label="API type">
                      {kind === 'llm' ? (
                        <select className="input" value={(p as AiLlmProvider).kind} onChange={(e) => set(i, { kind: e.target.value as AiLlmKind })}>
                          {(Object.keys(LLM_KIND_LABEL) as AiLlmKind[]).map((k) => <option key={k} value={k}>{LLM_KIND_LABEL[k]}</option>)}
                        </select>
                      ) : (
                        <select className="input" value={tp.kind} onChange={(e) => set(i, { kind: e.target.value as AiTtsKind })}>
                          {(Object.keys(TTS_KIND_LABEL) as AiTtsKind[]).map((k) => <option key={k} value={k}>{TTS_KIND_LABEL[k]}</option>)}
                        </select>
                      )}
                    </Field>
                  </div>
                  <div className="form-row">
                    <Field label={kind === 'tts' && tp.kind === 'piper' ? 'Piper HTTP server URL (empty = run the program)' : 'API URL'}><input className="input mono" value={p.url} onChange={(e) => set(i, { url: e.target.value })} /></Field>
                    {!(kind === 'tts' && tp.kind === 'piper') && <Field label="Model"><input className="input mono" value={p.model ?? ''} onChange={(e) => set(i, { model: e.target.value })} /></Field>}
                    {kind === 'tts' && tp.kind !== 'piper' && <Field label={tp.kind === 'elevenlabs' ? 'Voice id' : 'Voice'}><input className="input mono" value={tp.voice ?? ''} onChange={(e) => set(i, { voice: e.target.value })} /></Field>}
                  </div>
                  {kind === 'tts' && tp.kind === 'piper' && !tp.url && (
                    <div className="form-row">
                      <Field label="piper program" hint="piper on the server's PATH, or the VIBE_PIPER environment variable. Programs can't be chosen here, for security."><input className="input mono" value="piper" readOnly disabled /></Field>
                      <Field label="Voice model (.onnx)"><input className="input mono" value={tp.voiceModel ?? ''} onChange={(e) => set(i, { voiceModel: e.target.value || null })} /></Field>
                      <Field label="Speaker #"><input className="input" type="number" min={0} value={tp.speaker ?? ''} onChange={(e) => set(i, { speaker: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
                    </div>
                  )}
                  {!(kind === 'tts' && tp.kind === 'piper') && (
                    <div className="form-row">
                      <Field label="API key" hint={p.hasKey ? 'A key is stored on the server (never shown). Type a new one to replace it.' : 'Only for hosted services. Stored on the server; never shown again.'}>
                        <input className="input mono" type="password" autoComplete="off" value={p.apiKey ?? ''} placeholder={p.hasKey ? 'Stored — type to replace' : 'Not needed for local servers'} onChange={(e) => set(i, { apiKey: e.target.value || undefined })} />
                      </Field>
                      {p.hasKey && <div className="ai-chain-keyrm"><button className="btn btn-sm" onClick={() => set(i, { apiKey: '', hasKey: false })}><Icon name="trash" size={14} /> Remove stored key</button></div>}
                    </div>
                  )}
                  <div className="form-row">
                    <Switch checked={!!p.paid} onChange={(v) => set(i, { paid: v })} label="Paid service" hint="Shown as paid; give it a daily cap so a busy evening can't run up a bill." />
                    <Field label="Daily cap (calls, this provider)" hint="Over the cap the next provider is used until midnight UTC. Empty = no cap.">
                      <input className="input" type="number" min={0} value={p.dailyCap ?? ''} placeholder="No cap" onChange={(e) => set(i, { dailyCap: e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0) })} />
                    </Field>
                  </div>
                  <div className="row-gap">
                    <button className="btn btn-sm" onClick={() => void test(p)} disabled={!!testing || !savedIds.has(p.id)} title={savedIds.has(p.id) ? '' : 'Save first'}>
                      {testing === p.id ? <Spinner size={14} /> : <Icon name={kind === 'llm' ? 'zap' : 'volume'} size={14} />} Test{savedIds.has(p.id) ? '' : ' (save first)'}
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => onChange(list.filter((_, j) => j !== i))}><Icon name="trash" size={14} /> Remove</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {adding ? (
        <div className="ai-chain-add">
          {(['local', 'free', 'paid'] as ProviderGroup[]).map((g) => {
            const ps = presets.filter((p) => p.group === g);
            if (!ps.length) return null;
            return (
              <div key={g}>
                <h4>{GROUP_LABEL[g]}</h4>
                <div className="ai-presets">
                  {ps.map((p) => (
                    <button key={p.id} className="ai-preset" title={p.note} onClick={() => {
                      const np = p.make();
                      onChange([...list, np]);
                      setOpen(np.id);
                      setAdding(false);
                    }}>
                      <strong>{p.label}</strong> <span className={`ai-tag ai-tag-${g === 'local' ? 'free' : g === 'free' ? 'free-tier' : 'cheap'}`}>{GROUP_LABEL[g]}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <div><button className="btn btn-sm btn-ghost" onClick={() => setAdding(false)}>Cancel</button></div>
        </div>
      ) : (
        <div><button className="btn btn-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add {kind === 'llm' ? 'a language model' : 'a voice'}</button></div>
      )}
    </div>
  );
}

/** Server settings → AI DJ: the DJ's own options. Models and voices live in Admin → AI (provider chains). */
export function AiDjSettingsPanel({ value, onChange }: { value: AiDjSettings; onChange: (v: AiDjSettings) => void }) {
  const toast = useToast();
  const [testing, setTesting] = useState<'llm' | 'tts' | null>(null);
  const v = value;

  const test = async (kind: 'llm' | 'tts') => {
    setTesting(kind);
    try {
      const r = await api.dj.aiTest(kind);
      if (kind === 'llm') toast.success(`The model answered in ${r.ms} ms${r.usage?.max ? ` · ${r.usage.used}/${r.usage.max} calls today` : ''}`);
      else if (r.audioUrl) {
        await new Audio(`${r.audioUrl}?token=${encodeURIComponent(getToken() ?? '')}`).play();
        toast.success('Playing a test line');
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="form-grid">
      <p className="muted">
        The AI DJ turns requests like “chilled 90s house for a Sunday morning” into a mix, runs Your DJ sets and the optional Radio Host, and talks between songs.
        It works for free out of the box with built-in understanding, template lines and each device's voice.
      </p>
      <Switch checked={v.enabled} onChange={(x) => onChange({ ...v, enabled: x })} label="Enable the AI DJ" hint="Shows “Ask the DJ”, Your DJ, the Radio Host and the DJ voice in every app." />
      <div className="form-row">
        <Field label="Host name"><input className="input" value={v.hostName} maxLength={40} onChange={(e) => onChange({ ...v, hostName: e.target.value || 'Max' })} /></Field>
        <Field label="How often the host talks (advanced DJ page)">
          <select className="input" value={v.chattiness} onChange={(e) => onChange({ ...v, chattiness: e.target.value as AiDjSettings['chattiness'] })}>
            <option value="rare">Now and then (every 4th song)</option>
            <option value="normal">Regularly (every 2nd song)</option>
            <option value="chatty">Between every song</option>
          </select>
        </Field>
      </div>
      <h3 className="section-title">Language models and voices</h3>
      <p className="field-hint">
        Both are ordered fallback chains shared by every AI feature, set up in <Link to="/admin/ai">Admin → AI</Link>. If one fails or runs out of quota the next one is used quietly;
        listeners never see an error.
      </p>
      <div className="row-gap">
        <button className="btn" onClick={() => void test('llm')} disabled={!!testing}>{testing === 'llm' ? <Spinner size={16} /> : <Icon name="zap" size={16} />} Test the model chain</button>
        <button className="btn" onClick={() => void test('tts')} disabled={!!testing}>{testing === 'tts' ? <Spinner size={16} /> : <Icon name="volume" size={16} />} Test the voice chain</button>
      </div>
    </div>
  );
}
