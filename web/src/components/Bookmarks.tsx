import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Bookmark, Item } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useMusic } from '../player/music';
import { useToast } from '../state/toast';
import { isAudio } from '../utils/items';
import { formatClock } from '../utils/format';
import { Icon } from './Icon';
import { Skeleton, Spinner } from './ui';

const CHANGED = 'mm:bookmarks';
const announce = (itemId: string) => window.dispatchEvent(new CustomEvent(CHANGED, { detail: itemId }));

/** Bookmarks of one or more items (e.g. all parts of an audiobook), kept in sync across the page and the player. */
export function useBookmarks(itemIds: string[]) {
  const key = itemIds.join(',');
  const [list, setList] = useState<Bookmark[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!key) {
      setList([]);
      return;
    }
    try {
      const ids = key.split(',');
      const all = await Promise.all(ids.map((id) => api.items.bookmarks(id).catch(() => [] as Bookmark[])));
      setList(all.flat());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [key]);
  useEffect(() => {
    setList(null);
    void load();
  }, [load]);
  useEffect(() => {
    const h = (e: Event) => {
      if (key.split(',').includes((e as CustomEvent<string>).detail)) void load();
    };
    window.addEventListener(CHANGED, h);
    return () => window.removeEventListener(CHANGED, h);
  }, [key, load]);
  return { list, error, reload: load, setList };
}

/** Play `bm`: seek if its item is playing, jump within the queue, or start the book/part from that point. */
export function usePlayBookmark() {
  const music = useMusic();
  const toast = useToast();
  return useCallback(async (bm: Bookmark) => {
    if (music.current?.id === bm.itemId) {
      music.seek(bm.positionMs);
      if (!music.playing) music.toggle();
      return;
    }
    const qi = music.queue.findIndex((q) => q.id === bm.itemId);
    if (qi >= 0) {
      music.jump(qi, bm.positionMs);
      return;
    }
    try {
      const item = await api.items.get(bm.itemId);
      if (item.parentId && (item.type === 'bookpart' || item.type === 'podcastepisode')) {
        const siblings = item.type === 'bookpart' ? (await api.items.children(item.parentId, { sort: 'index', limit: 1000 })).items.filter(isAudio) : [item];
        const i = siblings.findIndex((s) => s.id === item.id);
        if (i >= 0) {
          music.playQueue(siblings, i, bm.positionMs);
          return;
        }
      }
      music.playQueue([item], 0, bm.positionMs);
    } catch (e) {
      toast.error(e);
    }
  }, [music, toast]);
}

export function AddBookmarkForm({ itemId, positionMs, compact }: { itemId: string; positionMs: number; compact?: boolean }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.items.addBookmark(itemId, { positionMs: Math.round(positionMs), note: note.trim() || undefined });
      setNote('');
      announce(itemId);
      toast.success(`Bookmark added at ${formatClock(positionMs)}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={`bookmark-add ${compact ? 'compact' : ''}`} onSubmit={submit}>
      <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Bookmark note" maxLength={500} />
      <button className="btn btn-primary btn-sm" disabled={busy}>
        {busy ? <Spinner size={14} /> : <Icon name="plus" size={14} />} Bookmark {formatClock(positionMs)}
      </button>
    </form>
  );
}

export function BookmarkList({ bookmarks, titles, activeItemId, onPlay, onRemove }: {
  bookmarks: Bookmark[];
  titles?: Record<string, string>;
  activeItemId?: string | null;
  onPlay: (b: Bookmark) => void;
  onRemove: (b: Bookmark) => void;
}) {
  if (!bookmarks.length) return <p className="muted bookmark-empty">No bookmarks yet.</p>;
  return (
    <ol className="bookmark-list">
      {bookmarks.map((b) => (
        <li key={b.id} className={b.itemId === activeItemId ? 'current-item' : ''}>
          <button className="bookmark-item" onClick={() => onPlay(b)} title={`Play from ${formatClock(b.positionMs)}`}>
            <span className="bookmark-time"><Icon name="play" size={12} /> {formatClock(b.positionMs)}</span>
            <span className="bookmark-text">
              {b.note ? <span>{b.note}</span> : <span className="muted">Bookmark</span>}
              {titles?.[b.itemId] && <small>{titles[b.itemId]}</small>}
            </span>
          </button>
          <button className="btn-icon" onClick={() => onRemove(b)} aria-label={`Delete bookmark at ${formatClock(b.positionMs)}`} title="Delete">
            <Icon name="trash" size={14} />
          </button>
        </li>
      ))}
    </ol>
  );
}

function useRemoveBookmark(setList: (fn: (l: Bookmark[] | null) => Bookmark[] | null) => void) {
  const toast = useToast();
  return async (b: Bookmark) => {
    setList((l) => (l ?? []).filter((x) => x.id !== b.id));
    try {
      await api.items.removeBookmark(b.itemId, b.id);
      announce(b.itemId);
    } catch (e) {
      toast.error(e);
      announce(b.itemId);
    }
  };
}

/** Bookmarks section on an audiobook or part page. */
export function BookmarksSection({ item }: { item: Item }) {
  const music = useMusic();
  const playBookmark = usePlayBookmark();
  const [parts, setParts] = useState<Item[] | null>(item.type === 'audiobook' ? null : [item]);
  useEffect(() => {
    if (item.type !== 'audiobook') {
      setParts([item]);
      return;
    }
    let cancelled = false;
    api.items.children(item.id, { sort: 'index', limit: 200 })
      .then((r) => !cancelled && setParts(r.items.filter(isAudio)))
      .catch(() => !cancelled && setParts([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.type]);
  const ids = (parts ?? []).map((p) => p.id);
  const bm = useBookmarks(ids);
  const remove = useRemoveBookmark(bm.setList);
  const titles = parts && parts.length > 1 ? Object.fromEntries(parts.map((p) => [p.id, p.title])) : undefined;
  const order = new Map(ids.map((id, i) => [id, i]));
  const sorted = [...(bm.list ?? [])].sort((a, b) => (order.get(a.itemId) ?? 0) - (order.get(b.itemId) ?? 0) || a.positionMs - b.positionMs);
  const playingHere = music.current && ids.includes(music.current.id) ? music.current : null;

  return (
    <section className="bookmarks-section">
      <h2 className="section-title">Bookmarks {sorted.length > 0 && <span className="tab-count">{sorted.length}</span>}</h2>
      {playingHere ? (
        <AddBookmarkForm itemId={playingHere.id} positionMs={music.positionMs} />
      ) : (
        <p className="muted small">Start listening to add a bookmark at the current position.</p>
      )}
      {parts === null || bm.list === null ? <Skeleton h={60} /> : (
        <BookmarkList bookmarks={sorted} titles={titles} activeItemId={music.current?.id} onPlay={(b) => void playBookmark(b)} onRemove={remove} />
      )}
    </section>
  );
}

/** Bookmarks panel content for the audio player. */
export function PlayerBookmarks() {
  const music = useMusic();
  const playBookmark = usePlayBookmark();
  const cur = music.current;
  const bm = useBookmarks(cur ? [cur.id] : []);
  const remove = useRemoveBookmark(bm.setList);
  if (!cur) return null;
  const sorted = [...(bm.list ?? [])].sort((a, b) => a.positionMs - b.positionMs);
  return (
    <div className="player-bookmarks">
      <AddBookmarkForm itemId={cur.id} positionMs={music.positionMs} compact />
      {bm.list === null ? <Skeleton h={48} /> : <BookmarkList bookmarks={sorted} activeItemId={cur.id} onPlay={(b) => void playBookmark(b)} onRemove={remove} />}
    </div>
  );
}
