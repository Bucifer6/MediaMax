/**
 * The stock "Kinora" logo (mark + outlined wordmark, rendered by scripts/brand-export.mjs) for a
 * server that has not been renamed; a white-labelled server shows its own name in the theme font.
 * Uploaded logos are handled by the callers (they always win).
 */
import Constants from 'expo-constants';
import { Image } from 'expo-image';
import React from 'react';
import { View } from 'react-native';
import { useTheme } from '@/theme';
import { Icon } from './Icon';
import { T } from './Text';

const WORDMARK = { dark: require('../../assets/brand/wordmark-dark.png'), light: require('../../assets/brand/wordmark-light.png') };
const ASPECT = 960 / 328; // wordmark-*.png from scripts/brand-export.mjs

export function BrandWordmark({ name, width, textVariant = 'hero' }: { name?: string | null; width: number; textVariant?: 'hero' | 'heading' }) {
  const t = useTheme();
  if (name && name !== 'Kinora' && name !== 'MediaMax') {
    return (
      <T variant={textVariant} center={textVariant === 'hero'}>
        {name}
      </T>
    );
  }
  return <Image source={WORDMARK[t.dark ? 'dark' : 'light']} style={{ width, height: width / ASPECT }} contentFit="contain" accessibilityLabel="Kinora" accessible />;
}

const MARK = require('../../assets/brand/mark.png');
const MARK_ASPECT = 512 / 582; // brand/mark.png
const isWhiteLabel = !!Constants.expoConfig?.extra?.brand;

/**
 * The app's own mark on the connect screen (shown before any server, so it is the app's identity).
 * White-label builds (KINORA_BRAND) show a neutral play tile in their primary colour instead.
 */
export function BrandMarkImage({ size }: { size: number }) {
  const t = useTheme();
  if (isWhiteLabel) {
    return (
      <View style={{ width: size, height: size, borderRadius: size * 0.28, backgroundColor: t.colors.primary, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="play" size={size * 0.53} color={t.colors.primaryText} />
      </View>
    );
  }
  return <Image source={MARK} style={{ width: size * MARK_ASPECT, height: size }} contentFit="contain" accessibilityLabel="Kinora" />;
}
