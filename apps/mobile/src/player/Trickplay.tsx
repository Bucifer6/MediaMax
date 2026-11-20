/**
 * Trickplay: seek-bar preview thumbnails cropped from server sprite sheets (phone, Android TV, Apple TV).
 *
 * - The manifest (tiny JSON) is fetched when an item starts; sprite sheets are prefetched into expo-image's
 *   memory/disk cache depending on the "Scrub previews" setting: "Always" warms the first sheets at once and the
 *   rest when scrubbing starts; "Data saver" loads nothing until you start scrubbing (and then only the sheets
 *   around the position) — it is also used automatically when the last bandwidth probe was slow (< 3 Mbit/s,
 *   typically mobile data); "Off" shows no previews.
 * - Downloads keep their sheets next to the video (state/downloads.tsx), so previews work offline.
 */
import { Image } from 'expo-image';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { getJSON, setJSON } from '@/api/storage';
import type { Chapter, TrickplayInfo } from '@/api/types';
import { T } from '@/components/Text';
import { useSession } from '@/state/session';
import { rememberedBandwidth } from './bandwidth';

export type TrickplayMode = 'always' | 'saver' | 'off';
const MODE_KEY = 'mm.trickplay.mode';
let modeCache: TrickplayMode | null = null;
const listeners = new Set<(m: TrickplayMode) => void>();

export async function getTrickplayMode(): Promise<TrickplayMode> {
  if (modeCache) return modeCache;
  const m = await getJSON<TrickplayMode>(MODE_KEY, 'always');
  modeCache = m === 'saver' || m === 'off' ? m : 'always';
  return modeCache;
}

export async function setTrickplayMode(m: TrickplayMode) {
  modeCache = m;
  await setJSON(MODE_KEY, m);
  for (const l of listeners) l(m);
}

export function useTrickplayMode(): TrickplayMode {
  const [m, setM] = useState<TrickplayMode>(modeCache ?? 'always');
  useEffect(() => {
    void getTrickplayMode().then(setM);
    listeners.add(setM);
    return () => {
      listeners.delete(setM);
    };
  }, []);
  return m;
}

/** Below this the app treats the connection as metered/slow and only fetches sheets on demand. */
const SAVER_BELOW_BPS = 3_000_000;

/**
 * Trickplay manifest for an item (null while loading, when absent (404), off, or on error).
 * `offline` = manifest of a downloaded copy (sheets are local files). `active` = the user is scrubbing / dialling
 * a seek right now at `atMs` (sheets are fetched then in data-saver mode).
 */
export function useTrickplay(itemId: string | null, opts: { offline?: TrickplayInfo | null; active?: boolean; atMs?: number } = {}): TrickplayInfo | null {
  const { api } = useSession();
  const mode = useTrickplayMode();
  const [info, setInfo] = useState<TrickplayInfo | null>(null);
  const saver = useRef(true);
  const warmed = useRef(new Set<number>());
  const offline = opts.offline ?? null;

  useEffect(() => {
    setInfo(null);
    warmed.current = new Set();
    if (mode === 'off') return;
    if (offline) {
      setInfo(offline);
      return;
    }
    if (!itemId || !api) return;
    const ctrl = new AbortController();
    void (async () => {
      const bps = await rememberedBandwidth(api).catch(() => null);
      saver.current = mode === 'saver' || (bps != null && bps < SAVER_BELOW_BPS);
      const ti = await api.trickplay(itemId, undefined, ctrl.signal).catch(() => null); // 404 = not generated yet
      if (ctrl.signal.aborted || !ti || !ti.sheets?.length || ti.count <= 0 || ti.intervalMs <= 0) return;
      setInfo(ti);
      if (!saver.current) {
        // Warm the cache so the first scrub shows a frame immediately.
        ti.sheets.slice(0, 2).forEach((_, i) => warmed.current.add(i));
        Image.prefetch(ti.sheets.slice(0, 2).map((s) => api.absolute(s)), 'memory-disk').catch(() => undefined);
      }
    })();
    return () => ctrl.abort();
  }, [itemId, api, mode, offline]);

  const warm = useCallback(
    (ms: number) => {
      if (!info || !api || offline) return;
      const perSheet = Math.max(1, info.columns * info.rows);
      const cur = Math.floor(Math.max(0, Math.min(info.count - 1, Math.floor(ms / info.intervalMs))) / perSheet);
      // Data saver: just the sheets around the position. Otherwise everything once scrubbing starts.
      const want = saver.current ? [cur - 1, cur, cur + 1] : info.sheets.map((_, i) => i);
      const urls: string[] = [];
      for (const i of want) {
        if (i < 0 || i >= info.sheets.length || warmed.current.has(i)) continue;
        warmed.current.add(i);
        urls.push(api.absolute(info.sheets[i]));
      }
      if (urls.length) Image.prefetch(urls, 'memory-disk').catch(() => undefined);
    },
    [info, api, offline],
  );
  const { active, atMs } = opts;
  useEffect(() => {
    if (active && atMs != null) warm(atMs);
  }, [active, atMs, warm]);
  return info;
}

/** Where thumbnail n lives: sheet index plus column/row inside that sheet. */
export function trickplayCell(info: TrickplayInfo, ms: number) {
  const n = Math.max(0, Math.min(info.count - 1, Math.floor(ms / info.intervalMs)));
  const perSheet = info.columns * info.rows;
  return { sheet: Math.min(info.sheets.length - 1, Math.floor(n / perSheet)), col: n % info.columns, row: Math.floor(n / info.columns) % info.rows };
}

/** The chapter playing at `ms`, if the item has chapters. */
export function chapterAt(chapters: Chapter[] | null | undefined, ms: number): Chapter | null {
  if (!chapters?.length) return null;
  let hit: Chapter | null = null;
  for (const c of chapters) if (ms >= c.startMs && (ms < c.endMs || !c.endMs)) hit = c;
  return hit;
}

/** One preview frame, `width` points wide: a clipped View with the whole sheet offset inside it, plus time/chapter. */
export function TrickplayThumb({ info, ms, width, label, chapter }: { info: TrickplayInfo; ms: number; width: number; label?: string; chapter?: string | null }) {
  const { api } = useSession();
  const k = width / info.width;
  const height = Math.round(info.height * k);
  const { sheet, col, row } = trickplayCell(info, ms);
  const src = info.sheets[sheet];
  if (!src) return null;
  const uri = /^file:/i.test(src) || !api ? src : api.absolute(src);
  return (
    <View style={{ borderRadius: 8, borderWidth: 2, borderColor: 'rgba(255,255,255,0.9)', backgroundColor: '#000', overflow: 'hidden', width: width + 4 }}>
      <View style={{ width, height, overflow: 'hidden' }}>
        <Image
          source={{ uri }}
          cachePolicy="memory-disk"
          transition={0}
          recyclingKey={uri}
          contentFit="fill"
          style={{ position: 'absolute', left: -col * info.width * k, top: -row * info.height * k, width: info.columns * info.width * k, height: info.rows * info.height * k }}
        />
      </View>
      {label || chapter ? (
        <View style={{ paddingHorizontal: 6, paddingVertical: 3, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center' }}>
          {label ? (
            <T variant="small" weight="700" color="#fff">
              {label}
            </T>
          ) : null}
          {chapter ? (
            <T variant="small" color="rgba(255,255,255,0.8)" numberOfLines={1}>
              {chapter}
            </T>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
