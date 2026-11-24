import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DjBreakRequest, DjBreakResponse, DjFeedback, DjHostRequest, DjRules, DjRulesResponse, DjSessionNextRequest, DjSessionRequestBody, DjSessionStartRequest, DjSuggestions, DjMixRequest, DjOrderRequest, DjOrderResponse, DjStatus, DjTransition, DjTransitionsRequest, DjTransitionsResponse, TrackAnalysis } from '@mediamax/shared';
import { db } from '../db.js';
import { remoteAddr, requireAdmin, requireUser } from '../http.js';
import { assertRemoteAllowed } from '../services/playback.js';
import { accessClause, assertCanSee, itemsByIds } from '../services/items.js';
import { analyseOnDemand, analysisOutdated, getAnalyses, analysisStatus, getAnalysis, upgradeLazily } from '../services/dj/analysis.js';
import { buildMix, orderTracks, planTransition, transitionOptions } from '../services/dj/mix.js';
import { buildTransitionGraph, ffmpegHasFilter, renderTransition } from '../services/dj/render.js';
import { parseJson } from '../util/misc.js';
import { findSeed, hostLine, llmChat, llmUsage, parsePrompt, recordFeedback, serverVoiceConfigured, speak, voiceFile } from '../services/dj/ai.js';
import { getSettings } from '../services/settings.js';
import { llmAvailable } from '../services/ai/llm.js';
import { runTask } from '../services/tasks.js';
import { badRequest, forbidden, notFound } from '../util/errors.js';
import { getEnforced, rulesResponse, setEnforced } from '../services/dj/rules.js';
import { getSession, moreSession, requestSession, segmentStartingAt, startSession, suggestions, switchSession } from '../services/dj/session.js';
import { makeBreak } from '../services/dj/host/breaks.js';
import { getUser } from '../services/auth.js';

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
        enabled: ai.enabled, llm: llmAvailable('dj'),
        serverVoice: serverVoiceConfigured(), hostName: ai.hostName, chattiness: ai.chattiness,
        yourDj: ai.enabled, radioHost: ai.enabled, weather: !!getSettings().ai?.weatherLocation, onlineFacts: getSettings().ai?.onlineFacts === true,
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
    // Not analysed yet, outdated (older algorithm) or the file changed: analysed now (≈0.3 s, throttled, local only).
    // null when the track can't be analysed (undecodable, under 5 s); clients then use a plain crossfade.
    return analyseOnDemand(req.params.id);
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
        if (assertCanSee(user, last).type === 'track') await analyseOnDemand(last);
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

  /**
   * Plan many transitions at once (lite automix): stored analyses only — no on-demand analysis, no AI, no network.
   * An unanalysed side gets planTransition's plain fade.
   */
  app.post<{ Body: DjTransitionsRequest }>('/dj/transitions', async (req): Promise<DjTransitionsResponse> => {
    const { user } = requireUser(req);
    const b = req.body;
    if (!b || !Array.isArray(b.pairs)) throw badRequest('pairs must be a list of {from, to}');
    if (b.pairs.length > 50) throw badRequest('At most 50 pairs per request');
    if (b.pairs.some((p) => !p || typeof p !== 'object' || typeof p.from !== 'string' || typeof p.to !== 'string' || !p.from || !p.to || p.from.length > 100 || p.to.length > 100)) {
      throw badRequest('Each pair needs string ids from and to');
    }
    const ids = [...new Set(b.pairs.flatMap((p) => [p.from, p.to]))];
    const acc = accessClause(user, 'i');
    // Tracks the user may see (library access and parental ratings), with their file's duration and genres.
    const rows = db.all<{ id: string; duration_ms: number | null; genres: string | null }>(
      `SELECT i.id, COALESCE(m.duration_ms, i.duration_ms) duration_ms, i.genres FROM items i LEFT JOIN media m ON m.id = (SELECT id FROM media WHERE item_id = i.id AND path IS NOT NULL LIMIT 1)
       WHERE i.id IN (${ids.map(() => '?').join(',')}) AND i.type = 'track' AND ${acc.sql}`, ...ids, ...acc.params);
    const seen = new Map(rows.map((r) => [r.id, r]));
    const analyses = getAnalyses(ids);
    const opts = transitionOptions(b.transitions, b.maxStretchPct);
    const genres = (r: { genres: string | null }) => parseJson<string[]>(r.genres, []).filter((g) => typeof g === 'string').map((g) => g.toLowerCase());
    const transitions = b.pairs.map(({ from, to }): DjTransition | null => {
      const ra = seen.get(from);
      const rb = seen.get(to);
      if (!ra || !rb) return null;
      const a = analyses.get(from) ?? null;
      return planTransition(a, ra.duration_ms ?? a?.durationMs ?? 0, analyses.get(to) ?? null, { ...opts, genresA: genres(ra), genresB: genres(rb) });
    });
    return { transitions };
  });

  /**
   * Order a source (library, genre, artist, album, playlist, folder) or a list of ids as a mix: local scoring on
   * key, tempo, energy and timbre, no AI, no network. Page through big sources with `history`.
   */
  app.post<{ Body: DjOrderRequest }>('/dj/order', async (req): Promise<DjOrderResponse> => {
    const { user } = requireUser(req);
    const b = req.body;
    if (!b || typeof b !== 'object') throw badRequest('Send itemIds or a source');
    const { ids, total, remaining } = orderTracks(user, b);
    const items = itemsByIds(user, ids);
    const stored = getAnalyses(items.map((i) => i.id));
    const analyses: Record<string, TrackAnalysis | null> = {};
    for (const it of items) {
      const a = stored.get(it.id);
      analyses[it.id] = a ? { ...a, timbre: null } : null;
    }
    // Tracks with an older-version analysis are upgraded in the background, a few per request.
    upgradeLazily(ids.slice(0, 8));
    return { items, analyses, total, remaining };
  });

  /* ----------------------------- DJ rules ----------------------------- */

  app.get('/dj/rules', async (req): Promise<DjRulesResponse> => rulesResponse(requireUser(req).user));

  /** Admin: restrictions enforced for one user (e.g. a kids' profile); the user can't loosen them. {} = none. */
  app.get<{ Params: { id: string } }>('/users/:id/dj-restrictions', async (req): Promise<DjRules> => {
    requireAdmin(req);
    getUser(req.params.id); // 404 for an unknown user
    return getEnforced(req.params.id);
  });
  app.put<{ Params: { id: string }; Body: DjRules }>('/users/:id/dj-restrictions', async (req): Promise<DjRules> => {
    requireAdmin(req);
    getUser(req.params.id);
    if (req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body))) throw badRequest('Send the rules as an object');
    return setEnforced(req.params.id, req.body ?? {});
  });

  /* ----------------------------- Your DJ ----------------------------- */

  const sessionOf = (user: Parameters<typeof getSession>[0], id: string) => {
    const s = getSession(user, id);
    if (!s) throw notFound('This DJ session has ended; start a new one');
    return s;
  };
  const checkHistory = (h: unknown) => {
    if (h != null && (!Array.isArray(h) || h.length > 2000)) throw badRequest('history must be a list of up to 2000 item ids');
  };

  app.post<{ Body: DjSessionStartRequest }>('/dj/session', async (req) => {
    const { user } = requireUser(req);
    aiOn();
    return startSession(user, req.body ?? {});
  });

  app.get<{ Querystring: { hour?: string } }>('/dj/session/suggestions', async (req): Promise<DjSuggestions> => {
    const { user } = requireUser(req);
    aiOn();
    return { chips: suggestions(user, req.query.hour) };
  });

  app.post<{ Params: { id: string }; Body: DjSessionNextRequest }>('/dj/session/:id/more', async (req) => {
    const { user } = requireUser(req);
    aiOn();
    checkHistory(req.body?.history);
    return moreSession(user, sessionOf(user, req.params.id), req.body ?? {});
  });

  app.post<{ Params: { id: string }; Body: DjSessionNextRequest }>('/dj/session/:id/switch', async (req) => {
    const { user } = requireUser(req);
    aiOn();
    checkHistory(req.body?.history);
    return switchSession(user, sessionOf(user, req.params.id), req.body ?? {});
  });

  app.post<{ Params: { id: string }; Body: DjSessionRequestBody }>('/dj/session/:id/request', async (req) => {
    const { user } = requireUser(req);
    aiOn();
    const b = req.body;
    if (!b || typeof b.text !== 'string' || !b.text.trim()) throw badRequest('text is required');
    if (b.text.length > 300) throw badRequest('Keep the request under 300 characters');
    checkHistory(b.history);
    return requestSession(user, sessionOf(user, req.params.id), b);
  });

  /* ----------------------------- radio host ----------------------------- */

  /**
   * A host break for the coming transition (Radio Host add-on or Your DJ commentary). Most calls return null.
   * Silent by design: any AI / voice failure degrades to templates, device speech or no talk — never an error.
   */
  app.post<{ Body: DjBreakRequest }>('/dj/break', async (req): Promise<DjBreakResponse> => {
    const { user } = requireUser(req);
    aiOn();
    const b = req.body;
    if (!b || typeof b.nextItemId !== 'string' || !b.nextItemId) throw badRequest('nextItemId is required');
    if (b.mode !== 'radio' && b.mode !== 'yourdj') throw badRequest('mode must be radio or yourdj');
    assertCanSee(user, b.nextItemId);
    if (b.previousItemId) assertCanSee(user, b.previousItemId);
    const segmentStart = b.mode === 'yourdj' ? segmentStartingAt(user, b.sessionId, b.nextItemId) : null;
    const brk = await makeBreak({ user, req: b, segmentStart });
    return { break: brk };
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
    // Rendered audio of library tracks: media bytes, so "home network only" accounts get none remotely.
    assertRemoteAllowed(user, remoteAddr(req));
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
    const ensure = (id: string) => analyseOnDemand(id);
    const [a, b] = await Promise.all([ensure(from), ensure(to)]);
    const tr = planTransition(a, fa.duration_ms ?? a?.durationMs ?? 0, b, {
      ...transitionOptions(req.query.transitions, req.query.maxStretchPct),
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
      if (!serverVoiceConfigured()) throw badRequest('Choose a server voice (Piper or a speech API) first');
      const v = await speak(`Hi, this is ${getSettings().aiDj.hostName}. Your Vibe DJ is ready.`);
      if (!v) throw badRequest('No server voice answered — see Admin → AI → provider health for the error');
      return { ok: true, audioUrl: `/api/v1/dj/voice/${v.file}` };
    }
    const t = Date.now();
    const r = await llmChat('Reply with exactly: OK', 'Say OK.', { maxTokens: 5, temperature: 0 });
    if (!r) throw badRequest('No reply from the language model — check the URL, model name, API key, and the daily limit');
    return { ok: true, reply: r.slice(0, 100), ms: Date.now() - t, usage: llmUsage() };
  });
}
