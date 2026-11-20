import React from 'react';
import { View } from 'react-native';
import { useTheme } from '@/theme';
import { Focusable } from './Focusable';
import { Icon } from './Icon';
import { T } from './Text';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const;

export function PinPad({ value, onChange, length = 4, onComplete, error }: { value: string; onChange: (v: string) => void; length?: number; onComplete?: (pin: string) => void; error?: boolean }) {
  const t = useTheme();
  const size = t.isTV ? t.s(76) : 72;
  const press = (k: (typeof KEYS)[number]) => {
    if (k === 'clear') return onChange('');
    if (k === 'back') return onChange(value.slice(0, -1));
    if (value.length >= length) return;
    const next = value + k;
    onChange(next);
    if (next.length === length) onComplete?.(next);
  };
  return (
    <View style={{ alignItems: 'center', gap: t.space.lg }}>
      <View style={{ flexDirection: 'row', gap: t.space.md }}>
        {Array.from({ length }).map((_, i) => (
          <View
            key={i}
            style={{
              width: t.s(16),
              height: t.s(16),
              borderRadius: t.s(8),
              backgroundColor: i < value.length ? (error ? t.colors.danger : t.colors.primary) : 'transparent',
              borderWidth: 2,
              borderColor: error ? t.colors.danger : t.colors.textMuted,
            }}
          />
        ))}
      </View>
      <View style={{ width: size * 3 + t.space.md * 2, flexDirection: 'row', flexWrap: 'wrap', gap: t.space.md }}>
        {KEYS.map((k, i) => (
          <Focusable
            key={k}
            onPress={() => press(k)}
            hasTVPreferredFocus={i === 0}
            ringRadius={size / 2}
            accessibilityLabel={k === 'back' ? 'Delete' : k === 'clear' ? 'Clear' : k}
            style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: k === 'clear' || k === 'back' ? 'transparent' : t.alpha(t.colors.text, 0.1) }}
          >
            {k === 'back' ? <Icon name="backspace-outline" /> : k === 'clear' ? <T variant="small" tone="muted">Clear</T> : <T variant="title">{k}</T>}
          </Focusable>
        ))}
      </View>
    </View>
  );
}
