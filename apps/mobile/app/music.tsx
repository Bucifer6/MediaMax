import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { FlatList, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Visualizer } from '@/player/Visualizer';
import { CastButton } from '@/cast';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Img } from '@/components/Img';
import { OptionSheet } from '@/components/OptionSheet';
import { PlayOnSheet } from '@/components/PlayOnSheet';
import { EmptyState } from '@/components/States';
import { T } from '@/components/Text';
import { BookmarksPanel } from '@/player/Bookmarks';
import { LyricsView, useLyrics } from '@/player/Lyrics';
import { Scrubber } from '@/player/Scrubber';
import { HostCaption, YourDjPanel, YourDjStrip } from '@/player/YourDjPanel';
import { SKIP_BACK_MS, SKIP_FORWARD_MS } from '@/car/policy';
import { SPEEDS, useMusic, type SleepOption } from '@/state/music';
import { useRemote } from '@/state/remote';
import { useSession } from '@/state/session';
import { useAdvancedDj } from '@/state/dj';
import { useTheme } from '@/theme';
import { useTVRemote } from '@/tv';
import { formatClock } from '@/utils/format';
import { openDj } from '@/utils/nav';

type Panel = 'queue' | 'lyrics' | 'chapters' | 'bookmarks' | 'yourdj' | 'visualizer';
const speedLabel = (r: number) => `${r}x`;
const SLEEP_MINUTES = [5, 15, 30, 45, 60];

export default function NowPlaying() {
  const t = useTheme();
  const m = useMusic();
  const insets = useSafeAreaInsets();
  const [panel, setPanel] = useState<Panel>('queue');
  const [speedSheet, setSpeedSheet] = useState(false);
  const [sleepSheet, setSleepSheet] = useState(false);
  const [playOn, setPlayOn] = useState(false);
  const remote = useRemote();
  const { status } = useSession();
  const advancedDj = useAdvancedDj();
  const cur = m.current;
  const isTrack = cur?.type === 'track';
  /** ±15/30 s buttons: spoken audio, and music longer than LONG_TRACK_MS (mixes, live sets…). */
  const intervalSkip = m.spoken || m.longTrack;
  const lyrics = useLyrics(isTrack && panel === 'lyrics' ? cur.id : null);
  // A panel that no longer applies (track ↔ episode) falls back to the queue.
  useEffect(() => {
    if (((panel === 'lyrics' || panel === 'visualizer') && !isTrack) || (panel === 'chapters' && !m.chapters.length) || (panel === 'bookmarks' && !m.spoken) || (panel === 'yourdj' && !m.yourDj)) setPanel('queue');
  }, [panel, isTrack, m.chapters.length, m.spoken, m.yourDj]);
  useTVRemote((e) => {
    if (e.eventType === 'playPause') m.toggle();
    if (e.eventType === 'fastForward') (m.spoken || m.longTrack ? m.skip(SKIP_FORWARD_MS) : m.next());
    if (e.eventType === 'rewind') (m.spoken || m.longTrack ? m.skip(-SKIP_BACK_MS) : m.previous());
  });
  if (!cur) return <View style={{ flex: 1, backgroundColor: t.colors.background }}><EmptyState icon="musical-notes-outline" title="Nothing playing" action="Close" onAction={() => router.back()} /></View>;

  const art = cur.posterUrl ?? cur.thumbUrl;
  const size = t.isTV ? t.s(panel === 'queue' ? 420 : 300) : Math.min(t.width - 64, t.height * (panel === 'queue' || t.wide ? 0.42 : 0.22), 420);
  /** TV artwork: its own column, so it may use most of the height but must leave room for the controls and the queue. */
  const tvArt = Math.round(Math.min(t.s(420), t.height * 0.55, t.width * 0.24));
  /** TV side panel height. Lists and scroll views there get it explicitly: on Fire TV a FlatList / ScrollView measured
   *  itself 2 px tall under flex alone (its content rendered, clipped), while plain views filled the panel. */
  const tvPanelH = t.height - t.space.gutter * 2;
  const transportIcon = t.isTV ? t.s(34) : 32;
  const canPlayOn = remote.enabled && status === 'signed-in';
  const sleepLabel = m.sleep ? (m.sleepRemainingMs != null ? `Sleep ${formatClock(m.sleepRemainingMs)}` : m.sleep.mode === 'time' ? 'Sleep' : 'Sleep · end') : 'Sleep';
  const sleepKey = !m.sleep ? 'off' : m.sleep.mode === 'time' ? `m${m.sleep.minutes}` : 'chapter';

  const controls = (
    <View style={{ width: t.isTV ? t.s(520) : '100%', gap: t.space.lg }}>
      <View style={{ gap: 4 }}>
        <T variant={t.isTV ? 'title' : 'heading'} color="#fff" numberOfLines={2}>{cur.title}</T>
        <Focusable onPress={() => cur.grandparentId && router.push(`/item/${cur.grandparentId}` as never)} focusScale={1}>
          <T color="rgba(255,255,255,0.75)" numberOfLines={1}>{[cur.grandparentTitle, cur.parentTitle].filter(Boolean).join(' — ')}</T>
        </Focusable>
        {m.blend ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }} accessibilityLiveRegion="polite">
            <Icon name="infinite-outline" size={14} color={t.colors.primary} />
            <T variant="small" weight="700" color={t.colors.primary} numberOfLines={1} style={{ flexShrink: 1 }}>
              Mixing into {m.blend.into.title}
            </T>
            <T variant="caption" color="rgba(255,255,255,0.6)" numberOfLines={1}>· {m.blend.label}</T>
          </View>
        ) : m.mix ? (
          <T variant="caption" color="rgba(255,255,255,0.6)" numberOfLines={1} style={{ marginTop: 2 }}>
            Mix · {m.mix.label}{m.endless ? ' · Endless' : ''}
          </T>
        ) : null}
      </View>
      {m.yourDj ? <YourDjStrip /> : <HostCaption variant="np" />}
      <Scrubber positionMs={m.positionMs} durationMs={m.durationMs} onSeek={m.seek} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        {intervalSkip ? (
          <Focusable onPress={() => m.skip(-SKIP_BACK_MS)} ringRadius={999} style={{ padding: 10, borderRadius: 999 }} accessibilityLabel={`Back ${SKIP_BACK_MS / 1000} seconds`}>
            <Icon name="play-back-outline" size={t.isTV ? t.s(28) : 26} color="#fff" />
            <T variant="caption" color="rgba(255,255,255,0.8)" center style={{ letterSpacing: 0 }}>{SKIP_BACK_MS / 1000}</T>
          </Focusable>
        ) : (
          <Focusable onPress={() => m.setShuffle(!m.shuffle)} ringRadius={999} style={{ padding: 10, borderRadius: 999 }} accessibilityLabel="Shuffle">
            <Icon name="shuffle" size={t.isTV ? t.s(26) : 24} color={m.shuffle ? t.colors.primary : 'rgba(255,255,255,0.7)'} />
          </Focusable>
        )}
        <Focusable onPress={m.previous} ringRadius={999} style={{ padding: 10, borderRadius: 999 }} accessibilityLabel="Previous">
          <Icon name="play-skip-back" size={transportIcon} color="#fff" />
        </Focusable>
        <Focusable onPress={m.toggle} hasTVPreferredFocus ringRadius={999} style={{ width: t.s(76), height: t.s(76), borderRadius: t.s(38), backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={m.playing ? 'Pause' : 'Play'}>
          <Icon name={m.playing ? 'pause' : 'play'} size={t.s(38)} color="#000" />
        </Focusable>
        <Focusable onPress={m.next} ringRadius={999} style={{ padding: 10, borderRadius: 999 }} accessibilityLabel="Next">
          <Icon name="play-skip-forward" size={transportIcon} color="#fff" />
        </Focusable>
        {intervalSkip ? (
          <Focusable onPress={() => m.skip(SKIP_FORWARD_MS)} ringRadius={999} style={{ padding: 10, borderRadius: 999 }} accessibilityLabel={`Forward ${SKIP_FORWARD_MS / 1000} seconds`}>
            <Icon name="play-forward-outline" size={t.isTV ? t.s(28) : 26} color="#fff" />
            <T variant="caption" color="rgba(255,255,255,0.8)" center style={{ letterSpacing: 0 }}>{SKIP_FORWARD_MS / 1000}</T>
          </Focusable>
        ) : (
          <Focusable onPress={m.cycleRepeat} ringRadius={999} style={{ padding: 10, borderRadius: 999 }} accessibilityLabel="Repeat">
            <View>
              <Icon name="repeat" size={t.isTV ? t.s(26) : 24} color={m.repeat !== 'off' ? t.colors.primary : 'rgba(255,255,255,0.7)'} />
              {m.repeat === 'one' ? <T variant="caption" color={t.colors.primary} style={{ position: 'absolute', right: -6, top: -6 }}>1</T> : null}
            </View>
          </Focusable>
        )}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm, justifyContent: 'center' }}>
        <PanelChip icon="list" label="Up next" active={panel === 'queue'} onPress={() => setPanel('queue')} />
        {m.yourDj ? <PanelChip icon="disc-outline" label="Your DJ" active={panel === 'yourdj'} onPress={() => setPanel(panel === 'yourdj' ? 'queue' : 'yourdj')} /> : null}
        {isTrack ? <PanelChip icon="chatbubble-ellipses-outline" label="Lyrics" active={panel === 'lyrics'} onPress={() => setPanel(panel === 'lyrics' ? 'queue' : 'lyrics')} /> : null}
        {isTrack ? <PanelChip icon="pulse-outline" label="Visualiser" active={panel === 'visualizer'} onPress={() => setPanel(panel === 'visualizer' ? 'queue' : 'visualizer')} /> : null}
        {m.chapters.length ? <PanelChip icon="bookmarks-outline" label="Chapters" active={panel === 'chapters'} onPress={() => setPanel(panel === 'chapters' ? 'queue' : 'chapters')} /> : null}
        {/* Long music: the ±15/30 s buttons took the shuffle / repeat places on the transport row. */}
        {m.longTrack ? <PanelChip icon="shuffle" label="Shuffle" active={m.shuffle} onPress={() => m.setShuffle(!m.shuffle)} /> : null}
        {m.longTrack ? <PanelChip icon="repeat" label={m.repeat === 'one' ? 'Repeat one' : 'Repeat'} active={m.repeat !== 'off'} onPress={m.cycleRepeat} /> : null}
        {m.spoken ? <PanelChip icon="bookmark-outline" label="Bookmarks" active={panel === 'bookmarks'} onPress={() => setPanel(panel === 'bookmarks' ? 'queue' : 'bookmarks')} /> : null}
        {m.spoken ? <PanelChip icon="speedometer-outline" label={speedLabel(m.rate)} active={m.rate !== 1} onPress={() => setSpeedSheet(true)} /> : null}
        <PanelChip icon={m.sleep ? 'moon' : 'moon-outline'} label={sleepLabel} active={!!m.sleep} onPress={() => setSleepSheet(true)} />
        {isTrack && !m.castingTo ? <PanelChip icon="infinite-outline" label="Automix" active={m.automix} onPress={() => m.setAutomix(!m.automix)} /> : null}
        {m.mix && !m.castingTo ? <PanelChip icon="sync-outline" label="Endless" active={m.endless} onPress={() => m.setEndless(!m.endless)} /> : null}
        {isTrack && !m.castingTo && advancedDj ? <PanelChip icon="disc-outline" label="DJ mix" active={false} onPress={() => openDj(cur)} /> : null}
        {canPlayOn && t.isTV ? <PanelChip icon="phone-portrait-outline" label="Play on…" active={false} onPress={() => setPlayOn(true)} /> : null}
        {/* Phones stop from the header (hidden on TV, where Back only leaves the screen and the music keeps going). */}
        {t.isTV ? <PanelChip icon="stop-circle-outline" label="Stop" active={false} onPress={() => { m.stop(); router.back(); }} /> : null}
      </View>
      {m.error ? <T tone="danger">{m.error}</T> : null}
    </View>
  );

  const chapterIdx = m.chapters.reduce((best, c, i) => (c.startMs <= m.positionMs + 500 ? i : best), -1);
  const chapterList = (
    <FlatList
      data={m.chapters}
      keyExtractor={(c, i) => `${c.startMs}-${i}`}
      style={t.isTV ? { height: tvPanelH } : { flex: 1 }}
      contentContainerStyle={{ paddingBottom: insets.bottom + t.space.lg }}
      ListHeaderComponent={<T variant="heading" color="#fff" style={{ marginBottom: t.space.sm }}>Chapters</T>}
      renderItem={({ item: c, index }) => (
        <Focusable onPress={() => m.seek(c.startMs)} hasTVPreferredFocus={t.isTV && index === chapterIdx} focusScale={t.isTV ? 1.02 : 1} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingVertical: t.space.sm, paddingHorizontal: t.space.sm, borderRadius: t.radius, backgroundColor: index === chapterIdx ? 'rgba(255,255,255,0.12)' : 'transparent' }}>
          {index === chapterIdx ? <Icon name="volume-high" size={16} color={t.colors.primary} /> : <T variant="small" color="rgba(255,255,255,0.6)" style={{ width: 16 }}>{index + 1}</T>}
          <T weight={index === chapterIdx ? '800' : '600'} color="#fff" numberOfLines={2} style={{ flex: 1 }}>{c.title || `Chapter ${index + 1}`}</T>
          <T variant="small" color="rgba(255,255,255,0.6)">{formatClock(c.startMs)}</T>
        </Focusable>
      )}
    />
  );
  const lyricsPanel = <LyricsView lyrics={lyrics} positionMs={m.positionMs} onSeek={m.seek} height={t.isTV ? tvPanelH : undefined} />;
  const djPanel = (
    <ScrollView style={t.isTV ? { height: tvPanelH } : { flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + t.space.lg }} keyboardShouldPersistTaps="handled">
      <YourDjPanel />
    </ScrollView>
  );
  const sidePanel = panel === 'visualizer' ? <Visualizer art={art} /> : panel === 'lyrics' ? lyricsPanel : panel === 'chapters' ? chapterList : panel === 'bookmarks' ? <BookmarksPanel /> : panel === 'yourdj' && m.yourDj ? djPanel : null;

  const queue = (
    <FlatList
      data={m.queue}
      keyExtractor={(x, i) => `${x.id}-${i}`}
      style={t.isTV ? { height: tvPanelH } : { flex: 1 }}
      contentContainerStyle={{ paddingBottom: insets.bottom + t.space.lg }}
      ListHeaderComponent={<T variant="heading" color="#fff" style={{ marginBottom: t.space.sm }}>Up next</T>}
      renderItem={({ item, index }) => (
        <Focusable onPress={() => m.jumpTo(index)} focusScale={t.isTV ? 1.02 : 1} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingVertical: t.space.sm, paddingHorizontal: t.space.sm, borderRadius: t.radius, backgroundColor: index === m.index ? 'rgba(255,255,255,0.12)' : 'transparent' }}>
          {index === m.index ? <Icon name="volume-high" size={16} color={t.colors.primary} /> : <T variant="small" color="rgba(255,255,255,0.6)" style={{ width: 16 }}>{index + 1}</T>}
          <View style={{ flex: 1 }}>
            <T weight={index === m.index ? '800' : '600'} color="#fff" numberOfLines={1}>{item.title}</T>
            <T variant="caption" color="rgba(255,255,255,0.6)" numberOfLines={1}>{item.grandparentTitle ?? item.parentTitle ?? ''}</T>
          </View>
          <T variant="small" color="rgba(255,255,255,0.6)">{item.durationMs ? formatClock(item.durationMs) : ''}</T>
        </Focusable>
      )}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {art ? <Img path={art} width={400} blurRadius={50} style={{ position: 'absolute', width: '100%', height: '100%', opacity: 0.7 }} /> : null}
      <LinearGradient colors={['rgba(0,0,0,0.3)', 'rgba(0,0,0,0.85)']} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      {!t.isTV ? (
        <View style={{ paddingTop: insets.top + 6, paddingHorizontal: t.space.sm, flexDirection: 'row', alignItems: 'center' }}>
          <Focusable onPress={() => router.back()} style={{ padding: 8 }} accessibilityLabel="Close">
            <Icon name="chevron-down" color="#fff" size={28} />
          </Focusable>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <T variant="caption" color="rgba(255,255,255,0.7)" style={{ textTransform: 'uppercase' }}>Now playing</T>
            {m.castingTo ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Icon name="tv-outline" size={13} color={t.colors.primary} />
                <T variant="caption" color={t.colors.primary} numberOfLines={1}>Casting to {m.castingTo}</T>
              </View>
            ) : null}
          </View>
          {canPlayOn ? (
            <Focusable onPress={() => setPlayOn(true)} style={{ padding: 8 }} accessibilityLabel="Play on another device">
              <Icon name="phone-portrait-outline" color="#fff" size={24} />
            </Focusable>
          ) : null}
          <CastButton tint="#fff" size={30} style={{ marginHorizontal: 4 }} />
          <Focusable onPress={() => { m.stop(); router.back(); }} style={{ padding: 8 }} accessibilityLabel="Stop">
            <Icon name="stop-circle-outline" color="#fff" size={26} />
          </Focusable>
        </View>
      ) : null}
      {t.isTV ? (
        // TV: artwork, controls and the queue / lyrics panel side by side. Stacked, the artwork plus the controls (with
        // the Your DJ card) were taller than the screen and the art and transport were cut off.
        // Children stretch to the full height (the side panel needs it: with alignSelf 'stretch' in a centred row it
        // collapsed to 2 px on Android TV, invisible but still taking the focus); art and controls centre themselves.
        <View style={{ flex: 1, flexDirection: 'row', padding: t.space.gutter, gap: t.space.xl, alignItems: 'stretch' }}>
          {panel !== 'visualizer' ? (
          <View style={{ justifyContent: 'center' }}>
            <View style={{ width: tvArt, height: tvArt, borderRadius: t.radius, overflow: 'hidden', backgroundColor: '#222', shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 30 }}>
              {art ? <Img path={art} width={tvArt} style={{ width: '100%', height: '100%' }} /> : null}
            </View>
          </View>
          ) : null}
          <View style={{ justifyContent: 'center' }}>{controls}</View>
          {/* Pinned to the row's edges: flex stretching and an explicit height both still left this panel 2 px tall on
              Fire TV (seen in the view hierarchy), so it is positioned absolutely, right of the controls. */}
          <View style={{ flex: 1 }} />
          <View style={{ position: 'absolute', top: t.space.gutter, bottom: t.space.gutter, right: t.space.gutter, left: t.space.gutter + (panel === 'visualizer' ? 0 : tvArt + t.space.xl) + t.s(520) + t.space.xl }}>{sidePanel ?? queue}</View>
        </View>
      ) : t.wide ? (
        <View style={{ flex: 1, flexDirection: 'row', padding: t.space.gutter, gap: t.space.xxl, alignItems: 'center' }}>
          <View style={{ gap: t.space.xl, alignItems: 'flex-start' }}>
            <View style={{ width: size, height: size, borderRadius: t.radius, overflow: 'hidden', backgroundColor: '#222', shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 30 }}>
              {art ? <Img path={art} width={size} style={{ width: '100%', height: '100%' }} /> : null}
            </View>
            {controls}
          </View>
          <View style={{ flex: 1, alignSelf: 'stretch' }}>{sidePanel ?? queue}</View>
        </View>
      ) : (
        <View style={{ flex: 1, paddingHorizontal: 32, gap: t.space.xl, paddingTop: t.space.lg }}>
          <View style={{ alignSelf: 'center', width: size, height: size, borderRadius: t.radius, overflow: 'hidden', backgroundColor: '#222', shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 30, elevation: 16 }}>
            {art ? <Img path={art} width={size} style={{ width: '100%', height: '100%' }} /> : null}
          </View>
          {controls}
          {sidePanel ?? queue}
        </View>
      )}
      <OptionSheet
        visible={speedSheet}
        title="Playback speed"
        options={SPEEDS.map((r) => ({ key: String(r), label: r === 1 ? '1x (normal)' : speedLabel(r), selected: r === m.rate }))}
        onSelect={(k) => {
          m.setRate(Number(k));
          setSpeedSheet(false);
        }}
        onClose={() => setSpeedSheet(false)}
      />
      <OptionSheet
        visible={sleepSheet}
        title={m.sleep && m.sleepRemainingMs != null ? `Sleep timer · ${formatClock(m.sleepRemainingMs)} left` : 'Sleep timer'}
        options={[
          { key: 'off', label: 'Off', icon: 'close-circle-outline', selected: sleepKey === 'off' },
          ...SLEEP_MINUTES.map((n) => ({ key: `m${n}`, label: `${n} minutes`, icon: 'time-outline' as const, selected: sleepKey === `m${n}` })),
          {
            key: 'chapter',
            label: m.chapters.length ? 'End of chapter' : m.spoken ? 'End of this part' : 'End of this track',
            description: m.chapters.length ? 'Falls back to the end of the part after the last chapter' : undefined,
            icon: 'bookmark-outline',
            selected: sleepKey === 'chapter',
          },
        ]}
        onSelect={(k) => {
          const opt: SleepOption | null = k === 'off' ? null : k === 'chapter' ? 'chapter' : { minutes: Number(k.slice(1)) };
          m.setSleep(opt);
          setSleepSheet(false);
        }}
        onClose={() => setSleepSheet(false)}
      />
      {canPlayOn ? (
        <PlayOnSheet visible={playOn} what={{ itemId: cur.id, positionMs: m.spoken ? m.positionMs : undefined, title: cur.title }} onClose={() => setPlayOn(false)} onSent={() => m.pause()} />
      ) : null}
    </View>
  );
}

function PanelChip({ icon, label, active, onPress }: { icon: React.ComponentProps<typeof Icon>['name']; label: string; active: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Focusable onPress={onPress} ringRadius={999} accessibilityLabel={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: t.isTV ? t.s(14) : 12, paddingVertical: t.isTV ? t.s(8) : 6, borderRadius: 999, backgroundColor: active ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)' }}>
      <Icon name={icon} size={t.isTV ? t.s(18) : 16} color={active ? t.colors.primary : '#fff'} />
      <T variant="small" weight="700" color="#fff">
        {label}
      </T>
    </Focusable>
  );
}
