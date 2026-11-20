import { useState } from 'react';
import type { Item } from '@mediamax/shared';
import { arrApi } from '../api/arr';
import { useApp } from '../state/app';
import { useAsync } from '../hooks';
import { useToast } from '../state/toast';
import { Spinner } from './ui';
import { Icon } from './Icon';
import '../styles/arr.css';

const NAME = { radarr: 'Radarr', sonarr: 'Sonarr', lidarr: 'Lidarr', readarr: 'Readarr', bazarr: 'Bazarr' } as const;
const SUPPORTED = new Set(['movie', 'show', 'season', 'episode', 'artist', 'album']);

/**
 * Admin-only *arr actions for an item page: "Open in Radarr/Sonarr/Lidarr", "Search for upgrade"
 * and "Find subtitles with Bazarr". Renders nothing for other users, other item types or when no *arr matches.
 *
 * Usage (e.g. in pages/ItemDetail.tsx, under the action buttons): `<ArrItemActions item={item} />`
 */
export function ArrItemActions({ item }: { item: Pick<Item, 'id' | 'type'> }) {
  const { user } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const show = !!user?.isAdmin && SUPPORTED.has(item.type);
  const info = useAsync(async () => (show ? arrApi.item(item.id).catch(() => null) : null), [item.id, show]);
  const data = info.data;
  if (!show || !data || (!data.matches.length && !data.bazarr)) return null;

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try {
      toast.success(await fn());
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="arr-item-actions" aria-label="Media automation">
      {data.matches.map((m) => (
        <span key={m.instance.id} className="row-gap">
          <a className="btn btn-sm" href={m.webUrl} target="_blank" rel="noreferrer">
            <Icon name="external" size={14} /> Open in {m.instance.name}{m.instance.name.toLowerCase().includes(NAME[m.instance.kind].toLowerCase()) ? '' : ` (${NAME[m.instance.kind]})`}
          </a>
          <button
            className="btn btn-sm"
            disabled={busy === m.instance.id}
            onClick={() => void run(m.instance.id, async () => {
              await arrApi.search(m.instance.id, { ids: [m.arrId], command: m.searchCommand });
              return `${m.instance.name} is searching for ${m.hasFile ? 'an upgrade' : 'a release'}`;
            })}
          >
            {busy === m.instance.id ? <Spinner size={14} /> : <Icon name="search" size={14} />} {m.hasFile ? 'Search for upgrade' : 'Search'}{data.matches.length > 1 ? ` (${m.instance.name})` : ''}
          </button>
        </span>
      ))}
      {data.bazarr && item.type !== 'artist' && item.type !== 'album' && (
        <button className="btn btn-sm" disabled={busy === 'bazarr'} onClick={() => void run('bazarr', async () => (await arrApi.bazarr(item.id)).message)}>
          {busy === 'bazarr' ? <Spinner size={14} /> : <Icon name="subtitles" size={14} />} Find subtitles with Bazarr
        </button>
      )}
    </div>
  );
}
