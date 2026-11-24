import { useCallback } from 'react';
import { FlatList, View } from 'react-native';
import type { Channel, Item } from '@/api/types';
import { useTheme } from '@/theme';
import { ChannelCard } from './ChannelCard';
import { Focusable } from './Focusable';
import { Icon } from './Icon';
import { MediaCard, type CardVariant } from './MediaCard';
import { T } from './Text';

export function RowHeader({ title, onSeeAll }: { title: string; onSeeAll?: () => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: t.space.gutter, marginBottom: t.space.sm }}>
      <T variant="heading" numberOfLines={1} style={{ flex: 1 }}>
        {title}
      </T>
      {onSeeAll && !t.isTV ? (
        <Focusable onPress={onSeeAll} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 4, paddingLeft: 8 }}>
          <T variant="small" tone="primary" weight="700">
            See all
          </T>
          <Icon name="chevron-forward" size={16} color={t.colors.primary} />
        </Focusable>
      ) : null}
    </View>
  );
}

export function ItemRow({
  title,
  items,
  variant = 'auto',
  onSeeAll,
  onFocusItem,
  firstPreferred,
}: {
  title: string;
  items: Item[];
  variant?: CardVariant;
  onSeeAll?: () => void;
  onFocusItem?: (i: Item) => void;
  firstPreferred?: boolean;
}) {
  const t = useTheme();
  const renderItem = useCallback(
    ({ item, index }: { item: Item; index: number }) => (
      <MediaCard item={item} variant={variant} onFocusItem={onFocusItem} hasTVPreferredFocus={firstPreferred && index === 0} />
    ),
    [variant, onFocusItem, firstPreferred],
  );
  if (!items.length) return null;
  return (
    <View style={{ marginBottom: t.space.lg }}>
      <RowHeader title={title} onSeeAll={onSeeAll} />
      <FlatList
        horizontal
        data={items}
        keyExtractor={(i) => i.id}
        renderItem={renderItem}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: t.space.gutter, gap: t.card.gap, paddingVertical: t.isTV ? t.s(14) : 0 }}
        initialNumToRender={8}
        windowSize={5}
        removeClippedSubviews={!t.isTV}
        {...(onSeeAll && t.isTV
          ? {
              ListFooterComponent: (
                <Focusable onPress={onSeeAll} style={{ height: t.card.posterHeight * 0.6, paddingHorizontal: t.space.lg, justifyContent: 'center', alignItems: 'center', backgroundColor: t.colors.surfaceAlt, borderRadius: t.radius }}>
                  <Icon name="arrow-forward" />
                  <T variant="small">See all</T>
                </Focusable>
              ),
            }
          : {})}
      />
    </View>
  );
}

export function ChannelRow({ title, channels, onSeeAll }: { title: string; channels: Channel[]; onSeeAll?: () => void }) {
  const t = useTheme();
  if (!channels.length) return null;
  return (
    <View style={{ marginBottom: t.space.lg }}>
      <RowHeader title={title} onSeeAll={onSeeAll} />
      <FlatList
        horizontal
        data={channels}
        keyExtractor={(c) => c.id}
        renderItem={({ item }) => <ChannelCard channel={item} />}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: t.space.gutter, gap: t.card.gap, paddingVertical: t.isTV ? t.s(14) : 0 }}
        removeClippedSubviews={!t.isTV}
      />
    </View>
  );
}
