/**
 * Full-fidelity ASS/SSA rendering with libass compiled to WebAssembly (jassub 1.8.8, MIT; the WASM bundles libass
 * (ISC), FreeType (FTL), HarfBuzz (MIT), FriBidi (LGPL-2.1), Brotli/Expat (MIT) — see jassub's COPYRIGHT file, served
 * next to the worker). Loaded lazily, only when an ASS track is shown.
 *
 * Works without SharedArrayBuffer / COOP-COEP. Uses an OffscreenCanvas in the worker when the browser has one, a
 * main-thread canvas otherwise; browsers without WebAssembly (Tizen 4, webOS 4) would need jassub's 3.7 MB asm.js
 * build, so `libassSupported()` only reports true for them when the user forces the file's styles — otherwise the
 * player uses the simplified ASS renderer (ass.ts + textRenderer.ts).
 *
 * jassub binds to the <video>: it renders on requestVideoFrameCallback (where available, else on timeupdate with frame
 * prediction), honours playbackRate, seeking and pause, and applies `timeOffset` (seconds) for the stream start offset
 * and the user's subtitle delay.
 */
import type JASSUBType from 'jassub';

export interface LibassOptions {
  video: HTMLVideoElement;
  content: string;
  /** Font URLs to load up front (embedded MKV fonts). */
  fonts: string[];
  /** Seconds added to video time to get subtitle time. */
  timeOffset: number;
  /** Lower render resolution on weak devices (TV). */
  lowPower?: boolean;
  onError?: (e: unknown) => void;
}

export function wasmSupported(): boolean {
  try {
    return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function' && WebAssembly.validate(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  } catch {
    return false;
  }
}

/** Can libass run here? `force` accepts the slow asm.js path on browsers without WebAssembly. */
export function libassSupported(force = false): boolean {
  if (typeof Worker === 'undefined' || typeof document === 'undefined') return false;
  if (!document.createElement('canvas').getContext('2d')) return false;
  return wasmSupported() || force;
}

export class LibassRenderer {
  private jassub: JASSUBType | null = null;
  private destroyed = false;
  readonly ready: Promise<void>;

  constructor(private readonly o: LibassOptions) {
    this.ready = this.init();
  }

  private async init() {
    const [{ default: JASSUB }, workerUrl, wasmUrl, legacyWasmUrl, fontUrl] = await Promise.all([
      import('jassub'),
      import('jassub/dist/jassub-worker.js?url').then((m) => m.default),
      import('jassub/dist/jassub-worker.wasm?url').then((m) => m.default),
      import('jassub/dist/jassub-worker.wasm.js?url').then((m) => m.default),
      import('jassub/dist/default.woff2?url').then((m) => m.default),
      // Licence notices for the WASM build travel with it.
      import('jassub/dist/COPYRIGHT?url').catch(() => null),
    ]);
    if (this.destroyed) return;
    const abs = (u: string) => new URL(u, window.location.href).href;
    const j = new JASSUB({
      video: this.o.video,
      subContent: this.o.content,
      workerUrl: abs(workerUrl),
      wasmUrl: abs(wasmUrl),
      legacyWasmUrl: abs(legacyWasmUrl),
      availableFonts: { 'liberation sans': abs(fontUrl) },
      fallbackFont: 'liberation sans',
      fonts: this.o.fonts.map(abs),
      timeOffset: this.o.timeOffset,
      // Weak TVs: cap the canvas resolution and let the compositor scale it up.
      ...(this.o.lowPower ? { maxRenderHeight: 720, blendMode: 'wasm' as const } : {}),
      useLocalFonts: false,
    });
    j.addEventListener('error', (e) => this.o.onError?.((e as ErrorEvent).error ?? e));
    this.jassub = j;
  }

  setContent(content: string) {
    void this.ready.then(() => this.jassub?.setTrack(content));
  }

  setTimeOffset(seconds: number) {
    void this.ready.then(() => {
      const j = this.jassub;
      if (!j) return;
      j.timeOffset = seconds;
      const v = this.o.video;
      // Re-render the current frame now (matters while paused).
      j.setCurrentTime(v.paused, v.currentTime + seconds, v.playbackRate);
    });
  }

  resize() {
    try {
      this.jassub?.resize();
    } catch {
      /* not ready yet */
    }
  }

  destroy() {
    this.destroyed = true;
    try {
      this.jassub?.destroy();
    } catch {
      /* ignore */
    }
    this.jassub = null;
  }
}
