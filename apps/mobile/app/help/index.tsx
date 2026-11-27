/** Help Centre (GET /help, /help/search): sections and articles in the app, on phones and TVs alike. */
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import type { HelpArticleSummary, HelpSearchResult } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { Focusable } from '@/components/Focusable';
import { Input } from '@/components/Input';
import { Screen, ScreenHeader } from '@/components/Screen';
import { ErrorState, Loading } from '@/components/States';
import { T } from '@/components/Text';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';

function ArticleRow({ a, snippet, first }: { a: HelpArticleSummary; snippet?: string; first?: boolean }) {
  const t = useTheme();
  return (
    <Focusable
      onPress={() => router.push(`/help/${a.slug}` as never)}
      hasTVPreferredFocus={first}
      focusScale={t.isTV ? 1.01 : 1}
      style={{ paddingVertical: t.space.sm, paddingHorizontal: t.space.md, borderRadius: t.radius, backgroundColor: t.colors.surface, gap: 2 }}
      accessibilityLabel={a.title}
    >
      <T weight="700">{a.title}</T>
      <T variant="small" tone="muted" numberOfLines={2}>{snippet ?? a.summary}</T>
    </Focusable>
  );
}

export default function HelpScreen() {
  const t = useTheme();
  const api = useApi();
  const index = useQuery('help-index', (a, signal) => a.helpIndex(signal), { staleMs: 3600000 });
  const [q, setQ] = useState('');
  const [results, setResults] = useState<HelpSearchResult[] | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => void api.helpSearch(term, ctrl.signal).then((r) => setResults(r.results)).catch(() => undefined), 300);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, api]);

  const maxW = t.isTV ? t.s(1000) : 720;
  return (
    <Screen>
      <ScreenHeader title="Help" subtitle={index.data ? `${index.data.product} ${index.data.version}` : undefined} />
      {index.loading && !index.data ? (
        <Loading />
      ) : index.error && !index.data ? (
        <ErrorState error={index.error} onRetry={index.refresh} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.xxl * 2, alignItems: 'center' }} keyboardShouldPersistTaps="handled">
          <View style={{ width: '100%', maxWidth: maxW, gap: t.space.lg }}>
            <Input value={q} onChangeText={setQ} placeholder="Search help" icon="search" autoCapitalize="none" autoCorrect={false} returnKeyType="search" />
            {results ? (
              <View style={{ gap: t.space.sm }}>
                {results.length ? results.map((r) => <ArticleRow key={r.slug} a={r} snippet={r.snippet} />) : <T tone="muted">No articles match “{q.trim()}”.</T>}
              </View>
            ) : (
              (index.data?.sections ?? []).map((s, si) => (
                <View key={s.id} style={{ gap: t.space.sm }}>
                  <View>
                    <T variant="heading">{s.title}</T>
                    {s.description ? <T variant="small" tone="muted">{s.description}</T> : null}
                  </View>
                  {s.articles.map((a, ai) => <ArticleRow key={a.slug} a={a} first={t.isTV && si === 0 && ai === 0} />)}
                </View>
              ))
            )}
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}
