import { useEffect, useState } from 'react';
import type { DirectoryEntry } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Icon } from './Icon';
import { Modal, Spinner } from './ui';

function parentOf(p: string): string | null {
  if (!p || p === '/') return null;
  const win = /^[A-Za-z]:\\?$/.test(p);
  if (win) return '';
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
  const trimmed = p.endsWith(sep) ? p.slice(0, -1) : p;
  const i = trimmed.lastIndexOf(sep);
  if (i <= 0) return sep;
  return trimmed.slice(0, i);
}

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
      .then((e) => !cancelled && setEntries(e.filter((x) => x.isDirectory).sort((a, b) => a.name.localeCompare(b.name))))
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
        <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="/media" aria-label="Path" />
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
            <button key={e.path} className="fb-entry" onClick={() => setPath(e.path)}>
              <Icon name="folder" size={18} /> <span>{e.name}</span>
              <Icon name="chevronRight" size={16} className="fb-chev" />
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
