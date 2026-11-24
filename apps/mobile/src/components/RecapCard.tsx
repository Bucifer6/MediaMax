import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { getRecap } from '@/api/ai';
import type { RecapResponse } from '@/api/types';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { playItem } from '@/utils/nav';
import { Button } from './Button';
import { Focusable } from './Focusable';
import { Icon } from './Icon';
import { T } from './Text';

/**
 * "Previously on…" for an episode: shown when the viewer returns after a break or starts a new season. Built only from
 * episodes they already watched before this one. Dismissible; "Recap clip" plays the episode's own recap segment.
 */
export function RecapCard({ itemId }: { itemId: string }) {
  const t = useTheme();
  const api = useApi();
  const [recap, setRecap] = useState<RecapResponse | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setRecap(null);
    setHidden(false);
    getRecap(api, itemId).then((r) => !cancelled && setRecap(r)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, itemId]);

  if (!recap || hidden) return null;
  if (!recap.available) {
    if (recap.daysSinceLastWatched == null) return null;
    return <Button icon="book-outline" label="Recap the story so far" size="sm" variant="secondary" onPress={() => getRecap(api, itemId, true).then(setRecap).catch(() => undefined)} />;
  }
  const why = recap.reason === 'new-season' ? 'New season' : recap.daysSinceLastWatched != null ? `It's been ${recap.daysSinceLastWatched} days` : '';
  return (
    <View style={{ padding: t.space.md, borderRadius: t.radius, backgroundColor: t.alpha(t.colors.text, t.dark ? 0.1 : 0.06), borderWidth: 1, borderColor: t.alpha(t.colors.text, 0.12), gap: t.space.sm }} accessibilityLabel="Previously on">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        <Icon name="book-outline" size={18} color={t.colors.text} />
        <View style={{ flex: 1 }}>
          <T weight="700">Previously on{recap.showTitle ? ` ${recap.showTitle}` : ''}…</T>
          {why ? <T variant="caption" tone="muted">{why} · only what you've watched</T> : null}
        </View>
        <Focusable onPress={() => setHidden(true)} accessibilityLabel="Dismiss recap" style={{ padding: 6 }}>
          <Icon name="close" size={20} color={t.colors.text} />
        </Focusable>
      </View>
      {recap.text ? <T>{recap.text}</T> : recap.bullets.map((b) => <T key={b} variant="small">• {b}</T>)}
      {recap.clip ? <Button icon="play" label={`Recap clip (${Math.max(1, Math.round((recap.clip.endMs - recap.clip.startMs) / 1000))} s)`} size="sm" variant="secondary" onPress={() => playItem(recap.clip!.itemId, { startMs: recap.clip!.startMs || 1 })} /> : null}
    </View>
  );
}
