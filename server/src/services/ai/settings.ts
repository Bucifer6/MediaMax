/**
 * Server-wide AI settings (Admin → AI): one language model shared by the AI DJ, Ask, recaps and automatic subtitles,
 * per-feature switches and each feature's options.
 *
 * Migration: before this section existed the language model lived under `aiDj.llm`. When `ai` is missing it is built
 * from `aiDj.llm`, and `aiDj.llm` keeps mirroring `ai.llm` so older apps, backups and the DJ API see the same model.
 * Pure functions only (settings.ts calls them), so there is no import cycle.
 */
import type { AiDjSettings, AiLlmKind, AiLlmProvider, AiLlmSettings, AiSettings, AiTtsKind, AiTtsProvider, AiWeatherLocation, AutoSubtitleSettings, ServerSettings } from '@mediamax/shared';

export const DEFAULT_LLM: AiLlmSettings = { provider: 'none', url: null, model: null, apiKey: null, maxRequestsPerDay: 300 };

export const DEFAULT_AUTO_SUBTITLES: AutoSubtitleSettings = {
  engine: 'whisper-cpp', whisperPath: null, model: 'base', modelPath: null, threads: 0,
  apiUrl: null, apiModel: null, apiKey: null, languages: [], windowStart: '01:00', windowEnd: '07:00', translate: true, libraryIds: [],
};

export const DEFAULT_AI: AiSettings = {
  llm: DEFAULT_LLM,
  features: { dj: true, ask: true, recaps: true, autoSubtitles: false },
  autoSubtitles: DEFAULT_AUTO_SUBTITLES,
  ask: { embeddings: false, embeddingSource: 'local', embeddingModel: null },
  recaps: { minGapDays: 7, maxEpisodes: 3 },
  llmProviders: [],
  ttsProviders: [],
  weatherLocation: null,
  onlineFacts: false,
  djTrackCooldownDays: 7,
};

const str = (v: unknown, max = 1000): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
function int(v: unknown, min: number, max: number, d: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : d;
}
const hhmm = (v: unknown, d: string) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d);
const langs = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-z]{2,3}$/.test(x)))].slice(0, 10) : []);

export function normaliseLlm(v: Partial<AiLlmSettings> | undefined, d: AiLlmSettings = DEFAULT_LLM): AiLlmSettings {
  const x = v ?? {};
  return {
    provider: x.provider === 'ollama' || x.provider === 'openai' || x.provider === 'none' ? x.provider : d.provider,
    url: x.url === undefined ? d.url : str(x.url),
    model: x.model === undefined ? d.model : str(x.model, 200),
    apiKey: x.apiKey === undefined ? d.apiKey : str(x.apiKey, 500),
    maxRequestsPerDay: int(x.maxRequestsPerDay, 0, 1_000_000, d.maxRequestsPerDay),
  };
}

/** Every field present and valid; `prev` supplies values the patch leaves out. */
export function normaliseAi(v: Partial<AiSettings> | undefined, prev: AiSettings = DEFAULT_AI): AiSettings {
  const x = v ?? {};
  const f = (x.features ?? {}) as Partial<AiSettings['features']>;
  const a = { ...prev.autoSubtitles, ...(x.autoSubtitles ?? {}) } as AutoSubtitleSettings;
  const k = { ...prev.ask, ...(x.ask ?? {}) };
  const r = { ...prev.recaps, ...(x.recaps ?? {}) };
  return {
    llm: normaliseLlm(x.llm, prev.llm),
    features: { dj: bool(f.dj, prev.features.dj), ask: bool(f.ask, prev.features.ask), recaps: bool(f.recaps, prev.features.recaps), autoSubtitles: bool(f.autoSubtitles, prev.features.autoSubtitles) },
    autoSubtitles: {
      engine: a.engine === 'api' ? 'api' : 'whisper-cpp',
      whisperPath: str(a.whisperPath),
      model: (['tiny', 'base', 'small', 'medium'] as const).includes(a.model) ? a.model : 'base',
      modelPath: str(a.modelPath),
      threads: int(a.threads, 0, 64, 0),
      apiUrl: str(a.apiUrl),
      apiModel: str(a.apiModel, 200),
      apiKey: str(a.apiKey, 500),
      languages: langs(a.languages),
      windowStart: hhmm(a.windowStart, DEFAULT_AUTO_SUBTITLES.windowStart),
      windowEnd: hhmm(a.windowEnd, DEFAULT_AUTO_SUBTITLES.windowEnd),
      translate: bool(a.translate, true),
      libraryIds: Array.isArray(a.libraryIds) ? a.libraryIds.map(String).filter((s) => /^[\w-]{1,64}$/.test(s)).slice(0, 100) : [],
    },
    ask: { embeddings: bool(k.embeddings, false), embeddingSource: k.embeddingSource === 'api' ? 'api' : 'local', embeddingModel: str(k.embeddingModel, 200) },
    recaps: { minGapDays: int(r.minGapDays, 0, 365, 7), maxEpisodes: int(r.maxEpisodes, 1, 3, 3) },
    llmProviders: Array.isArray(x.llmProviders) ? normaliseLlmProviders(x.llmProviders) : prev.llmProviders ?? [],
    ttsProviders: Array.isArray(x.ttsProviders) ? normaliseTtsProviders(x.ttsProviders) : prev.ttsProviders ?? [],
    weatherLocation: x.weatherLocation === undefined ? prev.weatherLocation ?? null : normaliseLocation(x.weatherLocation),
    onlineFacts: bool(x.onlineFacts, prev.onlineFacts ?? false),
    djTrackCooldownDays: int(x.djTrackCooldownDays, 0, 365, prev.djTrackCooldownDays ?? 7),
  };
}

/* ------------------------------ provider chains ------------------------------ */

const LLM_KINDS: AiLlmKind[] = ['ollama', 'openai', 'anthropic', 'gemini'];
const TTS_KINDS: AiTtsKind[] = ['piper', 'kokoro', 'openai', 'elevenlabs'];
const pid = (v: unknown, i: number) => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : `p${i + 1}`);
const capOf = (v: unknown) => (v == null || v === '' ? null : int(v, 0, 1_000_000, 0) || null);

/** Valid, de-duplicated chain (keys already resolved: `apiKey` is the stored secret or null). At most 12 providers. */
export function normaliseLlmProviders(list: unknown[]): AiLlmProvider[] {
  const seen = new Set<string>();
  const out: AiLlmProvider[] = [];
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || out.length >= 12) return;
    const x = raw as Partial<AiLlmProvider>;
    let id = pid(x.id, i);
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    const kind = LLM_KINDS.includes(x.kind as AiLlmKind) ? (x.kind as AiLlmKind) : 'openai';
    out.push({
      id, name: str(x.name, 80) ?? kind, kind, url: str(x.url) ?? '', model: str(x.model, 200) ?? '',
      enabled: bool(x.enabled, true), paid: bool(x.paid, false), dailyCap: capOf(x.dailyCap), apiKey: str(x.apiKey, 500),
    });
  });
  return out;
}

export function normaliseTtsProviders(list: unknown[]): AiTtsProvider[] {
  const seen = new Set<string>();
  const out: AiTtsProvider[] = [];
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || out.length >= 12) return;
    const x = raw as Partial<AiTtsProvider>;
    let id = pid(x.id, i);
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    const kind = TTS_KINDS.includes(x.kind as AiTtsKind) ? (x.kind as AiTtsKind) : 'openai';
    out.push({
      id, name: str(x.name, 80) ?? kind, kind, url: str(x.url) ?? '', model: str(x.model, 200), voice: str(x.voice, 200),
      piperPath: str(x.piperPath), voiceModel: str(x.voiceModel), speaker: x.speaker == null || (x.speaker as unknown) === '' ? null : int(x.speaker, 0, 10000, 0),
      enabled: bool(x.enabled, true), paid: bool(x.paid, false), dailyCap: capOf(x.dailyCap), apiKey: str(x.apiKey, 500),
    });
  });
  return out;
}

function normaliseLocation(v: unknown): AiWeatherLocation | null {
  if (!v || typeof v !== 'object') return null;
  const x = v as Partial<AiWeatherLocation>;
  const lat = Number(x.lat);
  const lon = Number(x.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  // Two decimals (~1 km) is plenty for weather and keeps the exact address off the wire.
  return { name: str(x.name, 80) ?? 'Here', lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

/**
 * Write-only keys: a provider in the patch without `apiKey` (or with the mask) keeps the key stored under the same
 * id; "" / null removes it; anything else replaces it. `hasKey` from clients is ignored.
 */
export function resolveProviderKeys<P extends { id: string; apiKey?: string | null; hasKey?: boolean }>(patch: P[], cur: P[], mask: string): P[] {
  return patch.map((p) => {
    if (!p || typeof p !== 'object') return p;
    const { hasKey: _h, ...rest } = p;
    const old = cur.find((c) => c.id === p.id)?.apiKey ?? null;
    const apiKey = p.apiKey === undefined || p.apiKey === mask ? old : p.apiKey === null || p.apiKey === '' ? null : p.apiKey;
    return { ...rest, apiKey } as P;
  });
}

/** Chain providers as sent to the admin UI: no keys, just whether one is stored. */
export function publicProviders<P extends { apiKey?: string | null }>(list: P[] | undefined): (Omit<P, 'apiKey'> & { hasKey: boolean })[] {
  return (list ?? []).map(({ apiKey, ...p }) => ({ ...p, hasKey: !!apiKey }));
}

const nameFor = (url: string | null, kind: string) => {
  const u = (url ?? '').toLowerCase();
  for (const [k, n] of [['groq', 'Groq'], ['openrouter', 'OpenRouter'], ['mistral', 'Mistral'], ['cerebras', 'Cerebras'], ['deepseek', 'DeepSeek'], ['openai.com', 'OpenAI'], ['generativelanguage', 'Gemini'], [':11434', 'Ollama'], [':1234', 'LM Studio'], [':8880', 'Kokoro']] as const) {
    if (u.includes(k)) return n;
  }
  return kind === 'ollama' ? 'Ollama' : kind === 'piper' ? 'Piper' : 'Language model';
};

/** The single legacy model as a one-item chain (empty when none was configured). */
export function chainFromLegacyLlm(l: AiLlmSettings): AiLlmProvider[] {
  if (l.provider === 'none' || !l.url || !l.model) return [];
  const paid = /openai\.com|deepseek|anthropic/.test(l.url);
  return [{ id: 'default', name: nameFor(l.url, l.provider), kind: l.provider, url: l.url, model: l.model, enabled: true, paid, dailyCap: null, apiKey: l.apiKey }];
}

/** The DJ's old single voice as a one-item chain ('device' = empty chain: each device speaks). */
export function chainFromLegacyTts(t: Partial<AiDjSettings['tts']> | undefined): AiTtsProvider[] {
  if (!t) return [];
  if (t.provider === 'piper' && t.voiceModel) {
    return [{ id: 'default', name: 'Piper', kind: 'piper', url: '', piperPath: t.piperPath ?? null, voiceModel: t.voiceModel, speaker: t.speaker ?? null, model: null, voice: null, enabled: true, paid: false, dailyCap: null, apiKey: null }];
  }
  if (t.provider === 'openai' && t.url) {
    const kokoro = /:8880|kokoro/i.test(`${t.url} ${t.model ?? ''}`);
    return [{ id: 'default', name: kokoro ? 'Kokoro' : nameFor(t.url, 'openai'), kind: kokoro ? 'kokoro' : 'openai', url: t.url, model: t.model ?? null, voice: t.voice ?? null, enabled: true, paid: /openai\.com/.test(t.url), dailyCap: null, apiKey: t.apiKey ?? null }];
  }
  return [];
}

/**
 * Keep the legacy single-model field describing the chain for older apps, backups and embeddings: the first enabled
 * Ollama / OpenAI-compatible provider, else provider 'none' (the rest of `llm` kept).
 */
export function mirrorLegacyLlm(ai: AiSettings): AiSettings {
  const p = (ai.llmProviders ?? []).find((x) => x.enabled && (x.kind === 'ollama' || x.kind === 'openai') && x.url && x.model);
  const llm: AiLlmSettings = p
    ? { provider: p.kind as 'ollama' | 'openai', url: p.url, model: p.model, apiKey: p.apiKey ?? null, maxRequestsPerDay: ai.llm.maxRequestsPerDay }
    : { ...ai.llm, provider: 'none' };
  return { ...ai, llm };
}

/** Apply an edit of the legacy `llm` field (older admin apps, aiDj.llm) to the chain provider it mirrors. */
function applyLegacyLlm(ai: AiSettings, llm: AiLlmSettings): AiSettings {
  const chain = [...(ai.llmProviders ?? [])];
  const src = chain.find((x) => x.enabled && (x.kind === 'ollama' || x.kind === 'openai') && x.url && x.model)?.id ?? 'default';
  const i = chain.findIndex((x) => x.id === src);
  if (llm.provider === 'none' || !llm.url || !llm.model) {
    if (i >= 0) chain[i] = { ...chain[i], enabled: false };
  } else {
    const next = chainFromLegacyLlm(llm)[0];
    if (i >= 0) chain[i] = { ...chain[i], kind: next.kind, url: next.url, model: next.model, apiKey: next.apiKey, enabled: true };
    else chain.unshift(next);
  }
  return mirrorLegacyLlm({ ...ai, llm: { ...llm }, llmProviders: chain });
}

/** Stored settings → AI section. Without one yet, the DJ's language model becomes the shared one (transparent migration). */
export function aiFromStored(stored: Partial<ServerSettings>): AiSettings {
  const ai = stored.ai ? normaliseAi(stored.ai) : normaliseAi({ llm: { ...DEFAULT_LLM, ...(stored.aiDj?.llm ?? {}) } });
  // Before provider chains: the single model / the DJ's single voice become one-item chains.
  if (!Array.isArray(stored.ai?.llmProviders)) ai.llmProviders = chainFromLegacyLlm(ai.llm);
  if (!Array.isArray(stored.ai?.ttsProviders)) ai.ttsProviders = chainFromLegacyTts(stored.aiDj?.tts);
  return mirrorLegacyLlm(ai);
}

const sameLlm = (a: AiLlmSettings | undefined, b: AiLlmSettings | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Merge a settings patch into the AI section. `patch.ai` wins; otherwise a changed `patch.aiDj.llm` (older admin apps,
 * the DJ API) updates the shared model. Secrets must already be unmasked.
 */
export function mergeAi(cur: AiSettings, patch: Partial<ServerSettings>, curDjLlm: AiLlmSettings, curDjTts?: AiDjSettings['tts']): AiSettings {
  let next = cur;
  if (patch.ai) {
    next = normaliseAi(patch.ai, cur);
    // An older client edited the single `llm` field (and left the chain as it was): apply it to the chain.
    const chainSame = !Array.isArray(patch.ai.llmProviders) || JSON.stringify(next.llmProviders) === JSON.stringify(cur.llmProviders);
    if (chainSame && !sameLlm(next.llm, cur.llm)) next = applyLegacyLlm(next, next.llm);
    else next = mirrorLegacyLlm(next);
  } else {
    const djLlm = patch.aiDj?.llm;
    if (djLlm && !sameLlm({ ...curDjLlm, ...djLlm }, curDjLlm)) next = applyLegacyLlm(cur, normaliseLlm({ ...curDjLlm, ...djLlm }, cur.llm));
  }
  // Older admin apps still edit the DJ's single voice (aiDj.tts): it becomes the chain's 'default' voice.
  const djTts = patch.aiDj?.tts;
  if (djTts && curDjTts && !(patch.ai && Array.isArray(patch.ai.ttsProviders)) && JSON.stringify({ ...curDjTts, ...djTts }) !== JSON.stringify(curDjTts)) {
    const rest = (next.ttsProviders ?? []).filter((p) => p.id !== 'default');
    next = { ...next, ttsProviders: [...chainFromLegacyTts({ ...curDjTts, ...djTts }), ...rest] };
  }
  return next;
}
