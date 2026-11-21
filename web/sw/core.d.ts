// Types for core.js (plain JS so it can be inlined into the service worker as is).
export declare const CACHE_PREFIX: string;
export declare const OFFLINE_STATUSES: number[];
export declare function cacheName(version: string): string;
export declare function staleCaches(names: string[], version: string): string[];
export type RequestKind = 'navigate' | 'asset' | 'shell' | 'network';
export declare function classify(req: { method: string; mode: string; url: string; hasAuth?: boolean }, scope: string, precache?: string[]): RequestKind;
export declare function precacheList(build: { entryAssets: string[]; publicFiles: string[] }): string[];
