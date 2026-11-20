/**
 * Help Centre: Markdown articles shipped with the server (server/help/<section>/<slug>.md, see docs/HELP.md).
 *
 * Articles are read and indexed once (at startup, or on first use) and kept in memory. `{{product}}` and
 * `{{version}}` are filled in per request from the branding, so white-labelled servers show their own name.
 * Admin-only articles are invisible to everyone else (index, search and direct links alike).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { HelpArticle, HelpArticleSummary, HelpAudience, HelpHeading, HelpIndex, HelpSearchResponse, HelpSearchResult, HelpSection, HelpWhatsNew } from '@mediamax/shared';
import { config } from '../config.js';
import { logger } from '../util/log.js';

const log = logger('help');

interface SectionDef { id: string; title: string; description: string; icon: string; audience: HelpAudience; order: number }

export interface LoadedArticle {
  slug: string;
  title: string;
  summary: string;
  section: string;
  audience: HelpAudience;
  keywords: string[];
  related: string[];
  order: number;
  /** Raw Markdown body (placeholders not yet filled in). */
  body: string;
  headings: HelpHeading[];
}

interface Loaded {
  sections: SectionDef[];
  articles: Map<string, LoadedArticle>;
  whatsNew: { version: string; title: string; body: string } | null;
  index: SearchIndex;
}

const DEFAULT_SECTIONS: SectionDef[] = [
  { id: 'getting-started', title: 'Getting started', description: 'Accounts, profiles and the apps.', icon: 'sparkles', audience: 'everyone', order: 1 },
  { id: 'watching', title: 'Watching & listening', description: 'Playback, subtitles, audio, music and live TV.', icon: 'play', audience: 'everyone', order: 2 },
  { id: 'requests', title: 'Requests & issues', description: 'Ask for new titles and report problems.', icon: 'inbox', audience: 'everyone', order: 3 },
  { id: 'tv', title: 'TV & remotes', description: 'Using a TV and its remote control.', icon: 'tv', audience: 'everyone', order: 4 },
  { id: 'admin', title: 'For admins', description: 'Setting up and running the server.', icon: 'shield', audience: 'admin', order: 5 },
  { id: 'troubleshooting', title: 'Troubleshooting', description: 'When something doesn’t work as expected.', icon: 'alert', audience: 'everyone', order: 6 },
];

/* ------------------------------- parsing ------------------------------- */

/** Minimal front-matter: `key: value` lines between `---` fences. Lists are comma-separated. */
export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: src.slice(m[0].length) };
}

const list = (v: string | undefined) => (v ?? '').replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean);

/** Heading id: explicit `{#anchor}` or a slug of the text. Shared with the web renderer (same rules). */
export function headingId(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/<[^>]+>/g, '').replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export function extractHeadings(body: string): HelpHeading[] {
  const out: HelpHeading[] = [];
  let fence = false;
  for (const line of body.split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    if (fence) continue;
    const m = line.match(/^(##|###)\s+(.+?)\s*(?:\{#([\w-]+)\})?\s*$/);
    if (m) out.push({ level: m[1].length as 2 | 3, text: m[2].replace(/[`*]/g, ''), id: m[3] ?? headingId(m[2]) });
  }
  return out;
}

/** Plain text of a Markdown body (for search and snippets). */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\{#[\w-]+\}/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?kbd>/g, '')
    .replace(/^\s*[|:\- ]+\s*$/gm, ' ')
    .replace(/[#>*_`|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------- search ------------------------------- */

const STOP = new Set('a an and are as at be by can do does for from how i if in into is it its me my no not of on or so that the their them then there this to up was what when where which who why will with you your'.split(' '));

export function tokenize(text: string): string[] {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t));
}

/** Damerau-Levenshtein distance, capped (returns max+1 as soon as it is exceeded). */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

const FIELD_WEIGHT = { title: 10, keywords: 7, summary: 4, headings: 3, body: 1 } as const;

interface SearchDoc { slug: string; weights: Map<string, number>; text: string; titleLower: string }

export interface SearchIndex { docs: SearchDoc[]; vocab: string[] }

/** `product` fills {{product}} in the indexed text; empty by default so the name itself never decides a ranking. */
export function buildIndex(articles: Iterable<LoadedArticle>, product = ''): SearchIndex {
  const docs: SearchDoc[] = [];
  const vocab = new Set<string>();
  for (const a of articles) {
    const weights = new Map<string, number>();
    const add = (text: string, w: number) => {
      // Body terms count with diminishing returns, so long articles don't win by size alone.
      const seen = new Map<string, number>();
      for (const t of tokenize(fill(text, product, ''))) seen.set(t, (seen.get(t) ?? 0) + 1);
      for (const [t, n] of seen) {
        weights.set(t, (weights.get(t) ?? 0) + w * (1 + Math.log2(n)));
        vocab.add(t);
      }
    };
    add(a.title, FIELD_WEIGHT.title);
    add(a.keywords.join(' '), FIELD_WEIGHT.keywords);
    add(a.summary, FIELD_WEIGHT.summary);
    add(a.headings.map((h) => h.text).join(' '), FIELD_WEIGHT.headings);
    add(plainText(a.body), FIELD_WEIGHT.body);
    docs.push({ slug: a.slug, weights, text: plainText(a.body), titleLower: a.title.toLowerCase() });
  }
  return { docs, vocab: [...vocab] };
}

/** Index terms a query term matches, with a factor: exact 1, prefix 0.75, one typo 0.5 (two for long words). */
export function expandTerm(q: string, vocab: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of vocab) {
    if (t === q) out.set(t, 1);
    else if (q.length >= 2 && t.startsWith(q)) out.set(t, Math.max(out.get(t) ?? 0, 0.75 * Math.min(1, (q.length + 2) / t.length)));
    else if (q.length >= 4) {
      const max = q.length >= 8 ? 2 : 1;
      // A typo in the part typed so far also counts as a prefix match ("trancod" → "transcoding").
      const dist = Math.min(editDistance(q, t, max), t.length > q.length ? editDistance(q, t.slice(0, q.length), max) : max + 1);
      if (dist <= max) out.set(t, Math.max(out.get(t) ?? 0, dist === 1 ? 0.5 : 0.3));
    }
  }
  return out;
}

export function searchIndex(index: SearchIndex, query: string, allowed: (slug: string) => boolean, limit = 20): { slug: string; score: number; terms: string[] }[] {
  const qTerms = [...new Set(tokenize(query))].slice(0, 8);
  if (!qTerms.length) return [];
  const expansions = qTerms.map((q) => expandTerm(q, index.vocab));
  const phrase = query.trim().toLowerCase();
  const scored: { slug: string; score: number; terms: string[]; matched: number }[] = [];
  for (const doc of index.docs) {
    if (!allowed(doc.slug)) continue;
    let score = 0;
    let matched = 0;
    const terms: string[] = [];
    expansions.forEach((exp) => {
      let best = 0;
      let bestTerm = '';
      for (const [t, f] of exp) {
        const w = doc.weights.get(t);
        if (w && w * f > best) {
          best = w * f;
          bestTerm = t;
        }
      }
      if (best > 0) {
        matched++;
        score += best;
        terms.push(bestTerm);
      }
    });
    if (!matched) continue;
    if (phrase.length > 2 && doc.titleLower.includes(phrase)) score *= 1.6;
    scored.push({ slug: doc.slug, score, terms, matched });
  }
  // Articles matching every term first, then the rest (so a typo in one word still finds something).
  const all = scored.filter((s) => s.matched === qTerms.length);
  const pool = all.length ? all : scored;
  pool.sort((a, b) => b.score - a.score);
  // Drop passing mentions: anything far below the best match is noise.
  const floor = (pool[0]?.score ?? 0) * 0.12;
  return pool.filter((s) => s.score >= floor).slice(0, limit).map(({ slug, score, terms }) => ({ slug, score: Math.round(score * 10) / 10, terms }));
}

/** A ~180-character excerpt of `text` around the first of `terms`. */
export function snippet(text: string, terms: string[], len = 180): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    const m = re.exec(lower);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  if (at < 0) return text.length > len ? text.slice(0, len).replace(/\s+\S*$/, '') + '…' : text;
  let start = Math.max(0, at - 60);
  if (start > 0) start = text.indexOf(' ', start) + 1 || start;
  let out = text.slice(start, start + len);
  if (start + len < text.length) out = out.replace(/\s+\S*$/, '') + '…';
  return (start > 0 ? '…' : '') + out;
}

/* ------------------------------- loading ------------------------------- */

export function fill(text: string, product: string, version: string): string {
  return text.replace(/\{\{\s*product\s*\}\}/g, product).replace(/\{\{\s*version\s*\}\}/g, version);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

export function loadHelp(dir = config.helpDir): Loaded {
  const articles = new Map<string, LoadedArticle>();
  let sections = DEFAULT_SECTIONS;
  let whatsNew: Loaded['whatsNew'] = null;
  if (!fs.existsSync(dir)) {
    log.warn(`Help articles not found at ${dir}`);
    return { sections, articles, whatsNew, index: buildIndex([]) };
  }
  try {
    const custom = JSON.parse(fs.readFileSync(path.join(dir, 'sections.json'), 'utf8')) as Partial<SectionDef>[];
    if (Array.isArray(custom) && custom.length) {
      sections = custom.filter((s) => s.id && s.title).map((s, i) => ({ id: s.id!, title: s.title!, description: s.description ?? '', icon: s.icon ?? 'info', audience: s.audience === 'admin' ? 'admin' : 'everyone', order: s.order ?? i + 1 }));
    }
  } catch {
    /* no sections.json: defaults */
  }
  for (const file of walk(dir)) {
    const slug = path.basename(file, '.md').toLowerCase();
    const { meta, body } = parseFrontMatter(fs.readFileSync(file, 'utf8'));
    if (slug === 'whats-new') {
      whatsNew = { version: meta.version ?? config.version, title: meta.title ?? 'What’s new', body };
      continue;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      log.warn(`Skipping help article with an invalid file name: ${file}`);
      continue;
    }
    if (articles.has(slug)) log.warn(`Duplicate help article "${slug}" (${file}); the later one wins`);
    const rel = path.relative(dir, path.dirname(file)).split(path.sep)[0];
    articles.set(slug, {
      slug,
      title: meta.title ?? slug,
      summary: meta.summary ?? '',
      section: meta.section ?? (rel || 'getting-started'),
      audience: meta.audience === 'admin' ? 'admin' : 'everyone',
      keywords: list(meta.keywords),
      related: list(meta.related),
      order: Number.isFinite(Number(meta.order)) ? Number(meta.order) : 100,
      body,
      headings: extractHeadings(body),
    });
  }
  return { sections: [...sections].sort((a, b) => a.order - b.order), articles, whatsNew, index: buildIndex(articles.values()) };
}

let cache: Loaded | null = null;
const loaded = () => (cache ??= loadHelp());
/** Load (or reload, for tests and the docs workflow) the articles from disk. */
export function reloadHelp(dir?: string) {
  cache = loadHelp(dir);
  return cache;
}

/* ------------------------------- queries ------------------------------- */

const visible = (a: LoadedArticle, isAdmin: boolean) => isAdmin || a.audience !== 'admin';

function summaryOf(a: LoadedArticle, product: string, version: string): HelpArticleSummary {
  return { slug: a.slug, title: fill(a.title, product, version), summary: fill(a.summary, product, version), section: a.section, audience: a.audience };
}

export function helpIndex(isAdmin: boolean, product: string, version = config.version): HelpIndex {
  const { sections, articles } = loaded();
  const bySection = new Map<string, LoadedArticle[]>();
  for (const a of articles.values()) {
    if (!visible(a, isAdmin)) continue;
    bySection.set(a.section, [...(bySection.get(a.section) ?? []), a]);
  }
  const out: HelpSection[] = [];
  for (const s of sections) {
    const list = (bySection.get(s.id) ?? []).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    if (!list.length || (s.audience === 'admin' && !isAdmin)) continue;
    out.push({ id: s.id, title: fill(s.title, product, version), description: fill(s.description, product, version), icon: s.icon, audience: s.audience, articles: list.map((a) => summaryOf(a, product, version)) });
  }
  return { product, version, sections: out };
}

const sectionTitle = (id: string) => loaded().sections.find((s) => s.id === id)?.title ?? id;

/** One article, or null when it doesn't exist or the caller may not read it (the route answers 404 either way). */
export function helpArticle(slug: string, isAdmin: boolean, product: string, version = config.version): HelpArticle | null {
  const { articles } = loaded();
  const a = articles.get(String(slug).toLowerCase());
  if (!a || !visible(a, isAdmin)) return null;
  const related = a.related.map((r) => articles.get(r)).filter((r): r is LoadedArticle => !!r && visible(r, isAdmin) && r.slug !== a.slug);
  // Fill up to three related articles from the same section.
  for (const r of [...articles.values()].filter((x) => x.section === a.section && x.slug !== a.slug && visible(x, isAdmin)).sort((x, y) => x.order - y.order)) {
    if (related.length >= 3) break;
    if (!related.includes(r)) related.push(r);
  }
  return {
    ...summaryOf(a, product, version),
    sectionTitle: fill(sectionTitle(a.section), product, version),
    keywords: a.keywords,
    markdown: fill(a.body, product, version),
    headings: a.headings.map((h) => ({ ...h, text: fill(h.text, product, version) })),
    related: related.slice(0, 6).map((r) => summaryOf(r, product, version)),
  };
}

export function helpSearch(query: string, isAdmin: boolean, product: string, version = config.version): HelpSearchResponse {
  const q = String(query ?? '').slice(0, 200);
  const { articles, index } = loaded();
  const hits = searchIndex(index, fill(q, product, version), (slug) => {
    const a = articles.get(slug);
    return !!a && visible(a, isAdmin);
  });
  const results: HelpSearchResult[] = hits.map((h) => {
    const a = articles.get(h.slug)!;
    return { ...summaryOf(a, product, version), sectionTitle: fill(sectionTitle(a.section), product, version), snippet: snippet(fill(plainText(a.body), product, version), h.terms), score: h.score };
  });
  return { query: q, results };
}

export function helpWhatsNew(product: string, version = config.version): HelpWhatsNew | null {
  const w = loaded().whatsNew;
  if (!w) return null;
  return { version: w.version, title: fill(w.title, product, version), markdown: fill(w.body, product, version) };
}

export const helpArticleCount = () => loaded().articles.size;
