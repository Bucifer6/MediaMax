/**
 * The Help Centre's Markdown subset (server/help/*.md: headings, paragraphs, lists, tables, block quotes, fenced code,
 * links, bold/italic, inline code, <kbd>) parsed into blocks and inline spans for the app's Help screens.
 */

export type Span =
  | { kind: 'text'; text: string; bold?: boolean; italic?: boolean }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

export type Block =
  | { type: 'heading'; level: 2 | 3; spans: Span[]; id: string }
  | { type: 'paragraph'; spans: Span[] }
  | { type: 'item'; ordered: boolean; n: number; spans: Span[] }
  | { type: 'quote'; spans: Span[] }
  | { type: 'code'; text: string }
  | { type: 'table'; header: Span[][]; rows: Span[][][] };

/** Strips tags until none are left (one pass could leave a tag rebuilt from the pieces, e.g. `<<b>kbd>`). */
const stripTags = (s: string) => {
  let prev: string;
  do {
    prev = s;
    s = s.replace(/<[^>]*>/g, '');
  } while (s !== prev);
  return s;
};
const slug = (s: string) => stripTags(s.toLowerCase()).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Inline Markdown → spans. Unknown HTML is dropped; <kbd>X</kbd> becomes inline code. */
export function parseInline(src: string): Span[] {
  // Only real HTML tags go; placeholders such as <folder> or <version> in the articles stay as text.
  const s = src
    .replace(/<kbd>(.*?)<\/kbd>/g, '`$1`')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/?(?:b|i|em|strong|u|span|small|sup|sub|code|a)(?:\s[^>]*)?>/gi, '');
  const out: Span[] = [];
  const re = /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const text = (t: string, extra: { bold?: boolean; italic?: boolean } = {}) => {
    if (t) out.push({ kind: 'text', text: t, ...extra });
  };
  while ((m = re.exec(s))) {
    text(s.slice(last, m.index));
    const tok = m[0];
    if (m[1]) out.push({ kind: 'code', text: tok.slice(1, -1) });
    else if (m[2]) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      out.push({ kind: 'link', text: lm[1]!, href: lm[2]! });
    } else if (m[3]) text(tok.slice(2, -2), { bold: true });
    else text(tok.slice(1, -1), { italic: true });
    last = m.index + tok.length;
  }
  text(s.slice(last));
  return out;
}

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => parseInline(c.trim()));

/** Markdown → blocks. Paragraph lines are joined; a blank line ends a paragraph or list. */
export function parseHelpMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'paragraph', spans: parseInline(para.join(' ')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    if (t.startsWith('```')) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith('```'); i++) code.push(lines[i]!);
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(t);
    if (h) {
      flush();
      if (h[1]!.length === 1) continue; // the article title is shown by the screen itself
      blocks.push({ type: 'heading', level: h[1]!.length as 2 | 3, spans: parseInline(h[2]!), id: slug(h[2]!) });
      continue;
    }
    if (t.startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      flush();
      const header = cells(t);
      const rows: Span[][][] = [];
      for (i += 2; i < lines.length && lines[i]!.trim().startsWith('|'); i++) rows.push(cells(lines[i]!));
      i--;
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    const li = /^([-*+]|(\d+)[.)])\s+(.*)$/.exec(t);
    if (li) {
      flush();
      blocks.push({ type: 'item', ordered: !!li[2], n: li[2] ? Number(li[2]) : 0, spans: parseInline(li[3]!) });
      continue;
    }
    if (t.startsWith('>')) {
      flush();
      blocks.push({ type: 'quote', spans: parseInline(t.replace(/^>\s?/, '')) });
      continue;
    }
    para.push(t);
  }
  flush();
  return blocks;
}

/** A link to another help article (`/help/<slug>`, `slug`, `slug.md`), or null for anything else. */
export function helpSlugOf(href: string): string | null {
  const m = /^(?:help:|\/help\/|\.\/)?([a-z0-9][a-z0-9-]*)(?:\.md)?(?:#.*)?$/.exec(href);
  return m ? m[1]! : null;
}
