/**
 * The one-tap "Your DJ" card (Home and the music library screen). Starts a personal set picked by the Vibe server
 * (POST /dj/session with the active play-rules preset); while it plays, the card shows the segment and the DJ button.
 * Server only: offline, or with the AI DJ switched off by the admin, the card is disabled with a short note (or hidden).
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useQuery } from '@/api/useQuery';
import { DjSwitchButton } from '@/player/YourDjPanel';
import { segmentOf } from '@/player/yourDj';
import { useMusic } from '@/state/music';
import { useSession } from '@/state/session';
import { useTheme } from '@/theme';
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
  const avail = m.yourDjAvailability;
  if (!music || features.music === false || avail.hidden || t.isTV) return null;
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
        { marginHorizontal: t.space.gutter, marginVertical: t.space.sm, padding: t.space.md, borderRadius: t.radius * 1.2, gap: t.space.sm, backgroundColor: t.alpha(t.colors.primary, t.dark ? 0.16 : 0.1), borderWidth: 1, borderColor: t.alpha(t.colors.primary, 0.35), opacity: disabled ? 0.65 : 1 },
        style,
      ]}
      accessibilityLabel="Your DJ"
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <View style={{ width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.primary }}>
          <Icon name="disc" size={30} color={t.colors.primaryText} />
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
            <Focusable onPress={() => router.push('/music')} ringRadius={999} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999, backgroundColor: t.alpha(t.colors.text, 0.1) }} accessibilityLabel="Open Now Playing">
              <Icon name="expand-outline" size={16} />
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
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 999, backgroundColor: t.colors.primary }}
          >
            {m.yourDjStarting ? <ActivityIndicator color={t.colors.primaryText} size="small" /> : <Icon name="play" size={18} color={t.colors.primaryText} />}
            <T weight="800" color={t.colors.primaryText}>{m.yourDjStarting ? 'Warming up…' : 'Play'}</T>
          </Focusable>
        )}
        <Focusable onPress={() => setRulesOpen(true)} disabled={status !== 'signed-in'} ringRadius={999} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6 }} accessibilityLabel="Choose what Your DJ may play">
          <Icon name="options-outline" size={14} color={t.colors.textMuted} />
          <T variant="caption" tone="muted" numberOfLines={1}>{active ? active.name : 'Play rules: everything'}</T>
        </Focusable>
      </View>
      {message ? <T variant="small" tone="muted">{message}</T> : null}
      <PlayRulesSheet visible={rulesOpen} onClose={() => setRulesOpen(false)} />
    </View>
  );
}
