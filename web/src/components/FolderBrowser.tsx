import { useEffect, useState } from 'react';
import type { DirectoryEntry } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Icon } from './Icon';
import { Modal, Spinner } from './ui';
import { parentOf } from '../utils/paths';

export function FolderBrowser({ open, onClose, onPick, initialPath }: { open: boolean; onClose: () => void; onPick: (path: string) => void; initialPath?: string }) {
  const [path, setPath] = useState(initialPath ?? '');
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState(initialPath ?? '');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.system
      .browse(path || undefined)
      .then((e) => !cancelled && setEntries(e.filter((x) => x.isDirectory && x.name !== '..').sort((a, b) => (a.kind === 'network' ? 1 : 0) - (b.kind === 'network' ? 1 : 0) || a.name.localeCompare(b.name))))
      .catch((e) => !cancelled && setError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    setTyped(path);
    return () => {
      cancelled = true;
    };
  }, [path, open]);

  const parent = parentOf(path);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Choose a folder"
      size="md"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!path} onClick={() => { onPick(path); onClose(); }}>
            Select this folder
          </button>
        </>
      }
    >
      <form className="fb-path" onSubmit={(e) => { e.preventDefault(); setPath(typed.trim()); }}>
        <Icon name="folder" size={18} />
        <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={path === '' && entries.some((e) => e.kind) ? 'C:\\Media or \\\\nas\\media' : '/media'} aria-label="Path" />
        <button className="btn btn-sm">Go</button>
      </form>
      <div className="fb-list">
        {parent !== null && (
          <button className="fb-entry" onClick={() => setPath(parent)}>
            <Icon name="arrowLeft" size={18} /> <span>..</span>
          </button>
        )}
        {loading ? (
          <div className="center-pad"><Spinner /></div>
        ) : error ? (
          <p className="form-error">{error}</p>
        ) : entries.length === 0 ? (
          <p className="muted center-pad">No sub-folders</p>
        ) : (
          entries.map((e) => (
            <button key={e.path} className={`fb-entry ${e.error ? 'fb-unavailable' : ''}`} onClick={() => setPath(e.path)} title={e.kind === 'network' ? e.path : undefined}>
              <Icon name={e.kind === 'network' ? 'globe' : e.kind === 'drive' ? 'server' : 'folder'} size={18} />
              <span className="fb-name">
                {e.name}
                {e.kind === 'network' && <small className="muted">{e.error ?? 'Mapped network drive, added by its network path'}</small>}
              </span>
              <Icon name="chevronRight" size={16} className="fb-chev" />
            </button>
          ))
        )}
        {path === '' && !loading && entries.some((e) => e.kind) && (
          <p className="muted fb-tip">Media on a NAS or another PC? Type its network path above, for example <code>\\nas\media</code>.</p>
        )}
      </div>
    </Modal>
  );
}
