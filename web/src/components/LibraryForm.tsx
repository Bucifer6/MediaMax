import { useState, type FormEvent } from 'react';
import type { CreateLibraryRequest, Library } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { FolderBrowser } from './FolderBrowser';
import { Icon } from './Icon';
import { Field, Spinner, Switch } from './ui';
import { libraryIcon } from '../utils/items';

const TYPES: { value: CreateLibraryRequest['type']; label: string; hint?: string }[] = [
  { value: 'movies', label: 'Movies' },
  { value: 'shows', label: 'TV Shows' },
  { value: 'music', label: 'Music' },
  { value: 'audiobooks', label: 'Audiobooks', hint: 'Author/Book folders or .m4b files' },
  { value: 'photos', label: 'Photos' },
  { value: 'videos', label: 'Home videos' },
];

export function LibraryForm({ initial, onSaved, onCancel, submitLabel }: { initial?: Library; onSaved: (l: Library) => void; onCancel?: () => void; submitLabel?: string }) {
  const toast = useToast();
  // IPTV and podcast libraries are managed automatically and have no folders.
  const iptv = initial?.type === 'iptv-movies' || initial?.type === 'iptv-shows' || initial?.type === 'podcasts';
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<CreateLibraryRequest['type']>(iptv || !initial ? 'movies' : (initial.type as CreateLibraryRequest['type']));
  const [paths, setPaths] = useState<string[]>(initial?.paths ?? []);
  const [fetchMetadata, setFetchMetadata] = useState(initial?.fetchMetadata ?? true);
  const [browse, setBrowse] = useState(false);
  const [typedPath, setTypedPath] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const allPaths = typedPath.trim() ? [...paths, typedPath.trim()] : paths;
    if (!iptv && !allPaths.length) {
      toast.show('Add at least one folder', 'error');
      return;
    }
    setBusy(true);
    try {
      const lib = initial
        ? await api.libraries.update(initial.id, iptv ? { name } : { name, paths: allPaths, fetchMetadata })
        : await api.libraries.create({ name: name || TYPES.find((t) => t.value === type)!.label, type, paths: allPaths, fetchMetadata });
      toast.success(initial ? 'Library updated' : 'Library created — scanning started');
      onSaved(lib);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="form-grid">
      {!initial && (
        <div className="type-picker">
          {TYPES.map((t) => (
            <button type="button" key={t.value} className={`type-option ${type === t.value ? 'active' : ''}`} onClick={() => setType(t.value)}>
              <Icon name={libraryIcon(t.value)} size={26} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )}
      {!initial && TYPES.find((t) => t.value === type)?.hint && (
        <p className="muted type-hint"><Icon name="info" size={14} /> {TYPES.find((t) => t.value === type)!.hint}</p>
      )}
      <Field label="Name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={TYPES.find((t) => t.value === type)?.label} />
      </Field>
      {!iptv && (
        <>
          <div className="field">
            <span className="field-label">Folders</span>
            <div className="path-list">
              {paths.map((p) => (
                <div key={p} className="path-chip">
                  <Icon name="folder" size={16} />
                  <span>{p}</span>
                  <button type="button" className="btn-icon" onClick={() => setPaths((ps) => ps.filter((x) => x !== p))} aria-label={`Remove ${p}`}>
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
              <div className="path-add">
                <input className="input" value={typedPath} onChange={(e) => setTypedPath(e.target.value)} placeholder="/media/movies"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && typedPath.trim()) {
                      e.preventDefault();
                      setPaths((ps) => [...new Set([...ps, typedPath.trim()])]);
                      setTypedPath('');
                    }
                  }}
                />
                <button type="button" className="btn" onClick={() => setBrowse(true)}>
                  <Icon name="folder" size={16} /> Browse
                </button>
              </div>
            </div>
          </div>
          <Switch checked={fetchMetadata} onChange={setFetchMetadata} label="Fetch online metadata" hint="Posters, backdrops, cast and descriptions from TMDB." />
        </>
      )}
      <div className="form-actions">
        {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
        <button className="btn btn-primary" disabled={busy}>{busy ? <Spinner size={18} /> : submitLabel ?? (initial ? 'Save' : 'Add library')}</button>
      </div>
      <FolderBrowser open={browse} onClose={() => setBrowse(false)} initialPath={paths[paths.length - 1]} onPick={(p) => setPaths((ps) => [...new Set([...ps, p])])} />
    </form>
  );
}
