import React, { useMemo, useRef, useState } from 'react';
import { PanResponder, View, type LayoutChangeEvent } from 'react-native';
import type { Marker, TrickplayInfo } from '@/api/types';
import { Focusable } from '@/components/Focusable';
import { T } from '@/components/Text';
import { useTheme } from '@/theme';
import { formatClock } from '@/utils/format';
import { TrickplayThumb } from './Trickplay';

export function Scrubber({
  positionMs,
  durationMs,
  bufferedMs,
  markers,
  onSeek,
  onScrubbing,
  onFocusChange,
  pendingMs,
  trickplay,
}: {
  positionMs: number;
  durationMs: number;
  bufferedMs?: number;
  markers?: Marker[];
  onSeek: (ms: number) => void;
  onScrubbing?: (active: boolean) => void;
  /** TV: the parent drives left/right seeking while the bar has focus. */
  onFocusChange?: (focused: boolean) => void;
  /** TV: a seek target being dialled in with the D-pad. */
  pendingMs?: number | null;
  /** Scrub-preview sprite sheets (shown while dragging / dialling a seek). */
  trickplay?: TrickplayInfo | null;
}) {
  const t = useTheme();
  const [width, setWidth] = useState(1);
  const [dragMs, setDragMs] = useState<number | null>(null);
  const widthRef = useRef(1);
  const durRef = useRef(durationMs);
  durRef.current = durationMs;
  const startX = useRef(0);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          startX.current = e.nativeEvent.locationX;
          const ms = Math.max(0, Math.min(1, startX.current / widthRef.current)) * durRef.current;
          setDragMs(ms);
          onScrubbing?.(true);
        },
        onPanResponderMove: (_, g) => {
          const x = startX.current + g.dx;
          setDragMs(Math.max(0, Math.min(1, x / widthRef.current)) * durRef.current);
        },
        onPanResponderRelease: (_, g) => {
          const x = startX.current + g.dx;
          const ms = Math.max(0, Math.min(1, x / widthRef.current)) * durRef.current;
          setDragMs(null);
          onScrubbing?.(false);
          onSeek(ms);
        },
        onPanResponderTerminate: () => {
          setDragMs(null);
          onScrubbing?.(false);
        },
      }),
    [onSeek, onScrubbing],
  );

  const shown = dragMs ?? pendingMs ?? positionMs;
  const frac = durationMs > 0 ? Math.max(0, Math.min(1, shown / durationMs)) : 0;
  const bufFrac = durationMs > 0 && bufferedMs ? Math.max(0, Math.min(1, bufferedMs / durationMs)) : 0;
  const h = t.isTV ? t.s(6) : 4;
  const thumbW = Math.min(Math.max(1, width - 4), t.isTV ? t.s(280) : t.wide ? 220 : 160);
  const onLayout = (e: LayoutChangeEvent) => {
    widthRef.current = e.nativeEvent.layout.width;
    setWidth(e.nativeEvent.layout.width);
  };

  const bar = (focused: boolean) => (
    <View style={{ height: t.isTV ? t.s(30) : 30, justifyContent: 'center' }} onLayout={onLayout} {...(t.isTV ? {} : pan.panHandlers)}>
      <View style={{ height: focused ? h * 1.6 : h, borderRadius: h, backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden' }}>
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${bufFrac * 100}%`, backgroundColor: 'rgba(255,255,255,0.35)' }} />
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${frac * 100}%`, backgroundColor: t.colors.primary }} />
      </View>
      {markers?.map((m, i) =>
        durationMs > 0 ? <View key={i} style={{ position: 'absolute', left: (m.startMs / durationMs) * width, width: Math.max(2, ((m.endMs - m.startMs) / durationMs) * width), height: h, top: '50%', marginTop: -h / 2, backgroundColor: t.alpha(t.colors.accent, 0.7) }} pointerEvents="none" /> : null,
      )}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: frac * width - (focused || dragMs != null ? 9 : 7),
          width: focused || dragMs != null ? 18 : 14,
          height: focused || dragMs != null ? 18 : 14,
          borderRadius: 9,
          backgroundColor: '#fff',
          shadowColor: t.colors.primary,
          shadowOpacity: focused ? 0.9 : 0.4,
          shadowRadius: 8,
        }}
      />
      {(dragMs != null || pendingMs != null) && trickplay ? (
        <View pointerEvents="none" style={{ position: 'absolute', bottom: (t.isTV ? t.s(34) : 30) + (t.isTV ? t.s(34) : 28), left: Math.max(0, Math.min(width - thumbW - 4, frac * width - thumbW / 2 - 2)) }}>
          <TrickplayThumb info={trickplay} ms={shown} width={thumbW} />
        </View>
      ) : null}
      {dragMs != null || pendingMs != null ? (
        <View pointerEvents="none" style={{ position: 'absolute', bottom: t.isTV ? t.s(34) : 30, left: Math.max(0, Math.min(width - 70, frac * width - 35)), width: 70, alignItems: 'center' }}>
          <View style={{ backgroundColor: 'rgba(0,0,0,0.8)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
            <T variant="small" weight="700" color="#fff">
              {formatClock(shown)}
            </T>
          </View>
        </View>
      ) : null}
    </View>
  );

  return (
    <View>
      {t.isTV ? (
        <Focusable ring={false} focusScale={1} onFocus={() => onFocusChange?.(true)} onBlur={() => onFocusChange?.(false)} onPress={() => pendingMs != null && onSeek(pendingMs)} accessibilityLabel="Seek bar">
          {({ focused }) => bar(focused)}
        </Focusable>
      ) : (
        bar(false)
      )}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <T variant="small" weight="600" color="#fff">
          {formatClock(shown)}
        </T>
        <T variant="small" weight="600" color="rgba(255,255,255,0.75)">
          -{formatClock(Math.max(0, durationMs - shown))}
        </T>
      </View>
    </View>
  );
}
