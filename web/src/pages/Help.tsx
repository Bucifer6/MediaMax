import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { HelpArticle, HelpIndex, HelpSearchResult } from '@mediamax/shared';
import { helpApi } from '../api/help';
import { useApp } from '../state/app';
import { Icon, type IconName } from '../components/Icon';
import { BrandLogo } from '../components/BrandLogo';
import { Markdown } from '../components/Markdown';
import { EmptyState, ErrorState, Skeleton, Spinner } from '../components/ui';
import { errorMessage } from '../api/client';
import { openShortcuts } from '../components/Shortcuts';

/* One index per audience for the whole session: articles only change with the server version. */
let indexCache: { key: string; data: Promise<HelpIndex> } | null = null;
function loadIndex(key: string): Promise<HelpIndex> {
  if (!indexCache || indexCache.key !== key) {
    const data = helpApi.index();
    indexCache = { key, data };
    data.catch(() => {
      if (indexCache?.data === data) indexCache = null;
    });
  }
  return indexCache.data;
}

function useHelpIndex() {
  const { user } = useApp();
  const key = user ? `${user.id}:${user.isAdmin ? 'a' : 'u'}` : 'anon';
  const [state, setState] = useState<{ data?: HelpIndex; error?: string }>({});
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    loadIndex(key).then((data) => alive && setState({ data }), (e) => alive && setState({ error: errorMessage(e) }));
    return () => { alive = false; };
  }, [key, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

const isTv = () => typeof document !== 'undefined' && document.documentElement.classList.contains('tv');

/** /help and /help/:slug */
export default function HelpPage() {
  const { slug } = useParams();
  return slug ? <ArticleView slug={slug} /> : <HelpHome />;
}

/* --------------------------------- home --------------------------------- */

function HelpHome() {
  const { branding } = useApp();
  const idx = useHelpIndex();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [results, setResults] = useState<HelpSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isTv() && window.matchMedia('(pointer: fine)').matches) inputRef.current?.focus();
  }, []);

  // Instant search: debounced, previous request aborted, query kept in the URL.
  useEffect(() => {
    const query = q.trim();
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (query) next.set('q', query);
      else next.delete('q');
      return next;
    }, { replace: true });
    if (!query) {
      setResults(null);
      setSearching(false);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    const t = window.setTimeout(() => {
      helpApi.search(query, ctrl.signal).then(
        (r) => {
          setResults(r.results);
          setSearchError(null);
          setSearching(false);
        },
        (e) => {
          if ((e as Error).name === 'AbortError') return;
          setSearchError(errorMessage(e));
          setSearching(false);
        },
      );
    }, 120);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const product = idx.data?.product ?? branding.serverName;
  return (
    <div className="page help-page">
      <section className="help-hero">
        <h1><Icon name="help" size={30} /> Help Centre</h1>
        <p className="muted">Answers and step-by-step guides for {product}.</p>
        <form className="help-search" role="search" onSubmit={(e) => e.preventDefault()}>
          <Icon name="search" size={20} />
          <input
            ref={inputRef}
            className="input"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search help, e.g. “subtitles out of sync”"
            aria-label="Search help"
            autoComplete="off"
            enterKeyHint="search"
          />
          {searching && <Spinner size={18} />}
        </form>
        <div className="help-hero-links">
          <button type="button" className="btn btn-ghost btn-sm" onClick={openShortcuts}><Icon name="keyboard" size={16} /> Keyboard shortcuts</button>
          {branding.supportUrl && (
            <a className="btn btn-ghost btn-sm" href={branding.supportUrl} target="_blank" rel="noopener noreferrer"><Icon name="external" size={16} /> Contact your server admin</a>
          )}
        </div>
      </section>

      {q.trim() ? (
        <section className="help-results" aria-live="polite" aria-label="Search results">
          {searchError ? <ErrorState message={searchError} /> : results === null ? <Skeleton h={180} /> : results.length === 0 ? (
            <EmptyState icon="search" title="No articles found" message={<>Try other words, or browse the topics below. {branding.supportUrl ? 'You can also contact your server admin.' : ''}</>} />
          ) : (
            <>
              <p className="muted small">{results.length} result{results.length === 1 ? '' : 's'}</p>
              <ul className="help-result-list">
                {results.map((r) => (
                  <li key={r.slug}>
                    <Link to={`/help/${r.slug}`} className="help-result" data-nav>
                      <span className="help-result-title">{r.title}{r.audience === 'admin' && <span className="help-tag">Admin</span>}</span>
                      <span className="help-result-meta">{r.sectionTitle}</span>
                      <span className="help-result-snippet">{r.snippet || r.summary}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : null}

      {idx.error ? <ErrorState message={idx.error} onRetry={idx.reload} /> : !idx.data ? (
        <div className="help-sections">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={220} r={16} />)}</div>
      ) : (
        <div className={`help-sections ${q.trim() ? 'dim' : ''}`}>
          {idx.data.sections.map((s) => <SectionCard key={s.id} section={s} />)}
        </div>
      )}
    </div>
  );
}

function SectionCard({ section }: { section: HelpIndex['sections'][number] }) {
  const [all, setAll] = useState(false);
  const LIMIT = 6;
  const list = all ? section.articles : section.articles.slice(0, LIMIT);
  return (
    <section className={`help-section-card ${section.audience === 'admin' ? 'admin' : ''}`} id={`section-${section.id}`} aria-labelledby={`help-sec-${section.id}`}>
      <header>
        <span className="help-section-icon"><Icon name={section.icon as IconName} size={22} /></span>
        <div>
          <h2 id={`help-sec-${section.id}`}>{section.title}{section.audience === 'admin' && <span className="help-tag">Admin</span>}</h2>
          <p className="muted small">{section.description}</p>
        </div>
      </header>
      <ul>
        {list.map((a) => (
          <li key={a.slug}><Link to={`/help/${a.slug}`} data-nav>{a.title}</Link></li>
        ))}
      </ul>
      {section.articles.length > LIMIT && (
        <button type="button" className="btn btn-ghost btn-sm help-more" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? 'Show fewer' : `Show all ${section.articles.length}`} <Icon name={all ? 'chevronUp' : 'chevronDown'} size={14} />
        </button>
      )}
    </section>
  );
}

/* -------------------------------- article -------------------------------- */

function ArticleView({ slug }: { slug: string }) {
  const idx = useHelpIndex();
  const loc = useLocation();
  const navigate = useNavigate();
  const [article, setArticle] = useState<HelpArticle | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  useEffect(() => {
    let alive = true;
    setArticle(null);
    setError(null);
    helpApi.article(slug).then(
      (a) => alive && setArticle(a),
      (e) => alive && setError({ status: (e as { status?: number }).status ?? 0, message: errorMessage(e) }),
    );
    return () => { alive = false; };
  }, [slug]);

  // Jump to #anchor once the article is on screen (and whenever the hash changes).
  useEffect(() => {
    if (!article) return;
    const id = decodeURIComponent(loc.hash.slice(1));
    if (!id) return;
    const t = window.setTimeout(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ block: 'start' });
      el.classList.add('help-flash');
      window.setTimeout(() => el.classList.remove('help-flash'), 1600);
      if (isTv()) el.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(t);
  }, [article, loc.hash]);

  const known = useMemo(() => (idx.data ? new Set(idx.data.sections.flatMap((s) => s.articles.map((a) => a.slug))) : null), [idx.data]);

  if (error) {
    return (
      <div className="page help-page">
        <Breadcrumbs />
        <EmptyState
          icon="help"
          title={error.status === 404 ? 'Article not found' : 'Couldn’t load this article'}
          message={error.status === 404 ? 'It may have moved, or it’s only for server admins.' : error.message}
          action={<button className="btn btn-primary" onClick={() => navigate('/help')}>Browse all help</button>}
        />
      </div>
    );
  }
  if (!article) return <div className="page help-page"><Breadcrumbs /><Skeleton h={36} w="60%" /><Skeleton h={320} style={{ marginTop: 16 }} /></div>;

  const toc = article.headings.filter((h) => h.level === 2);
  return (
    <div className="page help-page">
      <Breadcrumbs section={{ id: article.section, title: article.sectionTitle }} title={article.title} />
      <div className={`help-article-layout ${toc.length > 2 ? 'has-toc' : ''}`}>
        <article className="help-article" aria-labelledby="help-title">
          <h1 id="help-title">{article.title}{article.audience === 'admin' && <span className="help-tag">Admin</span>}</h1>
          {article.summary && <p className="help-summary">{article.summary}</p>}
          <Markdown source={article.markdown} knownSlugs={known} />
          {article.related.length > 0 && (
            <nav className="help-related" aria-label="Related articles">
              <h2>Related articles</h2>
              <ul>
                {article.related.map((r) => (
                  <li key={r.slug}>
                    <Link to={`/help/${r.slug}`} className="help-related-card" data-nav>
                      <strong>{r.title}</strong>
                      <span className="muted small">{r.summary}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          <p className="help-foot muted small">
            <Link to="/help" data-nav><Icon name="arrowLeft" size={14} /> All help topics</Link>
          </p>
        </article>
        {toc.length > 2 && (
          <aside className="help-toc" aria-label="On this page">
            <strong>On this page</strong>
            <ul>{toc.map((h) => <li key={h.id}><a href={`#${h.id}`}>{h.text}</a></li>)}</ul>
          </aside>
        )}
      </div>
    </div>
  );
}

function Breadcrumbs({ section, title }: { section?: { id: string; title: string }; title?: string }) {
  return (
    <nav className="help-crumbs" aria-label="Breadcrumb">
      <ol>
        <li><Link to="/help" data-nav>Help</Link></li>
        {section && <li><Link to={`/help#section-${section.id}`} data-nav>{section.title}</Link></li>}
        {title && <li aria-current="page">{title}</li>}
      </ol>
    </nav>
  );
}

/* ----------------------- signed-out shell for /help ----------------------- */

/** /help without an account (login screen, phone and TV apps open it in a browser): logo, sign-in link, the page. */
export function PublicHelpShell() {
  const loc = useLocation();
  return (
    <div className="help-public">
      <header className="help-public-bar">
        <Link to="/help" className="help-public-brand" aria-label="Help home"><BrandLogo height={26} /></Link>
        <Link to={`/login?next=${encodeURIComponent(loc.pathname + loc.hash)}`} className="btn btn-sm">Sign in</Link>
      </header>
      <main id="main"><Outlet /></main>
    </div>
  );
}
