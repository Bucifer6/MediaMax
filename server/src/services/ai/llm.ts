/**
 * The shared language-model client (Admin → AI): an ordered chain of providers (Ollama, any OpenAI-compatible API,
 * Anthropic, Gemini) with silent fallback (chain.ts), one daily call budget for every feature, and per-feature
 * switches. With no provider, a feature switched off, the budget used up or every provider failing, every call
 * returns null and the feature uses its built-in fallback.
 */
import type { AiFeature, AiLlmProvider, AiSettings } from '@mediamax/shared';
import { checkResponse, runChain } from './chain.js';
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

/** Chain providers that can be called (enabled, with a URL where the kind needs one, and a model). */
export function llmProviders(): AiLlmProvider[] {
  return (aiSettings().llmProviders ?? []).filter((p) => p.enabled && p.model && (p.url || p.kind === 'anthropic' || p.kind === 'gemini'));
}

/** A model is set up (at least one enabled provider in the chain). */
export function llmConfigured(): boolean {
  return llmProviders().length > 0;
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
  /** Reject a reply (treated like a failed provider: the next one is tried). */
  validate?: (text: string) => boolean;
}

const base = (u: string) => u.replace(/\/+$/, '');

/** Anthropic Messages endpoint from a pasted base (https://api.anthropic.com, …/v1 or …/v1/messages). */
export function anthropicUrl(u: string): string {
  const b = base(u || 'https://api.anthropic.com').replace(/\/messages$/, '');
  return /\/v1$/.test(b) ? `${b}/messages` : `${b}/v1/messages`;
}

/** Gemini generateContent endpoint from a pasted base (https://generativelanguage.googleapis.com, …/v1beta). */
export function geminiUrl(u: string, model: string): string {
  let b = base(u || 'https://generativelanguage.googleapis.com').replace(/\/models\/.*$/, '').replace(/\/openai$/, '');
  if (!/\/v1(beta|alpha)?\d*$/.test(b)) b += '/v1beta';
  return `${b}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`;
}

/** One chat call to one provider. Throws ProviderError (or a network error) on failure; null for an empty reply. */
export async function chatOnce(p: AiLlmProvider, system: string, user: string, opts: ChatOptions = {}): Promise<string | null> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 45000);
  const temperature = opts.temperature ?? 0.7;
  const maxTokens = opts.maxTokens ?? 300;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const post = async (url: string, body: unknown) => checkResponse(await fetch(url, { method: 'POST', headers, signal, body: JSON.stringify(body) }));
  let text: string | undefined;
  if (p.kind === 'anthropic') {
    if (p.apiKey) headers['x-api-key'] = p.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    const sys = opts.json ? `${system}\nReply with one JSON object only.` : system;
    const j = (await (await post(anthropicUrl(p.url), { model: p.model, max_tokens: maxTokens, temperature, system: sys, messages: [{ role: 'user', content: user }] })).json()) as { content?: { type?: string; text?: string }[] };
    text = j.content?.filter((c) => c.type === 'text' || c.text).map((c) => c.text ?? '').join('');
  } else if (p.kind === 'gemini') {
    if (p.apiKey) headers['x-goog-api-key'] = p.apiKey;
    const j = (await (await post(geminiUrl(p.url, p.model), {
      systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature, maxOutputTokens: maxTokens, ...(opts.json ? { responseMimeType: 'application/json' } : {}) },
    })).json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    text = j.candidates?.[0]?.content?.parts?.map((x) => x.text ?? '').join('');
  } else {
    if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    if (p.kind === 'ollama' && !/\/v1$/.test(base(p.url))) {
      const j = (await (await post(`${base(p.url)}/api/chat`, { model: p.model, messages, stream: false, ...(opts.json ? { format: 'json' } : {}), options: { temperature, num_predict: maxTokens } })).json()) as { message?: { content?: string } };
      text = j.message?.content;
    } else {
      const j = (await (await post(openaiUrl(p.url, 'chat/completions'), { model: p.model, messages, temperature, max_tokens: maxTokens, ...(opts.json ? { response_format: { type: 'json_object' } } : {}) })).json()) as { choices?: { message?: { content?: string } }[] };
      text = j.choices?.[0]?.message?.content;
    }
  }
  const t = text?.trim();
  if (!t) return null;
  if (opts.validate && !opts.validate(t)) return null;
  return t;
}

/**
 * Send a chat through the provider chain (first healthy provider wins; failures fall through silently). Returns the
 * reply text, or null when no model is set up, the feature is off, the budget is used up or every provider failed.
 */
export async function llmChat(system: string, user: string, opts: ChatOptions = {}): Promise<string | null> {
  const chain = llmProviders();
  if (!chain.length) return null;
  if (opts.feature && !featureEnabled(opts.feature)) return null;
  if (!takeBudget()) {
    log.info('Daily language-model budget used up; AI features use their built-in fallbacks until tomorrow');
    return null;
  }
  const r = await runChain('llm', chain, (p) => chatOnce(p, system, user, opts), { feature: opts.feature ?? 'admin' });
  return r?.value ?? null;
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
