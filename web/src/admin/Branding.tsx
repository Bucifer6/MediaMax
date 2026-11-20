import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Branding, BrandingAssetKind, FeatureFlags, HomeRowConfig, HomeRowType, Item, StarterLook, Theme, ThemeColors } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Badge, Field, Img, Spinner, Switch, Tabs, useConfirm } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { BrandMark } from '../components/BrandLogo';
import { COLOR_KEYS, loadFont, themeStyle } from '../theme/applyTheme';
import { DEFAULT_THEME } from '../theme/defaults';
import { AdminHeader } from './AdminRoutes';

type Tab = 'looks' | 'theme' | 'assets' | 'text' | 'rows' | 'features' | 'css';

const COLOR_LABELS: Record<keyof ThemeColors, string> = {
  primary: 'Primary', primaryText: 'Text on primary', background: 'Background', surface: 'Surface', surfaceAlt: 'Surface (alt)',
  text: 'Text', textMuted: 'Muted text', accent: 'Accent', border: 'Border', success: 'Success', warning: 'Warning', danger: 'Danger', overlay: 'Hero overlay',
};

const FONTS: { label: string; family: string; url: string | null }[] = [
  { label: 'Inter', family: "'Inter', system-ui, sans-serif", url: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap' },
  { label: 'Poppins', family: "'Poppins', system-ui, sans-serif", url: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap' },
  { label: 'Montserrat', family: "'Montserrat', system-ui, sans-serif", url: 'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap' },
  { label: 'Outfit', family: "'Outfit', system-ui, sans-serif", url: 'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap' },
  { label: 'DM Sans', family: "'DM Sans', system-ui, sans-serif", url: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap' },
  { label: 'Manrope', family: "'Manrope', system-ui, sans-serif", url: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap' },
  { label: 'Plus Jakarta Sans', family: "'Plus Jakarta Sans', system-ui, sans-serif", url: 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap' },
  { label: 'Space Grotesk', family: "'Space Grotesk', system-ui, sans-serif", url: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap' },
  { label: 'Nunito', family: "'Nunito', system-ui, sans-serif", url: 'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap' },
  { label: 'Roboto', family: "'Roboto', system-ui, sans-serif", url: 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;900&display=swap' },
  { label: 'Lato', family: "'Lato', system-ui, sans-serif", url: 'https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900&display=swap' },
  { label: 'Playfair Display', family: "'Playfair Display', Georgia, serif", url: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700;800&display=swap' },
  { label: 'System UI', family: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", url: null },
];

const ROW_TYPES: { value: HomeRowType; label: string; hint: string }[] = [
  { value: 'hero', label: 'Hero spotlight', hint: 'Big featured carousel at the top' },
  { value: 'continue', label: 'Continue watching', hint: 'In-progress items' },
  { value: 'nextup', label: 'Next up', hint: 'Next episode of shows in progress' },
  { value: 'recent', label: 'Recently added', hint: 'Across all libraries' },
  { value: 'library-recent', label: 'Recently added in library', hint: 'Pick a library' },
  { value: 'favorites', label: 'Favourites', hint: "The viewer's favourites" },
  { value: 'genre', label: 'Genre', hint: 'Pick a genre' },
  { value: 'collection', label: 'Collection', hint: 'Pick a collection' },
  { value: 'playlist', label: 'Playlist', hint: 'Pick a playlist' },
  { value: 'live-now', label: 'Live now', hint: 'Channels with current programme' },
  { value: 'favorite-channels', label: 'Favourite channels', hint: 'Viewer favourites' },
  { value: 'recordings', label: 'Recordings', hint: 'Latest DVR recordings' },
];

const FEATURE_LABELS: { key: keyof FeatureFlags; label: string; hint: string; icon: IconName }[] = [
  { key: 'liveTv', label: 'Live TV', hint: 'Channels, guide and live playback', icon: 'tv' },
  { key: 'dvr', label: 'DVR', hint: 'Recording and series rules', icon: 'recordOutline' },
  { key: 'iptvVod', label: 'IPTV VOD & series', hint: 'Show Xtream movie & series libraries', icon: 'zap' },
  { key: 'music', label: 'Music', hint: 'Music libraries and the mini player', icon: 'music' },
  { key: 'photos', label: 'Photos', hint: 'Photo libraries', icon: 'image' },
  { key: 'downloads', label: 'Downloads', hint: 'Allow downloading originals', icon: 'download' },
  { key: 'syncPlay', label: 'Watch together', hint: 'SyncPlay rooms in the player', icon: 'together' },
  { key: 'profilePicker', label: 'Profile picker', hint: '“Who’s watching?” on the login screen', icon: 'users' },
  { key: 'linkCodes', label: 'Link codes', hint: 'Sign in TVs with a short code', icon: 'link' },
  { key: 'requests', label: 'Requests', hint: 'Discover tab: ask for new movies and shows (Radarr/Sonarr)', icon: 'compass' },
];

const ASSETS: { kind: BrandingAssetKind; label: string; field: keyof Branding | 'splashLogo'; hint: string; wide?: boolean }[] = [
  { kind: 'logo', label: 'Logo', field: 'logoUrl', hint: 'Square or compact mark. PNG/SVG with transparency.' },
  { kind: 'logoWide', label: 'Wide logo', field: 'logoWideUrl', hint: 'Horizontal wordmark for headers and TV top bars.', wide: true },
  { kind: 'favicon', label: 'Favicon', field: 'faviconUrl', hint: 'Browser tab icon. 64×64 PNG/SVG/ICO.' },
  { kind: 'appIcon', label: 'App icon', field: 'appIconUrl', hint: 'Home-screen icon for phones & TVs. 1024×1024.' },
  { kind: 'loginBackground', label: 'Login background', field: 'loginBackgroundUrl', hint: 'Full-bleed image behind the sign-in screen.', wide: true },
  { kind: 'splashLogo', label: 'Splash logo', field: 'splashLogo', hint: 'Shown on the loading splash screen of apps.' },
  { kind: 'tvBanner', label: 'Android TV banner', field: 'tvBannerUrl', hint: 'Launcher banner on Android TV / Google TV home. 320×180 PNG.', wide: true },
  { kind: 'topShelf', label: 'Apple TV top shelf', field: 'topShelfUrl', hint: 'Top shelf artwork on the Apple TV home screen. 1920×720 (or 2320×720 wide).', wide: true },
];

/* ---------------- colour helpers ---------------- */
function toHex(c: string): string | null {
  const s = c.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return ('#' + s.slice(1).split('').map((x) => x + x).join('')).toLowerCase();
  if (/^#[0-9a-f]{8}$/i.test(s)) return s.slice(0, 7).toLowerCase();
  return null;
}
function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
function contrast(a: string, b: string): number | null {
  const ha = toHex(a);
  const hb = toHex(b);
  if (!ha || !hb) return null;
  const la = luminance(ha);
  const lb = luminance(hb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function ContrastBadge({ fg, bg, label }: { fg: string; bg: string; label: string }) {
  const r = contrast(fg, bg);
  if (r == null) return null;
  const tone = r >= 4.5 ? 'success' : r >= 3 ? 'warning' : 'danger';
  return <Badge tone={tone}>{label} {r.toFixed(1)}:1 {r >= 4.5 ? 'AA' : r >= 3 ? 'AA large' : 'Fail'}</Badge>;
}
const rid = () => Math.random().toString(36).slice(2, 10);

/* ---------------- preview ---------------- */
function BrandPreview({ draft, theme, sample }: { draft: Branding; theme: Theme; sample: Item[] }) {
  useEffect(() => loadFont(theme.fontUrl), [theme.fontUrl]);
  const logo = draft.logoWideUrl ?? draft.logoUrl;
  const hero = sample.find((s) => s.backdropUrl);
  const cards = sample.filter((s) => s.posterUrl).slice(0, 6);
  const rows = draft.homeRows.filter((r) => r.enabled && r.type !== 'hero').slice(0, 3);
  return (
    <div className="bp" style={themeStyle(theme)} data-mode={theme.mode} data-poster-shape={theme.posterShape}>
      <div className="bp-top">
        {logo ? <Img src={logo} className="bp-logo" /> : <span className="bp-brand"><BrandMark size={18} /> {draft.serverName}</span>}
        <span className="bp-nav"><i>Home</i><i>Movies</i><i>Live TV</i></span>
        <span className="bp-avatar" />
      </div>
      {theme.heroStyle !== 'none' && draft.homeRows.some((r) => r.enabled && r.type === 'hero') && (
        <div className="bp-hero">
          {hero && <Img src={hero.backdropUrl} width={800} className="bp-hero-img" />}
          <div className="bp-hero-shade" />
          <div className="bp-hero-text">
            <strong>{hero?.title ?? 'Featured title'}</strong>
            <span>{hero?.year ?? '2026'} · Drama · 2h 4m</span>
            <span className="bp-actions"><span className="bp-btn">▶ Play</span><span className="bp-btn bp-btn-glass">More info</span></span>
          </div>
          {theme.heroStyle === 'carousel' && <span className="bp-dots"><i className="on" /><i /><i /></span>}
        </div>
      )}
      {(rows.length ? rows : [{ id: 'x', type: 'recent', enabled: true } as HomeRowConfig]).map((r, ri) => (
        <div className="bp-row" key={r.id}>
          <span className="bp-row-title">{r.title || ROW_TYPES.find((t) => t.value === r.type)?.label}</span>
          <div className={`bp-cards bp-${theme.cardSize} ${r.type === 'continue' || r.type === 'live-now' ? 'bp-wide' : ''}`}>
            {Array.from({ length: 6 }).map((_, i) => {
              const s = cards[(i + ri * 2) % Math.max(1, cards.length)];
              return (
                <span key={i} className="bp-card">
                  {s && r.type !== 'continue' && r.type !== 'live-now' ? <Img src={s.posterUrl} width={160} /> : <span className="bp-card-fill" style={{ ['--h' as string]: `${(i * 47 + ri * 90) % 360}` }} />}
                  {r.type === 'continue' && <span className="bp-prog"><i style={{ width: `${30 + i * 10}%` }} /></span>}
                </span>
              );
            })}
          </div>
        </div>
      ))}
      <div className="bp-foot">
        <span className="bp-chip">Tag</span>
        <span className="bp-badge-s">Success</span>
        <span className="bp-badge-w">Warning</span>
        <span className="bp-badge-d">Danger</span>
        <span className="bp-muted">{draft.footerText || 'Footer text'}</span>
      </div>
    </div>
  );
}

function LoginPreview({ draft, theme }: { draft: Branding; theme: Theme }) {
  return (
    <div className="bp bp-login" style={themeStyle(theme)} data-mode={theme.mode}>
      {draft.loginBackgroundUrl ? <Img src={draft.loginBackgroundUrl} width={800} className="bp-login-bg" /> : <div className="login-aurora" />}
      <div className="bp-login-card">
        {draft.logoUrl ? <Img src={draft.logoUrl} className="bp-login-logo" /> : <BrandMark size={34} />}
        <strong>{draft.serverName}</strong>
        <small>{draft.tagline}</small>
        {draft.loginMessage && <p>{draft.loginMessage}</p>}
        <span className="bp-input" />
        <span className="bp-input" />
        <span className="bp-btn bp-btn-block">Sign in</span>
      </div>
    </div>
  );
}

/* ---------------- theme editor ---------------- */
function ColorField({ k, value, onChange }: { k: keyof ThemeColors; value: string; onChange: (v: string) => void }) {
  const hex = toHex(value);
  return (
    <label className="color-field">
      <span className="color-swatch" style={{ background: value }}>
        <input type="color" value={hex ?? '#000000'} onChange={(e) => onChange(e.target.value)} aria-label={COLOR_LABELS[k]} />
      </span>
      <span className="color-meta">
        <span className="color-name">{COLOR_LABELS[k]}</span>
        <input className="input input-sm mono" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      </span>
    </label>
  );
}

function ThemeEditor({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  const set = <K extends keyof Theme>(k: K, v: Theme[K]) => onChange({ ...theme, [k]: v });
  const setColor = (k: keyof ThemeColors, v: string) => onChange({ ...theme, colors: { ...theme.colors, [k]: v } });
  const fontPreset = FONTS.find((f) => f.family === theme.fontFamily);
  const autoText = () => {
    const hex = toHex(theme.colors.primary);
    if (!hex) return;
    setColor('primaryText', luminance(hex) > 0.4 ? '#111111' : '#ffffff');
  };
  return (
    <div className="theme-editor">
      <div className="form-row">
        <Field label="Theme name"><input className="input" value={theme.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Mode">
          <div className="segmented">
            <button className={theme.mode === 'dark' ? 'active' : ''} onClick={() => set('mode', 'dark')}>Dark</button>
            <button className={theme.mode === 'light' ? 'active' : ''} onClick={() => set('mode', 'light')}>Light</button>
          </div>
        </Field>
      </div>
      <div className="contrast-row">
        <ContrastBadge fg={theme.colors.text} bg={theme.colors.background} label="Text" />
        <ContrastBadge fg={theme.colors.textMuted} bg={theme.colors.background} label="Muted" />
        <ContrastBadge fg={theme.colors.primaryText} bg={theme.colors.primary} label="Button" />
        <button className="btn btn-ghost btn-sm" onClick={autoText}><Icon name="sparkles" size={14} /> Auto button text</button>
      </div>
      <div className="color-grid">
        {COLOR_KEYS.map((k) => <ColorField key={k} k={k} value={theme.colors[k] ?? DEFAULT_THEME.colors[k]} onChange={(v) => setColor(k, v)} />)}
      </div>
      <Field label={`Corner radius · ${theme.radius}px`}>
        <input type="range" className="range" min={0} max={28} value={theme.radius} onChange={(e) => set('radius', Number(e.target.value))} />
      </Field>
      <div className="form-row">
        <Field label="Font">
          <select className="select" value={fontPreset?.label ?? 'custom'} onChange={(e) => {
            const f = FONTS.find((x) => x.label === e.target.value);
            if (f) onChange({ ...theme, fontFamily: f.family, fontUrl: f.url });
          }}>
            {FONTS.map((f) => <option key={f.label} value={f.label}>{f.label}</option>)}
            <option value="custom">Custom…</option>
          </select>
        </Field>
        <Field label="CSS font-family"><input className="input mono" value={theme.fontFamily} onChange={(e) => set('fontFamily', e.target.value)} /></Field>
      </div>
      <Field label="Font stylesheet URL" hint="Any Google Fonts (or self-hosted) CSS URL.">
        <input className="input mono" value={theme.fontUrl ?? ''} onChange={(e) => set('fontUrl', e.target.value || null)} placeholder="https://fonts.googleapis.com/css2?family=…" />
      </Field>
      <div className="form-row form-row-3">
        <Field label="Poster shape">
          <div className="segmented">
            {(['rounded', 'square', 'pill'] as const).map((s) => <button key={s} className={theme.posterShape === s ? 'active' : ''} onClick={() => set('posterShape', s)}>{s}</button>)}
          </div>
        </Field>
        <Field label="Card size">
          <div className="segmented">
            {(['small', 'medium', 'large'] as const).map((s) => <button key={s} className={theme.cardSize === s ? 'active' : ''} onClick={() => set('cardSize', s)}>{s}</button>)}
          </div>
        </Field>
        <Field label="Hero style">
          <div className="segmented">
            {(['carousel', 'static', 'none'] as const).map((s) => <button key={s} className={theme.heroStyle === s ? 'active' : ''} onClick={() => set('heroStyle', s)}>{s}</button>)}
          </div>
        </Field>
      </div>
    </div>
  );
}

/* ---------------- home row builder ---------------- */
function RowBuilder({ rows, onChange }: { rows: HomeRowConfig[]; onChange: (r: HomeRowConfig[]) => void }) {
  const { libraries } = useApp();
  const collections = useAsync(() => api.collections.list().catch(() => [] as Item[]), []);
  const playlists = useAsync(() => api.playlists.list().catch(() => [] as Item[]), []);
  const genres = useAsync(() => api.items.genres().catch(() => [] as string[]), []);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const update = (i: number, patch: Partial<HomeRowConfig>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= rows.length) return;
    const next = [...rows];
    const [r] = next.splice(from, 1);
    next.splice(to, 0, r!);
    onChange(next);
  };

  return (
    <div className="row-builder">
      <p className="muted">Drag to reorder. Every client — web, phones and TVs — renders the home screen from this list.</p>
      <ul className="rb-list">
        {rows.map((r, i) => (
          <li
            key={r.id}
            className={`rb-item ${r.enabled ? '' : 'dim'} ${dragIdx === i ? 'dragging' : ''} ${overIdx === i && dragIdx !== i ? 'over' : ''}`}
            draggable
            onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { e.preventDefault(); setOverIdx(i); }}
            onDrop={(e) => { e.preventDefault(); if (dragIdx != null) move(dragIdx, i); setDragIdx(null); setOverIdx(null); }}
            onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
          >
            <span className="rb-handle" title="Drag to reorder"><Icon name="drag" size={18} /></span>
            <div className="rb-fields">
              <div className="rb-line">
                <select className="select" value={r.type} onChange={(e) => update(i, { type: e.target.value as HomeRowType })} aria-label="Row type">
                  {ROW_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <input className="input" value={r.title ?? ''} onChange={(e) => update(i, { title: e.target.value })} placeholder={ROW_TYPES.find((t) => t.value === r.type)?.label} aria-label="Title" />
                <input className="input input-num" type="number" min={1} max={100} value={r.limit ?? ''} onChange={(e) => update(i, { limit: e.target.value ? Number(e.target.value) : undefined })} placeholder="Limit" aria-label="Limit" />
              </div>
              {r.type === 'library-recent' && (
                <select className="select" value={r.libraryId ?? ''} onChange={(e) => update(i, { libraryId: e.target.value || undefined })}>
                  <option value="">Choose a library…</option>
                  {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              )}
              {r.type === 'genre' && (
                <>
                  <input className="input" list={`genres-${r.id}`} value={r.genre ?? ''} onChange={(e) => update(i, { genre: e.target.value || undefined })} placeholder="Genre, e.g. Comedy" />
                  <datalist id={`genres-${r.id}`}>{(genres.data ?? []).map((g) => <option key={g} value={g} />)}</datalist>
                  <select className="select" value={r.libraryId ?? ''} onChange={(e) => update(i, { libraryId: e.target.value || undefined })}>
                    <option value="">Any library</option>
                    {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </>
              )}
              {(r.type === 'collection' || r.type === 'playlist') && (
                <select className="select" value={r.itemId ?? ''} onChange={(e) => update(i, { itemId: e.target.value || undefined })}>
                  <option value="">Choose a {r.type}…</option>
                  {((r.type === 'collection' ? collections.data : playlists.data) ?? []).map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </select>
              )}
              <small className="muted">{ROW_TYPES.find((t) => t.value === r.type)?.hint}</small>
            </div>
            <div className="rb-actions">
              <input type="checkbox" className="switch" checked={r.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} aria-label="Enabled" />
              <button className="btn-icon" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label="Move up"><Icon name="chevronUp" size={16} /></button>
              <button className="btn-icon" onClick={() => move(i, i + 1)} disabled={i === rows.length - 1} aria-label="Move down"><Icon name="chevronDown" size={16} /></button>
              <button className="btn-icon" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove row"><Icon name="trash" size={16} /></button>
            </div>
          </li>
        ))}
      </ul>
      <button className="btn" onClick={() => onChange([...rows, { id: rid(), type: 'recent', enabled: true }])}><Icon name="plus" size={16} /> Add row</button>
    </div>
  );
}

/* ---------------- CSS editor ---------------- */
function CssEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const el = e.currentTarget;
    const s = el.selectionStart;
    const end = el.selectionEnd;
    const next = value.slice(0, s) + '  ' + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = s + 2;
    });
  };
  const lines = value.split('\n').length;
  return (
    <div className="css-editor">
      <p className="muted">Injected into every web client after the theme. Use the theme variables (e.g. <code>var(--c-primary)</code>, <code>var(--radius)</code>) so your CSS follows theme changes.</p>
      <div className="code-wrap">
        <div className="code-gutter" aria-hidden>{Array.from({ length: Math.max(lines, 12) }).map((_, i) => <span key={i}>{i + 1}</span>)}</div>
        <textarea ref={ref} className="code-area" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} spellCheck={false} placeholder={'/* Example */\n.hero-title { letter-spacing: -0.04em; }\n.card:hover .card-art { transform: scale(1.06); }'} />
      </div>
      <details className="css-snippets">
        <summary>Useful selectors</summary>
        <code>.sidebar .topbar .hero .hero-title .row-title .card .card-art .detail .player .login .login-card .miniplayer</code>
      </details>
    </div>
  );
}

/* ---------------- studio ---------------- */
export function BrandingStudio() {
  const app = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Branding>(app.branding);
  const [themeId, setThemeId] = useState(app.branding.defaultThemeId);
  const [tab, setTab] = useState<Tab>('theme');
  const [dirty, setDirty] = useState(false);
  const [dirtyThemes, setDirtyThemes] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [livePreview, setLivePreview] = useState(false);
  const [previewKind, setPreviewKind] = useState<'home' | 'login'>('home');
  const [uploading, setUploading] = useState<BrandingAssetKind | null>(null);
  const sample = useAsync(() => api.items.home().then((h) => h.rows.flatMap((r) => r.items)).catch(() => [] as Item[]), []);

  // Load the freshest branding on mount.
  useEffect(() => {
    api.branding.get().then((b) => { setDraft(b); app.setBranding(b); }).catch(() => {});
    return () => {
      app.setPreviewTheme(null);
      app.setPreviewCss(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Follow remote changes when we have nothing unsaved.
  useEffect(() => {
    if (!dirty && dirtyThemes.size === 0) setDraft(app.branding);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.branding.revision]);

  const theme = useMemo(() => draft.themes.find((t) => t.id === themeId) ?? draft.themes[0] ?? DEFAULT_THEME, [draft.themes, themeId]);

  useEffect(() => {
    if (livePreview) {
      app.setPreviewTheme(theme);
      app.setPreviewCss(draft.customCss);
    } else {
      app.setPreviewTheme(null);
      app.setPreviewCss(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePreview, theme, draft.customCss]);

  const patch = (p: Partial<Branding>) => {
    setDraft((d) => ({ ...d, ...p }));
    setDirty(true);
  };
  const editTheme = (t: Theme) => {
    setDraft((d) => ({ ...d, themes: d.themes.map((x) => (x.id === t.id ? t : x)) }));
    setDirtyThemes((s) => new Set(s).add(t.id));
  };
  /** Merge server branding while keeping unsaved edits. */
  const mergeServer = (b: Branding, keepDraft = true) => {
    app.setBranding(b);
    setDraft((d) => {
      if (!keepDraft) return b;
      const themes = b.themes.map((t) => (dirtyThemes.has(t.id) ? d.themes.find((x) => x.id === t.id) ?? t : t));
      return dirty ? { ...d, themes, logoUrl: b.logoUrl, logoWideUrl: b.logoWideUrl, faviconUrl: b.faviconUrl, appIconUrl: b.appIconUrl, loginBackgroundUrl: b.loginBackgroundUrl, tvBannerUrl: b.tvBannerUrl, topShelfUrl: b.topShelfUrl, splash: { ...d.splash, logoUrl: b.splash.logoUrl }, revision: b.revision } : { ...b, themes };
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      let latest: Branding | null = null;
      for (const id of dirtyThemes) {
        const t = draft.themes.find((x) => x.id === id);
        if (t) latest = await api.branding.updateTheme(t);
      }
      if (dirty) {
        latest = await api.branding.update({
          serverName: draft.serverName,
          tagline: draft.tagline,
          loginMessage: draft.loginMessage,
          footerText: draft.footerText,
          supportUrl: draft.supportUrl || null,
          splash: draft.splash,
          defaultThemeId: draft.defaultThemeId,
          allowUserThemes: draft.allowUserThemes,
          homeRows: draft.homeRows,
          features: draft.features,
          customCss: draft.customCss,
        });
      }
      if (latest) {
        app.setBranding(latest);
        setDraft(latest);
      }
      setDirty(false);
      setDirtyThemes(new Set());
      setLivePreview(false);
      toast.success('Branding published to every client');
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    setDraft(app.branding);
    setDirty(false);
    setDirtyThemes(new Set());
  };

  const newTheme = async (base: Theme, name: string) => {
    try {
      const { id: _id, builtIn: _b, ...rest } = base;
      const before = new Set(draft.themes.map((t) => t.id));
      const b = await api.branding.createTheme({ ...rest, name });
      mergeServer(b);
      const created = b.themes.find((t) => !before.has(t.id));
      if (created) setThemeId(created.id);
      toast.success(`Created theme "${name}"`);
    } catch (e) {
      toast.error(e);
    }
  };
  const deleteTheme = async (t: Theme) => {
    if (!(await confirm({ title: `Delete theme "${t.name}"?`, message: 'Users who picked it fall back to the default theme.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      const b = await api.branding.deleteTheme(t.id);
      setDirtyThemes((s) => {
        const n = new Set(s);
        n.delete(t.id);
        return n;
      });
      mergeServer(b);
      setThemeId(b.defaultThemeId);
    } catch (e) {
      toast.error(e);
    }
  };

  const uploadAsset = async (kind: BrandingAssetKind, file: File) => {
    setUploading(kind);
    try {
      mergeServer(await api.branding.uploadAsset(kind, file));
      toast.success('Uploaded');
    } catch (e) {
      toast.error(e);
    } finally {
      setUploading(null);
    }
  };
  const removeAsset = async (kind: BrandingAssetKind) => {
    try {
      mergeServer(await api.branding.deleteAsset(kind));
    } catch (e) {
      toast.error(e);
    }
  };
  const assetUrl = (a: (typeof ASSETS)[number]) => (a.field === 'splashLogo' ? draft.splash.logoUrl : (draft[a.field as keyof Branding] as string | null));

  const unsaved = dirty || dirtyThemes.size > 0;

  return (
    <div className="studio">
      <AdminHeader
        title="Branding studio"
        subtitle="Everything here is served to every MediaMax client — web, iOS, Android and TV — and updates live."
        actions={
          <>
            <label className="check-inline"><input type="checkbox" checked={livePreview} onChange={(e) => setLivePreview(e.target.checked)} /> Preview on whole app</label>
            {unsaved && <button className="btn btn-ghost" onClick={discard}>Discard</button>}
            <button className="btn btn-primary" onClick={save} disabled={!unsaved || saving}>{saving ? <Spinner size={18} /> : <><Icon name="upload" size={16} /> Publish</>}</button>
          </>
        }
      />
      {unsaved && <div className="unsaved-bar"><Icon name="info" size={16} /> You have unpublished changes.</div>}
      <div className="studio-layout">
        <div className="studio-editor">
          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            className="studio-tabs"
            tabs={[
              { value: 'looks', label: <><Icon name="sparkles" size={16} /> Starter looks</> },
              { value: 'theme', label: <><Icon name="palette" size={16} /> Theme</> },
              { value: 'assets', label: <><Icon name="image" size={16} /> Assets</> },
              { value: 'text', label: <><Icon name="type" size={16} /> Text</> },
              { value: 'rows', label: <><Icon name="rows" size={16} /> Home rows</> },
              { value: 'features', label: <><Icon name="flag" size={16} /> Features</> },
              { value: 'css', label: <><Icon name="code" size={16} /> Custom CSS</> },
            ]}
          />

          {tab === 'looks' && (
            <StarterLooks
              themes={draft.themes}
              current={draft.defaultThemeId}
              onApply={async (look) => {
                if (!(await confirm({ title: `Apply “${look.name}”?`, message: 'This sets the default theme, replaces the home screen rows and turns on the features it needs. Logos, text and your own themes are kept. You can fine-tune everything afterwards.', confirmLabel: 'Apply look' }))) return;
                try {
                  const b = await api.branding.applyLook(look.id);
                  setDraft(b);
                  app.setBranding(b);
                  setThemeId(look.themeId);
                  setDirty(false);
                  setDirtyThemes(new Set());
                  toast.success(`“${look.name}” applied to every app`);
                } catch (e) {
                  toast.error(e);
                }
              }}
            />
          )}

          {tab === 'theme' && (
            <div className="studio-panel">
              <div className="preset-list">
                {draft.themes.map((t) => (
                  <div key={t.id} className={`preset ${t.id === themeId ? 'active' : ''}`}>
                    <button className="preset-main" onClick={() => setThemeId(t.id)} style={themeStyle(t)}>
                      <span className="preset-swatches">
                        <i style={{ background: t.colors.background }} />
                        <i style={{ background: t.colors.surface }} />
                        <i style={{ background: t.colors.primary }} />
                        <i style={{ background: t.colors.accent }} />
                      </span>
                      <span className="preset-name">{t.name}{dirtyThemes.has(t.id) ? ' •' : ''}</span>
                      <span className="preset-badges">
                        {t.id === draft.defaultThemeId && <Badge tone="primary">Default</Badge>}
                        {t.builtIn && <Badge tone="muted">Built-in</Badge>}
                      </span>
                    </button>
                  </div>
                ))}
                <button className="preset preset-add" onClick={() => newTheme(DEFAULT_THEME, 'New theme')}><Icon name="plus" size={18} /> New theme</button>
              </div>
              <div className="toolbar">
                <button className="btn btn-sm" onClick={() => newTheme(theme, `${theme.name} copy`)}><Icon name="copy" size={14} /> Duplicate</button>
                <button className="btn btn-sm" disabled={draft.defaultThemeId === theme.id} onClick={() => patch({ defaultThemeId: theme.id })}><Icon name="check" size={14} /> Make default</button>
                <button className="btn btn-sm btn-ghost" disabled={!!theme.builtIn} onClick={() => deleteTheme(theme)}><Icon name="trash" size={14} /> Delete</button>
                <span className="spacer" />
                <Switch checked={draft.allowUserThemes} onChange={(v) => patch({ allowUserThemes: v })} label="Let users choose a theme" />
              </div>
              {theme.builtIn && <p className="muted small">Built-in presets can be tweaked but not deleted. Duplicate one to start your own.</p>}
              <ThemeEditor theme={theme} onChange={editTheme} />
            </div>
          )}

          {tab === 'assets' && (
            <div className="studio-panel asset-grid">
              {ASSETS.map((a) => {
                const url = assetUrl(a);
                return (
                  <div key={a.kind} className={`asset-card ${a.wide ? 'wide' : ''}`}>
                    <label className="asset-drop"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void uploadAsset(a.kind, f); }}
                    >
                      {uploading === a.kind ? <Spinner /> : url ? <Img src={url} /> : <span className="asset-empty"><Icon name="upload" size={24} /> Drop or click</span>}
                      <input type="file" accept="image/*,.ico,.svg" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadAsset(a.kind, f); e.target.value = ''; }} />
                    </label>
                    <div className="asset-meta">
                      <strong>{a.label}</strong>
                      <small className="muted">{a.hint}</small>
                      {url && <button className="btn btn-ghost btn-sm" onClick={() => removeAsset(a.kind)}><Icon name="trash" size={14} /> Remove</button>}
                    </div>
                  </div>
                );
              })}
              <div className="asset-card">
                <div className="asset-meta">
                  <strong>Splash background</strong>
                  <small className="muted">Behind the splash logo while apps load.</small>
                  <label className="color-field">
                    <span className="color-swatch" style={{ background: draft.splash.backgroundColor }}>
                      <input type="color" value={toHex(draft.splash.backgroundColor) ?? '#000000'} onChange={(e) => patch({ splash: { ...draft.splash, backgroundColor: e.target.value } })} />
                    </span>
                    <input className="input input-sm mono" value={draft.splash.backgroundColor} onChange={(e) => patch({ splash: { ...draft.splash, backgroundColor: e.target.value } })} />
                  </label>
                </div>
              </div>
            </div>
          )}

          {tab === 'text' && (
            <div className="studio-panel form-grid">
              <Field label="Server name"><input className="input" value={draft.serverName} onChange={(e) => patch({ serverName: e.target.value })} /></Field>
              <Field label="Tagline"><input className="input" value={draft.tagline} onChange={(e) => patch({ tagline: e.target.value })} /></Field>
              <Field label="Login message" hint="Shown on the sign-in screen, e.g. a welcome or how to get an account."><textarea className="textarea" rows={3} value={draft.loginMessage} onChange={(e) => patch({ loginMessage: e.target.value })} /></Field>
              <Field label="Footer text"><input className="input" value={draft.footerText} onChange={(e) => patch({ footerText: e.target.value })} /></Field>
              <Field label="Support URL"><input className="input" value={draft.supportUrl ?? ''} onChange={(e) => patch({ supportUrl: e.target.value || null })} placeholder="https://…" /></Field>
            </div>
          )}

          {tab === 'rows' && <div className="studio-panel"><RowBuilder rows={draft.homeRows} onChange={(homeRows) => patch({ homeRows })} /></div>}

          {tab === 'features' && (
            <div className="studio-panel feature-grid">
              {FEATURE_LABELS.map((f) => (
                <label key={f.key} className={`feature-card ${draft.features[f.key] ? 'on' : ''}`}>
                  <span className="feature-icon"><Icon name={f.icon} size={22} /></span>
                  <span className="feature-text"><strong>{f.label}</strong><small>{f.hint}</small></span>
                  <input type="checkbox" className="switch" checked={draft.features[f.key]} onChange={(e) => patch({ features: { ...draft.features, [f.key]: e.target.checked } })} />
                </label>
              ))}
            </div>
          )}

          {tab === 'css' && <div className="studio-panel"><CssEditor value={draft.customCss} onChange={(customCss) => patch({ customCss })} /></div>}
        </div>

        <aside className="studio-preview">
          <div className="preview-head">
            <span className="muted">Live preview · {theme.name}</span>
            <div className="segmented">
              <button className={previewKind === 'home' ? 'active' : ''} onClick={() => setPreviewKind('home')}>Home</button>
              <button className={previewKind === 'login' ? 'active' : ''} onClick={() => setPreviewKind('login')}>Login</button>
            </div>
          </div>
          <div className="preview-frame">
            {previewKind === 'home' ? <BrandPreview draft={draft} theme={theme} sample={sample.data ?? []} /> : <LoginPreview draft={draft} theme={theme} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Starter looks: theme + home rows + features in one click, with a live mini preview. */
function StarterLooks({ themes, current, onApply }: { themes: Theme[]; current: string; onApply: (l: StarterLook) => void }) {
  const looks = useAsync(() => api.branding.looks(), []);
  if (looks.loading && !looks.data) return <div className="studio-panel"><Spinner /></div>;
  return (
    <div className="studio-panel">
      <p className="muted">Pick a starting point for the whole server — every app (web, phones, TVs) updates live. You can change anything afterwards.</p>
      <div className="look-grid">
        {(looks.data ?? []).map((l) => {
          const t = themes.find((x) => x.id === l.themeId);
          if (!t) return null;
          const c = t.colors;
          const posterR = t.posterShape === 'pill' ? 999 : t.posterShape === 'square' ? 2 : Math.min(t.radius, 12);
          const rows = l.homeRows.filter((r) => r.enabled && r.type !== 'hero');
          return (
            <div key={l.id} className={`look-card ${current === l.themeId ? 'current' : ''}`}>
              <div className="look-preview" style={{ background: c.background, color: c.text, fontFamily: t.fontFamily }} aria-hidden="true">
                {l.homeRows.some((r) => r.type === 'hero' && r.enabled) && t.heroStyle !== 'none' && (
                  <div className="look-hero" style={{ background: `linear-gradient(120deg, ${c.surfaceAlt}, ${c.primary}55)`, borderRadius: Math.min(t.radius, 14) }}>
                    <b style={{ background: c.primary, color: c.primaryText, borderRadius: Math.min(t.radius, 10) }}>Play</b>
                  </div>
                )}
                {rows.slice(0, 2).map((r) => (
                  <div key={r.id} className="look-row">
                    <small style={{ color: c.textMuted }}>{r.title || 'Recently added'}</small>
                    <div>{Array.from({ length: t.cardSize === 'large' ? 4 : t.cardSize === 'small' ? 7 : 5 }, (_, i) => <i key={i} style={{ background: i % 2 ? c.surfaceAlt : c.surface, borderRadius: posterR, borderColor: c.border }} />)}</div>
                  </div>
                ))}
              </div>
              <div className="look-info">
                <strong>{l.name}</strong>
                <span className="muted small">{l.description}</span>
                <span className="muted small">Theme: {t.name} · {rows.length} home rows</span>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => onApply(l)}>Apply</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
