/** Media requests (Discover): status chips, Discover poster cards and the request sheet. */
import React, { memo, useEffect, useState } from 'react';
import { View } from 'react-native';
import { ApiError } from '@/api/client';
import type { DiscoverResult, MediaRequest, RequestOptions, RequestStatus, RequestTvInfo } from '@/api/types';
import { invalidate } from '@/api/useQuery';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { Button } from './Button';
import { Chip } from './Chip';
import { Focusable } from './Focusable';
import { Icon, type IconName } from './Icon';
import { Img } from './Img';
import { Input } from './Input';
import { Sheet } from './Sheet';
import { T } from './Text';

type Tone = 'primary' | 'accent' | 'success' | 'warning' | 'danger';

export const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: Tone; icon: IconName }> = {
  pending: { label: 'Pending', tone: 'warning', icon: 'time-outline' },
  approved: { label: 'Approved', tone: 'primary', icon: 'checkmark-circle-outline' },
  processing: { label: 'Downloading', tone: 'accent', icon: 'cloud-download-outline' },
  available: { label: 'Available', tone: 'success', icon: 'checkmark-done-circle-outline' },
  declined: { label: 'Declined', tone: 'danger', icon: 'close-circle-outline' },
  failed: { label: 'Failed', tone: 'danger', icon: 'alert-circle-outline' },
};

function useToneColor() {
  const t = useTheme();
  return (tone: Tone) => ({ primary: t.colors.primary, accent: t.colors.accent, success: t.colors.success, warning: t.colors.warning, danger: t.colors.danger })[tone];
}

/** Small coloured pill, used for request status and Discover badges. */
export function StatusPill({ label, tone, icon, solid }: { label: string; tone: Tone; icon?: IconName; solid?: boolean }) {
  const t = useTheme();
  const color = useToneColor()(tone);
  const fg = solid ? '#fff' : color;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingHorizontal: t.isTV ? t.s(10) : 8, paddingVertical: t.isTV ? t.s(3) : 2, borderRadius: 999, backgroundColor: solid ? color : t.alpha(color, 0.16) }}>
      {icon ? <Icon name={icon} size={t.isTV ? t.s(14) : 12} color={fg} /> : null}
      <T variant="caption" color={fg} style={{ letterSpacing: 0.2 }} numberOfLines={1}>
        {label}
      </T>
    </View>
  );
}

export function RequestStatusChip({ status }: { status: RequestStatus }) {
  const m = REQUEST_STATUS[status];
  return <StatusPill label={m.label} tone={m.tone} icon={m.icon} />;
}

/** The badge a Discover result shows, if any. */
export function discoverBadge(r: DiscoverResult): { label: string; tone: Tone; icon: IconName } | null {
  if (r.availableItemId || r.requestStatus === 'available') return { label: 'In library', tone: 'success', icon: 'checkmark-circle' };
  if (r.requestStatus === 'pending') return { label: 'Pending', tone: 'warning', icon: 'time' };
  if (r.requestStatus === 'approved' || r.requestStatus === 'processing') return { label: 'Requested', tone: 'primary', icon: 'checkmark' };
  if (r.requestStatus === 'declined') return { label: 'Declined', tone: 'danger', icon: 'close' };
  if (r.requestStatus === 'failed') return { label: 'Failed', tone: 'danger', icon: 'alert' };
  return null;
}

/** A title can be requested unless it is in a library or has an open request. */
export const isRequestable = (r: DiscoverResult) => !r.blacklisted && !r.availableItemId && (!r.requestStatus || r.requestStatus === 'declined' || r.requestStatus === 'failed');

/** The user's permission for a result's kind (servers without permissions allow everything). */
export function requestPermission(opts: RequestOptions | null, r: DiscoverResult): 'none' | 'request' | 'auto' {
  const p = opts?.permissions;
  if (!p) return 'request';
  return p[r.mediaType === 'movie' ? 'movie' : r.mediaType === 'show' ? 'show' : r.mediaType === 'book' ? 'book' : 'music'];
}

/** Friendly title + message for the server's request / discover errors. */
export function describeRequestError(e: unknown): { title: string; message: string; icon: IconName } {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof ApiError) {
    if (e.status === 429) return { title: 'Request quota reached', message, icon: 'hourglass-outline' };
    if (e.status === 409) return { title: /library/i.test(message) ? 'Already in the library' : 'Already requested', message, icon: 'copy-outline' };
    if (e.status === 400) return { title: "Requests aren't set up", message, icon: 'construct-outline' };
    if (e.status === 403) return { title: /permission|allowed|blacklist/i.test(message) ? 'Not allowed' : 'Requests are turned off', message, icon: 'lock-closed-outline' };
    if (e.status === 0) return { title: 'Server unreachable', message, icon: 'cloud-offline-outline' };
  }
  return { title: 'Something went wrong', message, icon: 'alert-circle-outline' };
}

export function ErrorBanner({ error }: { error: unknown }) {
  const t = useTheme();
  const info = describeRequestError(error);
  return (
    <View accessibilityRole="alert" style={{ flexDirection: 'row', gap: t.space.sm, padding: t.space.md, borderRadius: t.radius, backgroundColor: t.alpha(t.colors.danger, 0.12), borderWidth: 1, borderColor: t.alpha(t.colors.danger, 0.4) }}>
      <Icon name={info.icon} color={t.colors.danger} size={t.isTV ? t.s(24) : 20} />
      <View style={{ flex: 1, gap: 2 }}>
        <T weight="700" tone="danger">
          {info.title}
        </T>
        <T variant="small" tone="muted">
          {info.message}
        </T>
      </View>
    </View>
  );
}

export const DiscoverCard = memo(function DiscoverCard({ result, width, onPress, hasTVPreferredFocus }: { result: DiscoverResult; width: number; onPress: (r: DiscoverResult) => void; hasTVPreferredFocus?: boolean }) {
  const t = useTheme();
  const height = Math.round(width * 1.5);
  const radius = t.shapeRadius(width, height);
  const badge = discoverBadge(result);
  return (
    <View style={{ width }}>
      <Focusable
        onPress={() => onPress(result)}
        hasTVPreferredFocus={hasTVPreferredFocus}
        ringRadius={radius}
        accessibilityLabel={`${result.title}${result.year ? `, ${result.year}` : ''}${badge ? `, ${badge.label}` : ''}`}
        style={{ width, height, borderRadius: radius, overflow: 'hidden', backgroundColor: t.colors.surfaceAlt }}
      >
        {result.posterUrl ? (
          <Img path={result.posterUrl} width={width} style={{ width: '100%', height: '100%' }} />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.space.sm }}>
            <Icon name={result.mediaType === 'show' ? 'tv-outline' : 'film-outline'} color={t.colors.textMuted} />
            <T variant="small" tone="muted" center numberOfLines={3} style={{ marginTop: t.space.xs }}>
              {result.title}
            </T>
          </View>
        )}
        {badge ? (
          <View style={{ position: 'absolute', top: 6, left: 6, right: 6 }}>
            <StatusPill label={badge.label} tone={badge.tone} icon={badge.icon} solid />
          </View>
        ) : null}
      </Focusable>
      <View style={{ marginTop: t.space.xs + 2, paddingHorizontal: 2 }}>
        <T variant="small" weight="600" numberOfLines={1}>
          {result.title}
        </T>
        <T variant="caption" tone="muted" weight="500" numberOfLines={1}>
          {[result.year, result.mediaType === 'show' ? 'Show' : 'Movie'].filter(Boolean).join(' · ')}
        </T>
      </View>
    </View>
  );
});

/**
 * Request a Discover result. Shows: all seasons or chosen season numbers (TMDB
 * season counts aren't in the result, so numbers are picked from a growing grid).
 */
export function RequestSheet({ result, onClose, onRequested, onOpenRequests }: { result: DiscoverResult | null; onClose: () => void; onRequested: (r: DiscoverResult, req: MediaRequest) => void; onOpenRequests: () => void }) {
  const t = useTheme();
  const api = useApi();
  const [allSeasons, setAllSeasons] = useState(true);
  const [seasons, setSeasons] = useState<number[]>([]);
  const [maxSeason, setMaxSeason] = useState(10);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<MediaRequest | null>(null);
  const [opts, setOpts] = useState<RequestOptions | null>(null);
  const [tv, setTv] = useState<RequestTvInfo | null>(null);

  useEffect(() => {
    if (!result) return;
    setAllSeasons(true);
    setSeasons([]);
    setMaxSeason(10);
    setNote('');
    setError(null);
    setDone(null);
    setTv(null);
    let alive = true;
    api.requestOptions().then((o) => alive && setOpts(o)).catch(() => undefined);
    // Partially available shows: offer only the seasons that are still missing.
    if (result.mediaType === 'show') {
      api.requestTvInfo(result.tmdbId).then((info) => {
        if (!alive) return;
        setTv(info);
        const free = info.seasons.filter((x) => x.status === 'missing' || x.status === 'partial').map((x) => x.seasonNumber);
        if (free.length && free.length < info.seasons.length) {
          setAllSeasons(false);
          setSeasons(free);
        }
        if (info.seasons.length) setMaxSeason(Math.max(...info.seasons.map((x) => x.seasonNumber)));
      }).catch(() => undefined);
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  if (!result) return null;
  const isShow = result.mediaType === 'show';
  const level = requestPermission(opts, result);
  const quota = opts?.quotas?.[result.mediaType === 'movie' ? 'movie' : result.mediaType === 'show' ? 'show' : result.mediaType === 'book' ? 'book' : 'music'] ?? null;
  const takenSeasons = new Set((tv?.seasons ?? []).filter((x) => x.status !== 'missing' && x.status !== 'partial').map((x) => x.seasonNumber));
  const requestable = level !== 'none' && (isRequestable(result) || (isShow && !!result.availableItemId && !!tv && takenSeasons.size < tv.seasons.length));
  const units = isShow ? (allSeasons ? Math.max(1, (tv?.seasons.length ?? 1) - takenSeasons.size) : seasons.length) : 1;
  const overQuota = !!quota && quota.remaining !== null && quota.remaining < units;
  const badge = discoverBadge(result);
  const toggleSeason = (n: number) => setSeasons((s) => (s.includes(n) ? s.filter((x) => x !== n) : [...s, n].sort((a, b) => a - b)));
  const canSend = requestable && !overQuota && !busy && !done && (!isShow || allSeasons || seasons.length > 0);

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      const req = await api.createMediaRequest({
        tmdbId: result.tmdbId,
        mediaType: result.mediaType,
        ...(isShow && !allSeasons ? { seasons } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setDone(req);
      invalidate('requests:');
      onRequested(result, req);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={!!result} title={result.title} subtitle={[result.year, isShow ? 'TV show' : 'Movie', result.rating ? `★ ${result.rating.toFixed(1)}` : null].filter(Boolean).join(' · ')} onClose={onClose} width={680}>
      <View style={{ flexDirection: 'row', gap: t.space.md }}>
        {result.posterUrl ? <Img path={result.posterUrl} width={t.s(96)} style={{ width: t.s(96), height: t.s(144), borderRadius: t.radius }} /> : null}
        <View style={{ flex: 1, gap: t.space.sm }}>
          {badge ? <StatusPill label={badge.label} tone={badge.tone} icon={badge.icon} /> : null}
          {result.overview ? (
            <T variant="small" tone="muted" numberOfLines={t.isTV ? 5 : 6}>
              {result.overview}
            </T>
          ) : null}
        </View>
      </View>

      {done ? (
        <View style={{ gap: t.space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
            <Icon name="checkmark-circle" color={t.colors.success} />
            <T tone="success" weight="700" style={{ flex: 1 }}>
              {done.status === 'pending' ? 'Requested — waiting for approval' : `Requested · ${REQUEST_STATUS[done.status].label}`}
            </T>
          </View>
          <View style={{ flexDirection: 'row', gap: t.space.sm, flexWrap: 'wrap' }}>
            <Button label="Done" onPress={onClose} hasTVPreferredFocus />
            <Button label="My requests" icon="list" variant="secondary" onPress={onOpenRequests} />
          </View>
        </View>
      ) : requestable ? (
        <>
          {isShow ? (
            <View style={{ gap: t.space.sm }}>
              <T variant="caption" tone="muted" style={{ textTransform: 'uppercase' }}>
                Seasons
              </T>
              <View style={{ flexDirection: 'row', gap: t.space.sm, flexWrap: 'wrap' }}>
                <Chip label="All seasons" icon="layers-outline" selected={allSeasons} onPress={() => setAllSeasons(true)} hasTVPreferredFocus />
                <Chip label="Choose seasons" icon="options-outline" selected={!allSeasons} onPress={() => setAllSeasons(false)} />
              </View>
              {!allSeasons ? (
                <View style={{ flexDirection: 'row', gap: t.space.xs, flexWrap: 'wrap' }}>
                  {Array.from({ length: maxSeason }, (_, i) => i + 1).filter((n) => !takenSeasons.has(n)).map((n) => (
                    <Chip key={n} label={`S${n}`} selected={seasons.includes(n)} onPress={() => toggleSeason(n)} />
                  ))}
                  {!tv && maxSeason < 60 ? <Chip label="More" icon="add" onPress={() => setMaxSeason((m) => Math.min(60, m + 10))} /> : null}
                </View>
              ) : null}
              {!allSeasons && !seasons.length ? (
                <T variant="small" tone="muted">
                  Pick at least one season.
                </T>
              ) : null}
            </View>
          ) : null}
          {quota && !quota.exempt && quota.limit > 0 ? (
            <T variant="small" tone={overQuota ? 'danger' : 'muted'}>
              {overQuota
                ? `Quota reached: ${quota.remaining ?? 0} of ${quota.limit} ${isShow ? 'seasons' : 'requests'} left in ${quota.days} days.`
                : `${quota.remaining} of ${quota.limit} ${isShow ? 'seasons' : 'requests'} left in the last ${quota.days} days.`}
            </T>
          ) : null}
          {level === 'auto' ? <T variant="small" tone="muted">Approved automatically.</T> : null}
          <Input label="Note (optional)" value={note} onChangeText={setNote} placeholder="Anything the admin should know" maxLength={500} returnKeyType="done" onSubmitEditing={() => void send()} />
          {error ? <ErrorBanner error={error} /> : null}
          <View style={{ flexDirection: 'row', gap: t.space.sm, flexWrap: 'wrap' }}>
            <Button label="Request" icon="add-circle-outline" onPress={() => void send()} loading={busy} disabled={!canSend} hasTVPreferredFocus={!isShow} />
            <Button label="Cancel" variant="secondary" onPress={onClose} />
          </View>
        </>
      ) : (
        <View style={{ gap: t.space.md }}>
          <T tone="muted">{level === 'none' ? "You don't have permission to request this kind of title." : result.blacklisted ? "This title can't be requested on this server." : 'This title has already been requested.'}</T>
          <View style={{ flexDirection: 'row', gap: t.space.sm, flexWrap: 'wrap' }}>
            <Button label="My requests" icon="list" onPress={onOpenRequests} hasTVPreferredFocus />
            <Button label="Close" variant="secondary" onPress={onClose} />
          </View>
        </View>
      )}
    </Sheet>
  );
}
