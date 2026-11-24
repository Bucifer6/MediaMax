/**
 * Your DJ on Now Playing (segment, per-track reason, like, the DJ "Switch it up" button, requests with suggestion
 * chips, commentary Off / Intros / Full, play rules) and the host captions (Your DJ / Radio Host) with Skip talk and
 * mute. Everything shown here comes from the Vibe server; nothing is generated on the phone.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { YourDjCommentary } from '@/api/types';
import { Chip } from '@/components/Chip';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Input } from '@/components/Input';
import { PlayRulesSheet, useRulePresets } from '@/components/PlayRulesSheet';
import { T } from '@/components/Text';
import { rulesSummary } from '@/player/djRules';
import { reasonLabel, segmentKindLabel, segmentOf, yourDjCommentary } from '@/player/yourDj';
import { useMusic } from '@/state/music';
import { useSession } from '@/state/session';
import { useTheme } from '@/theme';

/** The prominent DJ button: one tap switches to a different segment. */
export function DjSwitchButton({ withLabel = false, onDark = true }: { withLabel?: boolean; onDark?: boolean }) {
  const t = useTheme();
  const m = useMusic();
  const busy = m.yourDj?.busy === 'switch' || m.yourDj?.busy === 'request';
  const fg = onDark ? '#fff' : t.colors.text;
  return (
    <Focusable
      onPress={() => void m.djSwitch()}
      disabled={!m.yourDj || busy}
      ringRadius={999}
      accessibilityLabel="Switch it up: Your DJ plays something different"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 4, paddingRight: withLabel ? 14 : 4, paddingVertical: 4, borderRadius: 999, borderWidth: 2, borderColor: t.colors.primary, backgroundColor: t.alpha(t.colors.primary, 0.18) }}
    >
      <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.primary }}>
        {busy ? <ActivityIndicator color={t.colors.primaryText} size="small" /> : <Icon name="disc" size={20} color={t.colors.primaryText} />}
      </View>
      {withLabel ? <T variant="small" weight="800" color={fg}>Switch it up</T> : null}
    </Focusable>
  );
}

/** Under the title: the segment, why this song (or what the DJ is saying), a like and the DJ button. */
export function YourDjStrip() {
  const t = useTheme();
  const m = useMusic();
  const [loved, setLoved] = useState<string | null>(null);
  const dj = m.yourDj;
  const seg = dj ? segmentOf(dj, m.current?.id) ?? dj.segments[dj.segmentId] ?? null : null;
  if (!dj || !seg) return null;
  const reason = reasonLabel(dj, m.current?.id);
  const cur = m.current;
  const isLoved = !!cur && (loved === cur.id || !!cur.userData?.favorite);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.sm, borderRadius: t.radius, backgroundColor: 'rgba(255,255,255,0.08)' }} accessibilityLabel="Your DJ">
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Icon name="disc" size={12} color={t.colors.primary} />
          <T variant="caption" weight="800" color={t.colors.primary} style={{ textTransform: 'uppercase' }} numberOfLines={1}>Your DJ · {segmentKindLabel(seg.kind)}</T>
        </View>
        <T weight="800" color="#fff" numberOfLines={1}>{seg.title}</T>
        {m.host.caption ? (
          <HostCaption variant="inline" />
        ) : reason ? (
          <T variant="caption" color="rgba(255,255,255,0.75)" numberOfLines={2}>{reason}</T>
        ) : null}
      </View>
      {cur ? (
        <Focusable
          onPress={() => {
            if (isLoved) return;
            setLoved(cur.id);
            m.djLove(cur);
          }}
          ringRadius={999}
          style={{ padding: 6 }}
          accessibilityLabel={isLoved ? 'Liked' : 'Like this song'}
          accessibilityState={{ selected: isLoved }}
        >
          <Icon name={isLoved ? 'heart' : 'heart-outline'} size={24} color={isLoved ? t.colors.primary : '#fff'} />
        </Focusable>
      ) : null}
      <DjSwitchButton />
    </View>
  );
}

const COMMENTARY: { key: YourDjCommentary; label: string; hint: string }[] = [
  { key: 'off', label: 'Off', hint: 'No talking (a caption when you switch).' },
  { key: 'intros', label: 'Intros', hint: 'A few words when a new segment starts.' },
  { key: 'full', label: 'Full', hint: 'Intros, plus a little between songs.' },
];

/** Suggestion chips from the server (history + time of day); cached for a few minutes. */
let chipCache: { at: number; chips: string[] } | null = null;
function useSuggestions(enabled: boolean): string[] {
  const { api } = useSession();
  const [chips, setChips] = useState<string[]>(chipCache?.chips ?? []);
  useEffect(() => {
    if (!enabled || !api) return;
    if (chipCache && Date.now() - chipCache.at < 10 * 60000) return;
    const ctrl = new AbortController();
    api
      .djSuggestions(new Date().getHours(), ctrl.signal)
      .then((r) => {
        const c = (r.chips ?? []).filter(Boolean).slice(0, 3);
        chipCache = { at: Date.now(), chips: c };
        setChips(c);
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [enabled, api]);
  return chips;
}

/** Requests, commentary and play rules (a Now Playing panel while Your DJ plays). */
export function YourDjPanel() {
  const t = useTheme();
  const m = useMusic();
  const { user, updatePreferences } = useSession();
  const { prefs, setPrefs, active } = useRulePresets();
  const dj = m.yourDj;
  const chips = useSuggestions(!!dj && m.djAi.on);
  const [text, setText] = useState('');
  const [rulesOpen, setRulesOpen] = useState(false);
  if (!dj) return null;
  const commentary = yourDjCommentary(user?.preferences);
  const busy = dj.busy === 'request';
  const submit = (value = text) => {
    const q = value.trim();
    if (!q || dj.busy) return;
    void m.djRequest(q);
    setText('');
  };
  return (
    <View style={{ gap: t.space.md }}>
      <T variant="heading" color="#fff">Your DJ</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        <View style={{ flex: 1 }}>
          <Input
            value={text}
            onChangeText={setText}
            placeholder="Ask for something… “90s hip hop”, “something calmer”"
            icon="sparkles-outline"
            returnKeyType="go"
            editable={!busy}
            onSubmitEditing={() => submit()}
            maxLength={300}
            accessibilityLabel="Request"
          />
        </View>
        <Focusable onPress={() => submit()} disabled={!text.trim() || busy} ringRadius={999} style={{ padding: 10, borderRadius: 999, backgroundColor: t.colors.primary, opacity: !text.trim() || busy ? 0.5 : 1 }} accessibilityLabel="Ask">
          {busy ? <ActivityIndicator color={t.colors.primaryText} size="small" /> : <Icon name="arrow-forward" size={20} color={t.colors.primaryText} />}
        </Focusable>
      </View>
      {chips.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityLabel="Suggestions">
          {chips.map((c) => <Chip key={c} label={c} icon="sparkles-outline" onPress={() => !dj.busy && submit(c)} />)}
        </View>
      ) : null}
      {dj.message ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: t.space.sm, padding: t.space.sm, borderRadius: t.radius, backgroundColor: 'rgba(255,255,255,0.1)' }} accessibilityLiveRegion="polite">
          <Icon name="chatbubble-ellipses-outline" size={16} color="#fff" />
          <T variant="small" color="#fff" style={{ flex: 1 }}>{dj.message}</T>
          <Focusable onPress={m.djDismiss} style={{ padding: 2 }} accessibilityLabel="Dismiss">
            <Icon name="close" size={16} color="rgba(255,255,255,0.7)" />
          </Focusable>
        </View>
      ) : null}

      <View style={{ gap: t.space.xs }}>
        <T variant="caption" color="rgba(255,255,255,0.7)" style={{ textTransform: 'uppercase' }}>DJ commentary</T>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {COMMENTARY.map((c) => (
            <Chip key={c.key} label={c.label} selected={commentary === c.key} onPress={() => void updatePreferences({ yourDj: { commentary: c.key } }).catch(() => undefined)} />
          ))}
        </View>
        <T variant="caption" color="rgba(255,255,255,0.6)">{COMMENTARY.find((c) => c.key === commentary)?.hint}</T>
      </View>

      <View style={{ gap: t.space.xs }}>
        <T variant="caption" color="rgba(255,255,255,0.7)" style={{ textTransform: 'uppercase' }}>Play rules</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Chip label="Everything" selected={!prefs.activePresetId} onPress={() => void setPrefs({ ...prefs, activePresetId: null }).catch(() => undefined)} />
          {prefs.presets.map((p) => (
            <Chip key={p.id} label={p.name} selected={prefs.activePresetId === p.id} onPress={() => void setPrefs({ ...prefs, activePresetId: p.id }).catch(() => undefined)} />
          ))}
          <Chip label="Edit" icon="options-outline" onPress={() => setRulesOpen(true)} />
        </View>
        <T variant="caption" color="rgba(255,255,255,0.6)">{active ? rulesSummary(active.rules, 3) : 'Your whole library'}. Changes apply from the next song.</T>
      </View>

      <Focusable onPress={() => m.host.setMuted(!m.host.muted)} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, paddingVertical: 4 }} accessibilityRole="switch" accessibilityState={{ checked: m.host.muted }}>
        <Icon name={m.host.muted ? 'volume-mute' : 'volume-high-outline'} size={18} color="#fff" />
        <T variant="small" weight="700" color="#fff">{m.host.muted ? 'DJ voice muted on this device' : 'Mute the DJ voice on this device'}</T>
      </Focusable>
      <PlayRulesSheet visible={rulesOpen} onClose={() => setRulesOpen(false)} />
    </View>
  );
}

/** Animated-looking "talking" bars (static: no animation dependency). */
function VoiceBars({ live, color }: { live: boolean; color: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 12 }} accessibilityElementsHidden importantForAccessibility="no">
      {[6, 11, 8, 12].map((h, i) => <View key={i} style={{ width: 2.5, height: live ? h : 4, borderRadius: 1, backgroundColor: color }} />)}
    </View>
  );
}

/**
 * What the host is saying (captions), with Skip talk and mute. `np` = above the Now Playing transport, `inline` =
 * inside the Your DJ strip, `mini` = the mini player's second line.
 */
export function HostCaption({ variant }: { variant: 'np' | 'inline' | 'mini' }) {
  const t = useTheme();
  const m = useMusic();
  const h = m.host;
  if (!h.caption) return null;
  const who = m.yourDj ? 'Your DJ' : 'Radio Host';
  const onDark = variant !== 'mini';
  const fg = onDark ? '#fff' : t.colors.text;
  if (variant === 'mini') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }} accessibilityLiveRegion="polite" accessibilityLabel={`${who} says: ${h.caption}`}>
        <VoiceBars live={h.speaking} color={t.colors.primary} />
        <T variant="caption" tone="primary" numberOfLines={1} style={{ flex: 1 }}>{h.caption}</T>
      </View>
    );
  }
  return (
    <View
      style={variant === 'np' ? { gap: 6, padding: t.space.sm, borderRadius: t.radius, backgroundColor: 'rgba(0,0,0,0.45)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' } : { gap: 4, marginTop: 2 }}
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${who} says`}
    >
      {variant === 'np' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <VoiceBars live={h.speaking} color={t.colors.primary} />
          <T variant="caption" weight="800" color={t.colors.primary} style={{ textTransform: 'uppercase' }}>{who}</T>
        </View>
      ) : null}
      <T variant={variant === 'np' ? 'small' : 'caption'} color={fg} numberOfLines={variant === 'np' ? 4 : 3}>{h.caption}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        {h.speaking ? (
          <Focusable onPress={h.skip} ringRadius={999} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.16)' }} accessibilityLabel="Skip talk: stop talking, the music carries on">
            <Icon name="play-skip-forward" size={12} color={fg} />
            <T variant="caption" weight="700" color={fg}>Skip talk</T>
          </Focusable>
        ) : null}
        <Focusable onPress={() => h.setMuted(!h.muted)} ringRadius={999} style={{ padding: 4 }} accessibilityLabel={h.muted ? `Unmute ${who}` : `Mute ${who} on this device`}>
          <Icon name={h.muted ? 'volume-mute' : 'volume-high-outline'} size={16} color={fg} />
        </Focusable>
      </View>
    </View>
  );
}
