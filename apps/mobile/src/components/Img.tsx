import { Image, type ImageContentFit } from 'expo-image';
import React from 'react';
import { PixelRatio, type StyleProp, type ImageStyle } from 'react-native';
import { useSession } from '@/state/session';

/** Server image (server-relative path) or an absolute/local URI. */
export function Img({
  path,
  width,
  style,
  contentFit = 'cover',
  transition = 250,
  priority,
  blurRadius,
}: {
  path: string | null | undefined;
  /** Rendered width in points; used to ask the server for a right-sized image. */
  width?: number;
  style?: StyleProp<ImageStyle>;
  contentFit?: ImageContentFit;
  transition?: number;
  priority?: 'low' | 'normal' | 'high';
  blurRadius?: number;
}) {
  const { api } = useSession();
  if (!path) return null;
  const isLocal = /^(file|content|data|asset):/i.test(path);
  const uri = isLocal ? path : api ? api.image(path, width ? PixelRatio.getPixelSizeForLayoutSize(width) : undefined) : null;
  if (!uri) return null;
  return (
    <Image
      source={{ uri }}
      style={style}
      contentFit={contentFit}
      transition={transition}
      cachePolicy="memory-disk"
      recyclingKey={uri}
      priority={priority}
      blurRadius={blurRadius}
    />
  );
}
