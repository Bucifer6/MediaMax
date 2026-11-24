/**
 * Vibe's own subtitle renderer, used by every web player (desktop, mobile web, TV mode on Tizen/webOS).
 * Never uses <track>/native text tracks or the platform's subtitle parser: the track is fetched from the server in its
 * original format and drawn on an overlay above the video.
 *
 *   SRT / WebVTT  → our parsers (text.ts) → DOM text renderer, in the user's subtitle style
 *   ASS / SSA     → libass (jassub, WASM) with embedded fonts; falls back to the simplified styled-text renderer
 *                   (ass.ts) without WebAssembly/Workers, on error, or when the user prefers their own style
 *   PGS (.sup)    → our PGS decoder (pgs.ts) → canvas
 *
 * Timing follows the video every animation frame: subtitle time = stream start + video.currentTime − user delay, so
 * playback rate, seeking and HLS transcodes that start mid-file (streamStartMs) are all handled.
 */
import { useEffect, useRef, useState } from 'react';
import type { SubtitleStyle, SubtitleTrack } from '@mediamax/shared';
import { getToken } from '../../api/client';
import { parseAss } from './ass';
import { parseSrt, parseVtt, sniffTextFormat } from './text';
import { parsePgs, type PgsEvent } from './pgs';
import { CueIndex, subtitleClock } from './timing';
import { TextRenderer, videoContentRect, type TextRenderOptions } from './textRenderer';
import { PgsRenderer } from './pgsRenderer';
import { LibassRenderer, libassSupported } from './assRenderer';
import type { ParsedText, TextCue } from './types';

export type RendererKind = 'text' | 'libass' | 'ass-fallback' | 'pgs';

export interface SubtitleStatus {
  renderer: RendererKind | null;
  loading: boolean;
  /** Extraction progress 0..1 while the server is still reading a long file. */
  progress: number | null;
  error: string | null;
}

export interface SubtitleOverlayProps {
  /** Selected track (null = off). */
  track: SubtitleTrack | null;
  /** The <video> currently showing (players may swap elements during a seamless quality switch). */
  video: HTMLVideoElement | null;
  /** Media position (ms) of stream time 0. */
  streamStartMs: number;
  /** User subtitle delay (ms, positive = later). */
  delayMs: number;
  style: SubtitleStyle;
  tv: boolean;
  /** Raise bottom subtitles above the visible control bar. */
  controlsVisible?: boolean;
  /** Live captions (CEA-608/708 / WebVTT renditions from hls.js): shown as given, no timing. */
  liveCues?: TextCue[] | null;
  onStatus?: (s: SubtitleStatus) => void;
}

/**
 * libass needs OffscreenCanvas, requestVideoFrameCallback, module workers and a recent WebAssembly (see
 * libassSupported); browsers without them, typically older TVs, use the light ASS renderer whatever the setting.
 */
function wantLibass(style: SubtitleStyle, _tv: boolean): boolean {
  const mode = style.assStyles ?? 'auto';
  if (mode === 'user') return false;
  return libassSupported(mode === 'file');
}

async function fetchTrack(url: string, binary: boolean, signal: AbortSignal): Promise<{ data: string | Uint8Array; complete: boolean; progress: number | null }> {
  const token = getToken();
  const u = `${url}${url.includes('?') ? '&' : '?'}partial=1`;
  const res = await fetch(u, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal });
  if (!res.ok) {
    let msg = `Subtitle download failed (${res.status})`;
    try {
      msg = ((await res.json()) as { message?: string }).message ?? msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  const complete = res.headers.get('X-Subtitle-Complete') !== '0';
  const p = res.headers.get('X-Subtitle-Progress');
  const data = binary ? new Uint8Array(await res.arrayBuffer()) : await res.text();
  return { data, complete, progress: p != null ? Number(p) : null };
}

export function SubtitleOverlay(p: SubtitleOverlayProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<SubtitleStatus>({ renderer: null, loading: false, progress: null, error: null });
  const statusRef = useRef(p.onStatus);
  statusRef.current = p.onStatus;
  useEffect(() => statusRef.current?.(status), [status]);

  /** Live values read by the animation loop without restarting it. */
  const live = useRef(p);
  live.current = p;

  const textRef = useRef<TextRenderer | null>(null);
  const pgsRef = useRef<PgsRenderer | null>(null);
  const libassRef = useRef<LibassRenderer | null>(null);
  const textIndex = useRef<CueIndex<TextCue> | null>(null);
  const parsedRef = useRef<ParsedText | null>(null);
  const pgsIndex = useRef<CueIndex<PgsEvent> | null>(null);
  const [kind, setKind] = useState<RendererKind | null>(null);
  const [assContent, setAssContent] = useState<string | null>(null);
  const [assFailed, setAssFailed] = useState(false);
  const [fonts, setFonts] = useState<string[]>([]);

  const format = p.track?.format ?? (p.track ? 'vtt' : null);
  const url = p.track ? p.track.rawUrl ?? p.track.url : null;
  const useLibass = format === 'ass' && !assFailed && wantLibass(p.style, p.tv);
  const textOpts: TextRenderOptions = { style: p.style, tv: p.tv, assMode: p.style.assStyles === 'user' ? 'user' : 'file' };

  /* ------------------------- fetch + parse (with partial polling) ------------------------- */
  useEffect(() => {
    textIndex.current = null;
    parsedRef.current = null;
    pgsIndex.current = null;
    setAssContent(null);
    setAssFailed(false);
    if (!url || !format) {
      setKind(null);
      setStatus({ renderer: null, loading: false, progress: null, error: null });
      return;
    }
    const ctrl = new AbortController();
    let timer = 0;
    let delay = 2000;
    const binary = format === 'pgs';
    const round = async () => {
      try {
        const r = await fetchTrack(url, binary, ctrl.signal);
        if (ctrl.signal.aborted) return;
        if (binary) {
          pgsIndex.current = new CueIndex(parsePgs(r.data as Uint8Array).events);
          setKind('pgs');
        } else {
          const text = r.data as string;
          const f = format === 'ass' || sniffTextFormat(text) === 'ass' ? 'ass' : sniffTextFormat(text) === 'vtt' ? 'vtt' : format === 'vtt' ? 'vtt' : 'srt';
          if (f === 'ass') {
            setAssContent(text);
            const parsed: ParsedText = parseAss(text);
            textIndex.current = new CueIndex(parsed.cues);
            parsedRef.current = parsed;
            textRef.current?.setTrack(parsed);
            setKind('ass-fallback');
          } else {
            const parsed = f === 'vtt' ? parseVtt(text) : parseSrt(text);
            textIndex.current = new CueIndex(parsed.cues);
            parsedRef.current = parsed;
            textRef.current?.setTrack(parsed);
            setKind('text');
          }
        }
        setStatus((s) => ({ ...s, loading: !r.complete, progress: r.complete ? null : r.progress, error: null }));
        if (!r.complete) {
          timer = window.setTimeout(round, delay);
          delay = Math.min(10000, delay * 1.5);
        }
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setStatus((s) => ({ ...s, loading: false, error: (e as Error).message }));
      }
    };
    setStatus({ renderer: null, loading: true, progress: null, error: null });
    void round();
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [url, format]);

  // Embedded fonts for libass.
  useEffect(() => {
    setFonts([]);
    const fu = p.track?.fontsUrl;
    if (!fu || format !== 'ass') return;
    const ctrl = new AbortController();
    const token = getToken();
    fetch(fu, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: { url: string }[]) => setFonts(list.map((f) => f.url)))
      .catch(() => {});
    return () => ctrl.abort();
  }, [p.track?.fontsUrl, format]);

  /* --------------------------------- renderers --------------------------------- */
  const effectiveKind: RendererKind | null = kind === 'ass-fallback' && useLibass ? 'libass' : kind;
  useEffect(() => {
    setStatus((s) => ({ ...s, renderer: effectiveKind }));
  }, [effectiveKind]);

  // Text / ASS-fallback renderer.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || (effectiveKind !== 'text' && effectiveKind !== 'ass-fallback')) return;
    const r = new TextRenderer(layer, textOpts);
    if (parsedRef.current) r.setTrack(parsedRef.current);
    textRef.current = r;
    return () => {
      r.destroy();
      textRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveKind]);
  useEffect(() => {
    textRef.current?.setOptions(textOpts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(textOpts)]);

  // PGS renderer.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || effectiveKind !== 'pgs') return;
    const r = new PgsRenderer(layer);
    pgsRef.current = r;
    return () => {
      r.destroy();
      pgsRef.current = null;
    };
  }, [effectiveKind]);

  // libass (jassub) — bound to the video element; recreated when the element changes.
  const libassOffset = (p.streamStartMs - p.delayMs) / 1000;
  useEffect(() => {
    if (effectiveKind !== 'libass' || !p.video || assContent == null) return;
    const r = new LibassRenderer({
      video: p.video,
      content: assContent,
      fonts,
      timeOffset: (live.current.streamStartMs - live.current.delayMs) / 1000,
      lowPower: live.current.tv,
      onError: (e) => {
        console.warn('libass renderer failed, using the simplified ASS renderer', e);
        setAssFailed(true);
      },
    });
    libassRef.current = r;
    r.ready.catch((e) => {
      console.warn('libass renderer could not load', e);
      setAssFailed(true);
    });
    return () => {
      r.destroy();
      libassRef.current = null;
    };
    // Content updates during partial extraction go through setContent below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveKind, p.video, fonts.join('|')]);
  useEffect(() => {
    if (assContent != null) libassRef.current?.setContent(assContent);
  }, [assContent]);
  useEffect(() => {
    libassRef.current?.setTimeOffset(libassOffset);
  }, [libassOffset]);

  /* ----------------------------------- clock ----------------------------------- */
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const cur = live.current;
      const v = cur.video;
      const layer = layerRef.current;
      if (!v || !layer) return;
      const rect = videoContentRect(v);
      if (cur.liveCues) {
        textRef.current?.render(cur.liveCues, 0, rect);
        return;
      }
      const t = subtitleClock(cur.streamStartMs + v.currentTime * 1000, cur.delayMs);
      if (textRef.current && textIndex.current) textRef.current.render(textIndex.current.at(t), t, rect);
      if (pgsRef.current && pgsIndex.current) pgsRef.current.render(pgsIndex.current.at(t).at(-1) ?? null, rect);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Live captions use the text renderer without a track.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !p.liveCues || textRef.current) return;
    const r = new TextRenderer(layer, textOpts);
    textRef.current = r;
    return () => {
      r.destroy();
      if (textRef.current === r) textRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!p.liveCues]);

  return (
    <div
      ref={layerRef}
      className={`mm-subs-layer ${p.controlsVisible ? 'controls-up' : ''} ${p.tv ? 'tv' : ''}`}
      aria-live="off"
      data-renderer={effectiveKind ?? 'none'}
    />
  );
}
