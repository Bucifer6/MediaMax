import { memo } from 'react';
import { View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { Item } from '@/api/types';
import { useTheme } from '@/theme';
import { episodeLabel, progressFraction } from '@/utils/format';
import { openItem } from '@/utils/nav';
import { Focusable } from './Focusable';
import { Icon } from './Icon';
import { Img } from './Img';
import { ProgressBar } from './ProgressBar';
import { SmartBadge } from './SmartBadge';
import { T } from './Text';

export type CardVariant = 'poster' | 'landscape' | 'square' | 'auto';

export function cardVariantFor(item: Item, preferred: CardVariant = 'auto'): Exclude<CardVariant, 'auto'> {
  if (preferred !== 'auto') return preferred;
  if (item.type === 'episode' || item.type === 'video' || item.type === 'photo') return 'landscape';
  if (item.type === 'album' || item.type === 'artist' || item.type === 'track' || item.type === 'playlist' || item.type === 'podcast' || item.type === 'podcastepisode') return 'square';
  return 'poster';
}

export function useCardSize(variant: Exclude<CardVariant, 'auto'>, widthOverride?: number) {
  const t = useTheme();
  const { card } = t;
  if (variant === 'landscape') {
    const w = widthOverride ?? card.landscapeWidth;
    return { width: w, height: Math.round((w * 9) / 16) };
  }
  if (variant === 'square') {
    const w = widthOverride ?? card.squareSize;
    return { width: w, height: w };
  }
  const w = widthOverride ?? card.posterWidth;
  return { width: w, height: Math.round(w * 1.5) };
}

export interface MediaCardProps {
  item: Item;
  variant?: CardVariant;
  width?: number;
  onPress?: (item: Item) => void;
  onFocusItem?: (item: Item) => void;
  showTitle?: boolean;
  showProgress?: boolean;
  hasTVPreferredFocus?: boolean;
}

export const MediaCard = memo(function MediaCard({ item, variant = 'auto', width, onPress, onFocusItem, showTitle = true, showProgress = true, hasTVPreferredFocus }: MediaCardProps) {
  const t = useTheme();
  const v = cardVariantFor(item, variant);
  const size = useCardSize(v, width);
  const radius = t.shapeRadius(size.width, size.height);
  const image =
    v === 'landscape' ? item.thumbUrl ?? item.backdropUrl ?? item.posterUrl : v === 'square' ? item.posterUrl ?? item.thumbUrl : item.posterUrl ?? item.thumbUrl;
  const progress = showProgress ? progressFraction(item) : 0;
  const unplayed = item.userData?.unplayedCount;
  const title = item.type === 'episode' && v === 'landscape' ? item.grandparentTitle ?? item.title : item.title;
  const subtitle = item.type === 'episode' ? [episodeLabel(item), item.title].filter(Boolean).join(' · ') : item.year ? String(item.year) : item.parentTitle ?? '';

  return (
    <View style={{ width: size.width }}>
      <Focusable
        onPress={() => (onPress ? onPress(item) : openItem(item))}
        onFocus={() => onFocusItem?.(item)}
        hasTVPreferredFocus={hasTVPreferredFocus}
        ringRadius={radius}
        accessibilityLabel={item.title}
        style={{ width: size.width, height: size.height, borderRadius: radius, overflow: 'hidden', backgroundColor: t.colors.surfaceAlt }}
      >
        {image ? (
          <Img path={image} width={size.width} style={{ width: '100%', height: '100%' }} />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.space.sm }}>
            <Icon name={item.type === 'album' || item.type === 'track' ? 'musical-notes' : item.type === 'audiobook' || item.type === 'bookpart' ? 'book-outline' : item.type === 'podcast' || item.type === 'podcastepisode' ? 'mic-outline' : 'film-outline'} color={t.colors.textMuted} />
            <T variant="small" tone="muted" center numberOfLines={3} style={{ marginTop: t.space.xs }}>
              {item.title}
            </T>
          </View>
        )}
        {progress > 0 ? (
          <LinearGradient colors={['transparent', 'rgba(0,0,0,0.75)']} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '35%', justifyContent: 'flex-end', padding: t.isTV ? t.s(8) : 6 }}>
            <ProgressBar value={progress} />
          </LinearGradient>
        ) : null}
        {item.smart ? (
          <View style={{ position: 'absolute', top: 6, left: 6 }}>
            <SmartBadge overlay />
          </View>
        ) : null}
        {item.userData?.played && !progress ? (
          <View style={{ position: 'absolute', top: 6, right: 6, backgroundColor: t.colors.primary, borderRadius: 999, padding: 2 }}>
            <Icon name="checkmark" size={t.isTV ? t.s(16) : 12} color={t.colors.primaryText} />
          </View>
        ) : unplayed ? (
          <View style={{ position: 'absolute', top: 6, right: 6, backgroundColor: t.colors.primary, borderRadius: 999, minWidth: 22, paddingHorizontal: 6, paddingVertical: 1, alignItems: 'center' }}>
            <T variant="caption" color={t.colors.primaryText}>
              {unplayed}
            </T>
          </View>
        ) : null}
      </Focusable>
      {showTitle ? (
        <View style={{ marginTop: t.space.xs + 2, paddingHorizontal: 2 }}>
          <T variant="small" weight="600" numberOfLines={1}>
            {title}
          </T>
          {subtitle ? (
            <T variant="caption" tone="muted" weight="500" numberOfLines={1}>
              {subtitle}
            </T>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});
