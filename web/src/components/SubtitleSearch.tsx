import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Item, RemoteSubtitle, SubtitleStream } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { ApiRequestError, errorMessage } from '../api/client';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { DEFAULT_PREFERENCES } from '../theme/defaults';
import { languageName } from '../utils/format';
import { isVideo } from '../utils/items';
import { Icon, type IconName } from './Icon';
import { Badge, Modal, Spinner } from './ui';

/** Subtitles fetched from OpenSubtitles are stored with a high index and an "OpenSubtitles…" title. */
export function isDownloadedSubtitle(s: Pick<SubtitleStream, 'index' | 'title'>): boolean {
  return s.index >= 2000 || !!s.title?.startsWith('OpenSubtitles');
}

/** Online search needs a local video file (not an IPTV stream). */
export function canSearchSubtitles(item: Item | null | undefined): item is Item {
  return !!item && isVideo(item) && !!item.media?.length && !item.media[0].remote;
}

interface Problem {
  icon: IconName;
  title: string;
  message: string;
}

function describeError(e: unknown, isAdmin: boolean): Problem {
  const msg = errorMessage(e);
  if (e instanceof ApiRequestError) {
    if (e.code === 'quota' || e.status === 429) {
      return { icon: 'clock', title: 'Download limit reached', message: msg || 'The OpenSubtitles daily download quota is used up. Try again tomorrow.' };
    }
    if (/not configured/i.test(msg)) {
      return {
        icon: 'key',
        title: 'Online subtitles aren’t set up',
        message: isAdmin ? 'Add an OpenSubtitles API key in Admin → Server settings → OpenSubtitles.' : 'Ask your server admin to connect OpenSubtitles.',
      };
    }
    if (e.status === 502 || e.code === 'provider_error') {
      return { icon: 'globe', title: 'OpenSubtitles is having trouble', message: msg };
    }
    if (e.code === 'network') return { icon: 'server', title: 'Can’t reach the server', message: msg };
  }
  return { icon: 'alert', title: 'Something went wrong', message: msg };
}

function formatCount(n: number) {
  return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Search OpenSubtitles for an item and download a track onto the server.
 * `onUpdated` receives the refreshed Item after a download or delete.
 */
export function SubtitleSearchModal({
  open, onClose, item, onUpdated, container,
}: {
  open: boolean;
  onClose: () => void;
  item: Item;
  onUpdated: (item: Item) => void;
  container?: Element | null;
}) {
  const { user } = useApp();
  const toast = useToast();
  const isAdmin = !!user?.isAdmin;
  const defaultLang = user?.preferences?.subtitleLanguage ?? DEFAULT_PREFERENCES.subtitleLanguage ?? 'en';
  const [languages, setLanguages] = useState(defaultLang);
  const [results, setResults] = useState<RemoteSubtitle[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const search = useCallback(async (langs: string) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    setProblem(null);
    try {
      const clean = langs.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).join(',');
      const r = await api.subtitles.search(item.id, clean || 'en', c.signal);
      if (!c.signal.aborted) setResults(r);
    } catch (e) {
      if (c.signal.aborted || (e as Error).name === 'AbortError') return;
      setResults(null);
      setProblem(describeError(e, isAdmin));
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, [item.id, isAdmin]);

  // Fresh search each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setLanguages(defaultLang);
    setResults(null);
    setDone(new Set());
    setConfirmDelete(null);
    void search(defaultLang);
    return () => ctrl.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void search(languages);
  };

  const download = async (s: RemoteSubtitle) => {
    setBusy(s.fileId);
    setProblem(null);
    try {
      const updated = await api.subtitles.download(item.id, { fileId: s.fileId, language: s.language, hearingImpaired: s.hearingImpaired, forced: s.forced });
      setDone((d) => new Set(d).add(s.fileId));
      toast.success(`${languageName(s.language)} subtitles added`);
      onUpdated(updated);
    } catch (e) {
      setProblem(describeError(e, isAdmin));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (s: SubtitleStream) => {
    setBusy(`del-${s.index}`);
    try {
      const updated = await api.subtitles.remove(item.id, s.index);
      toast.success('Subtitle removed');
      onUpdated(updated);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
      setConfirmDelete(null);
    }
  };

  const downloaded = (item.media?.[0]?.subtitleStreams ?? []).filter(isDownloadedSubtitle);

  return (
    <Modal open={open} onClose={onClose} title="Find subtitles online" size="lg" className="subsearch-modal" container={container}>
      <form className="subsearch-form" onSubmit={submit}>
        <label className="field subsearch-lang">
          <span className="field-label">Languages</span>
          <input
            className="input"
            value={languages}
            onChange={(e) => setLanguages(e.target.value)}
            placeholder="en, fr"
            aria-describedby="subsearch-lang-hint"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button className="btn btn-primary" disabled={loading}>
          {loading ? <Spinner size={16} /> : <Icon name="search" size={16} />} Search
        </button>
      </form>
      <small id="subsearch-lang-hint" className="field-hint">Two-letter codes, comma separated. Results that match your file exactly are listed first.</small>

      {downloaded.length > 0 && (
        <div className="subsearch-downloaded">
          <div className="subsearch-heading">Downloaded for this title</div>
          <ul>
            {downloaded.map((s) => (
              <li key={s.index}>
                <Icon name="subtitles" size={16} />
                <span className="subsearch-dl-name">{languageName(s.language)} <span className="muted">{s.title}</span></span>
                {isAdmin && (confirmDelete === s.index ? (
                  <span className="row-gap">
                    <button className="btn btn-danger btn-sm" onClick={() => remove(s)} disabled={busy === `del-${s.index}`} autoFocus>
                      {busy === `del-${s.index}` ? <Spinner size={14} /> : 'Delete'}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
                  </span>
                ) : (
                  <button className="btn-icon" onClick={() => setConfirmDelete(s.index)} aria-label={`Delete ${languageName(s.language)} subtitle`} title="Delete">
                    <Icon name="trash" size={16} />
                  </button>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      {problem && (
        <div className="subsearch-problem" role="alert">
          <span className="subsearch-problem-icon"><Icon name={problem.icon} size={22} /></span>
          <div>
            <strong>{problem.title}</strong>
            <p>{problem.message}</p>
          </div>
        </div>
      )}

      {loading && !results ? (
        <div className="subsearch-loading"><Spinner size={32} /></div>
      ) : results && results.length === 0 && !problem ? (
        <div className="subsearch-empty">
          <Icon name="subtitles" size={30} />
          <p>No subtitles found for “{languages}”. Try another language.</p>
        </div>
      ) : results && results.length > 0 ? (
        <ul className={`subsearch-results ${loading ? 'is-loading' : ''}`} aria-busy={loading}>
          {results.map((s) => {
            const isDone = done.has(s.fileId);
            return (
              <li key={s.fileId} className="subsearch-row">
                <span className="subsearch-lang-tag" title={languageName(s.language)}>{s.language.toUpperCase()}</span>
                <div className="subsearch-info">
                  <div className="subsearch-release" title={s.release ?? undefined}>{s.release || <span className="muted">Untitled release</span>}</div>
                  <div className="subsearch-meta">
                    <span className="muted">{languageName(s.language)}</span>
                    <span className="muted"><Icon name="download" size={12} /> {formatCount(s.downloads)}</span>
                    {s.rating != null && s.rating > 0 && <span className="muted"><Icon name="star" size={12} /> {s.rating.toFixed(1)}</span>}
                    {s.hearingImpaired && <Badge tone="accent">SDH</Badge>}
                    {s.forced && <Badge tone="warning">Forced</Badge>}
                    {s.aiTranslated && <Badge tone="muted">AI translated</Badge>}
                  </div>
                </div>
                <button
                  className={`btn btn-sm ${isDone ? 'btn-ghost' : ''}`}
                  onClick={() => download(s)}
                  disabled={!!busy || isDone}
                  aria-label={`Download ${languageName(s.language)} subtitle${s.release ? ` ${s.release}` : ''}`}
                >
                  {busy === s.fileId ? <Spinner size={14} /> : <Icon name={isDone ? 'check' : 'download'} size={14} />}
                  {isDone ? 'Added' : 'Download'}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </Modal>
  );
}
