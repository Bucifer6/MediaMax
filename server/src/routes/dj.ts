import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DjFeedback, DjHostRequest, DjMixRequest, DjStatus, DjTransitionPreference } from '@mediamax/shared';
import { db } from '../db.js';
import { requireAdmin, requireUser } from '../http.js';
import { assertCanSee } from '../services/items.js';
import { analyseTrack, analysisOutdated, analysisStatus, getAnalysis, upgradeLazily } from '../services/dj/analysis.js';
import { buildMix, planTransition } from '../services/dj/mix.js';
import { buildTransitionGraph, ffmpegHasFilter, renderTransition } from '../services/dj/render.js';
import { parseJson } from '../util/misc.js';
import { findSeed, hostLine, llmChat, llmUsage, parsePrompt, recordFeedback, serverVoiceConfigured, speak, voiceFile } from '../services/dj/ai.js';
import { getSettings } from '../services/settings.js';
import { runTask } from '../services/tasks.js';
import { badRequest, forbidden, notFound } from '../util/errors.js';

/** DJ mode and the AI DJ: analysis, automatic beat/key-aware mixes, natural-language requests and a spoken host. */
export default async function djRoutes(app: FastifyInstance) {
  const aiOn = () => {
    const ai = getSettings().aiDj;
    if (!ai.enabled) throw forbidden('The AI DJ is turned off on this server');
    return ai;
  };

  app.get('/dj/status', async (req): Promise<DjStatus> => {
    requireUser(req);
    const ai = getSettings().aiDj;
    return {
      ...analysisStatus(),
      ai: {
        enabled: ai.enabled, llm: ai.llm.provider !== 'none' && !!ai.llm.url && !!ai.llm.model,
        serverVoice: serverVoiceConfigured(), hostName: ai.hostName, chattiness: ai.chattiness,
      },
    };
  });

  app.post('/dj/analyze', async (req) => {
    requireAdmin(req);
    void runTask('dj-analysis').catch(() => {});
    return { ok: true };
  });

  // Analysis for one track; analysed on demand (≈0.5 s) when it hasn't been yet.
  app.get<{ Params: { id: string } }>('/items/:id/analysis', async (req) => {
    const { user } = requireUser(req);
    const row = assertCanSee(user, req.params.id);
    if (row.type !== 'track') throw badRequest('Only music tracks can be analysed');
    // Outdated analyses (older algorithm) are re-run on demand; it takes about half a second.
    if (analysisOutdated(req.params.id)) return (await analyseTrack(req.params.id)) ?? getAnalysis(req.params.id);
    return getAnalysis(req.params.id) ?? (await analyseTrack(req.params.id));
  });

  app.post<{ Body: DjMixRequest }>('/dj/mix', async (req) => {
    const { user } = requireUser(req);
    let body: DjMixRequest = req.body ?? {};
    if (body.history && (!Array.isArray(body.history) || body.history.length > 2000)) throw badRequest('history must be a list of up to 2000 item ids');
    if (body.genres && !Array.isArray(body.genres)) throw badRequest('genres must be a list');
    let summary: string | undefined;
    let understoodBy: 'llm' | 'rules' | undefined;
    let continuous: boolean | undefined;
    // AI DJ: turn a plain-language request into mix settings (explicit fields in the body still win).
    if (typeof body.prompt === 'string' && body.prompt.trim()) {
      aiOn();
      if (body.prompt.length > 500) throw badRequest('Keep the request under 500 characters');
      const parsed = await parsePrompt(user, body.prompt.trim());
      const explicit = Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== undefined && k !== 'prompt'));
      body = { ...parsed.request, ...explicit };
      if (!body.seedItemId && parsed.seedName && !body.history?.length) body.seedItemId = findSeed(user, parsed.seedName) ?? undefined;
      summary = parsed.summary;
      understoodBy = parsed.by;
      continuous = parsed.continuous;
    }
    // Make sure the track we're mixing out of has been analysed, so the first transition is beat-matched.
    const last = body.history?.[body.history.length - 1];
    if (last && (!getAnalysis(last) || analysisOutdated(last))) {
      try {
        if (assertCanSee(user, last).type === 'track') await analyseTrack(last);
      } catch {
        /* unknown or hidden item: ignore */
      }
    }
    let mix;
    try {
      mix = buildMix(user, body);
    } catch (e) {
      // A prompt that filtered everything out: relax the filters before giving up.
      if (!summary) throw e;
      body = { ...body, yearFrom: undefined, yearTo: undefined, bpmMin: undefined, bpmMax: undefined, maxTrackMinutes: undefined };
      mix = buildMix(user, body);
      summary = `${summary} (relaxed: nothing matched exactly)`;
    }
    // Tracks with an older-version analysis (no phrases yet) are upgraded in the background, a few per request.
    upgradeLazily(mix.tracks.map((t) => t.item.id));
    const { history: _h, count: _c, ...resolved } = body;
    return { ...mix, summary, understoodBy, continuous, request: resolved };
  });

  /** AI DJ host: a short spoken link between two tracks. */
  app.post<{ Body: DjHostRequest }>('/dj/host', async (req) => {
    const { user } = requireUser(req);
    aiOn();
    const b = req.body;
    if (!b?.nextItemId) throw badRequest('nextItemId is required');
    assertCanSee(user, b.nextItemId);
    if (b.previousItemId) assertCanSee(user, b.previousItemId);
    return hostLine(user, { ...b, prompt: b.prompt?.slice(0, 300), position: Math.max(0, Number(b.position) || 0) });
  });

  /**
   * Hear a transition: renders "end of A → start of B" with the planned style (bass swap, filter fade, echo-out,
   * tempo match with key lock) through ffmpeg. ~25 s of MP3.
   */
  app.get<{ Querystring: { from?: string; to?: string; transitions?: string; maxStretchPct?: string } }>('/dj/transition-preview', async (req, reply) => {
    const { user } = requireUser(req);
    const { from, to } = req.query;
    if (!from || !to) throw badRequest('from and to are required');
    const file = (id: string) => {
      if (assertCanSee(user, id).type !== 'track') throw badRequest('Only music tracks can be mixed');
      const m = db.get<{ path: string; duration_ms: number | null; genres: string | null }>("SELECT m.path, m.duration_ms, i.genres FROM media m JOIN items i ON i.id = m.item_id WHERE i.id = ? AND m.path IS NOT NULL LIMIT 1", id);
      if (!m) throw notFound('Track file not found');
      return m;
    };
    const fa = file(from);
    const fb = file(to);
    const ensure = async (id: string) => (!getAnalysis(id) || analysisOutdated(id) ? await analyseTrack(id) : getAnalysis(id)) ?? getAnalysis(id);
    const [a, b] = await Promise.all([ensure(from), ensure(to)]);
    const prefs: DjTransitionPreference[] = ['auto', 'smooth', 'energetic', 'minimal'];
    const pref = prefs.includes(req.query.transitions as DjTransitionPreference) ? (req.query.transitions as DjTransitionPreference) : 'auto';
    const stretch = Number(req.query.maxStretchPct);
    const tr = planTransition(a, fa.duration_ms ?? a?.durationMs ?? 0, b, {
      preference: pref, maxStretch: Number.isFinite(stretch) && stretch > 0 ? Math.min(16, stretch) / 100 : 0.08,
      genresA: parseJson<string[]>(fa.genres, []).map((g) => g.toLowerCase()), genresB: parseJson<string[]>(fb.genres, []).map((g) => g.toLowerCase()),
    });
    const glideMs = tr.beatMs ? tr.beatMs * 4 * 8 : 8000;
    const plan = buildTransitionGraph(tr, { leadMs: 8000, tailMs: 10000, glideMs, rubberband: ffmpegHasFilter('rubberband') });
    const out = path.join(os.tmpdir(), `mediamax-djprev-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);
    try {
      await renderTransition(fa.path, fb.path, plan, out);
      const buf = fs.readFileSync(out);
      reply.header('Content-Type', 'audio/mpeg').header('Cache-Control', 'private, max-age=3600')
        .header('X-DJ-Transition', encodeURIComponent(JSON.stringify({ style: tr.style, fx: tr.fx, crossfadeMs: tr.crossfadeMs, tempoRatio: tr.tempoRatio, stretch: plan.stretch })));
      return reply.send(buf);
    } finally {
      fs.rm(out, { force: true }, () => {});
    }
  });

  app.get<{ Params: { file: string } }>('/dj/voice/:file', async (req, reply) => {
    requireUser(req);
    const f = voiceFile(req.params.file);
    if (!f) throw notFound('Voice clip not found');
    reply.header('Content-Type', 'audio/mpeg').header('Cache-Control', 'private, max-age=604800');
    return reply.send(fs.createReadStream(f));
  });

  app.post<{ Body: DjFeedback }>('/dj/feedback', async (req) => {
    const { user } = requireUser(req);
    const b = req.body;
    if (!b?.itemId || (b.kind !== 'skip' && b.kind !== 'love')) throw badRequest('itemId and kind (skip|love) are required');
    assertCanSee(user, b.itemId);
    recordFeedback(user, b.itemId, b.kind);
    return { ok: true };
  });

  /** Admin: check the language model / Piper voice from the settings page. */
  app.post<{ Body: { kind: 'llm' | 'tts' } }>('/dj/ai/test', async (req) => {
    requireAdmin(req);
    if (req.body?.kind === 'tts') {
      const v = await speak(`Hi, this is ${getSettings().aiDj.hostName}. Your MediaMax DJ is ready.`).catch((e) => {
        throw badRequest(`Piper failed: ${(e as Error).message}`);
      });
      if (!v) throw badRequest('Choose a server voice (Piper or a speech API) first');
      return { ok: true, audioUrl: `/api/v1/dj/voice/${v.file}` };
    }
    const t = Date.now();
    const r = await llmChat('Reply with exactly: OK', 'Say OK.', { maxTokens: 5, temperature: 0 });
    if (!r) throw badRequest('No reply from the language model — check the URL, model name, API key, and the daily limit');
    return { ok: true, reply: r.slice(0, 100), ms: Date.now() - t, usage: llmUsage() };
  });
}
