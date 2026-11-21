import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Keyboard, ScrollView, View } from 'react-native';
import { getJSON, setJSON } from '@/api/storage';
import type { Channel, Item, Program, SearchResponse } from '@/api/types';
import { Chip } from '@/components/Chip';
import { ChannelRow, ItemRow, RowHeader } from '@/components/Row';
import { Focusable } from '@/components/Focusable';
import { Input } from '@/components/Input';
import { ProgramSheet } from '@/components/ProgramSheet';
import { Screen } from '@/components/Screen';
import { EmptyState } from '@/components/States';
import { useTabBarSpace } from '@/components/TabBar';
import { T } from '@/components/Text';
import { useMusic } from '@/state/music';
import { useApi, useCapabilities } from '@/state/session';
import { useTheme } from '@/theme';
import { formatDay, formatTime } from '@/utils/format';
import { aiFeatures } from '@/api/ai';
import { AskResults } from '@/components/AskResults';

const RECENT_KEY = 'mediamax.recentSearches';

const GROUPS: { title: string; types: string[]; variant?: 'poster' | 'landscape' | 'square' }[] = [
  { title: 'Movies', types: ['movie'] },
  { title: 'Shows', types: ['show'] },
  { title: 'Episodes', types: ['episode'], variant: 'landscape' },
  { title: 'Artists', types: ['artist'], variant: 'square' },
  { title: 'Albums', types: ['album'], variant: 'square' },
  { title: 'Songs', types: ['track'], variant: 'square' },
  { title: 'Collections & playlists', types: ['collection', 'playlist'] },
  { title: 'Videos', types: ['video', 'photo'], variant: 'landscape' },
];

export default function SearchScreen() {
  const t = useTheme();
  const api = useApi();
  const caps = useCapabilities();
  const music = useMusic();
  const bottom = useTabBarSpace();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [program, setProgram] = useState<{ p: Program; c: Channel | null } | null>(null);
  // "Ask": natural-language search (the server understands English and Romanian; an AI model makes it smarter).
  const [askOn, setAskOn] = useState(false);
  const [asking, setAsking] = useState(false);
  const [askQ, setAskQ] = useState('');
  useEffect(() => {
    aiFeatures(api).then((f) => setAskOn(f.ask)).catch(() => setAskOn(false));
  }, [api]);
  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => setAskQ(q.trim()), 800);
    return () => clearTimeout(timer);
  }, [q, asking]);

  useEffect(() => {
    getJSON<string[]>(RECENT_KEY, []).then(setRecent);
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 || asking) {
      setResults(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      api
        .search(term, 60, ctrl.signal)
        .then((r) => {
          setResults(r);
          const next = [term, ...recent.filter((x) => x.toLowerCase() !== term.toLowerCase())].slice(0, 8);
          setRecent(next);
          void setJSON(RECENT_KEY, next);
        })
        .catch(() => undefined)
        .finally(() => !ctrl.signal.aborted && setLoading(false));
    }, 350);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, api, asking]);

  const groups = useMemo(() => {
    if (!results) return [];
    return GROUPS.map((g) => ({ ...g, items: results.items.filter((i) => g.types.includes(i.type)) })).filter((g) => g.items.length);
  }, [results]);

  const onTrack = (item: Item) => {
    const tracks = results?.items.filter((i) => i.type === 'track') ?? [item];
    music.playQueue(tracks, Math.max(0, tracks.indexOf(item)));
  };

  const empty = results && !groups.length && !results.channels.length && !results.programs.length;

  return (
    <Screen padTop={!t.isTV}>
      <View style={{ paddingHorizontal: t.space.gutter, paddingVertical: t.space.sm, gap: t.space.sm }}>
        {!t.isTV ? <T variant="title">Search</T> : null}
        <Input value={q} onChangeText={setQ} placeholder={asking ? 'Ask: “a funny film under 90 minutes”…' : 'Movies, shows, music, channels…'} icon={asking ? 'sparkles-outline' : 'search'} autoCorrect={asking} autoCapitalize={asking ? 'sentences' : 'none'} returnKeyType="search" onSubmitEditing={() => {
          Keyboard.dismiss();
          if (asking) setAskQ(q.trim());
        }} clearButtonMode="while-editing" hasTVPreferredFocus />
        {askOn ? (
          <View style={{ flexDirection: 'row', gap: t.space.sm }}>
            <Chip label="Search" icon="search" selected={!asking} onPress={() => setAsking(false)} />
            <Chip label="Ask" icon="sparkles-outline" selected={asking} onPress={() => {
              setAsking(true);
              setAskQ(q.trim());
            }} />
          </View>
        ) : null}
      </View>
      {asking ? (
        <ScrollView contentContainerStyle={{ paddingBottom: bottom, paddingTop: t.space.sm }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <AskResults q={askQ} onPick={(e) => {
            setQ(e);
            setAskQ(e);
          }} />
        </ScrollView>
      ) : (
      <>
      <ScrollView contentContainerStyle={{ paddingBottom: bottom, paddingTop: t.space.sm }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {loading && !results ? <ActivityIndicator color={t.colors.primary} style={{ marginTop: t.space.xl }} /> : null}
        {!q && recent.length ? (
          <View style={{ paddingHorizontal: t.space.gutter, gap: t.space.sm }}>
            <T variant="heading">Recent searches</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
              {recent.map((r) => (
                <Chip key={r} label={r} icon="time-outline" onPress={() => setQ(r)} />
              ))}
            </View>
          </View>
        ) : null}
        {!q && !recent.length ? <EmptyState icon="search" title="Find anything" message="Search across every library you can access, plus live TV channels and the programme guide." /> : null}
        {empty ? <EmptyState icon="sad-outline" title="No results" message={`Nothing matched “${q.trim()}”.`} /> : null}
        {groups.map((g) => (
          <ItemRowWithPress key={g.title} title={g.title} items={g.items} variant={g.variant} onTrack={g.types.includes('track') ? onTrack : undefined} />
        ))}
        {caps.liveTv && results?.channels.length ? <ChannelRow title="Channels" channels={results.channels} /> : null}
        {caps.liveTv && results?.programs.length ? (
          <View style={{ marginBottom: t.space.lg }}>
            <RowHeader title="On TV" />
            <View style={{ paddingHorizontal: t.space.gutter, gap: t.space.xs }}>
              {results.programs.slice(0, 20).map((p) => {
                const ch = results.channels.find((c) => c.id === p.channelId) ?? null;
                return (
                  <Focusable
                    key={p.id}
                    onPress={async () => setProgram({ p, c: ch ?? (await api.channel(p.channelId).catch(() => null)) })}
                    focusScale={t.isTV ? 1.02 : 1}
                    style={{ padding: t.space.md, borderRadius: t.radius, backgroundColor: t.colors.surface, flexDirection: 'row', gap: t.space.md, alignItems: 'center' }}
                  >
                    <View style={{ width: t.s(90) }}>
                      <T variant="small" weight="700">
                        {formatTime(p.start)}
                      </T>
                      <T variant="caption" tone="muted">
                        {formatDay(p.start)}
                      </T>
                    </View>
                    <View style={{ flex: 1 }}>
                      <T weight="700" numberOfLines={1}>
                        {p.title}
                      </T>
                      <T variant="small" tone="muted" numberOfLines={1}>
                        {ch?.name ?? ''} {p.subtitle ? `· ${p.subtitle}` : ''}
                      </T>
                    </View>
                    {p.recordingId ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.colors.danger }} /> : null}
                  </Focusable>
                );
              })}
            </View>
          </View>
        ) : null}
      </ScrollView>
      </>
      )}
      <ProgramSheet program={program?.p ?? null} channel={program?.c} onClose={() => setProgram(null)} />
    </Screen>
  );
}

/** ItemRow where tracks start music playback instead of opening a page. */
function ItemRowWithPress({ title, items, variant, onTrack }: { title: string; items: Item[]; variant?: 'poster' | 'landscape' | 'square'; onTrack?: (i: Item) => void }) {
  if (!onTrack) return <ItemRow title={title} items={items} variant={variant} />;
  return <TrackRow title={title} items={items} onTrack={onTrack} />;
}

function TrackRow({ title, items, onTrack }: { title: string; items: Item[]; onTrack: (i: Item) => void }) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: t.space.lg }}>
      <RowHeader title={title} />
      <View style={{ paddingHorizontal: t.space.gutter, gap: 2 }}>
        {items.slice(0, 12).map((i) => (
          <Focusable key={i.id} onPress={() => onTrack(i)} focusScale={t.isTV ? 1.02 : 1} style={{ paddingVertical: t.space.sm, paddingHorizontal: t.space.sm, borderRadius: t.radius }}>
            <T weight="600" numberOfLines={1}>
              {i.title}
            </T>
            <T variant="small" tone="muted" numberOfLines={1}>
              {[i.grandparentTitle, i.parentTitle].filter(Boolean).join(' · ')}
            </T>
          </Focusable>
        ))}
      </View>
    </View>
  );
}
