import { useEffect, useState } from 'react';
import type { HomeLayout, HomeRowConfig } from '@mediamax/shared';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { api } from '../api/endpoints';
import { Icon } from './Icon';
import { Button, Modal } from './ui';

/** Row titles when a config has none (mirrors DEFAULT_TITLES in server/src/services/items.ts). */
const TYPE_TITLES: Record<string, string> = {
  hero: 'Featured', continue: 'Continue Watching', nextup: 'Next Up', recent: 'Recently Added', favorites: 'Favourites', 'live-now': 'On Now',
  'favorite-channels': 'Favourite Channels', recordings: 'Recordings', collection: 'Collection', genre: 'Genre', playlist: 'Playlist',
  'library-recent': 'Recently Added', recommended: 'Recommended for you', because: 'Because you watched…', top10: 'Top 10',
  trending: 'Popular right now', watchlist: 'My List', upcoming: 'Coming soon', spotlight: 'Spotlight',
};

interface Entry { id: string; title: string; hidden: boolean }

/** A human title for a row id that isn't on screen (hidden rows): from the server's row config and the libraries. */
function titleFor(id: string, configs: HomeRowConfig[], libName: (id: string) => string | undefined): string {
  const [base, lib] = id.split(':');
  const cfg = configs.find((c) => c.id === base);
  if (lib) return `Recently Added in ${libName(lib) ?? 'a library'}`;
  if (!cfg) return id;
  return cfg.title || cfg.genre || TYPE_TITLES[cfg.type] || id;
}

/**
 * "Customize Home" (per profile): show / hide and reorder the Home rows, or reset to the server's default. Saves
 * `preferences.homeLayout` with PATCH /auth/me; the server applies it when building Home (services/items.ts).
 *
 * `rows` are the rows Home is showing now, in order (`HomeRow.id` + title). Rows the profile hid are added from the
 * saved layout. Call `onSaved` to reload Home.
 */
export function CustomizeHome({ open, onClose, rows, onSaved }: { open: boolean; onClose: () => void; rows: { id: string; title: string }[]; onSaved?: () => void }) {
  const { user, setUser, branding, libraries } = useApp();
  const toast = useToast();
  const saved: HomeLayout = { hidden: [], order: [], ...(user?.preferences?.homeLayout ?? {}) };
  const [list, setList] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const shown = rows.map((r) => ({ id: r.id, title: r.title || titleFor(r.id, branding.homeRows, (l) => libraries.find((x) => x.id === l)?.name), hidden: false }));
    const known = new Set(shown.map((r) => r.id));
    const hidden = saved.hidden.filter((id) => !known.has(id)).map((id) => ({ id, title: titleFor(id, branding.homeRows, (l) => libraries.find((x) => x.id === l)?.name), hidden: true }));
    // Rows in the saved order first (as the server does), the rest after them; hidden rows keep their saved place.
    const rank = new Map(saved.order.map((id, i) => [id, i]));
    const all = [...shown, ...hidden]
      .map((e, i) => ({ e, i, r: rank.get(e.id) ?? Infinity }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.e);
    setList(all);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setList(next);
  };
  const toggle = (i: number) => setList((l) => l.map((e, k) => (k === i ? { ...e, hidden: !e.hidden } : e)));

  const persist = async (layout: HomeLayout) => {
    if (!user) return;
    setBusy(true);
    try {
      setUser(await api.auth.updateMe({ preferences: { homeLayout: layout } }));
      onSaved?.();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Customize Home"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => void persist({ hidden: [], order: [] })} disabled={busy} className="ch-reset">
            Reset to default
          </Button>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void persist({ hidden: list.filter((e) => e.hidden).map((e) => e.id), order: list.map((e) => e.id) })}>
            Save
          </Button>
        </>
      }
    >
      <p className="muted ch-intro">Choose which rows appear on your Home and in what order. Only your profile is affected.</p>
      <ol className="ch-list">
        {list.map((e, i) => (
          <li key={e.id} className={`ch-row ${e.hidden ? 'is-hidden' : ''}`}>
            <label className="ch-toggle">
              <input type="checkbox" className="switch" checked={!e.hidden} onChange={() => toggle(i)} aria-label={`Show ${e.title}`} />
              <span className="ch-title">{e.title}</span>
            </label>
            <button type="button" className="btn-icon btn-icon-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${e.title} up`}>
              <Icon name="chevronUp" size={16} />
            </button>
            <button type="button" className="btn-icon btn-icon-sm" onClick={() => move(i, 1)} disabled={i === list.length - 1} aria-label={`Move ${e.title} down`}>
              <Icon name="chevronDown" size={16} />
            </button>
          </li>
        ))}
      </ol>
      {!list.length && <p className="muted">There are no rows to arrange yet.</p>}
    </Modal>
  );
}
