/**
 * The one-tap "Your DJ" card (Home and the music library screen). Starts a personal set picked by the Vibe server
 * (POST /dj/session with the active play-rules preset); while it plays, the card shows the segment and the DJ button.
 * Server only: offline, or with the AI DJ switched off by the admin, the card is disabled with a short note (or hidden).
 * On TV every control is a remote-focusable pill, the card is width-capped, and "DJ mode" opens the DJ booth when the
 * Advanced DJ preference is on (the TV has no other obvious way in).
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useQuery } from '@/api/useQuery';
import { DjSwitchButton } from '@/player/YourDjPanel';
import { useAdvancedDj } from '@/state/dj';
import { segmentOf } from '@/player/yourDj';
import { useMusic } from '@/state/music';
import { useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { openDj } from '@/utils/nav';
import { Focusable } from './Focusable';
import { Icon } from './Icon';
import { PlayRulesSheet, useRulePresets } from './PlayRulesSheet';
import { T } from './Text';

function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return 'Late night picks from your library';
  if (h < 12) return 'A morning set from your library';
  if (h < 17) return 'An afternoon set from your library';
  if (h < 22) return 'An evening set from your library';
  return 'Late night picks from your library';
}

/** `hasMusic` can be passed by screens that already know (the music library screen). */
export function YourDjCard({ hasMusic, style }: { hasMusic?: boolean; style?: object }) {
  const t = useTheme();
  const m = useMusic();
  const { status, features } = useSession();
  const libs = useQuery(hasMusic === undefined && status === 'signed-in' ? 'libraries' : null, (a) => a.libraries());
  const music = hasMusic ?? (libs.data ?? []).some((l) => l.type === 'music');
  const { active } = useRulePresets();
  const [rulesOpen, setRulesOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const advancedDj = useAdvancedDj();
  const avail = m.yourDjAvailability;
  if (!music || features.music === false || avail.hidden) return null;
  const live = !!m.yourDj;
  const seg = live ? segmentOf(m.yourDj, m.current?.id) ?? m.yourDj!.segments[m.yourDj!.segmentId] : null;
  const disabled = !avail.available && !live;
  const start = async () => {
    setMessage(null);
    const r = await m.startYourDj();
    if (!r.ok && r.message) setMessage(r.message);
  };
  return (
    <View
      style={[
        { marginHorizontal: t.space.gutter, marginVertical: t.space.sm, padding: t.space.md, maxWidth: t.isTV ? t.s(900) : undefined, borderRadius: t.radius * 1.2, gap: t.space.sm, backgroundColor: t.alpha(t.colors.primary, t.dark ? 0.16 : 0.1), borderWidth: 1, borderColor: t.alpha(t.colors.primary, 0.35), opacity: disabled ? 0.65 : 1 },
        style,
      ]}
      accessibilityLabel="Your DJ"
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <View style={{ width: t.s(52), height: t.s(52), borderRadius: t.s(26), alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.primary }}>
          <Icon name="disc" size={t.s(30)} color={t.colors.primaryText} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="caption" tone="primary" weight="800" style={{ textTransform: 'uppercase' }}>{live ? 'Playing now' : 'Made for you'}</T>
          <T variant="heading" numberOfLines={1}>Your DJ</T>
          <T variant="small" tone="muted" numberOfLines={2}>
            {live && seg ? `${seg.title} · ${seg.reason}` : disabled && avail.note ? avail.note : greeting()}
          </T>
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, flexWrap: 'wrap' }}>
        {live ? (
          <>
            <Focusable onPress={() => router.push('/music')} ringRadius={999} style={{ flexDirection: 'row', alignItems: 'center', gap: t.s(6), paddingHorizontal: t.s(16), paddingVertical: t.s(9), borderRadius: 999, backgroundColor: t.alpha(t.colors.text, 0.1) }} accessibilityLabel="Open Now Playing">
              <Icon name="expand-outline" size={t.s(16)} />
              <T variant="small" weight="700">Open</T>
            </Focusable>
            <DjSwitchButton withLabel onDark={t.dark} />
          </>
        ) : (
          <Focusable
            onPress={disabled || m.yourDjStarting ? undefined : () => void start()}
            disabled={disabled || m.yourDjStarting}
            ringRadius={999}
            accessibilityLabel={m.yourDjStarting ? 'Your DJ is warming up' : 'Play Your DJ'}
            style={{ flexDirection: 'row', alignItems: 'center', gap: t.s(8), paddingHorizontal: t.s(20), paddingVertical: t.s(10), borderRadius: 999, backgroundColor: t.colors.primary }}
          >
            {m.yourDjStarting ? <ActivityIndicator color={t.colors.primaryText} size="small" /> : <Icon name="play" size={t.s(18)} color={t.colors.primaryText} />}
            <T weight="800" color={t.colors.primaryText}>{m.yourDjStarting ? 'Warming up…' : 'Play'}</T>
          </Focusable>
        )}
        {advancedDj ? (
          <Focusable onPress={() => openDj()} ringRadius={999} style={{ flexDirection: 'row', alignItems: 'center', gap: t.s(6), paddingHorizontal: t.s(16), paddingVertical: t.s(9), borderRadius: 999, backgroundColor: t.alpha(t.colors.text, 0.1) }} accessibilityLabel="Open DJ mode">
            <Icon name="disc-outline" size={t.s(16)} />
            <T variant="small" weight="700">DJ mode</T>
          </Focusable>
        ) : null}
        <Focusable onPress={() => setRulesOpen(true)} disabled={status !== 'signed-in'} ringRadius={999} style={{ flexDirection: 'row', alignItems: 'center', gap: t.s(4), paddingHorizontal: t.s(10), paddingVertical: t.s(6) }} accessibilityLabel="Choose what Your DJ may play">
          <Icon name="options-outline" size={t.s(14)} color={t.colors.textMuted} />
          <T variant="caption" tone="muted" numberOfLines={1}>{active ? active.name : 'Play rules: everything'}</T>
        </Focusable>
      </View>
      {message ? <T variant="small" tone="muted">{message}</T> : null}
      <PlayRulesSheet visible={rulesOpen} onClose={() => setRulesOpen(false)} />
    </View>
  );
}
