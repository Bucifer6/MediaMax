/**
 * My requests (everyone) and the request queue (admins: everyone's requests,
 * a status filter, Approve and Decline with a note).
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, RefreshControl, ScrollView, View } from 'react-native';
import type { MediaRequest, RequestStatus } from '@/api/types';
import { invalidate, useQuery } from '@/api/useQuery';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Icon } from '@/components/Icon';
import { Img } from '@/components/Img';
import { Input } from '@/components/Input';
import { OptionSheet } from '@/components/OptionSheet';
import { ErrorBanner, REQUEST_STATUS, RequestStatusChip, describeRequestError } from '@/components/Requests';
import { Screen, ScreenHeader } from '@/components/Screen';
import { EmptyState, Loading } from '@/components/States';
import { Sheet } from '@/components/Sheet';
import { T } from '@/components/Text';
import { useApi, useCapabilities, useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { formatDate } from '@/utils/format';

const STATUSES = Object.keys(REQUEST_STATUS) as RequestStatus[];

export default function RequestsScreen() {
  const t = useTheme();
  const api = useApi();
  const caps = useCapabilities();
  const { user } = useSession();
  const admin = !!user?.isAdmin;
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [status, setStatus] = useState<RequestStatus | null>(null);
  const mine = !admin || scope === 'mine';
  const q = useQuery(caps.requests ? `requests:${mine ? 'mine' : 'all'}:${admin ? status ?? '' : ''}` : null, (a) => a.mediaRequests({ status: admin ? status ?? undefined : undefined, mine: admin && mine }), { staleMs: 5000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [withdrawing, setWithdrawing] = useState<MediaRequest | null>(null);
  const [declining, setDeclining] = useState<MediaRequest | null>(null);
  const [declineNote, setDeclineNote] = useState('');

  const replace = (req: MediaRequest) => q.setData((prev) => prev?.map((r) => (r.id === req.id ? req : r)).filter((r) => !status || r.status === status));
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
      invalidate('requests:');
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  };

  const approve = (r: MediaRequest) => run(`approve:${r.id}`, async () => replace(await api.approveMediaRequest(r.id)));
  const decline = () => {
    const r = declining;
    if (!r) return;
    const note = declineNote.trim();
    setDeclining(null);
    void run(`decline:${r.id}`, async () => replace(await api.declineMediaRequest(r.id, note)));
  };
  const withdraw = () => {
    const r = withdrawing;
    if (!r) return;
    setWithdrawing(null);
    void run(`delete:${r.id}`, async () => {
      await api.deleteMediaRequest(r.id);
      q.setData((prev) => prev?.filter((x) => x.id !== r.id));
    });
  };

  if (!caps.requests) {
    return (
      <Screen>
        <ScreenHeader title="Requests" />
        <EmptyState icon="paper-plane-outline" title="Requests are off" message="Your server doesn't take media requests." />
      </Screen>
    );
  }

  const list = q.data ?? [];
  const filters = admin ? (
    <View style={{ gap: t.space.sm, marginBottom: t.space.md }}>
      <View style={{ flexDirection: 'row', gap: t.space.sm }}>
        <Chip label="Everyone" icon="people-outline" selected={scope === 'all'} onPress={() => setScope('all')} hasTVPreferredFocus />
        <Chip label="Mine" icon="person-outline" selected={scope === 'mine'} onPress={() => setScope('mine')} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: t.space.sm, paddingVertical: t.isTV ? t.s(6) : 0 }}>
        <Chip label="All statuses" selected={!status} onPress={() => setStatus(null)} />
        {STATUSES.map((s) => (
          <Chip key={s} label={REQUEST_STATUS[s].label} icon={REQUEST_STATUS[s].icon} selected={status === s} onPress={() => setStatus(s)} />
        ))}
      </ScrollView>
    </View>
  ) : null;

  return (
    <Screen>
      <ScreenHeader
        title={admin ? 'Requests' : 'My requests'}
        subtitle={admin ? 'Approve or decline what people asked for' : undefined}
        right={t.isTV ? undefined : <Button icon="compass-outline" label="Discover" size="sm" variant="secondary" onPress={() => router.push('/(tabs)/discover' as never)} />}
      />
      <FlatList
        data={list}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.xxl * 2, gap: t.space.sm }}
        refreshControl={t.isTV ? undefined : <RefreshControl refreshing={q.refreshing} onRefresh={q.refresh} tintColor={t.colors.primary} />}
        ListHeaderComponent={
          <View>
            {filters}
            {actionError ? (
              <View style={{ marginBottom: t.space.sm }}>
                <ErrorBanner error={actionError} />
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          q.loading ? (
            <Loading />
          ) : q.error ? (
            <EmptyState icon={describeRequestError(q.error).icon} title={describeRequestError(q.error).title} message={q.error.message} action="Try again" onAction={q.refresh} />
          ) : (
            <EmptyState
              icon="paper-plane-outline"
              title={status ? `No ${REQUEST_STATUS[status].label.toLowerCase()} requests` : 'No requests yet'}
              message={mine ? 'Find a movie or show in Discover and request it.' : undefined}
              action={mine ? 'Open Discover' : undefined}
              onAction={mine ? () => router.push('/(tabs)/discover' as never) : undefined}
            />
          )
        }
        renderItem={({ item: r, index }) => (
          <RequestRow
            req={r}
            showRequester={admin}
            canWithdraw={r.status === 'pending' && (r.requestedBy.id === user?.id || admin)}
            canApprove={admin && (r.status === 'pending' || r.status === 'failed' || r.status === 'declined')}
            canDecline={admin && r.status === 'pending'}
            busy={busy?.endsWith(`:${r.id}`) ? busy.split(':')[0] : null}
            preferred={!admin && index === 0}
            onApprove={() => void approve(r)}
            onDecline={() => {
              setDeclineNote('');
              setDeclining(r);
            }}
            onWithdraw={() => setWithdrawing(r)}
          />
        )}
      />

      <OptionSheet
        visible={!!withdrawing}
        title={withdrawing ? `Withdraw “${withdrawing.title}”?` : undefined}
        options={[
          { key: 'withdraw', label: withdrawing && withdrawing.requestedBy.id !== user?.id ? 'Delete request' : 'Withdraw request', icon: 'trash-outline', destructive: true },
          { key: 'cancel', label: 'Keep it', icon: 'close' },
        ]}
        onSelect={(k) => (k === 'withdraw' ? withdraw() : setWithdrawing(null))}
        onClose={() => setWithdrawing(null)}
      />

      <Sheet visible={!!declining} title={declining ? `Decline “${declining.title}”` : undefined} subtitle={declining ? `Requested by ${declining.requestedBy.displayName}` : undefined} onClose={() => setDeclining(null)}>
        <Input label="Note for the requester (optional)" value={declineNote} onChangeText={setDeclineNote} placeholder="e.g. Not available in good quality yet" maxLength={500} multiline returnKeyType="done" />
        <View style={{ flexDirection: 'row', gap: t.space.sm, flexWrap: 'wrap' }}>
          <Button label="Decline" icon="close-circle-outline" variant="danger" onPress={decline} hasTVPreferredFocus />
          <Button label="Cancel" variant="secondary" onPress={() => setDeclining(null)} />
        </View>
      </Sheet>
    </Screen>
  );
}

function RequestRow({
  req,
  showRequester,
  canWithdraw,
  canApprove,
  canDecline,
  busy,
  preferred,
  onApprove,
  onDecline,
  onWithdraw,
}: {
  req: MediaRequest;
  showRequester: boolean;
  canWithdraw: boolean;
  canApprove: boolean;
  canDecline: boolean;
  busy: string | null;
  preferred?: boolean;
  onApprove: () => void;
  onDecline: () => void;
  onWithdraw: () => void;
}) {
  const t = useTheme();
  const posterW = t.isTV ? t.s(70) : 56;
  const seasons = req.mediaType === 'show' ? (req.seasons.length ? `Season${req.seasons.length > 1 ? 's' : ''} ${req.seasons.join(', ')}` : 'All seasons') : null;
  const meta = [req.year, req.mediaType === 'show' ? 'Show' : 'Movie', seasons].filter(Boolean).join(' · ');
  const who = [showRequester ? req.requestedBy.displayName : null, formatDate(req.requestedAt)].filter(Boolean).join(' · ');
  const decided = req.decidedBy && req.decidedAt ? `${req.status === 'declined' ? 'Declined' : 'Approved'} by ${req.decidedBy.displayName} · ${formatDate(req.decidedAt)}` : null;
  const hasActions = canApprove || canDecline || canWithdraw || (req.status === 'available' && !!req.itemId);
  return (
    <View style={{ flexDirection: 'row', gap: t.space.md, padding: t.space.md, borderRadius: t.radius, backgroundColor: t.colors.surface }}>
      <View style={{ width: posterW, height: posterW * 1.5, borderRadius: t.radius * 0.6, overflow: 'hidden', backgroundColor: t.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
        {req.posterUrl ? <Img path={req.posterUrl} width={posterW} style={{ width: '100%', height: '100%' }} /> : <Icon name={req.mediaType === 'show' ? 'tv-outline' : 'film-outline'} color={t.colors.textMuted} />}
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: t.space.sm }}>
          <T weight="700" numberOfLines={2} style={{ flex: 1 }}>
            {req.title}
          </T>
          <RequestStatusChip status={req.status} />
        </View>
        <T variant="small" tone="muted" numberOfLines={1}>
          {meta}
        </T>
        <T variant="caption" tone="muted" weight="500" numberOfLines={1} style={{ letterSpacing: 0 }}>
          {who}
        </T>
        {decided ? (
          <T variant="caption" tone="muted" weight="500" numberOfLines={1} style={{ letterSpacing: 0 }}>
            {decided}
          </T>
        ) : null}
        {req.note ? (
          <T variant="small" numberOfLines={3} style={{ fontStyle: 'italic' }}>
            “{req.note}”
          </T>
        ) : null}
        {req.error ? (
          <T variant="small" tone="danger" numberOfLines={3}>
            {req.error}
          </T>
        ) : null}
        {hasActions ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm, marginTop: t.space.xs }}>
            {req.status === 'available' && req.itemId ? <Button label="Open" icon="play-circle-outline" size="sm" onPress={() => router.push(`/item/${req.itemId}` as never)} hasTVPreferredFocus={preferred} /> : null}
            {canApprove ? <Button label={req.status === 'failed' ? 'Retry' : 'Approve'} icon="checkmark-circle-outline" size="sm" onPress={onApprove} loading={busy === 'approve'} disabled={!!busy} /> : null}
            {canDecline ? <Button label="Decline" icon="close-circle-outline" size="sm" variant="secondary" onPress={onDecline} loading={busy === 'decline'} disabled={!!busy} /> : null}
            {canWithdraw ? <Button label={showRequester ? 'Delete' : 'Withdraw'} icon="trash-outline" size="sm" variant="secondary" onPress={onWithdraw} loading={busy === 'delete'} disabled={!!busy} hasTVPreferredFocus={preferred && req.status !== 'available'} /> : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}
