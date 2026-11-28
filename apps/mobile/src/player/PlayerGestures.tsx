/**
 * Phone player touch layer: a tap toggles the controls (as before); a vertical swipe on the left half sets the screen
 * brightness, on the right half the player volume, with a small level indicator. Horizontal moves are left alone
 * (the scrubber handles seeking). Brightness is the app window's own (no system permission) and is restored when the
 * player closes. Pure React Native PanResponder: no gesture library.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dimensions, PanResponder, Platform, StyleSheet, View } from 'react-native';
import * as Brightness from 'expo-brightness';
import { Icon } from '@/components/Icon';
import { T } from '@/components/Text';

const SWIPE_START = 12;

export function PlayerGestures({ onTap, getVolume, setVolume, height }: {
  onTap: () => void;
  getVolume: () => number;
  setVolume: (v: number) => void;
  /** Screen height: a full-height swipe moves the level from 0 to 1. */
  height: number;
}) {
  const [hud, setHud] = useState<{ kind: 'brightness' | 'volume'; value: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ kind: 'brightness' | 'volume'; value: number } | null>(null);
  const brightness = useRef<number | null>(null);
  const original = useRef<number | null>(null);
  const live = useRef({ onTap, getVolume, setVolume, height });
  live.current = { onTap, getVolume, setVolume, height };

  useEffect(() => {
    Brightness.getBrightnessAsync().then((b) => {
      original.current = b;
      brightness.current = b;
    }).catch(() => undefined);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      // Hand the screen back when the player closes: Android follows the system again; on iOS the change was the
      // system brightness itself, so the value from before is put back.
      if (Platform.OS === 'ios') {
        if (original.current != null && brightness.current !== original.current) void Brightness.setBrightnessAsync(original.current).catch(() => undefined);
      } else void Brightness.restoreSystemBrightnessAsync?.().catch(() => undefined);
    };
  }, []);

  const show = (kind: 'brightness' | 'volume', value: number) => {
    setHud({ kind, value });
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHud(null), 900);
  };

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > SWIPE_START && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
    onPanResponderGrant: () => {
      start.current = null;
    },
    onPanResponderMove: (e, g) => {
      if (Math.abs(g.dy) < SWIPE_START || Math.abs(g.dy) < Math.abs(g.dx) * 1.5) return;
      if (!start.current) {
        const kind = g.x0 < screenWidth() / 2 ? 'brightness' : 'volume';
        start.current = { kind, value: kind === 'brightness' ? brightness.current ?? 0.5 : live.current.getVolume() };
      }
      const delta = -g.dy / Math.max(200, live.current.height * 0.8);
      const value = Math.max(0, Math.min(1, start.current.value + delta));
      if (start.current.kind === 'brightness') {
        brightness.current = value;
        void Brightness.setBrightnessAsync(value).catch(() => undefined);
      } else live.current.setVolume(value);
      show(start.current.kind, value);
    },
    onPanResponderRelease: (_, g) => {
      if (!start.current && Math.abs(g.dx) < SWIPE_START && Math.abs(g.dy) < SWIPE_START) live.current.onTap();
      start.current = null;
    },
    onPanResponderTerminationRequest: () => true,
  }), []);

  return (
    <View style={StyleSheet.absoluteFill} {...responder.panHandlers}>
      {hud ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: '40%', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.7)' }}>
          <Icon name={hud.kind === 'brightness' ? 'sunny' : hud.value === 0 ? 'volume-mute' : 'volume-high'} size={20} color="#fff" />
          <View style={{ width: 120, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)' }}>
            <View style={{ width: `${Math.round(hud.value * 100)}%`, height: 4, borderRadius: 2, backgroundColor: '#fff' }} />
          </View>
          <T variant="small" color="#fff" style={{ width: 40, textAlign: 'right' }}>{Math.round(hud.value * 100)}%</T>
        </View>
      ) : null}
    </View>
  );
}

/** Window width at gesture time (rotation changes it). */
const screenWidth = () => Dimensions.get('window').width;
