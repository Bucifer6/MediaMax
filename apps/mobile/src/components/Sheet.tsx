/** Free-form modal panel: bottom sheet on phones, centred panel on TV (same look as OptionSheet). */
import React from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme';
import { T } from './Text';

export function Sheet({
  visible,
  title,
  subtitle,
  onClose,
  children,
  width,
  scroll = true,
}: {
  visible: boolean;
  title?: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  /** TV panel width (design units, scaled). */
  width?: number;
  scroll?: boolean;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const body = <View style={{ paddingHorizontal: t.space.lg, gap: t.space.md, paddingBottom: t.space.sm }}>{children}</View>;
  return (
    <Modal visible={visible} transparent animationType={t.isTV ? 'fade' : 'slide'} onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: t.isTV ? 'center' : 'flex-end', alignItems: t.isTV ? 'center' : 'stretch' }}>
        <Pressable style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)' }} onPress={onClose} focusable={false} />
        <View
          style={{
            backgroundColor: t.colors.surface,
            borderTopLeftRadius: t.radius * 1.5,
            borderTopRightRadius: t.radius * 1.5,
            borderBottomLeftRadius: t.isTV ? t.radius * 1.5 : 0,
            borderBottomRightRadius: t.isTV ? t.radius * 1.5 : 0,
            width: t.isTV ? t.s(width ?? 620) : t.wide ? Math.min(t.width, 640) : undefined,
            alignSelf: t.wide && !t.isTV ? 'center' : undefined,
            maxHeight: t.isTV ? '85%' : '85%',
            paddingBottom: insets.bottom + t.space.md,
            paddingTop: t.space.md,
            borderWidth: 1,
            borderColor: t.colors.border,
          }}
        >
          {!t.isTV ? <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: t.colors.border, marginBottom: t.space.sm }} /> : null}
          {title ? (
            <View style={{ paddingHorizontal: t.space.lg, paddingBottom: t.space.sm }}>
              <T variant="heading">{title}</T>
              {subtitle ? (
                <T variant="small" tone="muted">
                  {subtitle}
                </T>
              ) : null}
            </View>
          ) : null}
          {scroll ? <ScrollView keyboardShouldPersistTaps="handled">{body}</ScrollView> : body}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
