import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AiDjSettings } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { getToken } from '../api/client';
import { useToast } from '../state/toast';
import { Field, Spinner, Switch } from '../components/ui';
import { Icon } from '../components/Icon';

export type LlmPreset = { id: string; label: string; tag: 'free' | 'free tier' | 'cheap'; provider: AiDjSettings['llm']['provider']; url: string | null; model: string | null; key: boolean; note: string };
// Model names change over time; these are sensible starting points, editable below.
export const LLM_PRESETS: LlmPreset[] = [
  { id: 'none', label: 'Built-in (no AI model)', tag: 'free', provider: 'none', url: null, model: null, key: false, note: 'Understands moods, genres, decades, tempo and length with no setup. Host lines come from varied templates.' },
  { id: 'ollama', label: 'Ollama (on your server or PC)', tag: 'free', provider: 'ollama', url: 'http://localhost:11434', model: 'llama3.2:3b', key: false, note: 'Free and private. Install Ollama, run "ollama pull llama3.2:3b". A 3B model runs fine on a CPU for this.' },
  { id: 'lmstudio', label: 'LM Studio / llama.cpp / LocalAI', tag: 'free', provider: 'openai', url: 'http://localhost:1234/v1', model: 'local-model', key: false, note: 'Any self-hosted OpenAI-compatible server. Use the model name it shows.' },
  { id: 'groq', label: 'Groq', tag: 'free tier', provider: 'openai', url: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant', key: true, note: 'Very fast. Free tier with rate limits — create a key at console.groq.com.' },
  { id: 'gemini', label: 'Google Gemini', tag: 'free tier', provider: 'openai', url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', key: true, note: 'Free tier via Google AI Studio (aistudio.google.com). Free-tier prompts may be used by Google to improve its models.' },
  { id: 'openrouter', label: 'OpenRouter (free models)', tag: 'free tier', provider: 'openai', url: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', key: true, note: 'Models ending in ":free" cost nothing (rate-limited). Key at openrouter.ai.' },
  { id: 'mistral', label: 'Mistral', tag: 'free tier', provider: 'openai', url: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', key: true, note: 'Free "Experiment" plan at console.mistral.ai.' },
  { id: 'cerebras', label: 'Cerebras', tag: 'free tier', provider: 'openai', url: 'https://api.cerebras.ai/v1', model: 'llama3.1-8b', key: true, note: 'Free tier with daily token limits — cloud.cerebras.ai.' },
  { id: 'deepseek', label: 'DeepSeek', tag: 'cheap', provider: 'openai', url: 'https://api.deepseek.com', model: 'deepseek-chat', key: true, note: 'Pay-as-you-go at a very low price per token. A DJ session uses a few thousand tokens.' },
  { id: 'openai', label: 'OpenAI', tag: 'cheap', provider: 'openai', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', key: true, note: 'Small models cost fractions of a cent per DJ session.' },
];

type TtsPreset = { id: string; label: string; tag: 'free' | 'cheap'; patch: Partial<AiDjSettings['tts']>; key: boolean; note: string };
const TTS_PRESETS: TtsPreset[] = [
  { id: 'device', label: 'Each device\'s own voice', tag: 'free', patch: { provider: 'device' }, key: false, note: 'Uses the browser / phone / TV built-in speech. No setup.' },
  { id: 'piper', label: 'Piper (on this server)', tag: 'free', patch: { provider: 'piper', piperPath: 'piper', voiceModel: '/config/voices/en_GB-alan-medium.onnx' }, key: false, note: 'Open-source neural voices that run on a CPU. Install piper and download a voice (.onnx + .onnx.json) from the Piper voices list.' },
  { id: 'kokoro', label: 'Kokoro-FastAPI (self-hosted)', tag: 'free', patch: { provider: 'openai', url: 'http://localhost:8880/v1', model: 'kokoro', voice: 'af_heart' }, key: false, note: 'Natural open-source voices with an OpenAI-compatible API; runs in Docker (CPU or GPU).' },
  { id: 'openai-tts', label: 'OpenAI speech', tag: 'cheap', patch: { provider: 'openai', url: 'https://api.openai.com/v1', model: 'tts-1', voice: 'alloy' }, key: true, note: 'Pay-per-character; host lines are short and cached.' },
];

export function AiDjSettingsPanel({ value, onChange }: { value: AiDjSettings; onChange: (v: AiDjSettings) => void }) {
  const toast = useToast();
  const [testing, setTesting] = useState<'llm' | 'tts' | null>(null);
  const v = value;
  const setTts = (p: Partial<AiDjSettings['tts']>) => onChange({ ...v, tts: { ...v.tts, ...p } });
  const ttsPreset = TTS_PRESETS.find((p) => p.patch.provider === v.tts.provider && (p.patch.provider !== 'openai' || p.patch.url === v.tts.url))?.id ?? 'custom';

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

  const tag = (t: string) => <span className={`ai-tag ai-tag-${t.replace(' ', '-')}`}>{t}</span>;
  const curTts = TTS_PRESETS.find((p) => p.id === ttsPreset);

  return (
    <div className="form-grid">
      <p className="muted">
        The AI DJ turns requests like “chilled 90s house for a Sunday morning” into a mix and talks between songs like a radio host.
        It works for free out of the box. Connect a free local model or a free/cheap hosted API for richer understanding and chat; save, then test.
      </p>
      <Switch checked={v.enabled} onChange={(x) => onChange({ ...v, enabled: x })} label="Enable the AI DJ" hint="Shows “Ask the DJ” and the DJ voice in every app." />
      <div className="form-row">
        <Field label="Host name"><input className="input" value={v.hostName} maxLength={40} onChange={(e) => onChange({ ...v, hostName: e.target.value || 'Max' })} /></Field>
        <Field label="How often the host talks">
          <select className="input" value={v.chattiness} onChange={(e) => onChange({ ...v, chattiness: e.target.value as AiDjSettings['chattiness'] })}>
            <option value="rare">Now and then (every 4th song)</option>
            <option value="normal">Regularly (every 2nd song)</option>
            <option value="chatty">Between every song</option>
          </select>
        </Field>
      </div>

      <h3 className="section-title">Understanding & chat</h3>
      <p className="field-hint">
        The language model is now shared by every AI feature and set up in <Link to="/admin/ai">Admin → AI</Link>
        {v.llm.provider !== 'none' ? <> (currently <strong>{v.llm.model ?? v.llm.provider}</strong>)</> : ' (none: the DJ uses its built-in understanding and template lines)'}.
      </p>
      {v.llm.provider !== 'none' && <div><button className="btn" onClick={() => void test('llm')} disabled={!!testing}>{testing === 'llm' ? <Spinner size={16} /> : <Icon name="zap" size={16} />} Test the model</button></div>}

      <h3 className="section-title">DJ voice</h3>
      <div className="ai-presets" role="radiogroup" aria-label="Voice">
        {TTS_PRESETS.map((p) => (
          <button key={p.id} role="radio" aria-checked={ttsPreset === p.id} className={`ai-preset ${ttsPreset === p.id ? 'active' : ''}`}
            onClick={() => setTts({ ...p.patch, apiKey: p.key ? v.tts.apiKey : null })}>
            <strong>{p.label}</strong> {tag(p.tag)}
          </button>
        ))}
      </div>
      {curTts && <p className="field-hint">{curTts.note}</p>}
      {v.tts.provider === 'piper' && (
        <div className="form-row">
          <Field label="piper program"><input className="input mono" value={v.tts.piperPath ?? ''} placeholder="piper" onChange={(e) => setTts({ piperPath: e.target.value || null })} /></Field>
          <Field label="Voice model (.onnx)"><input className="input mono" value={v.tts.voiceModel ?? ''} onChange={(e) => setTts({ voiceModel: e.target.value || null })} /></Field>
          <Field label="Speaker # (multi-speaker voices)"><input className="input" type="number" min={0} value={v.tts.speaker ?? ''} onChange={(e) => setTts({ speaker: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
        </div>
      )}
      {v.tts.provider === 'openai' && (
        <>
          <div className="form-row">
            <Field label="Speech API URL"><input className="input mono" value={v.tts.url ?? ''} onChange={(e) => setTts({ url: e.target.value || null })} /></Field>
            <Field label="Model"><input className="input mono" value={v.tts.model ?? ''} onChange={(e) => setTts({ model: e.target.value || null })} /></Field>
            <Field label="Voice"><input className="input mono" value={v.tts.voice ?? ''} onChange={(e) => setTts({ voice: e.target.value || null })} /></Field>
          </div>
          <Field label="API key"><input className="input mono" type="password" autoComplete="off" value={v.tts.apiKey ?? ''} placeholder={curTts?.key ? 'Paste your key' : 'Not needed'} onChange={(e) => setTts({ apiKey: e.target.value || null })} /></Field>
        </>
      )}
      {v.tts.provider !== 'device' && <div><button className="btn" onClick={() => void test('tts')} disabled={!!testing}>{testing === 'tts' ? <Spinner size={16} /> : <Icon name="volume" size={16} />} Test the voice (save first)</button></div>}
    </div>
  );
}
