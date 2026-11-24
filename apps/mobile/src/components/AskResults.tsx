import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { askLibrary } from '@/api/ai';
import type { AskResponse } from '@/api/types';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { Chip } from './Chip';
import { ItemRow } from './Row';
import { EmptyState } from './States';
import { T } from './Text';

export const ASK_EXAMPLES = ["Something funny under 90 minutes we haven't seen", 'Romanian comedies from the 2000s', 'Like Inception but lighter', 'Filme de groază din anii 80'];

/** "Ask" results for the search tab: removable "Understood as" chips, then movies and shows. */
export function AskResults({ q, onPick }: { q: string; onPick: (q: string) => void }) {
  const t = useTheme();
  const api = useApi();
  const [res, setRes] = useState<AskResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (opts: { filter?: AskResponse['filter']; remove?: string[] }, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    askLibrary(api, q, opts, signal)
      .then(setRes)
      .catch((e) => !signal?.aborted && setError((e as Error).message))
      .finally(() => !signal?.aborted && setLoading(false));
  };
  useEffect(() => {
    if (!q) {
      setRes(null);
      return;
    }
    const ctrl = new AbortController();
    run({}, ctrl.signal);
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, api]);

  if (!q) {
    return (
      <View style={{ paddingHorizontal: t.space.gutter, gap: t.space.sm }}>
        <T tone="muted">Ask in your own words — English or Romanian:</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
          {ASK_EXAMPLES.map((e) => <Chip key={e} label={e} icon="sparkles-outline" onPress={() => onPick(e)} />)}
        </View>
      </View>
    );
  }
  if (loading && !res) return <ActivityIndicator color={t.colors.primary} style={{ marginTop: t.space.xl }} />;
  if (error) return <EmptyState icon="alert-circle-outline" title="Ask failed" message={error} />;
  if (!res) return null;
  const movies = res.items.filter((i) => i.type === 'movie');
  const shows = res.items.filter((i) => i.type === 'show');
  return (
    <View style={{ gap: t.space.md, opacity: loading ? 0.6 : 1 }}>
      {res.chips.length ? (
        <View style={{ paddingHorizontal: t.space.gutter, gap: t.space.xs }}>
          <T variant="small" tone="muted">Understood as{res.by === 'llm' ? ' (AI)' : ''} — tap to remove:</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
            {res.chips.map((c) => <Chip key={c.key} label={`${c.label}  ✕`} selected onPress={() => run({ filter: res.filter, remove: [c.key] })} />)}
          </View>
        </View>
      ) : null}
      {!res.items.length ? <EmptyState icon="search" title="Nothing matches all of that" message="Remove a chip to widen the search." /> : null}
      {movies.length ? <ItemRow title="Movies" items={movies} /> : null}
      {shows.length ? <ItemRow title="Shows" items={shows} /> : null}
    </View>
  );
}
