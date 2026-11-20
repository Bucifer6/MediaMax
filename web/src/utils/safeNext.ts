/**
 * The `?next=` target after signing in / picking a profile: only a path inside this app. Anything else
 * (absolute or protocol-relative URLs, "/\evil.example", javascript:, control characters) becomes "/", so a crafted
 * link can't send someone off-site straight after they sign in.
 */
export function safeNext(raw: string | null | undefined): string {
  const v = String(raw ?? '');
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\') || /[\u0000-\u001f\u007f\\]/.test(v)) return '/';
  return v;
}
