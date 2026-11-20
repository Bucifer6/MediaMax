/** Picker sheet (bottom sheet on phones, centred panel on TV). */
import React from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme';
import { Focusable } from './Focusable';
import { Icon, type IconName } from './Icon';
import { T } from './Text';

export interface SheetOption<K extends string | number = string> {
  key: K;
  label: string;
  description?: string;
  selected?: boolean;
  icon?: IconName;
  destructive?: boolean;
  disabled?: boolean;
}

export interface SheetSection<K extends string | number = string> {
  title?: string;
  options: SheetOption<K>[];
}

export function OptionSheet<K extends string | number>({
  visible,
  title,
  options,
  sections,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title?: string;
  options?: SheetOption<K>[];
  sections?: SheetSection<K>[];
  onSelect: (key: K) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const all: SheetSection<K>[] = sections ?? [{ options: options ?? [] }];
  const firstSelected = all.flatMap((s) => s.options).find((o) => o.selected)?.key ?? all[0]?.options[0]?.key;

  return (
    <Modal visible={visible} transparent animationType={t.isTV ? 'fade' : 'slide'} onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <View style={{ flex: 1, justifyContent: t.isTV ? 'center' : 'flex-end', alignItems: t.isTV ? 'center' : 'stretch' }}>
        <Pressable style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)' }} onPress={onClose} focusable={false} />
        <View
          style={{
            backgroundColor: t.colors.surface,
            borderTopLeftRadius: t.radius * 1.5,
            borderTopRightRadius: t.radius * 1.5,
            borderBottomLeftRadius: t.isTV ? t.radius * 1.5 : 0,
            borderBottomRightRadius: t.isTV ? t.radius * 1.5 : 0,
            width: t.isTV ? t.s(520) : undefined,
            maxHeight: t.isTV ? '80%' : '75%',
            paddingBottom: insets.bottom + t.space.md,
            paddingTop: t.space.md,
            borderWidth: 1,
            borderColor: t.colors.border,
          }}
        >
          {!t.isTV ? <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: t.colors.border, marginBottom: t.space.sm }} /> : null}
          {title ? (
            <T variant="heading" style={{ paddingHorizontal: t.space.lg, paddingBottom: t.space.sm }}>
              {title}
            </T>
          ) : null}
          <ScrollView contentContainerStyle={{ paddingHorizontal: t.space.sm }}>
            {all.map((section, si) => (
              <View key={si} style={{ marginBottom: t.space.sm }}>
                {section.title ? (
                  <T variant="caption" tone="muted" style={{ paddingHorizontal: t.space.md, paddingVertical: t.space.xs, textTransform: 'uppercase' }}>
                    {section.title}
                  </T>
                ) : null}
                {section.options.map((o) => (
                  <Focusable
                    key={String(o.key)}
                    disabled={o.disabled}
                    onPress={() => onSelect(o.key)}
                    hasTVPreferredFocus={o.key === firstSelected}
                    focusScale={t.isTV ? 1.03 : 1}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: t.space.md,
                      paddingVertical: t.isTV ? t.s(12) : 13,
                      paddingHorizontal: t.space.md,
                      borderRadius: t.radius,
                      backgroundColor: o.selected ? t.alpha(t.colors.primary, 0.14) : 'transparent',
                      opacity: o.disabled ? 0.45 : 1,
                    }}
                  >
                    {o.icon ? <Icon name={o.icon} color={o.destructive ? t.colors.danger : t.colors.text} /> : null}
                    <View style={{ flex: 1 }}>
                      <T weight={o.selected ? '700' : '500'} tone={o.destructive ? 'danger' : 'default'}>
                        {o.label}
                      </T>
                      {o.description ? (
                        <T variant="small" tone="muted">
                          {o.description}
                        </T>
                      ) : null}
                    </View>
                    {o.selected ? <Icon name="checkmark" color={t.colors.primary} /> : null}
                  </Focusable>
                ))}
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
