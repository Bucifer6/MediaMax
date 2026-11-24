import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import type { Theme } from '@/api/types';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Screen, ScreenHeader } from '@/components/Screen';
import { EmptyState } from '@/components/States';
import { T } from '@/components/Text';
import { useSession } from '@/state/session';
import { useTheme } from '@/theme';

export default function ThemeScreen() {
  const t = useTheme();
  const { branding, user, updatePreferences } = useSession();
  const [error, setError] = useState<string | null>(null);
  if (!branding?.allowUserThemes) return <Screen><ScreenHeader title="Theme" /><EmptyState icon="color-palette-outline" title="Theme set by your server" message="Your administrator has chosen a theme for everyone." /></Screen>;
  const current = user?.preferences.themeId ?? null;
  const cols = t.isTV ? 4 : t.wide ? 3 : 2;
  const w = Math.floor((t.width - t.space.gutter * 2 - t.card.gap * (cols - 1)) / cols);

  const choose = async (id: string | null) => {
    setError(null);
    try {
      await updatePreferences({ themeId: id });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };

  const defaultTheme = branding.themes.find((x) => x.id === branding.defaultThemeId);
  return (
    <Screen>
      <ScreenHeader title="Theme" subtitle="Changes apply instantly" />
      {error ? <T tone="danger" style={{ paddingHorizontal: t.space.gutter }}>{error}</T> : null}
      <ScrollView contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.xxl, flexDirection: 'row', flexWrap: 'wrap', gap: t.card.gap, rowGap: t.space.lg }}>
        {defaultTheme ? <ThemeCard theme={defaultTheme} label={`Server default · ${defaultTheme.name}`} width={w} selected={current === null} onPress={() => choose(null)} preferred /> : null}
        {branding.themes.map((th) => (
          <ThemeCard key={th.id} theme={th} label={th.name} width={w} selected={current === th.id} onPress={() => choose(th.id)} />
        ))}
      </ScrollView>
    </Screen>
  );
}

function ThemeCard({ theme, label, width, selected, onPress, preferred }: { theme: Theme; label: string; width: number; selected: boolean; onPress: () => void; preferred?: boolean }) {
  const t = useTheme();
  const c = theme.colors;
  const h = Math.round(width * 0.66);
  const r = theme.posterShape === 'square' ? 2 : theme.posterShape === 'pill' ? 999 : Math.min(theme.radius, 14);
  return (
    <View style={{ width, gap: t.space.xs }}>
      <Focusable onPress={onPress} hasTVPreferredFocus={preferred} ringRadius={t.radius} style={{ width, height: h, borderRadius: t.radius, overflow: 'hidden', backgroundColor: c.background, borderWidth: selected ? 3 : 1, borderColor: selected ? t.colors.primary : t.colors.border, padding: 10, gap: 8 }}>
        <View style={{ height: 10, width: '40%', borderRadius: 5, backgroundColor: c.text, opacity: 0.85 }} />
        <View style={{ flexDirection: 'row', gap: 6, flex: 1 }}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ flex: 1, borderRadius: r === 999 ? 20 : r, backgroundColor: i === 0 ? c.primary : i === 1 ? c.surfaceAlt : c.surface }} />
          ))}
        </View>
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: r === 999 ? 999 : Math.min(theme.radius, 10), backgroundColor: c.primary }}>
            <T variant="caption" color={c.primaryText}>Play</T>
          </View>
          <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: c.accent }} />
        </View>
        {selected ? (
          <View style={{ position: 'absolute', top: 8, right: 8, backgroundColor: t.colors.primary, borderRadius: 999, padding: 2 }}>
            <Icon name="checkmark" size={14} color={t.colors.primaryText} />
          </View>
        ) : null}
      </Focusable>
      <T variant="small" weight="700" numberOfLines={1}>{label}</T>
      <T variant="caption" tone="muted" numberOfLines={1}>{theme.mode} · {theme.cardSize} cards · {theme.heroStyle} hero</T>
    </View>
  );
}
