import type { HelpArticle, HelpIndex, HelpSearchResponse, HelpWhatsNew } from '@mediamax/shared';
import { API_BASE, ApiRequestError, getToken, http } from './client';
import { deviceHeaders } from './device';

export const helpApi = {
  index: () => http.get<HelpIndex>('/help'),
  article: (slug: string) => http.get<HelpArticle>(`/help/${encodeURIComponent(slug)}`),
  search: (q: string, signal?: AbortSignal) => http.get<HelpSearchResponse>('/help/search', { q }, signal),
  whatsNew: () => http.get<HelpWhatsNew>('/help/whats-new'),
};

/** Admin → Activity & logs → Download diagnostics: fetch the ZIP with the session token and save it. */
export async function downloadDiagnostics(): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_BASE}/admin/diagnostics.zip`, { headers: { ...deviceHeaders(), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      message = ((await res.json()) as { message?: string }).message ?? message;
    } catch {
      /* not json */
    }
    throw new ApiRequestError(res.status, 'download_failed', message);
  }
  const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'diagnostics.zip';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}
