/**
 * The TV-style channel banner along the bottom of live TV: number, logo and name, what's on now (with progress) and
 * next. While surfing (`preview`) it shows the channel you'd land on before it is tuned, with "OK to watch".
 */
import { LinearGradient } from 'expo-linear-gradient';
import { View } from 'react-native';
import type { Channel } from '@/api/types';
import { Icon } from '@/components/Icon';
import { Img } from '@/components/Img';
import { ProgressBar } from '@/components/ProgressBar';
import { T } from '@/components/Text';
import { useTheme } from '@/theme';
import { formatTime, programProgress } from '@/utils/format';

export function ChannelBanner({ channel, preview, typed, bottom = 0 }: { channel: Channel | null; preview?: boolean; typed?: string | null; bottom?: number }) {
  const t = useTheme();
  const now = channel?.nowPlaying ?? null;
  const next = channel?.next ?? null;
  const logo = t.isTV ? t.s(120) : 72;
  return (
    <LinearGradient
      pointerEvents="none"
      colors={['transparent', 'rgba(0,0,0,0.85)']}
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: t.space.xxl, paddingBottom: bottom + (t.isTV ? t.s(40) : t.space.lg), paddingHorizontal: t.isTV ? t.space.gutter : t.space.lg }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.lg }}>
        <View style={{ minWidth: t.isTV ? t.s(110) : 64, alignItems: 'center' }}>
          <T variant={t.isTV ? 'hero' : 'title'} weight="800" color="#fff">
            {typed ? `${typed}_` : channel?.number ?? ''}
          </T>
        </View>
        <View style={{ width: logo, height: Math.round(logo * 0.6), borderRadius: t.radius * 0.6, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          {channel?.logoUrl ? (
            <Img path={channel.logoUrl} width={logo * 2} contentFit="contain" style={{ width: '86%', height: '86%' }} />
          ) : (
            <Icon name={channel?.radio ? 'radio-outline' : 'tv-outline'} size={logo * 0.3} color="rgba(255,255,255,0.7)" />
          )}
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
            <T variant={t.isTV ? 'title' : 'heading'} weight="800" color="#fff" numberOfLines={1} style={{ flexShrink: 1 }}>
              {channel?.name ?? (typed ? 'No channel with that number yet' : '')}
            </T>
            {channel?.favorite ? <Icon name="star" size={t.isTV ? t.s(22) : 16} color={t.colors.warning} /> : null}
            {channel?.radio ? <T variant="caption" weight="800" color="rgba(255,255,255,0.7)">RADIO</T> : null}
          </View>
          {now ? (
            <>
              <T variant={t.isTV ? 'heading' : 'body'} color="#fff" numberOfLines={1}>
                Now · {now.title}
              </T>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
                <T variant="small" color="rgba(255,255,255,0.75)">{formatTime(now.start)} – {formatTime(now.end)}</T>
                <View style={{ flex: 1, maxWidth: t.isTV ? t.s(420) : 160 }}>
                  <ProgressBar value={programProgress(now)} />
                </View>
              </View>
            </>
          ) : channel ? (
            <T variant="small" color="rgba(255,255,255,0.7)">No guide information</T>
          ) : null}
          {next ? (
            <T variant="small" color="rgba(255,255,255,0.75)" numberOfLines={1}>
              Next · {formatTime(next.start)} {next.title}
            </T>
          ) : null}
        </View>
        {preview && channel ? (
          <View style={{ paddingHorizontal: t.space.md, paddingVertical: t.space.xs, borderRadius: 999, backgroundColor: t.colors.primary }}>
            <T variant="small" weight="800" color={t.colors.primaryText}>{t.isTV ? 'OK to watch' : 'Tuning…'}</T>
          </View>
        ) : null}
      </View>
    </LinearGradient>
  );
}
