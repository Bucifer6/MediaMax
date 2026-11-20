/** "Search online…" from the player's subtitle menu: OpenSubtitles search + download. */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { Item, RemoteSubtitle } from '@/api/types';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { Input } from '@/components/Input';
import { Sheet } from '@/components/Sheet';
import { T } from '@/components/Text';
import { useApi, useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { languageName } from '@/utils/format';

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function OnlineSubtitlesSheet({
  visible,
  itemId,
  onClose,
  onDownloaded,
}: {
  visible: boolean;
  itemId: string;
  onClose: () => void;
  /** Called with the updated item and the subtitle that was fetched. */
  onDownloaded: (item: Item, sub: RemoteSubtitle) => void;
}) {
  const t = useTheme();
  const api = useApi();
  const { user } = useSession();
  const defaultLang = user?.preferences.subtitleLanguage || 'en';
  const [lang, setLang] = useState(defaultLang);
  const [results, setResults] = useState<RemoteSubtitle[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = async (languages = lang) => {
    const langs = languages
      .split(/[,\s]+/)
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean);
    if (!langs.length) return;
    setSearching(true);
    setError(null);
    try {
      setResults(await api.searchSubtitles(itemId, langs));
    } catch (e) {
      setResults(null);
      setError(errText(e, 'Search failed'));
    } finally {
      setSearching(false);
    }
  };

  // Search straight away in the preferred language each time the sheet opens.
  useEffect(() => {
    if (!visible) return;
    setError(null);
    if (!results) void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const download = async (s: RemoteSubtitle) => {
    setDownloading(s.fileId);
    setError(null);
    try {
      const item = await api.downloadSubtitle(itemId, { fileId: s.fileId, language: s.language, hearingImpaired: s.hearingImpaired, forced: s.forced });
      onDownloaded(item, s);
    } catch (e) {
      setError(errText(e, 'Download failed'));
    } finally {
      setDownloading(null);
    }
  };

  return (
    <Sheet visible={visible} title="Search subtitles online" subtitle="From OpenSubtitles · best matches first" onClose={onClose} width={700}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: t.space.sm }}>
        <View style={{ flex: 1 }}>
          <Input
            label="Languages"
            value={lang}
            onChangeText={setLang}
            placeholder="en, fr"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={() => void search()}
            icon="language-outline"
          />
        </View>
        <Button label="Search" icon="search" onPress={() => void search()} loading={searching} hasTVPreferredFocus />
      </View>
      {error ? (
        <View style={{ flexDirection: 'row', gap: t.space.sm, alignItems: 'center' }}>
          <Icon name="alert-circle" color={t.colors.danger} size={t.isTV ? t.s(22) : 18} />
          <T tone="danger" weight="600" style={{ flex: 1 }}>
            {error}
          </T>
        </View>
      ) : null}
      {searching && !results ? <ActivityIndicator color={t.colors.primary} style={{ marginVertical: t.space.lg }} /> : null}
      {results && !results.length && !searching ? (
        <T tone="muted" center style={{ marginVertical: t.space.lg }}>
          No subtitles found for {lang}.
        </T>
      ) : null}
      {results?.map((s) => (
        <View key={s.fileId} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingVertical: t.space.sm, borderBottomWidth: 0.5, borderBottomColor: t.colors.border }}>
          <View style={{ flex: 1, gap: 2 }}>
            <T weight="700" numberOfLines={2}>
              {s.release || languageName(s.language)}
            </T>
            <T variant="small" tone="muted" numberOfLines={1}>
              {[languageName(s.language), `${s.downloads.toLocaleString()} downloads`, s.rating != null ? `★ ${s.rating.toFixed(1)}` : null, s.hearingImpaired ? 'SDH' : null, s.forced ? 'Forced' : null, s.aiTranslated ? 'AI translated' : null]
                .filter(Boolean)
                .join(' · ')}
            </T>
          </View>
          <Button icon="download-outline" label={t.isTV || t.wide ? 'Download' : undefined} size="sm" variant="secondary" loading={downloading === s.fileId} disabled={!!downloading && downloading !== s.fileId} onPress={() => void download(s)} accessibilityLabel={`Download ${s.release ?? s.language}`} />
        </View>
      ))}
    </Sheet>
  );
}
