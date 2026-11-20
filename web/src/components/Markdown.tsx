import { Fragment, useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { parseMarkdown, type Block, type Inline } from '../utils/markdown';

/**
 * Renders Help Centre Markdown as React elements (no innerHTML anywhere, see utils/markdown.ts).
 * `knownSlugs`: help articles this user can open; links to others (e.g. admin-only articles) render as plain text.
 */
export function Markdown({ source, knownSlugs, className }: { source: string; knownSlugs?: Set<string> | null; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <div className={`md ${className ?? ''}`}>{renderBlocks(blocks, knownSlugs ?? null)}</div>;
}

function renderBlocks(blocks: Block[], known: Set<string> | null): ReactNode {
  return blocks.map((b, i) => {
    switch (b.t) {
      case 'heading': {
        const H = `h${b.level}` as 'h2' | 'h3' | 'h4';
        return <H key={i} id={b.id} tabIndex={-1}>{renderInline(b.c, known)}</H>;
      }
      case 'p':
        return <p key={i}>{renderInline(b.c, known)}</p>;
      case 'list': {
        const items = b.items.map((it, j) => <li key={j}>{renderInline(it.c, known)}{it.children.length > 0 && renderBlocks(it.children, known)}</li>);
        return b.ordered ? <ol key={i} start={b.start !== 1 ? b.start : undefined}>{items}</ol> : <ul key={i}>{items}</ul>;
      }
      case 'table':
        return (
          <div key={i} className="md-table" role="region" aria-label="Table" tabIndex={0}>
            <table>
              <thead><tr>{b.head.map((c, j) => <th key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>{renderInline(c, known)}</th>)}</tr></thead>
              <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k} style={b.align[k] ? { textAlign: b.align[k]! } : undefined}>{renderInline(c, known)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        );
      case 'code':
        return <pre key={i}><code>{b.v}</code></pre>;
      case 'quote':
        return <blockquote key={i}>{renderBlocks(b.c, known)}</blockquote>;
      case 'hr':
        return <hr key={i} />;
    }
    return null;
  });
}

function renderInline(nodes: Inline[], known: Set<string> | null): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return <Fragment key={i}>{n.v}</Fragment>;
      case 'strong':
        return <strong key={i}>{renderInline(n.c, known)}</strong>;
      case 'em':
        return <em key={i}>{renderInline(n.c, known)}</em>;
      case 'code':
        return <code key={i}>{n.v}</code>;
      case 'kbd':
        return <kbd key={i}>{n.v}</kbd>;
      case 'link': {
        const label = renderInline(n.c, known);
        if (n.href.startsWith('help:')) {
          const [slug, anchor] = n.href.slice(5).split('#');
          if (known && !known.has(slug)) return <Fragment key={i}>{label}</Fragment>;
          return <Link key={i} to={`/help/${slug}${anchor ? `#${anchor}` : ''}`}>{label}</Link>;
        }
        if (n.href.startsWith('#')) return <a key={i} href={n.href}>{label}</a>;
        if (n.href.startsWith('/')) return <Link key={i} to={n.href}>{label}</Link>;
        return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">{label}</a>;
      }
    }
    return null;
  });
}
