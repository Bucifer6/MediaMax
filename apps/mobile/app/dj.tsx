/**
 * DJ mode: set up an automatic, beat- and key-aware mix (seed, genres, energy
 * curve, length, harmonic mixing, BPM range) and watch it play in the "booth"
 * (two decks, crossfader, upcoming transitions). Playback lives in
 * src/state/dj.tsx so it keeps going when you leave this screen.
 *
 * AI DJ (when the server has it on, DjStatus.ai.enabled): "Ask the DJ" builds a
 * mix from a plain-language prompt, the "DJ voice" host talks between tracks
 * (subtitle bubble in the booth) and ♥ Love / Skip next send feedback.
 *
 * Route params (all optional): seed (item id), seedTitle, seedType.
 */
import { useLocalSearchParams } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Keyboard, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DjEnergyCurve, DjMixRequest, DjMixTrack, DjStatus, DjTransition, Item } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Icon, type IconName } from '@/components/Icon';
import { Img } from '@/components/Img';
import { Input } from '@/components/Input';
import { ProgressBar } from '@/components/ProgressBar';
import { Screen, ScreenHeader } from '@/components/Screen';
import { SettingRow, SettingSection } from '@/components/SettingRow';
import { T } from '@/components/Text';
import { Focusable } from '@/components/Focusable';
import { useDj, type DeckView } from '@/state/dj';
import { useMusic } from '@/state/music';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { useTVRemote } from '@/tv';
import { formatClock } from '@/utils/format';
import { openItem } from '@/utils/nav';

const CURVES: { key: DjEnergyCurve; label: string; icon: IconName; description: string }[] = [
  { key: 'steady', label: 'Steady', icon: 'remove-outline', description: 'Keeps the energy level even the whole way through.' },
  { key: 'build', label: 'Build', icon: 'trending-up-outline', description: 'Starts relaxed and climbs steadily to a high finish.' },
  { key: 'peak', label: 'Peak', icon: 'triangle-outline', description: 'Warms up, peaks in the middle, then winds down.' },
  { key: 'wave', label: 'Wave', icon: 'pulse-outline', description: 'Rolls between highs and breathers for a party set.' },
  { key: 'chill', label: 'Chill', icon: 'cafe-outline', description: 'Low-key, mellow tracks for background listening.' },
];

type Length = 30 | 60 | 90 | 'continuous';
const LENGTHS: { key: Length; label: string }[] = [
  { key: 30, label: '30 min' },
  { key: 60, label: '60 min' },
  { key: 90, label: '90 min' },
  { key: 'continuous', label: 'Continuous' },
];

const BPM_PRESETS: { key: string; label: string; min?: number; max?: number }[] = [
  { key: 'any', label: 'Any tempo' },
  { key: 'slow', label: '< 100', max: 100 },
  { key: 'mid', label: '100–120', min: 100, max: 120 },
  { key: 'house', label: '120–130', min: 120, max: 130 },
  { key: 'fast', label: '130+', min: 130 },
];

type SeedKind = 'anything' | 'item' | 'current' | 'favourites';

export default function DjScreen() {
  const dj = useDj();
  const showBooth = dj.active || (dj.phase === 'ended' && dj.tracks.length > 0);
  useTVRemote((e) => {
    if (!dj.active) return;
    if (e.eventType === 'playPause') dj.toggle();
    if (e.eventType === 'fastForward') dj.mixNow();
  });
  return (
    <Screen>
      <ScreenHeader title="DJ mode" subtitle={showBooth ? (dj.continuous ? 'Continuous mix' : `${dj.tracks.length} tracks`) : 'Automatic beat-matched mixes'} />
      {showBooth ? <Booth /> : <Setup />}
    </Screen>
  );
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

function Setup() {
  const t = useTheme();
  const api = useApi();
  const dj = useDj();
  const music = useMusic();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ seed?: string; seedTitle?: string; seedType?: string }>();
  const currentTrack = music.current?.type === 'track' ? music.current : null;
  const [seed, setSeed] = useState<SeedKind>(params.seed ? 'item' : 'anything');
  const [genres, setGenres] = useState<string[]>([]);
  const [genreText, setGenreText] = useState('');
  const [curve, setCurve] = useState<DjEnergyCurve>('steady');
  const [length, setLength] = useState<Length>(60);
  const [harmonic, setHarmonic] = useState(true);
  const [bpm, setBpm] = useState('any');
  const [bpmMin, setBpmMin] = useState('');
  const [bpmMax, setBpmMax] = useState('');
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Which button the last attempt came from (errors show next to it). */
  const [via, setVia] = useState<'ask' | 'build'>('build');

  // Genres of the music libraries (GET /genres?libraryId=…); free text when there are none.
  const genreList = useQuery(
    'dj:genres',
    async (a) => {
      const libs = await a.libraries();
      const music = libs.filter((l) => l.type === 'music');
      const lists = await Promise.all(music.map((l) => a.genres(l.id).catch(() => [] as string[])));
      return [...new Set(lists.flat())].sort((x, y) => x.localeCompare(y));
    },
    { staleMs: 300000 },
  );
  const status = useQuery('dj:status', (a) => a.djStatus(), { staleMs: 30000 });
  const hasGenres = !!genreList.data?.length;
  // Older servers have no `ai` block: treat as off.
  const ai = status.data?.ai?.enabled ? status.data.ai : null;
  const playingArtist = music.playing && currentTrack ? currentTrack.grandparentTitle ?? currentTrack.parentTitle ?? null : null;

  const ask = async (prompt: string) => {
    const p = prompt.trim();
    if (!p) return;
    Keyboard.dismiss();
    setVia('ask');
    setErr(null);
    setStarting(true);
    try {
      await dj.start({ prompt: p }, { ai });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start the mix');
    } finally {
      setStarting(false);
    }
  };

  const go = async () => {
    setVia('build');
    setErr(null);
    setStarting(true);
    try {
      const req: DjMixRequest = { curve, harmonic };
      if (seed === 'item' && params.seed) req.seedItemId = params.seed;
      if (seed === 'current' && currentTrack) req.seedItemId = currentTrack.id;
      if (seed === 'favourites') {
        req.preferFavorites = true;
        const fav = await api.items({ type: 'track', favorite: true, sort: 'random', limit: 1 }).catch(() => null);
        if (fav?.items[0]) req.seedItemId = fav.items[0].id;
      }
      const g = hasGenres ? genres : genreText.split(',').map((x) => x.trim()).filter(Boolean);
      if (g.length) req.genres = g;
      const preset = BPM_PRESETS.find((p) => p.key === bpm);
      const min = bpm === 'custom' ? Number(bpmMin) || undefined : preset?.min;
      const max = bpm === 'custom' ? Number(bpmMax) || undefined : preset?.max;
      if (min) req.bpmMin = min;
      if (max) req.bpmMax = max;
      if (length !== 'continuous') req.durationMin = length;
      await dj.start(req, { continuous: length === 'continuous', ai });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start the mix');
    } finally {
      setStarting(false);
    }
  };

  const seedOptions: { key: SeedKind; label: string; icon: IconName }[] = [
    ...(params.seed ? [{ key: 'item' as const, label: params.seedTitle ?? 'This item', icon: 'disc-outline' as IconName }] : []),
    ...(currentTrack ? [{ key: 'current' as const, label: `Now playing: ${currentTrack.title}`, icon: 'musical-note-outline' as IconName }] : []),
    { key: 'favourites', label: 'My favourites', icon: 'heart-outline' },
    { key: 'anything', label: 'Surprise me', icon: 'shuffle-outline' },
  ];
  const curveInfo = CURVES.find((c) => c.key === curve)!;
  const section = { marginBottom: t.space.lg, gap: t.space.sm } as const;
  const chips = { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm } as const;

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: insets.bottom + t.space.xxl * 2, paddingTop: t.space.sm, maxWidth: t.isTV ? t.s(980) : undefined }}>
      {ai ? <AskDj ai={ai} artist={playingArtist} busy={starting || dj.phase === 'loading'} onAsk={(p) => void ask(p)} /> : null}

      {ai && via === 'ask' && (err || dj.error) ? (
        <T tone="danger" weight="600" style={{ marginBottom: t.space.md }}>
          {err ?? dj.error}
        </T>
      ) : null}

      <AnalysisNote status={status.data} />

      {ai ? (
        <T variant="heading" style={{ marginBottom: t.space.md }}>
          Or build it yourself
        </T>
      ) : null}

      <View style={section}>
        <Label>Start from</Label>
        <View style={chips}>
          {seedOptions.map((o, i) => (
            <Chip key={o.key} label={o.label} icon={o.icon} selected={seed === o.key} onPress={() => setSeed(o.key)} hasTVPreferredFocus={!ai && i === 0} />
          ))}
        </View>
      </View>

      <View style={section}>
        <Label>Genres {genres.length ? `· ${genres.length} selected` : '· any'}</Label>
        {hasGenres ? (
          <View style={chips}>
            {genreList.data!.map((g) => (
              <Chip key={g} label={g} selected={genres.includes(g)} onPress={() => setGenres((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]))} />
            ))}
            {genres.length ? <Chip label="Clear" icon="close" onPress={() => setGenres([])} /> : null}
          </View>
        ) : (
          <Input icon="pricetags-outline" placeholder="e.g. House, Disco (comma-separated)" value={genreText} onChangeText={setGenreText} autoCapitalize="words" />
        )}
      </View>

      <View style={section}>
        <Label>Energy curve</Label>
        <View style={chips}>
          {CURVES.map((c) => (
            <Chip key={c.key} label={c.label} icon={c.icon} selected={curve === c.key} onPress={() => setCurve(c.key)} />
          ))}
        </View>
        <T variant="small" tone="muted">
          {curveInfo.description}
        </T>
      </View>

      <View style={section}>
        <Label>Length</Label>
        <View style={chips}>
          {LENGTHS.map((l) => (
            <Chip key={String(l.key)} label={l.label} icon={l.key === 'continuous' ? 'infinite-outline' : 'time-outline'} selected={length === l.key} onPress={() => setLength(l.key)} />
          ))}
        </View>
        {length === 'continuous' ? (
          <T variant="small" tone="muted">
            Keeps picking the next tracks as it plays, until you stop it.
          </T>
        ) : null}
      </View>

      <View style={section}>
        <Label>Tempo (BPM)</Label>
        <View style={chips}>
          {BPM_PRESETS.map((p) => (
            <Chip key={p.key} label={p.label} selected={bpm === p.key} onPress={() => setBpm(p.key)} />
          ))}
          {!t.isTV ? <Chip label="Custom" icon="create-outline" selected={bpm === 'custom'} onPress={() => setBpm('custom')} /> : null}
        </View>
        {bpm === 'custom' && !t.isTV ? (
          <View style={{ flexDirection: 'row', gap: t.space.sm }}>
            <View style={{ flex: 1 }}>
              <Input placeholder="Min" keyboardType="number-pad" value={bpmMin} onChangeText={setBpmMin} />
            </View>
            <View style={{ flex: 1 }}>
              <Input placeholder="Max" keyboardType="number-pad" value={bpmMax} onChangeText={setBpmMax} />
            </View>
          </View>
        ) : null}
      </View>

      <SettingSection>
        <SettingRow icon="git-merge-outline" label="Harmonic mixing" value={harmonic ? 'Key-compatible neighbours' : 'Any key'} toggle={harmonic} onToggle={setHarmonic} />
        {ai ? <VoiceRow ai={ai} /> : null}
      </SettingSection>

      {(!ai || via === 'build') && (err || dj.error) ? (
        <T tone="danger" weight="600" style={{ marginBottom: t.space.md }}>
          {err ?? dj.error}
        </T>
      ) : null}
      <Button label={dj.phase === 'loading' || starting ? 'Building your mix…' : 'Start DJ mix'} icon="disc-outline" size="lg" block onPress={() => void go()} loading={starting} />
    </ScrollView>
  );
}

/** Example prompts for "Ask the DJ". */
function examplePrompts(artist: string | null): string[] {
  return ['Chilled Sunday morning', '90s party bangers, all night', 'Workout, fast, 45 minutes', ...(artist ? [`Something like ${artist}`] : []), 'Late-night jazz', 'Dinner party, mellow soul'].slice(0, 6);
}

function AskDj({ ai, artist, busy, onAsk }: { ai: DjStatus['ai']; artist: string | null; busy: boolean; onAsk: (prompt: string) => void }) {
  const t = useTheme();
  const [text, setText] = useState('');
  const submit = (p: string) => {
    if (busy || !p.trim()) return;
    onAsk(p);
  };
  return (
    <View style={{ gap: t.space.md, padding: t.space.lg, borderRadius: t.radius, backgroundColor: t.alpha(t.colors.primary, 0.1), borderWidth: 1, borderColor: t.alpha(t.colors.primary, 0.35), marginBottom: t.space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        <Icon name="sparkles-outline" color={t.colors.primary} size={t.isTV ? t.s(26) : 22} />
        <View style={{ flex: 1 }}>
          <T variant="heading">Ask the DJ</T>
          <T variant="small" tone="muted">
            {ai.llm ? 'Describe a mood, era, occasion or length. The AI DJ works out the rest.' : 'Describe a genre, decade, mood or length and the built-in DJ builds the mix.'}
          </T>
        </View>
      </View>
      <Input
        icon="chatbubble-ellipses-outline"
        placeholder="What do you feel like?"
        value={text}
        onChangeText={setText}
        returnKeyType="go"
        onSubmitEditing={() => submit(text)}
        autoCapitalize="sentences"
        maxLength={300}
        editable={!busy}
      />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
        {examplePrompts(artist).map((p, i) => (
          <Chip
            key={p}
            label={p}
            icon={p.startsWith('Something like') ? 'musical-notes-outline' : undefined}
            hasTVPreferredFocus={i === 0}
            onPress={() => {
              setText(p);
              submit(p);
            }}
          />
        ))}
      </View>
      <Button label={busy ? 'Building your mix…' : 'Ask the DJ'} icon="sparkles-outline" onPress={() => submit(text)} loading={busy} disabled={!text.trim()} block />
    </View>
  );
}

function VoiceRow({ ai }: { ai: DjStatus['ai'] }) {
  const dj = useDj();
  const how = { rare: 'every few tracks', normal: 'every other track', chatty: 'between every track' }[ai.chattiness] ?? 'between tracks';
  return <SettingRow icon="mic-outline" label="DJ voice" value={dj.voice ? `${ai.hostName || 'The host'} talks ${how}` : 'Off'} toggle={dj.voice} onToggle={dj.setVoice} />;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <T variant="caption" tone="muted" style={{ textTransform: 'uppercase' }}>
      {children}
    </T>
  );
}

function AnalysisNote({ status }: { status?: { analyzed: number; total: number; running: boolean } }) {
  const t = useTheme();
  if (!status || status.total === 0 || status.analyzed >= status.total) return null;
  return (
    <View style={{ flexDirection: 'row', gap: t.space.sm, alignItems: 'center', padding: t.space.md, borderRadius: t.radius, backgroundColor: t.alpha(t.colors.warning, 0.12), marginBottom: t.space.lg }}>
      <Icon name="analytics-outline" color={t.colors.warning} size={t.isTV ? t.s(22) : 18} />
      <T variant="small" style={{ flex: 1 }}>
        Analysed {status.analyzed.toLocaleString()} of {status.total.toLocaleString()} tracks{status.running ? ' (in progress)' : ''}. Mixes get tighter as more of your library is analysed.
      </T>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Booth                                                               */
/* ------------------------------------------------------------------ */

function Booth() {
  const t = useTheme();
  const dj = useDj();
  const insets = useSafeAreaInsets();
  const status = useQuery('dj:status', (a) => a.djStatus(), { staleMs: 30000 });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Item | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const ai = status.data?.ai?.enabled ? status.data.ai : null;
  const ended = dj.phase === 'ended';
  const upcoming = dj.tracks.slice(dj.currentIndex + 1).map((tr, i) => ({ tr, index: dj.currentIndex + 1 + i }));
  const played = Math.max(0, dj.currentIndex);
  const nextReady = dj.tracks[dj.currentIndex + 1] && dj.currentIndex >= 0;
  const stacked = !t.isTV && !t.wide;

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      const d = new Date();
      const pl = await dj.saveAsPlaylist(`DJ mix · ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
      setSaved(pl);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : 'Could not save the playlist');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: insets.bottom + t.space.xxl * 2, gap: t.space.lg, paddingTop: t.space.sm }}>
      {dj.summary || dj.prompt ? <AskedFor prompt={dj.prompt} summary={dj.summary} understoodBy={dj.understoodBy} /> : null}
      <AnalysisNote status={status.data} />
      {dj.error ? (
        <T tone="warning" variant="small" weight="600">
          {dj.error}
        </T>
      ) : null}

      {dj.phase === 'loading' && dj.currentIndex < 0 ? (
        <View style={{ gap: t.space.sm }}>
          <T weight="700">{dj.tracks.length ? 'Cueing the first track…' : 'Building your mix…'}</T>
          <ProgressBar value={0} indeterminate />
        </View>
      ) : null}

      <View style={{ flexDirection: stacked ? 'column' : 'row', gap: t.space.md }}>
        <DeckCard deck={dj.decks.A} />
        <DeckCard deck={dj.decks.B} />
      </View>

      {dj.hostLine ? <HostBubble name={dj.hostName} text={dj.hostLine.text} /> : null}

      <Crossfader value={dj.crossfader} mixing={dj.mixing} />

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
        {!ended ? (
          <>
            <Button label={dj.phase === 'paused' ? 'Resume' : 'Pause'} icon={dj.phase === 'paused' ? 'play' : 'pause'} onPress={dj.toggle} hasTVPreferredFocus />
            <Button label="Mix now" icon="git-merge-outline" variant="secondary" onPress={dj.mixNow} disabled={!nextReady || dj.mixing} />
            {ai ? <LoveButton /> : null}
            <Button label="Skip next" icon="play-skip-forward-outline" variant="secondary" onPress={dj.skipNext} disabled={!upcoming.length} />
            <Button label="Stop" icon="stop" variant="secondary" onPress={dj.stop} />
          </>
        ) : (
          <Button label="New mix" icon="disc-outline" onPress={dj.stop} hasTVPreferredFocus />
        )}
        <Button label={saved ? 'Saved' : 'Save as playlist'} icon={saved ? 'checkmark' : 'list-outline'} variant="secondary" onPress={() => void save()} loading={saving} disabled={!dj.tracks.length || !!saved} />
        {saved ? <Button label="Open playlist" icon="open-outline" variant="ghost" onPress={() => openItem(saved)} /> : null}
      </View>
      {ai && !ended ? (
        <SettingSection>
          <VoiceRow ai={ai} />
        </SettingSection>
      ) : null}
      {saveErr ? (
        <T tone="danger" variant="small">
          {saveErr}
        </T>
      ) : null}
      {ended ? (
        <T tone="muted">That's the end of the mix. Save it as a playlist or start a new one.</T>
      ) : null}

      <View style={{ gap: t.space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: t.space.sm }}>
          <T variant="heading">Up next</T>
          <T variant="small" tone="muted">
            {played ? `${played} played · ` : ''}
            {upcoming.length} queued{dj.toppingUp ? ' · finding more…' : ''}
          </T>
        </View>
        {upcoming.length ? (
          upcoming.map(({ tr, index }, i) => <QueueRow key={`${tr.item.id}-${index}`} tr={tr} first={i === 0} />)
        ) : (
          <T tone="muted" variant="small">
            {dj.continuous ? 'Picking the next tracks…' : 'No more tracks in this mix.'}
          </T>
        )}
      </View>
    </ScrollView>
  );
}

function AskedFor({ prompt, summary, understoodBy }: { prompt: string | null; summary: string | null; understoodBy: 'llm' | 'rules' | null }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: t.space.sm, alignItems: 'flex-start', padding: t.space.md, borderRadius: t.radius, backgroundColor: t.alpha(t.colors.primary, 0.1) }}>
      <Icon name="sparkles-outline" color={t.colors.primary} size={t.isTV ? t.s(22) : 18} />
      <View style={{ flex: 1, gap: 2 }}>
        <T weight="700">You asked for: {summary ?? prompt}</T>
        <T variant="small" tone="muted">
          {[summary && prompt ? `“${prompt}”` : null, understoodBy === 'llm' ? 'understood by AI' : understoodBy === 'rules' ? 'understood by the built-in DJ' : null].filter(Boolean).join(' · ')}
        </T>
      </View>
    </View>
  );
}

/** Subtitle bubble for the host line being spoken. */
function HostBubble({ name, text }: { name: string | null; text: string }) {
  const t = useTheme();
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    anim.setValue(0);
    Animated.timing(anim, { toValue: 1, duration: 250, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [text, anim]);
  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      style={{
        opacity: anim,
        transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
        flexDirection: 'row',
        gap: t.space.sm,
        alignItems: 'flex-start',
        padding: t.space.md,
        borderRadius: t.radius * 1.5,
        borderTopLeftRadius: 4,
        backgroundColor: t.colors.surface,
        borderWidth: 1,
        borderColor: t.alpha(t.colors.accent, 0.5),
      }}
    >
      <Icon name="mic" color={t.colors.accent} size={t.isTV ? t.s(22) : 18} />
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="caption" color={t.colors.accent} style={{ textTransform: 'uppercase' }}>
          {name || 'Your DJ'}
        </T>
        <T style={{ fontStyle: 'italic' }}>{text}</T>
      </View>
    </Animated.View>
  );
}

/** ♥ Love the audible track: AI DJ feedback (also favourites it on the server). */
function LoveButton() {
  const dj = useDj();
  const [loved, setLoved] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const pulse = useRef(new Animated.Value(1)).current;
  const id = dj.audibleItemId;
  const isLoved = !!id && loved.has(id);
  useEffect(() => setErr(false), [id]);
  const press = async () => {
    if (!id || isLoved || busy) return;
    setBusy(true);
    setErr(false);
    try {
      const done = await dj.love();
      if (done) {
        setLoved((s) => new Set(s).add(done));
        // No haptics module in this app: confirm with a quick pulse instead.
        pulse.setValue(1.25);
        Animated.spring(pulse, { toValue: 1, friction: 3, tension: 120, useNativeDriver: true }).start();
      }
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Animated.View style={{ transform: [{ scale: pulse }] }}>
      <Button
        label={isLoved ? 'Loved' : err ? 'Try again' : 'Love'}
        icon={isLoved ? 'heart' : 'heart-outline'}
        variant={isLoved ? 'danger' : 'secondary'}
        onPress={() => void press()}
        loading={busy}
        disabled={!id}
        accessibilityLabel={isLoved ? 'Loved this track' : 'Love this track'}
      />
    </Animated.View>
  );
}

function DeckCard({ deck }: { deck: DeckView }) {
  const t = useTheme();
  const tr = deck.track;
  const it = tr?.item;
  const a = tr?.analysis;
  const art = t.isTV ? t.s(120) : 72;
  const live = deck.role === 'live';
  const progress = deck.durationMs ? deck.positionMs / deck.durationMs : 0;
  const marker = deck.mixOutMs != null && deck.durationMs ? deck.mixOutMs / deck.durationMs : null;
  const bpmNow = a?.bpm ? a.bpm * deck.rate : null;
  return (
    <View
      style={{
        flex: 1,
        borderRadius: t.radius,
        padding: t.space.md,
        gap: t.space.sm,
        backgroundColor: t.colors.surface,
        borderWidth: live ? 2 : 1,
        borderColor: live ? t.colors.primary : t.colors.border,
        opacity: tr ? 1 : 0.6,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T variant="caption" tone="muted">
          DECK {deck.id}
        </T>
        <Badge label={live ? (deck.playing ? 'LIVE' : 'PAUSED') : deck.loading ? 'LOADING' : tr ? 'CUED' : 'EMPTY'} tone={live ? 'primary' : 'muted'} />
      </View>
      <View style={{ flexDirection: 'row', gap: t.space.md, alignItems: 'center' }}>
        <View style={{ width: art, height: art, borderRadius: t.radius / 1.5, overflow: 'hidden', backgroundColor: t.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
          {it && (it.posterUrl || it.thumbUrl) ? <Img path={it.posterUrl ?? it.thumbUrl} width={art} style={{ width: '100%', height: '100%' }} /> : <Icon name="disc-outline" size={art / 2.5} color={t.colors.textMuted} />}
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="700" numberOfLines={1}>
            {it?.title ?? '—'}
          </T>
          <T variant="small" tone="muted" numberOfLines={1}>
            {it ? it.grandparentTitle ?? it.parentTitle ?? '' : 'Waiting for the next track'}
          </T>
          <View style={{ flexDirection: 'row', gap: t.space.xs, flexWrap: 'wrap', marginTop: 2 }}>
            {bpmNow ? <Badge label={`${bpmNow.toFixed(1)} BPM${Math.abs(deck.rate - 1) > 0.002 ? ` (${deck.rate > 1 ? '+' : ''}${((deck.rate - 1) * 100).toFixed(1)}%)` : ''}`} /> : null}
            {a?.camelot ? <Badge label={a.camelot} /> : null}
          </View>
        </View>
      </View>
      {a ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
          <T variant="caption" tone="muted" style={{ width: t.isTV ? t.s(70) : 52 }}>
            ENERGY
          </T>
          <ProgressBar value={a.energy} color={t.colors.accent} track={t.alpha(t.colors.text, 0.1)} style={{ flex: 1 }} />
        </View>
      ) : null}
      <View style={{ gap: 4 }}>
        <View>
          <ProgressBar value={progress} track={t.alpha(t.colors.text, 0.12)} height={t.isTV ? t.s(6) : 4} />
          {marker != null ? (
            <View pointerEvents="none" style={{ position: 'absolute', left: `${Math.min(1, marker) * 100}%`, top: -3, bottom: -3, width: 2, backgroundColor: t.colors.warning }} />
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <T variant="caption" tone="muted">
            {tr ? formatClock(deck.positionMs) : ''}
          </T>
          <T variant="caption" tone="muted">
            {deck.mixOutMs != null && live ? `mix at ${formatClock(deck.mixOutMs)}` : deck.durationMs ? formatClock(deck.durationMs) : ''}
          </T>
        </View>
      </View>
    </View>
  );
}

function Crossfader({ value, mixing }: { value: number; mixing: boolean }) {
  const t = useTheme();
  const [w, setW] = useState(0);
  const anim = useRef(new Animated.Value(value)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: value, duration: 260, easing: Easing.linear, useNativeDriver: true }).start();
  }, [value, anim]);
  const knob = t.isTV ? t.s(36) : 26;
  const h = t.isTV ? t.s(8) : 6;
  return (
    <View style={{ gap: t.space.xs }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <T variant="caption" tone={value < 0.5 ? 'primary' : 'muted'}>
          A
        </T>
        <T variant="caption" tone={mixing ? 'accent' : 'muted'}>
          {mixing ? 'MIXING' : 'CROSSFADER'}
        </T>
        <T variant="caption" tone={value >= 0.5 ? 'primary' : 'muted'}>
          B
        </T>
      </View>
      <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ height: knob, justifyContent: 'center' }}>
        <View style={{ height: h, borderRadius: h, backgroundColor: t.alpha(t.colors.text, 0.12) }} />
        <View style={{ position: 'absolute', left: '50%', width: 2, height: knob * 0.7, backgroundColor: t.alpha(t.colors.text, 0.25) }} />
        <Animated.View
          style={{
            position: 'absolute',
            left: 0,
            width: knob * 1.6,
            height: knob,
            borderRadius: t.radius / 2,
            backgroundColor: mixing ? t.colors.accent : t.colors.primary,
            transform: [{ translateX: anim.interpolate({ inputRange: [0, 1], outputRange: [0, Math.max(0, w - knob * 1.6)] }) }],
          }}
        />
      </View>
    </View>
  );
}

const STYLE_ICON: Record<DjTransition['style'], IconName> = { blend: 'git-merge-outline', fade: 'swap-horizontal-outline', cut: 'cut-outline' };
const KEY_LABEL: Record<DjTransition['keyMatch'], string | null> = { perfect: 'Same key', compatible: 'Key match', energy: 'Energy boost', clash: 'Key clash', unknown: null };

function QueueRow({ tr, first }: { tr: DjMixTrack; first: boolean }) {
  const t = useTheme();
  const it = tr.item;
  const x = tr.transition;
  const size = t.isTV ? t.s(52) : 44;
  return (
    <Focusable
      onPress={() => openItem(it)}
      focusScale={t.isTV ? 1.02 : 1}
      style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.sm, borderRadius: t.radius, backgroundColor: first ? t.alpha(t.colors.primary, 0.08) : 'transparent' }}
    >
      <View style={{ width: size, height: size, borderRadius: 6, overflow: 'hidden', backgroundColor: t.colors.surfaceAlt }}>
        {it.posterUrl || it.thumbUrl ? <Img path={it.posterUrl ?? it.thumbUrl} width={size} style={{ width: '100%', height: '100%' }} /> : null}
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <T weight="600" numberOfLines={1}>
          {it.title}
        </T>
        <T variant="small" tone="muted" numberOfLines={1}>
          {[it.grandparentTitle ?? it.parentTitle, tr.analysis?.bpm ? `${Math.round(tr.analysis.bpm)} BPM` : null, tr.analysis?.camelot].filter(Boolean).join(' · ')}
        </T>
        {x ? (
          <View style={{ flexDirection: 'row', gap: t.space.xs, flexWrap: 'wrap' }}>
            <Badge icon={STYLE_ICON[x.style]} label={x.style} tone={x.style === 'blend' ? 'primary' : 'muted'} />
            {KEY_LABEL[x.keyMatch] ? <Badge label={KEY_LABEL[x.keyMatch]!} tone={x.keyMatch === 'clash' ? 'danger' : x.keyMatch === 'perfect' || x.keyMatch === 'compatible' ? 'success' : 'muted'} /> : null}
            {x.bpmDelta != null ? <Badge label={`${x.bpmDelta > 0 ? '+' : ''}${x.bpmDelta.toFixed(1)} BPM`} /> : null}
            {x.crossfadeMs > 0 && x.style !== 'cut' ? <Badge label={`${Math.round(x.crossfadeMs / 1000)}s mix`} /> : null}
          </View>
        ) : null}
      </View>
      <T variant="small" tone="muted">
        {it.durationMs ? formatClock(it.durationMs) : ''}
      </T>
    </Focusable>
  );
}

function Badge({ label, icon, tone = 'muted' }: { label: string; icon?: IconName; tone?: 'muted' | 'primary' | 'success' | 'danger' }) {
  const t = useTheme();
  const color = { muted: t.colors.textMuted, primary: t.colors.primary, success: t.colors.success, danger: t.colors.danger }[tone];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: t.isTV ? t.s(8) : 6, paddingVertical: 2, borderRadius: 999, backgroundColor: t.alpha(color, 0.14) }}>
      {icon ? <Icon name={icon} size={t.isTV ? t.s(14) : 11} color={color} /> : null}
      <T variant="caption" color={color} style={{ letterSpacing: 0.2 }}>
        {label}
      </T>
    </View>
  );
}
