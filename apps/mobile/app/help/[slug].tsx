/**
 * One Help Centre article (GET /help/:slug) rendered from its Markdown subset. On TV every block takes the focus, so
 * the D-pad scrolls through long articles; links to other articles open in the app, web links in the browser (phones).
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { Linking, ScrollView, View } from 'react-native';
import { useQuery } from '@/api/useQuery';
import { Focusable } from '@/components/Focusable';
import { Screen, ScreenHeader } from '@/components/Screen';
import { ErrorState, Loading } from '@/components/States';
import { T } from '@/components/Text';
import { useTheme } from '@/theme';
import { helpSlugOf, parseHelpMarkdown, type Block, type Span } from '@/utils/helpMarkdown';

function Spans({ spans, variant, weight }: { spans: Span[]; variant?: 'body' | 'heading' | 'title' | 'small'; weight?: '700' | '800' }) {
  const t = useTheme();
  return (
    <T variant={variant} weight={weight}>
      {spans.map((s, i) =>
        s.kind === 'code' ? (
          <T key={i} variant={variant} style={{ fontFamily: 'monospace', backgroundColor: t.colors.surfaceAlt }}>{` ${s.text} `}</T>
        ) : s.kind === 'link' ? (
          <T key={i} variant={variant} tone="primary" weight="700">{s.text}</T>
        ) : (
          <T key={i} variant={variant} weight={s.bold ? '800' : weight} style={s.italic ? { fontStyle: 'italic' } : undefined}>{s.text}</T>
        ),
      )}
    </T>
  );
}

/** First link of a block: pressing the block follows it (TVs can't focus a word inside a paragraph). */
const linkOf = (spans: Span[]) => spans.find((s): s is Extract<Span, { kind: 'link' }> => s.kind === 'link')?.href ?? null;

function follow(href: string | null) {
  if (!href) return;
  const slug = helpSlugOf(href);
  if (slug) router.push(`/help/${slug}` as never);
  else if (/^https?:/.test(href)) void Linking.openURL(href).catch(() => undefined);
}

function BlockView({ b, first }: { b: Block; first: boolean }) {
  const t = useTheme();
  const spans = b.type === 'code' || b.type === 'table' ? [] : b.spans;
  const href = linkOf(spans);
  const body = (() => {
    switch (b.type) {
      case 'heading':
        return <View style={{ paddingTop: t.space.md }}><Spans spans={b.spans} variant={b.level === 2 ? 'heading' : 'body'} weight="800" /></View>;
      case 'paragraph':
        return <Spans spans={b.spans} />;
      case 'item':
        return (
          <View style={{ flexDirection: 'row', gap: t.space.sm, paddingLeft: t.space.sm }}>
            <T tone="muted" style={{ minWidth: t.isTV ? t.s(24) : 18 }}>{b.ordered ? `${b.n}.` : '•'}</T>
            <View style={{ flex: 1 }}><Spans spans={b.spans} /></View>
          </View>
        );
      case 'quote':
        return <View style={{ borderLeftWidth: 3, borderLeftColor: t.colors.primary, paddingLeft: t.space.md }}><Spans spans={b.spans} /></View>;
      case 'code':
        return <T style={{ fontFamily: 'monospace', backgroundColor: t.colors.surfaceAlt, padding: t.space.sm, borderRadius: t.radius }}>{b.text}</T>;
      case 'table':
        return (
          <View style={{ borderWidth: 1, borderColor: t.alpha(t.colors.text, 0.15), borderRadius: t.radius, overflow: 'hidden' }}>
            {[b.header, ...b.rows].map((row, ri) => (
              <View key={ri} style={{ flexDirection: 'row', backgroundColor: ri === 0 ? t.colors.surfaceAlt : undefined, borderTopWidth: ri ? 1 : 0, borderTopColor: t.alpha(t.colors.text, 0.1) }}>
                {row.map((cell, ci) => (
                  <View key={ci} style={{ flex: 1, padding: t.space.sm }}>
                    <Spans spans={cell} variant="small" weight={ri === 0 ? '700' : undefined} />
                  </View>
                ))}
              </View>
            ))}
          </View>
        );
    }
  })();
  if (!t.isTV && !href) return body;
  return (
    <Focusable onPress={() => follow(href)} hasTVPreferredFocus={first} focusScale={1} style={{ borderRadius: t.radius, paddingHorizontal: t.isTV ? t.space.sm : 0, paddingVertical: t.isTV ? 2 : 0 }} accessibilityLabel={href ? 'Open linked article' : undefined}>
      {body}
    </Focusable>
  );
}

export default function HelpArticleScreen() {
  const t = useTheme();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { data, error, loading, refresh } = useQuery(slug ? `help:${slug}` : null, (a, signal) => a.helpArticle(slug!, signal), { staleMs: 3600000 });
  const blocks = useMemo(() => (data ? parseHelpMarkdown(data.markdown) : []), [data]);

  return (
    <Screen>
      <ScreenHeader title={data?.title ?? 'Help'} subtitle={data?.sectionTitle} />
      {loading && !data ? (
        <Loading />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={refresh} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.xxl * 2, alignItems: 'center' }}>
          <View style={{ width: '100%', maxWidth: t.isTV ? t.s(1000) : 720, gap: t.space.sm }}>
            {blocks.map((b, i) => <BlockView key={i} b={b} first={i === 0} />)}
            {data?.related.length ? (
              <View style={{ gap: t.space.sm, paddingTop: t.space.lg }}>
                <T variant="heading">Related</T>
                {data.related.map((r) => (
                  <Focusable key={r.slug} onPress={() => router.push(`/help/${r.slug}` as never)} style={{ padding: t.space.sm, borderRadius: t.radius, backgroundColor: t.colors.surface }}>
                    <T weight="700">{r.title}</T>
                    <T variant="small" tone="muted" numberOfLines={1}>{r.summary}</T>
                  </Focusable>
                ))}
              </View>
            ) : null}
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}
