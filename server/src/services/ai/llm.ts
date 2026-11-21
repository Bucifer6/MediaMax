/**
 * The shared language-model client (Admin → AI): Ollama or any OpenAI-compatible chat API, one daily call budget for
 * every feature, and per-feature switches. With provider 'none', a feature switched off or the budget used up, every
 * call returns null and the feature uses its built-in fallback.
 */
import type { AiFeature, AiSettings } from '@mediamax/shared';
import { getSettings } from '../settings.js';
import { DEFAULT_AI } from './settings.js';
import { logger } from '../../util/log.js';

const log = logger('ai');

export const aiSettings = (): AiSettings => getSettings().ai ?? DEFAULT_AI;

/** OpenAI-compatible endpoint for `path` (e.g. "chat/completions") from whatever base URL the admin pasted. */
export function openaiUrl(base: string, pathPart: string): string {
  const b = base.replace(/\/+$/, '').replace(/\/(chat\/completions|audio\/speech|audio\/transcriptions|embeddings)$/, '');
  // Bases that already carry an API version or an /openai prefix: Groq …/openai/v1, Gemini …/v1beta/openai, OpenRouter …/api/v1.
  return /\/(v\d+[a-z0-9]*|openai)$/i.test(b) ? `${b}/${pathPart}` : `${b}/v1/${pathPart}`;
}

/** A model is set up (provider, URL and model name). */
export function llmConfigured(): boolean {
  const c = aiSettings().llm;
  return c.provider !== 'none' && !!c.url && !!c.model;
}

/** The feature is switched on in Admin → AI. */
export const featureEnabled = (f: AiFeature): boolean => aiSettings().features[f] !== false;

/** The feature may call the language model right now (configured and switched on). */
export const llmAvailable = (f: AiFeature): boolean => llmConfigured() && featureEnabled(f);

// Daily call budget shared by every feature so hosted free tiers stay free (resets at UTC midnight).
let budget = { day: '', used: 0 };
function takeBudget(): boolean {
  const max = aiSettings().llm.maxRequestsPerDay;
  const day = new Date().toISOString().slice(0, 10);
  if (budget.day !== day) budget = { day, used: 0 };
  if (max > 0 && budget.used >= max) return false;
  budget.used++;
  return true;
}
export const llmUsage = () => {
  const day = new Date().toISOString().slice(0, 10);
  return { day, used: budget.day === day ? budget.used : 0, max: aiSettings().llm.maxRequestsPerDay };
};
/** Tests: start a fresh day. */
export const resetLlmBudget = () => {
  budget = { day: '', used: 0 };
};

export interface ChatOptions {
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Feature making the call; switched-off features get null. Omit for admin tests. */
  feature?: AiFeature;
  timeoutMs?: number;
}

/** Send a chat to the configured model. Returns the reply text, or null when no model is set up / it fails. */
export async function llmChat(system: string, user: string, opts: ChatOptions = {}): Promise<string | null> {
  const cfg = aiSettings().llm;
  if (!llmConfigured()) return null;
  if (opts.feature && !featureEnabled(opts.feature)) return null;
  if (!takeBudget()) {
    log.info('Daily language-model budget used up; AI features use their built-in fallbacks until tomorrow');
    return null;
  }
  const base = cfg.url!.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 45000);
  try {
    if (cfg.provider === 'ollama') {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST', headers, signal,
        body: JSON.stringify({ model: cfg.model, messages, stream: false, ...(opts.json ? { format: 'json' } : {}), options: { temperature: opts.temperature ?? 0.7, num_predict: opts.maxTokens ?? 300 } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { message?: { content?: string } };
      return j.message?.content?.trim() || null;
    }
    const res = await fetch(openaiUrl(base, 'chat/completions'), {
      method: 'POST', headers, signal,
      body: JSON.stringify({ model: cfg.model, messages, temperature: opts.temperature ?? 0.7, max_tokens: opts.maxTokens ?? 300, ...(opts.json ? { response_format: { type: 'json_object' } } : {}) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    log.warn(`Language model request failed: ${(e as Error).message}`);
    return null;
  }
}

/** Pull the first JSON object out of a model reply (models like to wrap JSON in prose or code fences). */
export function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Embeddings from the language-model server (Ollama /api/embed or OpenAI-compatible /embeddings). Null when not
 * configured or failing. Not counted against the chat budget (embedding calls are cheap and batched).
 */
export async function llmEmbed(texts: string[], model: string | null): Promise<Float32Array[] | null> {
  const cfg = aiSettings().llm;
  if (cfg.provider === 'none' || !cfg.url || !model || !texts.length) return null;
  const base = cfg.url.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  try {
    if (cfg.provider === 'ollama') {
      const res = await fetch(`${base}/api/embed`, { method: 'POST', headers, signal: AbortSignal.timeout(120000), body: JSON.stringify({ model, input: texts }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { embeddings?: number[][] };
      return j.embeddings?.length === texts.length ? j.embeddings.map((e) => Float32Array.from(e)) : null;
    }
    const res = await fetch(openaiUrl(base, 'embeddings'), { method: 'POST', headers, signal: AbortSignal.timeout(120000), body: JSON.stringify({ model, input: texts }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { data?: { embedding: number[]; index?: number }[] };
    if (!j.data || j.data.length !== texts.length) return null;
    return [...j.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => Float32Array.from(d.embedding));
  } catch (e) {
    log.warn(`Embedding request failed: ${(e as Error).message}`);
    return null;
  }
}
