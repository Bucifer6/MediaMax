/** Trickplay: seek-bar preview thumbnails cropped from server sprite sheets. */
import { Image } from 'expo-image';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { TrickplayInfo } from '@/api/types';
import { useSession } from '@/state/session';

/** Fetch the trickplay manifest for an item (null while loading, when absent (404) or on error). */
export function useTrickplay(itemId: string | null): TrickplayInfo | null {
  const { api } = useSession();
  const [info, setInfo] = useState<TrickplayInfo | null>(null);
  useEffect(() => {
    setInfo(null);
    if (!itemId || !api) return;
    const ctrl = new AbortController();
    api
      .trickplay(itemId, undefined, ctrl.signal)
      .then((ti) => {
        if (ctrl.signal.aborted || !ti || !ti.sheets?.length || ti.count <= 0 || ti.intervalMs <= 0) return;
        setInfo(ti);
        // Warm the cache so the first scrub shows a frame immediately.
        Image.prefetch(ti.sheets.slice(0, 2).map((s) => api.absolute(s)), 'memory-disk').catch(() => undefined);
      })
      // 404 = not generated yet; previews are optional, so any failure just means none.
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [itemId, api]);
  return info;
}

/** Where thumbnail n lives: sheet index plus column/row inside that sheet. */
export function trickplayCell(info: TrickplayInfo, ms: number) {
  const n = Math.max(0, Math.min(info.count - 1, Math.floor(ms / info.intervalMs)));
  const perSheet = info.columns * info.rows;
  return { sheet: Math.min(info.sheets.length - 1, Math.floor(n / perSheet)), col: n % info.columns, row: Math.floor(n / info.columns) % info.rows };
}

/** One preview frame, `width` points wide: a clipped View with the whole sheet offset inside it. */
export function TrickplayThumb({ info, ms, width }: { info: TrickplayInfo; ms: number; width: number }) {
  const { api } = useSession();
  if (!api) return null;
  const k = width / info.width;
  const height = Math.round(info.height * k);
  const { sheet, col, row } = trickplayCell(info, ms);
  const uri = api.absolute(info.sheets[sheet]);
  return (
    <View style={{ borderRadius: 8, borderWidth: 2, borderColor: 'rgba(255,255,255,0.9)', backgroundColor: '#000', overflow: 'hidden' }}>
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
    </View>
  );
}
