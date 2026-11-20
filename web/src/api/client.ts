import type { ApiError } from '@mediamax/shared';
import { deviceHeaders } from './device';

export const API_BASE = '/api/v1';
const TOKEN_KEY = 'mm.token';

let memoryToken: string | null = null;

export function getToken(): string | null {
  if (memoryToken) return memoryToken;
  try {
    memoryToken = localStorage.getItem(TOKEN_KEY);
  } catch {
    /* storage blocked */
  }
  return memoryToken;
}

export function setToken(token: string | null) {
  memoryToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked */
  }
}

export class ApiRequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type QueryValue = string | number | boolean | null | undefined;

export function buildQuery(query?: object): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query as Record<string, QueryValue>)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

interface RequestOptions {
  body?: unknown;
  query?: object;
  signal?: AbortSignal;
  keepalive?: boolean;
  /** Don't fire the global unauthorized event on 401. */
  silent401?: boolean;
}

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = { ...deviceHeaders() };
  const token = getToken();
  if (token) h.Authorization = `Bearer ${token}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function handle<T>(res: Response, silent401?: boolean): Promise<T> {
  if (!res.ok) {
    let err: Partial<ApiError> = {};
    try {
      err = (await res.json()) as ApiError;
    } catch {
      /* not json */
    }
    if (res.status === 401 && !silent401 && getToken()) {
      window.dispatchEvent(new CustomEvent('mm:unauthorized'));
    }
    throw new ApiRequestError(
      res.status,
      err.error ?? 'http_error',
      err.message ?? (res.status === 502 || res.status === 504 ? 'Server unreachable' : `Request failed (${res.status})`),
    );
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path + buildQuery(opts.query), {
      method,
      headers: headers(opts.body !== undefined),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
      keepalive: opts.keepalive,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiRequestError(0, 'network', 'Cannot reach the server');
  }
  return handle<T>(res, opts.silent401);
}

export async function upload<T>(path: string, file: File | Blob, field = 'file'): Promise<T> {
  const form = new FormData();
  form.append(field, file);
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { method: 'POST', headers: headers(false), body: form });
  } catch {
    throw new ApiRequestError(0, 'network', 'Cannot reach the server');
  }
  return handle<T>(res);
}

export const http = {
  get: <T>(path: string, query?: object, signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown, query?: object) => request<T>('POST', path, { body: body ?? {}, query }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body: body ?? {} }),
  del: <T>(path: string, query?: object) => request<T>('DELETE', path, { query }),
};

/** Resolve a server-relative URL (image, stream). Optionally request a width. */
export function mediaUrl(url: string | null | undefined, width?: number): string | undefined {
  if (!url) return undefined;
  if (!width || /^(data:|blob:)/.test(url)) return url;
  if (!url.startsWith('/api/')) return url;
  return url + (url.includes('?') ? '&' : '?') + 'w=' + Math.round(width * Math.min(window.devicePixelRatio || 1, 2));
}

/** Append the auth token to a URL that is consumed by a media element. */
export function withToken(url: string): string {
  const token = getToken();
  if (!token || /[?&]token=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
