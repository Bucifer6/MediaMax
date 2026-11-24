/**
 * Admin → AI: provider presets (grouped Local / Free tier / Paid) and pure helpers for the chain editor and the DJ
 * restrictions editor (no DOM, unit-tested in web/test/admin-ai-chain.test.ts).
 */
import type { AiLlmKind, AiLlmProvider, AiProviderHealth, AiTtsProvider, DjRules } from '@mediamax/shared';

/** Where a provider runs / what it costs (presets are grouped by it). */
export type ProviderGroup = 'local' | 'free' | 'paid';
export const GROUP_LABEL: Record<ProviderGroup, string> = { local: 'Local', free: 'Free tier', paid: 'Paid' };

export type LlmPreset = { id: string; label: string; group: ProviderGroup; kind: AiLlmKind; url: string; model: string; key: boolean; note: string };
// Model names change over time; these are sensible starting points, editable after adding.
export const LLM_PRESETS: LlmPreset[] = [
  { id: 'ollama', label: 'Ollama', group: 'local', kind: 'ollama', url: 'http://localhost:11434', model: 'llama3.2:3b', key: false, note: 'Free and private. Install Ollama, run "ollama pull llama3.2:3b". A 3B model runs fine on a CPU for this.' },
  { id: 'lmstudio', label: 'LM Studio', group: 'local', kind: 'openai', url: 'http://localhost:1234/v1', model: 'local-model', key: false, note: 'Start the local server in LM Studio and use the model name it shows.' },
  { id: 'llamacpp', label: 'llama.cpp server', group: 'local', kind: 'openai', url: 'http://localhost:8080/v1', model: 'local', key: false, note: 'llama-server (llama.cpp) speaks the OpenAI API; the model name is ignored.' },
  { id: 'localai', label: 'LocalAI', group: 'local', kind: 'openai', url: 'http://localhost:8080/v1', model: 'llama-3.2-3b-instruct', key: false, note: 'Self-hosted OpenAI-compatible server (Docker); use a model you installed.' },
  { id: 'groq', label: 'Groq', group: 'free', kind: 'openai', url: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant', key: true, note: 'Very fast. Free tier with rate limits — create a key at console.groq.com.' },
  { id: 'gemini', label: 'Google Gemini (free tier)', group: 'free', kind: 'gemini', url: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash', key: true, note: 'Free tier via Google AI Studio (aistudio.google.com). Free-tier prompts may be used by Google to improve its models.' },
  { id: 'openrouter', label: 'OpenRouter (free models)', group: 'free', kind: 'openai', url: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', key: true, note: 'Models ending in ":free" cost nothing (rate-limited). Key at openrouter.ai.' },
  { id: 'mistral', label: 'Mistral', group: 'free', kind: 'openai', url: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', key: true, note: 'Free "Experiment" plan at console.mistral.ai.' },
  { id: 'cerebras', label: 'Cerebras', group: 'free', kind: 'openai', url: 'https://api.cerebras.ai/v1', model: 'llama3.1-8b', key: true, note: 'Free tier with daily token limits — cloud.cerebras.ai.' },
  { id: 'openai', label: 'OpenAI', group: 'paid', kind: 'openai', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', key: true, note: 'Small models cost fractions of a cent per DJ session.' },
  { id: 'anthropic', label: 'Anthropic', group: 'paid', kind: 'anthropic', url: 'https://api.anthropic.com', model: 'claude-haiku-5-5', key: true, note: 'Messages API with your console.anthropic.com key. Pick a small, fast model.' },
  { id: 'gemini-paid', label: 'Google Gemini (paid)', group: 'paid', kind: 'gemini', url: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash', key: true, note: 'A billing-enabled Gemini key: higher limits, and prompts are not used for training.' },
  { id: 'deepseek', label: 'DeepSeek', group: 'paid', kind: 'openai', url: 'https://api.deepseek.com', model: 'deepseek-chat', key: true, note: 'Pay-as-you-go at a very low price per token.' },
];

export type TtsPreset = { id: string; label: string; group: ProviderGroup; patch: Omit<AiTtsProvider, 'id' | 'name' | 'enabled'>; key: boolean; note: string };
export const TTS_PRESETS: TtsPreset[] = [
  { id: 'piper', label: 'Piper (program on this server)', group: 'local', patch: { kind: 'piper', url: '', piperPath: 'piper', voiceModel: '/config/voices/en_GB-alan-medium.onnx' }, key: false, note: 'Open-source neural voices that run on a CPU. Install piper and download a voice (.onnx + .onnx.json).' },
  { id: 'piper-http', label: 'Piper HTTP server', group: 'local', patch: { kind: 'piper', url: 'http://localhost:5000' }, key: false, note: 'Piper\'s own web server (python -m piper.http_server): the text is POSTed, WAV comes back.' },
  { id: 'kokoro', label: 'Kokoro-FastAPI', group: 'local', patch: { kind: 'kokoro', url: 'http://localhost:8880/v1', model: 'kokoro', voice: 'af_heart' }, key: false, note: 'Natural open-source voices with an OpenAI-compatible API; runs in Docker (CPU or GPU).' },
  { id: 'openai-local', label: 'OpenAI-compatible (self-hosted)', group: 'local', patch: { kind: 'openai', url: 'http://localhost:8000/v1', model: 'tts-1', voice: 'alloy' }, key: false, note: 'openedai-speech, LocalAI or any other /audio/speech server.' },
  { id: 'elevenlabs', label: 'ElevenLabs', group: 'paid', patch: { kind: 'elevenlabs', url: 'https://api.elevenlabs.io', model: 'eleven_flash_v2_5', voice: '' }, key: true, note: 'Very natural voices; small free monthly allowance, then paid. Paste a voice id from your ElevenLabs voice library.' },
  { id: 'openai-tts', label: 'OpenAI speech', group: 'paid', patch: { kind: 'openai', url: 'https://api.openai.com/v1', model: 'tts-1', voice: 'alloy' }, key: true, note: 'Pay-per-character; host lines are short and cached.' },
];

const newId = (base: string) => `${base}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function llmFromPreset(p: LlmPreset): AiLlmProvider {
  return { id: newId(p.id), name: p.label, kind: p.kind, url: p.url, model: p.model, enabled: true, paid: p.group === 'paid', dailyCap: p.group === 'paid' ? 200 : null };
}
export function ttsFromPreset(p: TtsPreset): AiTtsProvider {
  return { id: newId(p.id), name: p.label, enabled: true, paid: p.group === 'paid', dailyCap: p.group === 'paid' ? 300 : null, ...p.patch };
}

/** Move item `from` to position `to` (drag or up/down). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

/** Health dot: green = working, amber = cooling down, red = last call failed, grey = off / not used yet. */
export function healthTone(p: { enabled: boolean }, h: AiProviderHealth | undefined): 'ok' | 'cooling' | 'error' | 'idle' {
  if (!p.enabled) return 'idle';
  if (!h) return 'idle';
  if (h.cooldownUntil && Date.parse(h.cooldownUntil) > Date.now()) return 'cooling';
  if (!h.ok && h.lastError) return 'error';
  return h.lastUsedAt ? 'ok' : 'idle';
}


/** Drop empty fields so "{}" means no restrictions. */
export function compactRules(r: DjRules): DjRules {
  const out: DjRules = {};
  for (const [k, v] of Object.entries(r) as [keyof DjRules, unknown][]) {
    if (v === undefined || v === null || v === false || (typeof v === 'number' && !Number.isFinite(v)) || (Array.isArray(v) && !v.length)) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
