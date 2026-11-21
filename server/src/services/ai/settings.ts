/**
 * Server-wide AI settings (Admin → AI): one language model shared by the AI DJ, Ask, recaps and automatic subtitles,
 * per-feature switches and each feature's options.
 *
 * Migration: before this section existed the language model lived under `aiDj.llm`. When `ai` is missing it is built
 * from `aiDj.llm`, and `aiDj.llm` keeps mirroring `ai.llm` so older apps, backups and the DJ API see the same model.
 * Pure functions only (settings.ts calls them), so there is no import cycle.
 */
import type { AiLlmSettings, AiSettings, AutoSubtitleSettings, ServerSettings } from '@mediamax/shared';

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
  };
}

/** Stored settings → AI section. Without one yet, the DJ's language model becomes the shared one (transparent migration). */
export function aiFromStored(stored: Partial<ServerSettings>): AiSettings {
  if (stored.ai) return normaliseAi(stored.ai);
  return normaliseAi({ llm: { ...DEFAULT_LLM, ...(stored.aiDj?.llm ?? {}) } });
}

const sameLlm = (a: AiLlmSettings | undefined, b: AiLlmSettings | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Merge a settings patch into the AI section. `patch.ai` wins; otherwise a changed `patch.aiDj.llm` (older admin apps,
 * the DJ API) updates the shared model. Secrets must already be unmasked.
 */
export function mergeAi(cur: AiSettings, patch: Partial<ServerSettings>, curDjLlm: AiLlmSettings): AiSettings {
  if (patch.ai) return normaliseAi(patch.ai, cur);
  const djLlm = patch.aiDj?.llm;
  if (djLlm && !sameLlm({ ...curDjLlm, ...djLlm }, curDjLlm)) return { ...cur, llm: normaliseLlm({ ...curDjLlm, ...djLlm }, cur.llm) };
  return cur;
}
