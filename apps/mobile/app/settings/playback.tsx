import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { QUALITY_OPTIONS } from '@/api/profiles';
import type { UserPreferences } from '@/api/types';
import { OptionSheet } from '@/components/OptionSheet';
import { Screen, ScreenHeader } from '@/components/Screen';
import { SettingRow, SettingSection } from '@/components/SettingRow';
import { T } from '@/components/Text';
import { useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { languageName } from '@/utils/format';

const LANGS = ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'fi', 'pl', 'ru', 'ja', 'ko', 'zh', 'ar', 'hi', 'tr'];
const SUB_MODES: { key: UserPreferences['subtitleMode']; label: string; description: string }[] = [
  { key: 'off', label: 'Off', description: 'Never show subtitles automatically' },
  { key: 'auto', label: 'Automatic', description: 'Forced or default tracks only' },
  { key: 'always', label: 'Always', description: 'Show subtitles in your language' },
  { key: 'forced', label: 'Forced only', description: 'Only foreign-language parts' },
];

type Sheet = 'quality' | 'subMode' | 'audioLang' | 'subLang' | null;

export default function PlaybackSettings() {
  const t = useTheme();
  const { user, updatePreferences } = useSession();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [error, setError] = useState<string | null>(null);
  const p = user?.preferences;
  if (!p) return null;

  const set = async (patch: Partial<UserPreferences>) => {
    setSheet(null);
    setError(null);
    try {
      await updatePreferences(patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const langOptions = (sel: string | null) => [{ key: '__none', label: 'No preference', selected: !sel }, ...LANGS.map((l) => ({ key: l, label: languageName(l), selected: sel === l }))];

  return (
    <Screen>
      <ScreenHeader title="Playback" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.xxl, alignItems: t.isTV ? 'center' : undefined }}>
        <View style={{ width: '100%', maxWidth: t.isTV ? t.s(820) : undefined }}>
          {error ? <T tone="danger">{error}</T> : null}
          <SettingSection title="Streaming">
            <SettingRow icon="speedometer-outline" label="Maximum quality" value={QUALITY_OPTIONS.find((q) => q.kbps === p.maxBitrate)?.label ?? `${p.maxBitrate} kbps`} onPress={() => setSheet('quality')} hasTVPreferredFocus />
          </SettingSection>
          <SettingSection title="Watching">
            <SettingRow icon="play-skip-forward-outline" label="Autoplay next episode" toggle={p.autoplayNext} onToggle={(v) => set({ autoplayNext: v })} />
            <SettingRow icon="flash-outline" label="Skip intros automatically" toggle={p.skipIntros} onToggle={(v) => set({ skipIntros: v })} />
          </SettingSection>
          <SettingSection title="Languages">
            <SettingRow icon="musical-note-outline" label="Audio language" value={p.audioLanguage ? languageName(p.audioLanguage) : 'Default'} onPress={() => setSheet('audioLang')} />
            <SettingRow icon="chatbox-outline" label="Subtitles" value={SUB_MODES.find((m) => m.key === p.subtitleMode)?.label} onPress={() => setSheet('subMode')} />
            <SettingRow icon="language-outline" label="Subtitle language" value={p.subtitleLanguage ? languageName(p.subtitleLanguage) : 'Default'} onPress={() => setSheet('subLang')} />
          </SettingSection>
        </View>
      </ScrollView>
      <OptionSheet visible={sheet === 'quality'} title="Maximum quality" options={QUALITY_OPTIONS.map((q) => ({ key: String(q.kbps ?? 'orig'), label: q.label, selected: q.kbps === p.maxBitrate }))} onSelect={(k) => set({ maxBitrate: k === 'orig' ? null : Number(k) })} onClose={() => setSheet(null)} />
      <OptionSheet visible={sheet === 'subMode'} title="Subtitles" options={SUB_MODES.map((m) => ({ key: m.key, label: m.label, description: m.description, selected: m.key === p.subtitleMode }))} onSelect={(k) => set({ subtitleMode: k })} onClose={() => setSheet(null)} />
      <OptionSheet visible={sheet === 'audioLang'} title="Audio language" options={langOptions(p.audioLanguage)} onSelect={(k) => set({ audioLanguage: k === '__none' ? null : k })} onClose={() => setSheet(null)} />
      <OptionSheet visible={sheet === 'subLang'} title="Subtitle language" options={langOptions(p.subtitleLanguage)} onSelect={(k) => set({ subtitleLanguage: k === '__none' ? null : k })} onClose={() => setSheet(null)} />
    </Screen>
  );
}
