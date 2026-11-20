/**
 * A small, safe Markdown parser for the Help Centre (the subset used in server/help, see docs/HELP.md).
 *
 * It produces a plain data tree that components/Markdown.tsx turns into React elements, so nothing is ever
 * injected as HTML: raw HTML in the source is shown as text, except <kbd>…</kbd>, which becomes a kbd node.
 * Links are limited to help:, in-app paths, #anchors, http(s) and mailto.
 *
 * Blocks: ## / ### / #### headings (optional {#id}), paragraphs, - / * / 1. lists (one nested level),
 * pipe tables, ``` code blocks, > quotes, ---. Inline: **bold**, *italic*, `code`, <kbd>, [text](href), \escapes.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong' | 'em'; c: Inline[] }
  | { t: 'code' | 'kbd'; v: string }
  | { t: 'link'; href: string; c: Inline[] };

export interface ListItem { c: Inline[]; children: Block[] }

export type Block =
  | { t: 'heading'; level: 2 | 3 | 4; c: Inline[]; id: string }
  | { t: 'p'; c: Inline[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'table'; head: Inline[][]; align: ('left' | 'center' | 'right' | null)[]; rows: Inline[][][] }
  | { t: 'code'; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' };

/** Same rules as the server's headingId (server/src/services/help.ts), so TOC links and anchors agree. */
export function headingId(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/<[^>]+>/g, '').replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

const SAFE_HREF = /^(help:[a-z0-9-]+(#[\w-]+)?|\/(?!\/)[^\s]*|#[\w-]+|https?:\/\/[^\s]+|mailto:[^\s]+)$/i;
export const isSafeHref = (href: string) => SAFE_HREF.test(href.trim());

/* -------------------------------- inline -------------------------------- */

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);
    if (ch === '\\' && i + 1 < src.length && /[\\`*_[\]()#<>|!-]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ t: 'code', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '<') {
      const m = rest.match(/^<kbd>([^<]{1,40})<\/kbd>/i);
      if (m) {
        flush();
        out.push({ t: 'kbd', v: decodeEntities(m[1]) });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '*' && src[i + 1] === '*') {
      const end = src.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'strong', c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === '*' && src[i + 1] !== ' ' && src[i + 1] !== '*') {
      const end = findClosing(src, i + 1, '*');
      if (end > i + 1) {
        flush();
        out.push({ t: 'em', c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const close = matchBracket(src, i);
      if (close > 0 && src[close + 1] === '(') {
        const end = src.indexOf(')', close + 2);
        if (end > 0) {
          const href = src.slice(close + 2, end).trim();
          const label = parseInline(src.slice(i + 1, close));
          flush();
          if (isSafeHref(href)) out.push({ t: 'link', href, c: label });
          else out.push(...label);
          i = end + 1;
          continue;
        }
      }
    }
    if (ch === '&') {
      const m = rest.match(/^&(lt|gt|amp|quot|#39|nbsp);/);
      if (m) {
        buf += decodeEntities(m[0]);
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

function findClosing(src: string, from: number, ch: string): number {
  for (let j = from; j < src.length; j++) {
    if (src[j] === '\\') {
      j++;
      continue;
    }
    if (src[j] === ch && src[j - 1] !== ' ' && src[j + 1] !== ch) return j;
  }
  return -1;
}

function matchBracket(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '\\') {
      j++;
      continue;
    }
    if (src[j] === '[') depth++;
    else if (src[j] === ']' && --depth === 0) return j;
  }
  return -1;
}

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/** Plain text of inline nodes (for heading ids and accessible labels). */
export function inlineText(c: Inline[]): string {
  return c.map((n) => ('v' in n ? n.v : inlineText(n.c))).join('');
}

/* -------------------------------- blocks -------------------------------- */

const LIST_RE = /^(\s*)([-*]|\d{1,3}[.)])\s+(.*)$/;
/** Table cells; `\|` is a literal pipe. (No regex lookbehind: older TV browsers can't parse it.) */
function splitRow(line: string): string[] {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '\\' && s[j + 1] === '|') {
      cur += '\\|';
      j++;
    } else if (s[j] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[j];
  }
  cells.push(cur.trim());
  return cells;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  return parseBlocks(lines);
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // Fenced code.
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push({ t: 'code', v: body.join('\n') });
      continue;
    }
    // Headings (# is reserved for the page title, so it renders as ##).
    const h = line.match(/^(#{1,4})\s+(.+?)\s*(?:\{#([\w-]+)\})?\s*$/);
    if (h) {
      const c = parseInline(h[2]);
      const level = Math.max(2, h[1].length) as 2 | 3 | 4;
      out.push({ t: 'heading', level, c, id: h[3] ?? headingId(h[2]) });
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    // Quote.
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push({ t: 'quote', c: parseBlocks(body) });
      continue;
    }
    // Table: a header row followed by a |---| separator.
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const head = splitRow(line).map(parseInline);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]).map(parseInline));
      out.push({ t: 'table', head, align, rows });
      continue;
    }
    // List.
    const lm = line.match(LIST_RE);
    if (lm && lm[1].length < 2) {
      const ordered = /\d/.test(lm[2]);
      const start = ordered ? parseInt(lm[2], 10) : 1;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_RE);
        if (m && m[1].length < 2 && /\d/.test(m[2]) === ordered) {
          const text = [m[3]];
          const sub: string[] = [];
          i++;
          // Continuation lines and indented sub-lists.
          while (i < lines.length && lines[i].trim() && !(lines[i].match(LIST_RE) && lines[i].match(LIST_RE)![1].length < 2) && !/^#{1,4}\s/.test(lines[i])) {
            if (/^\s{2,}/.test(lines[i])) sub.push(lines[i].replace(/^\s{2,4}/, ''));
            else text.push(lines[i].trim());
            i++;
          }
          const subBlocks = sub.length ? parseBlocks(sub) : [];
          // Leading plain lines in `sub` that aren't a list belong to the item text.
          const children: Block[] = [];
          for (const b of subBlocks) {
            if (b.t === 'p' && !children.length) text.push(inlineText(b.c));
            else children.push(b);
          }
          items.push({ c: parseInline(text.join(' ')), children });
          // A blank line followed by another item keeps the list going.
          if (i < lines.length && !lines[i].trim() && i + 1 < lines.length) {
            const nx = lines[i + 1].match(LIST_RE);
            if (nx && nx[1].length < 2 && /\d/.test(nx[2]) === ordered) i++;
          }
        } else break;
      }
      out.push({ t: 'list', ordered, start, items });
      continue;
    }
    // Paragraph: until a blank line or another block starts.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|>)/.test(lines[i]) && !(lines[i].match(LIST_RE) && lines[i].match(LIST_RE)![1].length < 2)) {
      if (lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) break;
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) out.push({ t: 'p', c: parseInline(para.join(' ')) });
    else i++;
  }
  return out;
}
