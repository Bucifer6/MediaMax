import { LinearGradient } from 'expo-linear-gradient';
import React, { useState } from 'react';
import { Alert, FlatList, Linking, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DownloadQuality, Item, Person, UserItemData } from '@/api/types';
import { AddToPlaylistSheet } from '@/components/AddToPlaylistSheet';
import { Button } from '@/components/Button';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { MetaLine } from '@/components/Hero';
import { OptionSheet } from '@/components/OptionSheet';
import { PlayOnSheet, type PlayOnWhat } from '@/components/PlayOnSheet';
import { Img } from '@/components/Img';
import { ProgressBar } from '@/components/ProgressBar';
import { RowHeader } from '@/components/Row';
import { SmartBadge } from '@/components/SmartBadge';
import { BackButton } from '@/components/Screen';
import { T } from '@/components/Text';
import { DOWNLOAD_QUALITIES, effectiveQuality, useDownloads } from '@/state/downloads';
import { useRemote } from '@/state/remote';
import { useApi, useCapabilities, useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { formatClock, progressFraction } from '@/utils/format';

/** Played / favourite toggles and the star rating, with optimistic updates. */
export function useUserDataActions(item: Item | undefined, onChange: (ud: UserItemData) => void) {
  const api = useApi();
  const setRating = async (rating: number | null) => {
    if (!item) return;
    const prev = item.userData;
    onChange({ ...prev, rating });
    try {
      const ud = await api.rate(item.id, rating);
      if (ud) onChange(ud);
    } catch {
      onChange(prev);
    }
  };
  const toggle = async (kind: 'played' | 'favorite') => {
    if (!item) return;
    const prev = item.userData;
    const next = kind === 'played' ? { ...prev, played: !prev.played, positionMs: prev.played ? prev.positionMs : 0 } : { ...prev, favorite: !prev.favorite };
    onChange(next);
    try {
      const ud = kind === 'played' ? await api.setPlayed(item.id, !prev.played) : await api.setFavorite(item.id, !prev.favorite);
      if (ud) onChange(ud);
    } catch {
      onChange(prev);
    }
  };
  return { togglePlayed: () => toggle('played'), toggleFavorite: () => toggle('favorite'), setRating };
}

/**
 * 5-star rating row. The server stores 0-10, so one star = 2 points.
 * Tapping the current star again clears the rating. Each star is focusable on TV.
 */
export function RatingStars({ rating, onRate, label = true }: { rating: number | null | undefined; onRate: (rating: number | null) => void; label?: boolean }) {
  const t = useTheme();
  const stars = rating == null ? 0 : Math.round(rating / 2);
  const size = t.isTV ? t.s(30) : 26;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.isTV ? t.s(4) : 2 }} accessibilityRole="adjustable" accessibilityLabel={`Your rating: ${stars} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Focusable
          key={n}
          onPress={() => onRate(n === stars ? null : n * 2)}
          ringRadius={999}
          focusScale={t.isTV ? 1.2 : 1}
          accessibilityRole="button"
          accessibilityLabel={n === stars ? 'Clear rating' : `Rate ${n} star${n > 1 ? 's' : ''}`}
          hitSlop={4}
          style={{ padding: t.isTV ? t.s(6) : 4, borderRadius: 999 }}
        >
          {({ focused }) => <Icon name={n <= stars ? 'star' : 'star-outline'} size={size} color={n <= stars ? t.colors.warning : focused ? t.colors.primary : t.colors.textMuted} />}
        </Focusable>
      ))}
      {label ? (
        <T variant="small" tone="muted" style={{ marginLeft: t.space.sm }}>
          {stars ? `Your rating · ${stars}/5` : 'Rate this'}
        </T>
      ) : null}
    </View>
  );
}

export function DetailBackdrop({ item, height }: { item: Item; height: number }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ height, width: '100%' }}>
      <Img path={item.backdropUrl ?? item.thumbUrl ?? item.posterUrl} width={t.width} style={{ position: 'absolute', width: '100%', height: '100%' }} priority="high" />
      <LinearGradient colors={['transparent', t.alpha(t.colors.overlay, 0.5), t.colors.background]} locations={[0.3, 0.7, 1]} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '80%' }} />
      {!t.isTV ? (
        <View style={{ position: 'absolute', top: insets.top + 6, left: 8 }}>
          <BackButton floating />
        </View>
      ) : null}
    </View>
  );
}

/** Full-screen TV backdrop behind detail pages. */
export function TVDetailBackground({ item }: { item: Item }) {
  const t = useTheme();
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} pointerEvents="none">
      <Img path={item.backdropUrl ?? item.thumbUrl ?? item.posterUrl} width={t.width} style={{ position: 'absolute', width: '100%', height: '100%' }} priority="high" />
      <LinearGradient colors={[t.colors.background, t.alpha(t.colors.background, 0.85), t.alpha(t.colors.background, 0.2)]} locations={[0, 0.45, 1]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      <LinearGradient colors={['transparent', t.colors.background]} locations={[0.55, 1]} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
    </View>
  );
}

export function TitleBlock({ item, center }: { item: Item; center?: boolean }) {
  const t = useTheme();
  const showTitle = item.type === 'episode' ? item.grandparentTitle : null;
  return (
    <View style={{ gap: t.space.sm, alignItems: center ? 'center' : 'flex-start' }}>
      {item.logoUrl && item.type !== 'episode' ? (
        <Img path={item.logoUrl} width={t.s(360)} contentFit="contain" style={{ width: t.isTV ? t.s(380) : Math.min(t.width * 0.7, 320), height: t.isTV ? t.s(120) : 80 }} />
      ) : (
        <>
          {showTitle ? (
            <T variant="small" tone="primary" weight="800" style={{ textTransform: 'uppercase' }} center={center}>
              {showTitle}
            </T>
          ) : null}
          <T variant={t.isTV ? 'hero' : 'title'} center={center}>
            {item.title}
          </T>
        </>
      )}
      {item.smart ? <SmartBadge /> : null}
      <MetaLine item={item} center={center} />
      <MediaBadges item={item} />
      {item.tagline ? (
        <T tone="muted" style={{ fontStyle: 'italic' }} center={center}>
          {item.tagline}
        </T>
      ) : null}
    </View>
  );
}

export function MediaBadges({ item }: { item: Item }) {
  const t = useTheme();
  const m = item.media?.[0];
  if (!m) return null;
  const a = m.audioStreams.find((s) => s.default) ?? m.audioStreams[0];
  const badges = [
    m.resolutionLabel,
    m.hdr ? 'HDR' : null,
    m.videoCodec?.toUpperCase(),
    a ? `${a.codec.toUpperCase()}${a.channels >= 6 ? ` ${a.channels === 8 ? '7.1' : '5.1'}` : ''}` : null,
    m.subtitleStreams.length ? 'CC' : null,
  ].filter(Boolean) as string[];
  return (
    <View style={{ flexDirection: 'row', gap: t.space.xs, flexWrap: 'wrap' }}>
      {badges.map((b) => (
        <View key={b} style={{ borderWidth: 1, borderColor: t.alpha(t.colors.text, 0.35), borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 }}>
          <T variant="caption" tone="muted">
            {b}
          </T>
        </View>
      ))}
    </View>
  );
}

export function ResumeInfo({ item }: { item: Item }) {
  const t = useTheme();
  const p = progressFraction(item);
  if (p <= 0.01 || p >= 0.95) return null;
  return (
    <View style={{ gap: 6, width: t.isTV ? t.s(320) : '100%' }}>
      <ProgressBar value={p} />
      <T variant="caption" tone="muted">
        {formatClock((item.durationMs ?? 0) - item.userData.positionMs)} left
      </T>
    </View>
  );
}

export function ActionBar({
  item,
  onPlay,
  onRestart,
  playLabel,
  togglePlayed,
  toggleFavorite,
  extra,
  downloadable,
  downloadItems,
  onRate,
  playlistItems,
  playOn,
}: {
  item: Item;
  onPlay?: () => void;
  onRestart?: () => void;
  playLabel?: string;
  togglePlayed: () => void;
  toggleFavorite: () => void;
  extra?: React.ReactNode;
  downloadable?: boolean;
  /** For seasons/albums: what "Download" grabs. */
  downloadItems?: () => Promise<Item[]>;
  /** Show the star rating row. */
  onRate?: (rating: number | null) => void;
  /** Show "Add to playlist"; resolves the item ids to add (default: this item). */
  playlistItems?: true | (() => Promise<string[]>);
  /** Show "Play on…" (remote control): what to send to another of the user's devices. */
  playOn?: PlayOnWhat;
}) {
  const t = useTheme();
  const caps = useCapabilities();
  const remote = useRemote();
  const { status } = useSession();
  const [playOnSheet, setPlayOnSheet] = useState(false);
  const canPlayOn = !!playOn && remote.enabled && status === 'signed-in';
  const downloads = useDownloads();
  const rec = downloads.get(item.id);
  const [busy, setBusy] = useState(false);
  const [pickQuality, setPickQuality] = useState(false);
  const [playlistSheet, setPlaylistSheet] = useState(false);
  const canDownload = downloadable && caps.downloads && downloads.supported;
  const isAudio = item.type === 'track' || item.type === 'album' || item.type === 'audiobook' || item.type === 'bookpart' || item.type === 'podcast' || item.type === 'podcastepisode';

  const onDownload = async () => {
    if (rec?.state === 'done') {
      Alert.alert('Remove download?', item.title, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => downloads.remove(item.id) },
      ]);
      return;
    }
    if (rec?.state === 'downloading' || rec?.state === 'queued') return downloads.cancel(item.id);
    // Audio has no resolution to pick: original (or AAC .m4a where iOS needs it).
    if (isAudio) return start('original');
    setPickQuality(true);
  };

  const start = async (quality: DownloadQuality) => {
    setPickQuality(false);
    setBusy(true);
    try {
      await downloads.download(downloadItems ? await downloadItems() : item, quality);
    } finally {
      setBusy(false);
    }
  };
  // Only a single item tells us its container; for seasons the per-episode choice happens in the provider.
  const iosConverts = !downloadItems && effectiveQuality(item, 'original') !== 'original';

  const dlIcon = rec?.state === 'done' ? 'checkmark-circle' : rec?.state === 'downloading' || rec?.state === 'queued' ? 'close-circle-outline' : 'arrow-down-circle-outline';
  const dlLabel = rec?.state === 'downloading' ? (rec.total ? `${Math.round(rec.progress * 100)}%` : 'Downloading') : rec?.state === 'queued' ? 'Queued' : rec?.state === 'done' ? 'Downloaded' : undefined;

  return (
    <View style={{ gap: t.space.md }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm, alignItems: 'center' }}>
        {onPlay ? <Button label={playLabel ?? 'Play'} icon="play" onPress={onPlay} size="lg" hasTVPreferredFocus /> : null}
        {onRestart ? <Button label={t.isTV ? 'From start' : undefined} icon="refresh" variant="secondary" size="lg" onPress={onRestart} accessibilityLabel="Play from start" /> : null}
        <Button icon={item.userData.played ? 'checkmark-done-circle' : 'checkmark-circle-outline'} variant="secondary" size="lg" onPress={togglePlayed} accessibilityLabel={item.userData.played ? 'Mark unwatched' : 'Mark watched'} />
        <Button icon={item.userData.favorite ? 'heart' : 'heart-outline'} variant="secondary" size="lg" onPress={toggleFavorite} accessibilityLabel={item.userData.favorite ? 'Remove favourite' : 'Add favourite'} />
        {canDownload ? <Button icon={dlIcon} label={dlLabel} variant="secondary" size="lg" onPress={onDownload} loading={busy} accessibilityLabel="Download" /> : null}
        {item.trailerUrl ? <Button icon="film-outline" label={t.isTV ? 'Trailer' : undefined} variant="secondary" size="lg" onPress={() => Linking.openURL(item.trailerUrl!)} accessibilityLabel="Trailer" /> : null}
        {playlistItems ? <Button icon="list-outline" label={t.isTV ? 'Playlist' : undefined} variant="secondary" size="lg" onPress={() => setPlaylistSheet(true)} accessibilityLabel="Add to playlist" /> : null}
        {canPlayOn ? <Button icon="phone-portrait-outline" label={t.isTV ? 'Play on…' : undefined} variant="secondary" size="lg" onPress={() => setPlayOnSheet(true)} accessibilityLabel="Play on another device" /> : null}
        {extra}
        {canDownload ? (
          <OptionSheet
            visible={pickQuality}
            title="Download quality"
            options={DOWNLOAD_QUALITIES.map((q) => ({
              key: q.key,
              label: q.key === downloads.defaultQuality ? `${q.label} (default)` : q.label,
              description: q.key === 'original' && iosConverts ? 'This format does not play offline on iOS — 1080p will be used' : q.description,
              selected: q.key === downloads.defaultQuality,
            }))}
            onSelect={(k) => void start(k)}
            onClose={() => setPickQuality(false)}
          />
        ) : null}
      </View>
      {onRate ? <RatingStars rating={item.userData.rating} onRate={onRate} /> : null}
      {canPlayOn && playOn ? <PlayOnSheet visible={playOnSheet} what={playOn} onClose={() => setPlayOnSheet(false)} /> : null}
      {playlistItems ? (
        <AddToPlaylistSheet visible={playlistSheet} title={item.title} getItemIds={playlistItems === true ? () => [item.id] : playlistItems} onClose={() => setPlaylistSheet(false)} />
      ) : null}
    </View>
  );
}

export function CastRow({ people }: { people: Person[] }) {
  const t = useTheme();
  if (!people?.length) return null;
  const size = t.isTV ? t.s(96) : 72;
  return (
    <View style={{ marginBottom: t.space.lg }}>
      <RowHeader title="Cast & Crew" />
      <FlatList
        horizontal
        data={people.slice(0, 30)}
        keyExtractor={(p, i) => `${p.name}-${i}`}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: t.space.gutter, gap: t.space.md }}
        renderItem={({ item: p }) => (
          <View style={{ width: size + 16, alignItems: 'center', gap: 4 }} focusable={t.isTV}>
            <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden', backgroundColor: t.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
              {p.imageUrl ? (
                <Img path={p.imageUrl} width={size} style={{ width: '100%', height: '100%' }} />
              ) : (
                <T variant="heading" tone="muted">
                  {p.name.slice(0, 1)}
                </T>
              )}
            </View>
            <T variant="caption" weight="700" center numberOfLines={2} style={{ letterSpacing: 0 }}>
              {p.name}
            </T>
            <T variant="caption" tone="muted" weight="500" center numberOfLines={1} style={{ letterSpacing: 0 }}>
              {p.role ?? p.kind}
            </T>
          </View>
        )}
      />
    </View>
  );
}

export function Overview({ text }: { text: string | null }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <T tone="muted" numberOfLines={open || t.isTV ? (t.isTV ? 4 : undefined) : 4} onPress={() => setOpen((o) => !o)} style={{ maxWidth: t.isTV ? t.width * 0.5 : undefined }}>
      {text}
    </T>
  );
}
