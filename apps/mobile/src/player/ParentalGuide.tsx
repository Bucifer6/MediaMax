/**
 * The content rating and parental guide severities for a few seconds once a title starts playing
 * (Settings → Playback → "Parental guide when a title starts"). Same rules as the web player's card.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { ParentalGuide } from '@/api/types';
import { T } from '@/components/Text';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';

const LABEL: Record<ParentalGuide['categories'][number]['category'], string> = {
  violence: 'Violence', nudity: 'Sex & nudity', profanity: 'Language', alcohol: 'Alcohol & drugs', frightening: 'Frightening scenes',
};
const COLOR = { none: '#ffffff', mild: '#b9e6a1', moderate: '#ffd479', severe: '#ff8f8f' } as const;
const SHOW_MS = 8000;

export function ParentalGuideCard({ itemId, positionMs }: { itemId: string; positionMs: number }) {
  const t = useTheme();
  const api = useApi();
  const [guide, setGuide] = useState<ParentalGuide | null>(null);
  const [shownAt, setShownAt] = useState<number | null>(null);
  useEffect(() => {
    setGuide(null);
    setShownAt(null);
    const ctrl = new AbortController();
    api.parentalGuide(itemId, ctrl.signal).then(setGuide).catch(() => undefined);
    return () => ctrl.abort();
  }, [api, itemId]);
  // Counts from the first frame, so a slow start doesn't use up the card's time.
  useEffect(() => {
    if (guide && shownAt == null && positionMs > 0) setShownAt(positionMs);
  }, [guide, positionMs, shownAt]);
  if (!guide || shownAt == null || positionMs < shownAt || positionMs - shownAt > SHOW_MS) return null;
  const notable = guide.categories.filter((c) => c.severity !== 'none');
  if (!guide.contentRating && !notable.length) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: t.isTV ? t.s(120) : 90, left: t.isTV ? t.space.gutter : 16, maxWidth: t.isTV ? t.s(460) : 280, backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 12, padding: 12, gap: 6 }}>
      {guide.contentRating ? (
        <View style={{ alignSelf: 'flex-start', borderWidth: 1, borderColor: 'rgba(255,255,255,0.6)', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2 }}>
          <T weight="800" color="#fff">{guide.contentRating}</T>
        </View>
      ) : null}
      {notable.map((c) => (
        <View key={c.category} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 16 }}>
          <T variant="small" color="#fff">{LABEL[c.category]}</T>
          <T variant="small" weight="700" color={COLOR[c.severity]} style={{ textTransform: 'capitalize' }}>{c.severity}</T>
        </View>
      ))}
    </View>
  );
}
