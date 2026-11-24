import { useState } from 'react';
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
import { LIP_SYNC_OPTIONS, formatDelay } from '@/api/audio';
import { deviceInfoSync } from '@/api/device';
import { setTrickplayMode, useTrickplayMode, type TrickplayMode } from '@/player/Trickplay';

const TRICKPLAY_MODES: { key: TrickplayMode; label: string; description: string }[] = [
  { key: 'always', label: 'Always', description: 'Load preview images when a video starts (data saver kicks in on slow connections)' },
  { key: 'saver', label: 'Data saver', description: 'Only load previews once you start scrubbing' },
  { key: 'off', label: 'Off', description: 'No preview images on the seek bar' },
];

const LANGS = ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'fi', 'pl', 'ru', 'ja', 'ko', 'zh', 'ar', 'hi', 'tr'];
const SUB_MODES: { key: UserPreferences['subtitleMode']; label: string; description: string }[] = [
  { key: 'off', label: 'Off', description: 'Never show subtitles automatically' },
  { key: 'auto', label: 'Automatic', description: 'Forced or default tracks only' },
  { key: 'always', label: 'Always', description: 'Show subtitles in your language' },
  { key: 'forced', label: 'Forced only', description: 'Only foreign-language parts' },
];

const RG_MODES: { key: NonNullable<UserPreferences['replayGain']>; label: string; description: string }[] = [
  { key: 'auto', label: 'Automatic', description: 'Album gain for whole albums, track gain otherwise' },
  { key: 'track', label: 'Track', description: 'Every track at the same loudness' },
  { key: 'album', label: 'Album', description: 'Keep the loudness differences within an album' },
  { key: 'off', label: 'Off', description: 'Play files at their own level' },
];

type Sheet = 'quality' | 'subMode' | 'audioLang' | 'subLang' | 'rg' | 'lipSync' | 'trickplay' | null;

export default function PlaybackSettings() {
  const t = useTheme();
  const { user, updatePreferences } = useSession();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [error, setError] = useState<string | null>(null);
  const trickMode = useTrickplayMode();
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
  const audio = p.audio ?? {};
  const deviceId = deviceInfoSync()?.deviceId ?? null;
  const lipSync = (deviceId && p.audioDevices?.[deviceId]?.delayMs) || 0;
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
            <SettingRow icon="film-outline" label="Cinema mode (trailers before movies)" toggle={p.cinemaMode !== false} onToggle={(v) => set({ cinemaMode: v })} />
            <SettingRow icon="images-outline" label="Scrub previews" value={TRICKPLAY_MODES.find((m) => m.key === trickMode)?.label} onPress={() => setSheet('trickplay')} />
          </SettingSection>
          <SettingSection title="Audio">
            <SettingRow icon="moon-outline" label="Night mode (softer loud scenes)" toggle={!!audio.nightMode} onToggle={(v) => set({ audio: { ...audio, nightMode: v } })} />
            <SettingRow icon="chatbubbles-outline" label="Dialogue boost" toggle={!!audio.dialogueBoost} onToggle={(v) => set({ audio: { ...audio, dialogueBoost: v } })} />
            <SettingRow icon="pulse-outline" label="Normalise volume" toggle={!!audio.normalize} onToggle={(v) => set({ audio: { ...audio, normalize: v } })} />
            {deviceId ? <SettingRow icon="timer-outline" label="Lip-sync on this device" value={formatDelay(lipSync)} onPress={() => setSheet('lipSync')} /> : null}
            <T tone="muted" style={{ marginTop: t.space.xs, marginHorizontal: t.space.sm }}>
              The server applies these by re-encoding the sound (the picture is untouched). While one is on, Dolby Atmos / DTS:X
              passthrough to a receiver is replaced by E-AC-3 / AAC.
            </T>
          </SettingSection>
          <SettingSection title="Music">
            <SettingRow icon="volume-medium-outline" label="Volume levelling (ReplayGain)" value={RG_MODES.find((m) => m.key === (p.replayGain ?? 'auto'))?.label} onPress={() => setSheet('rg')} />
          </SettingSection>
          <SettingSection title="Languages">
            <SettingRow icon="musical-note-outline" label="Audio language" value={p.audioLanguage ? languageName(p.audioLanguage) : 'Default'} onPress={() => setSheet('audioLang')} />
            <SettingRow icon="chatbox-outline" label="Subtitles" value={SUB_MODES.find((m) => m.key === p.subtitleMode)?.label} onPress={() => setSheet('subMode')} />
            <SettingRow icon="language-outline" label="Subtitle language" value={p.subtitleLanguage ? languageName(p.subtitleLanguage) : 'Default'} onPress={() => setSheet('subLang')} />
          </SettingSection>
        </View>
      </ScrollView>
      <OptionSheet visible={sheet === 'quality'} title="Maximum quality" options={QUALITY_OPTIONS.map((q) => ({ key: String(q.kbps ?? 'orig'), label: q.label, selected: q.kbps === p.maxBitrate }))} onSelect={(k) => set({ maxBitrate: k === 'orig' ? null : Number(k) })} onClose={() => setSheet(null)} />
      <OptionSheet visible={sheet === 'lipSync'} title="Lip-sync on this device" options={LIP_SYNC_OPTIONS.map((ms) => ({ key: String(ms), label: formatDelay(ms), selected: ms === lipSync }))} onSelect={(k) => deviceId && set({ audioDevices: { [deviceId]: Number(k) ? { delayMs: Number(k) } : {} } })} onClose={() => setSheet(null)} />
      <OptionSheet visible={sheet === 'trickplay'} title="Scrub previews" options={TRICKPLAY_MODES.map((m) => ({ key: m.key, label: m.label, description: m.description, selected: m.key === trickMode }))} onSelect={(k) => { setSheet(null); void setTrickplayMode(k as TrickplayMode); }} onClose={() => setSheet(null)} />
      <OptionSheet visible={sheet === 'rg'} title="Volume levelling" options={RG_MODES.map((m) => ({ key: m.key, label: m.label, description: m.description, selected: m.key === (p.replayGain ?? 'auto') }))} onSelect={(k) => set({ replayGain: k })} onClose={() => setSheet(null)} />
      <OptionSheet visible={sheet === 'subMode'} title="Subtitles" options={SUB_MODES.map((m) => ({ key: m.key, label: m.label, description: m.description, selected: m.key === p.subtitleMode }))} onSelect={(k) => set({ subtitleMode: k })} onClose={() => setSheet(null)} />
      <OptionSheet visible={sheet === 'audioLang'} title="Audio language" options={langOptions(p.audioLanguage)} onSelect={(k) => set({ audioLanguage: k === '__none' ? null : k })} onClose={() => setSheet(null)} />
      <OptionSheet visible={sheet === 'subLang'} title="Subtitle language" options={langOptions(p.subtitleLanguage)} onSelect={(k) => set({ subtitleLanguage: k === '__none' ? null : k })} onClose={() => setSheet(null)} />
    </Screen>
  );
}
