import type { FastifyInstance } from 'fastify';
import type { AiHealthResponse, AiLlmProvider, AiTtsProvider, AiProviderTestRequest, AiProviderTestResponse, AiStatus, AskRequest, AskResponse, RecapResponse, WhisperModelSize } from '@mediamax/shared';
import { requireAdmin, requireUser } from '../http.js';
import { badRequest, forbidden } from '../util/errors.js';
import { aiSettings, featureEnabled, llmAvailable, llmChat, llmConfigured, llmUsage } from '../services/ai/llm.js';
import { ask } from '../services/ask/search.js';
import { currentModelId, embeddingProgress, embeddingsEnabled, localEmbedError } from '../services/ask/embed.js';
import { getRecap } from '../services/recap.js';
import { assertCanSee } from '../services/items.js';
import { autoSubtitleStatus, cancelJob, clearFinished, enqueue, isRunning, runAutoSubtitles, stopAutoSubtitles } from '../services/autosubs/queue.js';
import { downloadModel, downloadWhisperBinary, WHISPER_MODELS } from '../services/autosubs/engine.js';
import { runTask } from '../services/tasks.js';
import { chatOnce } from '../services/ai/llm.js';
import { fallbackEvents, providerHealth, runChain } from '../services/ai/chain.js';
import { speakChain } from '../services/ai/tts.js';
import { getSettings } from '../services/settings.js';
import { logger } from '../util/log.js';

const log = logger('ai');

/** Admin → AI (shared language model, automatic subtitles, Ask embeddings) and the user-facing Ask and recaps. */
export default async function aiRoutes(app: FastifyInstance) {
  /* ------------------------------ admin ------------------------------ */

  app.get('/ai/status', async (req): Promise<AiStatus> => {
    requireAdmin(req);
    const s = aiSettings();
    const p = embeddingProgress();
    return {
      llmConfigured: llmConfigured(), features: s.features, usage: llmUsage(),
      embeddings: { enabled: embeddingsEnabled(), source: s.ask.embeddingSource, ready: p.count > 0, count: p.count, total: p.total, model: currentModelId(), error: localEmbedError() },
    };
  });

  app.post('/ai/test', async (req) => {
    requireAdmin(req);
    if (!llmConfigured()) throw badRequest('No language model is configured');
    const t = Date.now();
    const r = await llmChat('Reply with exactly: OK', 'Say OK.', { maxTokens: 5, temperature: 0, timeoutMs: 30000 });
    if (!r) throw badRequest('The model did not answer. Check the URL, model name and key (or the daily limit).');
    return { ok: true, reply: r.slice(0, 100), ms: Date.now() - t, usage: llmUsage() };
  });

  /** Provider chains: health (cooldowns, last errors, calls) and the fallback log, newest first. */
  app.get('/ai/health', async (req): Promise<AiHealthResponse> => {
    requireAdmin(req);
    const s = aiSettings();
    return { providers: [...providerHealth('llm', s.llmProviders ?? []), ...providerHealth('tts', s.ttsProviders ?? [])], events: fallbackEvents() };
  });

  /** Explicit test of one provider (ignores its cooldown and daily cap; the result updates its health). Save first. */
  app.post<{ Body: AiProviderTestRequest }>('/ai/providers/test', async (req): Promise<AiProviderTestResponse> => {
    requireAdmin(req);
    const { kind, providerId } = req.body ?? ({} as AiProviderTestRequest);
    if (kind !== 'llm' && kind !== 'tts') throw badRequest('kind must be llm or tts');
    const s = aiSettings();
    const list = kind === 'llm' ? s.llmProviders ?? [] : s.ttsProviders ?? [];
    const p = list.find((x) => x.id === providerId);
    if (!p) throw badRequest('Unknown provider (save the settings first)');
    const t = Date.now();
    const errorOf = () => providerHealth(kind, [p]).find((h) => h.lastErrorAt && Date.parse(h.lastErrorAt) >= t)?.lastError ?? 'No usable reply';
    if (kind === 'llm') {
      const lp = p as AiLlmProvider;
      const r = await runChain('llm', [{ ...lp, enabled: true }], (x) => chatOnce(x, 'Reply with exactly: OK', 'Say OK.', { maxTokens: 10, temperature: 0, timeoutMs: 30000 }), { feature: 'test', force: true });
      return r ? { ok: true, ms: Date.now() - t, sample: r.value.slice(0, 100) } : { ok: false, ms: Date.now() - t, error: errorOf() };
    }
    const v = await speakChain(`Hi, this is ${getSettings().aiDj.hostName}. Your Vibe DJ is ready.`, { providers: [{ ...(p as AiTtsProvider), enabled: true }], force: true, feature: 'test' });
    return v ? { ok: true, ms: Date.now() - t, sample: `/api/v1/dj/voice/${v.file}` } : { ok: false, ms: Date.now() - t, error: errorOf() };
  });

  app.get('/ai/subtitles', async (req) => {
    requireAdmin(req);
    return { ...autoSubtitleStatus(), models: WHISPER_MODELS };
  });

  app.post<{ Body: { itemId?: string; language?: string } }>('/ai/subtitles/queue', async (req) => {
    const { user } = requireAdmin(req);
    const { itemId, language } = req.body ?? {};
    if (!itemId || !language) throw badRequest('itemId and language are required');
    assertCanSee(user, itemId);
    try {
      return enqueue(itemId, language, 'manual');
    } catch (e) {
      throw badRequest((e as Error).message);
    }
  });

  // "Run now": process the queue now, ignoring the night window (still one job at a time, low priority).
  app.post('/ai/subtitles/run', async (req) => {
    requireAdmin(req);
    if (!featureEnabled('autoSubtitles')) throw badRequest('Automatic subtitles are switched off (Admin → AI)');
    if (!isRunning()) void runAutoSubtitles(() => {}, { ignoreWindow: true }).catch((e) => log.warn(`Automatic subtitles: ${(e as Error).message}`));
    return { ok: true };
  });

  app.post('/ai/subtitles/stop', async (req) => {
    requireAdmin(req);
    stopAutoSubtitles();
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/ai/subtitles/jobs/:id', async (req) => {
    requireAdmin(req);
    cancelJob(req.params.id);
    return { ok: true };
  });

  app.post<{ Body: { status?: 'done' | 'error' | 'skipped' | 'all' } }>('/ai/subtitles/clear', async (req) => {
    requireAdmin(req);
    const st = req.body?.status ?? 'all';
    if (!['done', 'error', 'skipped', 'all'].includes(st)) throw badRequest('Invalid status');
    clearFinished(st);
    return { ok: true };
  });

  app.post<{ Body: { what?: 'binary' | 'model'; model?: WhisperModelSize } }>('/ai/whisper/download', async (req) => {
    requireAdmin(req);
    const what = req.body?.what;
    if (what === 'binary') {
      void downloadWhisperBinary().catch(() => {});
      return { ok: true };
    }
    if (what === 'model') {
      const m = req.body?.model ?? aiSettings().autoSubtitles.model;
      if (!(m in WHISPER_MODELS)) throw badRequest('Unknown model');
      void downloadModel(m).catch(() => {});
      return { ok: true };
    }
    throw badRequest('what must be "binary" or "model"');
  });

  app.post('/ai/embeddings/build', async (req) => {
    requireAdmin(req);
    void runTask('ask-embeddings').catch(() => {});
    return { ok: true };
  });

  /* ------------------------------ users ------------------------------ */

  // What the apps should show: Ask, recaps, and whether a model makes them smarter.
  app.get('/ai/features', async (req) => {
    requireUser(req);
    return { ask: featureEnabled('ask'), recaps: featureEnabled('recaps'), askUsesModel: llmAvailable('ask'), recapsUseModel: llmAvailable('recaps') };
  });

  app.post<{ Body: AskRequest }>('/ask', async (req): Promise<AskResponse> => {
    const { user } = requireUser(req);
    if (!featureEnabled('ask')) throw forbidden('Ask is switched off on this server');
    const body = req.body ?? ({} as AskRequest);
    if (typeof body.q !== 'string' || !body.q.trim()) throw badRequest('q is required');
    if (body.remove !== undefined && !Array.isArray(body.remove)) throw badRequest('remove must be a list');
    return ask(user, body);
  });

  app.get<{ Params: { id: string }; Querystring: { force?: string } }>('/items/:id/recap', async (req): Promise<RecapResponse> => {
    const { user } = requireUser(req);
    return getRecap(user, req.params.id, { force: req.query.force === '1' || req.query.force === 'true' });
  });
}
