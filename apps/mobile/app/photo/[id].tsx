import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Item } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Img } from '@/components/Img';
import { Loading } from '@/components/States';
import { T } from '@/components/Text';
import { useTheme } from '@/theme';
import { useTVRemote } from '@/tv';

/** Full-screen photo viewer: swipe (phone) or D-pad (TV) through the album. */
export default function PhotoViewer() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const item = useQuery(`item:${id}`, (a) => a.item(id));
  const siblings = useQuery(item.data ? `photos:${item.data.parentId ?? item.data.libraryId}` : null, (a) =>
    item.data!.parentId ? a.children(item.data!.parentId, { limit: 1000 }).then((r) => r.items) : a.items({ libraryId: item.data!.libraryId ?? undefined, type: 'photo', sort: 'addedAt', order: 'desc', limit: 500 }).then((r) => r.items),
  );
  const list: Item[] = siblings.data?.filter((x) => x.type === 'photo') ?? (item.data ? [item.data] : []);
  const start = Math.max(0, list.findIndex((x) => x.id === id));
  const [index, setIndex] = useState(start);
  const ref = useRef<FlatList<Item>>(null);
  useEffect(() => setIndex(start), [start]);

  useTVRemote((e) => {
    if (e.eventType === 'right' || e.eventType === 'left') {
      const next = Math.max(0, Math.min(list.length - 1, index + (e.eventType === 'right' ? 1 : -1)));
      setIndex(next);
      ref.current?.scrollToIndex({ index: next, animated: true });
    }
  });

  if (!list.length) return <View style={{ flex: 1, backgroundColor: '#000' }}><Loading /></View>;
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <FlatList
        ref={ref}
        data={list}
        horizontal
        pagingEnabled
        initialScrollIndex={start}
        getItemLayout={(_, i) => ({ length: t.width, offset: t.width * i, index: i })}
        keyExtractor={(x) => x.id}
        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / t.width))}
        showsHorizontalScrollIndicator={false}
        renderItem={({ item: p }) => (
          <View style={{ width: t.width, height: t.height, alignItems: 'center', justifyContent: 'center' }}>
            <Img path={p.posterUrl ?? p.thumbUrl ?? p.backdropUrl} width={t.width} contentFit="contain" style={{ width: '100%', height: '100%' }} />
          </View>
        )}
      />
      <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 8, left: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {!t.isTV ? (
          <Focusable onPress={() => router.back()} style={{ padding: 8, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 999 }} accessibilityLabel="Close">
            <Icon name="close" color="#fff" />
          </Focusable>
        ) : null}
        <T color="#fff" weight="700" style={{ flex: 1 }} numberOfLines={1}>{list[index]?.title}</T>
        <T variant="small" color="rgba(255,255,255,0.7)">{index + 1} / {list.length}</T>
      </View>
    </View>
  );
}
