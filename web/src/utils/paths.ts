/** The folder above `p` in the folder picker: '' is the top level (Windows drives), null means none. */
export function parentOf(p: string): string | null {
  if (!p || p === '/') return null;
  const win = /^[A-Za-z]:\\?$/.test(p);
  if (win) return '';
  // A network share's root (\\nas\media): servers can't be browsed for their shares, so go back to the drives.
  if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(p)) return '';
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
  const trimmed = p.endsWith(sep) ? p.slice(0, -1) : p;
  const i = trimmed.lastIndexOf(sep);
  if (i <= 0) return sep;
  return trimmed.slice(0, i);
}
