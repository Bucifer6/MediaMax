import React from 'react';
import { Switch, View } from 'react-native';
import { useTheme } from '@/theme';
import { Focusable } from './Focusable';
import { Icon, type IconName } from './Icon';
import { T } from './Text';

export function SettingSection({ title, children }: { title?: string; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: t.space.lg, gap: t.space.xs }}>
      {title ? (
        <T variant="caption" tone="muted" style={{ textTransform: 'uppercase', paddingHorizontal: t.space.sm, marginBottom: 2 }}>
          {title}
        </T>
      ) : null}
      <View style={{ borderRadius: t.radius, backgroundColor: t.colors.surface, overflow: t.isTV ? 'visible' : 'hidden' }}>{children}</View>
    </View>
  );
}

export function SettingRow({
  icon,
  label,
  value,
  onPress,
  toggle,
  onToggle,
  destructive,
  chevron = true,
  hasTVPreferredFocus,
}: {
  icon?: IconName;
  label: string;
  value?: string;
  onPress?: () => void;
  toggle?: boolean;
  onToggle?: (v: boolean) => void;
  destructive?: boolean;
  chevron?: boolean;
  hasTVPreferredFocus?: boolean;
}) {
  const t = useTheme();
  const isToggle = toggle !== undefined;
  const press = isToggle ? () => onToggle?.(!toggle) : onPress;
  return (
    <Focusable
      onPress={press}
      disabled={!press}
      focusScale={t.isTV ? 1.02 : 1}
      hasTVPreferredFocus={hasTVPreferredFocus}
      style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingHorizontal: t.space.md, paddingVertical: t.isTV ? t.s(14) : 13, borderBottomWidth: 0.5, borderBottomColor: t.colors.border }}
    >
      {icon ? <Icon name={icon} color={destructive ? t.colors.danger : t.colors.primary} size={t.isTV ? t.s(24) : 20} /> : null}
      <T weight="600" tone={destructive ? 'danger' : 'default'} style={{ flex: 1 }} numberOfLines={1}>
        {label}
      </T>
      {value ? (
        <T variant="small" tone="muted" numberOfLines={1} style={{ maxWidth: '50%' }}>
          {value}
        </T>
      ) : null}
      {isToggle ? (
        t.isTV ? (
          <Icon name={toggle ? 'checkmark-circle' : 'ellipse-outline'} color={toggle ? t.colors.primary : t.colors.textMuted} />
        ) : (
          <Switch value={toggle} onValueChange={onToggle} trackColor={{ true: t.colors.primary, false: t.colors.border }} thumbColor="#fff" />
        )
      ) : onPress && chevron ? (
        <Icon name="chevron-forward" color={t.colors.textMuted} size={t.isTV ? t.s(20) : 18} />
      ) : null}
    </Focusable>
  );
}
