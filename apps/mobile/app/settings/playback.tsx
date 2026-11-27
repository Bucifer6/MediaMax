import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { QUALITY_OPTIONS } from '@/api/profiles';
import type { DjTransitionPreference, HostChattiness, RadioHostPrefs, UserPreferences, YourDjCommentary } from '@/api/types';
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
import { AUTOMIX_DEFAULT } from '@/player/automix';
import { EnforcedChips, PlayRulesSheet, useEnforcedRules, useRulePresets } from '@/components/PlayRulesSheet';
import { rulesSummary } from '@/player/djRules';
import { DEVICE_VOICE, radioHostPrefs, wantsDeviceVoice, withHostPatch } from '@/player/radioHost';
import { yourDjCommentary } from '@/player/yourDj';
import { useMusic } from '@/state/music';
import { EXTERNAL_PLAYERS, externalPlayerLabel } from '@/player/external';
import { externalPlayerSupported, frameRateMatchingSupported, setExternalPlayer, setMatchFrameRate, useExternalPlayer, useMatchFrameRate } from '@/player/deviceSettings';
import { MediaMaxMedia } from '../../modules/mediamax-media';

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

/** Automix transition feel: the same choices (and preference) as the web app. */
const MIX_STYLES: { key: DjTransitionPreference; label: string; description: string }[] = [
  { key: 'auto', label: 'Automatic', description: 'Picks per pair: beat-matched blends when tempos are close, else a crossfade' },
  { key: 'smooth', label: 'Smooth', description: 'Long, gentle blends' },
  { key: 'energetic', label: 'Energetic', description: 'Short blends and quick swaps' },
  { key: 'minimal', label: 'Minimal', description: 'Short, plain crossfades' },
];

/** Radio Host levels (same choices as the web app). */
const HOST_LEVELS: { key: HostChattiness; label: string; description: string }[] = [
  { key: 'off', label: 'Off', description: 'No host' },
  { key: 'intros', label: 'Just intros', description: 'A few words about the next song, now and then' },
  { key: 'light', label: 'Light', description: 'Intros, plus the occasional fact, time or weather' },
  { key: 'chatty', label: 'Chatty', description: 'More often, with a short break every so often' },
];
const HOST_CATEGORIES: { key: keyof RadioHostPrefs['categories']; label: string; icon: React.ComponentProps<typeof SettingRow>['icon'] }[] = [
  { key: 'announce', label: 'Song announcements', icon: 'megaphone-outline' },
  { key: 'facts', label: 'Music facts', icon: 'bulb-outline' },
  { key: 'jokes', label: 'Jokes', icon: 'happy-outline' },
  { key: 'weather', label: 'Weather', icon: 'partly-sunny-outline' },
  { key: 'time', label: 'Time checks', icon: 'time-outline' },
  { key: 'stats', label: 'Your listening stats', icon: 'stats-chart-outline' },
];
const COMMENTARY: { key: YourDjCommentary; label: string; description: string }[] = [
  { key: 'off', label: 'Off', description: 'No talking; a caption when you switch' },
  { key: 'intros', label: 'Intros', description: 'A few words when a new segment starts' },
  { key: 'full', label: 'Full', description: 'Intros, plus a little between songs' },
];

type Sheet = 'quality' | 'subMode' | 'audioLang' | 'subLang' | 'rg' | 'lipSync' | 'trickplay' | 'mixStyle' | 'hostLevel' | 'hostVoice' | 'commentary' | 'externalPlayer' | null;

/** External players offered: "Ask every time" plus the ones installed (all of them on builds that can't tell). */
function externalChoices(): typeof EXTERNAL_PLAYERS {
  const pkgs = EXTERNAL_PLAYERS.flatMap((p) => (p.packageName ? [p.packageName] : []));
  let installed: string[] | null = null;
  try {
    installed = MediaMaxMedia?.installedPlayers?.(pkgs) ?? null;
  } catch {
    installed = null;
  }
  return installed ? EXTERNAL_PLAYERS.filter((p) => !p.packageName || installed.includes(p.packageName)) : EXTERNAL_PLAYERS;
}

export default function PlaybackSettings() {
  const t = useTheme();
  const { user, updatePreferences } = useSession();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [error, setError] = useState<string | null>(null);
  const trickMode = useTrickplayMode();
  const ext = useExternalPlayer();
  const matchFrameRate = useMatchFrameRate();
  const m = useMusic();
  const [rulesOpen, setRulesOpen] = useState(false);
  const { active: activeRules, prefs: rulePrefs } = useRulePresets();
  const enforced = useEnforcedRules(true);
  const p = user?.preferences;
  if (!p) return null;
  const host = radioHostPrefs(p);
  const setHost = (patch: Partial<RadioHostPrefs>) => set({ radioHost: withHostPatch(host, patch) });
  const commentary = yourDjCommentary(p);
  // Server only: offline, or with the AI DJ off on the server, these can't be used (settings still show what's saved).
  const hostUsable = m.djAi.radioHost;
  const hostNote = !m.djAi.on ? 'Needs a connection to your Vibe server with the AI DJ turned on.' : null;
  const autoVoiceLabel = m.djAi.serverVoice ? `Automatic (${m.djAi.hostName || 'server'} voice)` : 'Automatic (this device)';

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
            {frameRateMatchingSupported ? (
              <SettingRow icon="tv-outline" label="Match frame rate" toggle={matchFrameRate} onToggle={(v) => void setMatchFrameRate(v)} />
            ) : null}
          </SettingSection>
          {externalPlayerSupported ? (
            <SettingSection title="External player">
              <SettingRow icon="open-outline" label="Open videos in another app" toggle={ext.enabled} onToggle={(v) => void setExternalPlayer({ ...ext, enabled: v })} />
              {ext.enabled ? <SettingRow icon="apps-outline" label="Player" value={externalPlayerLabel(ext.packageName)} onPress={() => setSheet('externalPlayer')} /> : null}
              <T tone="muted" style={{ marginTop: t.space.xs, marginHorizontal: t.space.sm }}>
                For files the built-in player can’t handle: Vibe asks the server for the original file and hands it to VLC,
                Kodi, Just Player, MX Player or mpv. VLC, Just Player, MX Player and mpv send the position back, so resume
                and watched state stay right; with Kodi they don’t change. Downloads still play here. Dolby Vision plays
                best in the built-in player.
              </T>
            </SettingSection>
          ) : null}
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
            <SettingRow icon="infinite-outline" label="Automix (blend tracks like a DJ)" toggle={p.automix ?? AUTOMIX_DEFAULT} onToggle={(v) => set({ automix: v })} />
            {p.automix ?? AUTOMIX_DEFAULT ? (
              <SettingRow icon="git-merge-outline" label="Transition style" value={MIX_STYLES.find((m) => m.key === (p.automixStyle ?? 'auto'))?.label} onPress={() => setSheet('mixStyle')} />
            ) : null}
            <SettingRow icon="disc-outline" label="Advanced DJ (DJ screen, AI DJ and its voice)" toggle={!!p.advancedDj} onToggle={(v) => set({ advancedDj: v })} />
            <T tone="muted" style={{ marginTop: t.space.xs, marginHorizontal: t.space.sm }}>
              Automix plays albums, playlists and your library as one continuous mix: beat-matched blends when tempos are close,
              smooth crossfades otherwise. Albums that run straight on stay gapless. On the phone the DJ effects (bass swap,
              filter, echo) play as volume fades. Everything comes from your Vibe server.
            </T>
          </SettingSection>
          <SettingSection title="Radio Host">
            <SettingRow icon="radio-outline" label="Radio Host" value={HOST_LEVELS.find((l) => l.key === host.chattiness)?.label} onPress={hostUsable || host.enabled ? () => setSheet('hostLevel') : undefined} />
            {host.enabled
              ? HOST_CATEGORIES.map((c) =>
                  c.key === 'weather' && m.djAi.weather === false ? (
                    <SettingRow key={c.key} icon={c.icon} label="Weather" value="Needs a location from your admin" chevron={false} />
                  ) : (
                    <SettingRow key={c.key} icon={c.icon} label={c.label} toggle={host.categories[c.key]} onToggle={(v) => setHost({ categories: { ...host.categories, [c.key]: v } })} />
                  ),
                )
              : null}
            {host.enabled || m.yourDj ? (
              <SettingRow icon="mic-outline" label="Voice" value={wantsDeviceVoice(host.voice) ? 'This device' : autoVoiceLabel} onPress={() => setSheet('hostVoice')} />
            ) : null}
            <SettingRow icon="volume-mute-outline" label="Mute the host on this device" toggle={m.host.muted} onToggle={m.host.setMuted} />
            <T tone="muted" style={{ marginTop: t.space.xs, marginHorizontal: t.space.sm }}>
              Like listening to the radio, without the commercials: a host who introduces songs and shares a fact, the time or the
              weather now and then, talking over song intros with the music turned down. Works with music streamed from your Vibe
              server (not downloads or offline playback); what the host says comes from the server.
              {hostNote ? ` ${hostNote}` : ''}
            </T>
          </SettingSection>
          <SettingSection title="Your DJ">
            <SettingRow icon="chatbubble-ellipses-outline" label="DJ commentary" value={COMMENTARY.find((c) => c.key === commentary)?.label} onPress={() => setSheet('commentary')} />
            <SettingRow icon="options-outline" label="Play rules" value={activeRules ? activeRules.name : 'Everything'} onPress={() => setRulesOpen(true)} />
            <View style={{ padding: t.space.md, gap: t.space.sm }}>
              <T variant="small" tone="muted">
                {activeRules ? `${activeRules.name}: ${rulesSummary(activeRules.rules, 3)}.` : 'Everything in your music library.'}
                {rulePrefs.presets.length ? ` ${rulePrefs.presets.length} preset${rulePrefs.presets.length > 1 ? 's' : ''} saved.` : ''} Used by Your DJ, Mix and Endless.
              </T>
              <EnforcedChips rules={enforced} />
            </View>
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
      <OptionSheet
        visible={sheet === 'externalPlayer'}
        title="External player"
        options={(sheet === 'externalPlayer' ? externalChoices() : EXTERNAL_PLAYERS).map((o) => ({
          key: o.packageName ?? '__ask',
          label: o.label,
          description: o.packageName ? (o.returnsPosition ? 'Sends your position back' : 'Doesn’t send your position back') : 'Android asks which app to use',
          selected: o.packageName === ext.packageName,
        }))}
        onSelect={(k) => {
          setSheet(null);
          void setExternalPlayer({ ...ext, packageName: k === '__ask' ? null : k });
        }}
        onClose={() => setSheet(null)}
      />
      <OptionSheet visible={sheet === 'mixStyle'} title="Transition style" options={MIX_STYLES.map((m) => ({ key: m.key, label: m.label, description: m.description, selected: m.key === (p.automixStyle ?? 'auto') }))} onSelect={(k) => set({ automixStyle: k as DjTransitionPreference })} onClose={() => setSheet(null)} />
      <OptionSheet visible={sheet === 'hostLevel'} title="Radio Host" options={HOST_LEVELS.map((l) => ({ key: l.key, label: l.label, description: l.description, selected: l.key === host.chattiness }))} onSelect={(k) => setHost({ chattiness: k as HostChattiness })} onClose={() => setSheet(null)} />
      <OptionSheet
        visible={sheet === 'hostVoice'}
        title="Host voice"
        options={[
          { key: 'auto', label: autoVoiceLabel, description: m.djAi.serverVoice ? 'Your server’s voice, or this device’s when there is none' : 'Your server has no voice set up, so this device speaks', selected: !wantsDeviceVoice(host.voice) },
          { key: DEVICE_VOICE, label: 'This device’s voice', description: 'Always speak with the phone’s own voice', selected: wantsDeviceVoice(host.voice) },
        ]}
        onSelect={(k) => setHost({ voice: k === DEVICE_VOICE ? DEVICE_VOICE : null })}
        onClose={() => setSheet(null)}
      />
      <OptionSheet visible={sheet === 'commentary'} title="DJ commentary" options={COMMENTARY.map((c) => ({ key: c.key, label: c.label, description: c.description, selected: c.key === commentary }))} onSelect={(k) => set({ yourDj: { commentary: k as YourDjCommentary } })} onClose={() => setSheet(null)} />
      <PlayRulesSheet visible={rulesOpen} onClose={() => setRulesOpen(false)} />
      <OptionSheet visible={sheet === 'rg'} title="Volume levelling" options={RG_MODES.map((m) => ({ key: m.key, label: m.label, description: m.description, selected: m.key === (p.replayGain ?? 'auto') }))} onSelect={(k) => set({ replayGain: k })} onClose={() => setSheet(null)} />
      <OptionSheet visible={sheet === 'subMode'} title="Subtitles" options={SUB_MODES.map((m) => ({ key: m.key, label: m.label, description: m.description, selected: m.key === p.subtitleMode }))} onSelect={(k) => set({ subtitleMode: k })} onClose={() => setSheet(null)} />
      <OptionSheet visible={sheet === 'audioLang'} title="Audio language" options={langOptions(p.audioLanguage)} onSelect={(k) => set({ audioLanguage: k === '__none' ? null : k })} onClose={() => setSheet(null)} />
      <OptionSheet visible={sheet === 'subLang'} title="Subtitle language" options={langOptions(p.subtitleLanguage)} onSelect={(k) => set({ subtitleLanguage: k === '__none' ? null : k })} onClose={() => setSheet(null)} />
    </Screen>
  );
}
