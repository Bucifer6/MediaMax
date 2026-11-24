import { useTheme } from '@/theme';
import { Focusable } from './Focusable';
import { Icon, type IconName } from './Icon';
import { T } from './Text';

export function Chip({ label, selected, onPress, icon, hasTVPreferredFocus, onFocus }: { label: string; selected?: boolean; onPress?: () => void; icon?: IconName; hasTVPreferredFocus?: boolean; onFocus?: () => void }) {
  const t = useTheme();
  const fg = selected ? t.colors.primaryText : t.colors.text;
  return (
    <Focusable
      onPress={onPress}
      onFocus={onFocus}
      hasTVPreferredFocus={hasTVPreferredFocus}
      ringRadius={999}
      focusScale={t.isTV ? 1.08 : 1}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.space.xs,
        paddingVertical: t.isTV ? t.s(8) : 7,
        paddingHorizontal: t.isTV ? t.s(18) : 14,
        borderRadius: 999,
        backgroundColor: selected ? t.colors.primary : t.alpha(t.colors.text, t.dark ? 0.1 : 0.07),
      }}
    >
      {icon ? <Icon name={icon} size={t.isTV ? t.s(18) : 15} color={fg} /> : null}
      <T variant="small" weight="700" color={fg} numberOfLines={1}>
        {label}
      </T>
    </Focusable>
  );
}
