/**
 * Full-fidelity ASS/SSA rendering with libass compiled to WebAssembly (jassub 2, MIT; the WASM bundles libass (ISC),
 * FreeType (FTL), HarfBuzz (MIT), FriBidi (LGPL-2.1) and friends — see jassub's package.json `license` field and its
 * LICENSE file, served next to the worker). Loaded lazily, only when an ASS track is shown.
 *
 * Works without SharedArrayBuffer / COOP-COEP (single-threaded then). jassub 2 always renders in a module worker on an
 * OffscreenCanvas (WebGL2 → WebGL1 → 2D) and paces itself with requestVideoFrameCallback; it has no main-thread or
 * asm.js fallback any more. `libassSupported()` checks all of that up front, so older TV browsers (and Firefox < 132,
 * which has no requestVideoFrameCallback) get the simplified ASS renderer (ass.ts + textRenderer.ts) instead.
 *
 * jassub binds to the <video>: it renders on requestVideoFrameCallback, honours playbackRate, seeking and pause, and
 * applies `timeOffset` (seconds) for the stream start offset and the user's subtitle delay.
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

let wasmFeatures: boolean | null = null;
/**
 * The WASM features jassub 2's build needs beyond the MVP: sign extension and non-trapping float-to-int (Chrome 75,
 * Safari 15, Firefox 64) and i64 ↔ BigInt at the JS boundary (Chrome 85, Safari 14.1, Firefox 78).
 */
function wasmFeaturesSupported(): boolean {
  if (wasmFeatures != null) return wasmFeatures;
  try {
    // () -> i32 { f32.const 0; i32.trunc_sat_f32_s; i32.extend8_s }
    const ops = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 0x60, 0, 1, 0x7f, 3, 2, 1, 0, 0x0a, 0x0c, 1, 0x0a, 0, 0x43, 0, 0, 0, 0, 0xfc, 0x00, 0xc0, 0x0b);
    // (export "f" (func (param i64))), called with a BigInt
    const i64 = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 0x60, 1, 0x7e, 0, 3, 2, 1, 0, 7, 5, 1, 1, 0x66, 0, 0, 0x0a, 4, 1, 2, 0, 0x0b);
    if (!WebAssembly.validate(ops) || typeof BigInt !== 'function') return (wasmFeatures = false);
    const f = new WebAssembly.Instance(new WebAssembly.Module(i64)).exports.f as (v: bigint) => void;
    f(BigInt(0));
    wasmFeatures = true;
  } catch {
    wasmFeatures = false;
  }
  return wasmFeatures;
}

let moduleWorkers: boolean | null = null;
function moduleWorkersSupported(): boolean {
  if (moduleWorkers != null) return moduleWorkers;
  moduleWorkers = false;
  // Browsers without module workers never read `type` from the options (the usual feature test).
  const probe = {
    get type() {
      moduleWorkers = true;
      return 'module' as const;
    },
  };
  try {
    new Worker('data:,', probe).terminate();
  } catch {
    /* the probe has run either way */
  }
  return moduleWorkers;
}

/**
 * Can libass run here? `force` (the user chose "the file's own styles") skips the low-power heuristics in the caller;
 * it can't make up for a missing platform feature, since jassub 2 has no fallback path for any of them.
 */
export function libassSupported(_force = false): boolean {
  if (typeof Worker === 'undefined' || typeof document === 'undefined') return false;
  if (typeof OffscreenCanvas === 'undefined' || typeof HTMLCanvasElement === 'undefined' || !('transferControlToOffscreen' in HTMLCanvasElement.prototype)) return false;
  if (typeof HTMLVideoElement === 'undefined' || !('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return false;
  if (typeof ResizeObserver === 'undefined') return false;
  return wasmSupported() && wasmFeaturesSupported() && moduleWorkersSupported();
}

export class LibassRenderer {
  private jassub: JASSUBType | null = null;
  private destroyed = false;
  readonly ready: Promise<void>;

  constructor(private readonly o: LibassOptions) {
    this.ready = this.init();
  }

  private async init() {
    const [{ default: JASSUB }, workerUrl, wasmUrl, wasmWorkerUrl, modernWasmUrl, modernWasmWorkerUrl, fontUrl] = await Promise.all([
      import('jassub'),
      // The renderer worker is bundled by Vite (it imports abslink etc.); the Emscripten glue and the .wasm files are
      // served as they are. Passing every URL keeps this working in dev too, where jassub is pre-bundled and its own
      // `new URL(..., import.meta.url)` lookups would point into .vite/deps.
      import('jassub/dist/worker/worker.js?worker&url').then((m) => m.default),
      import('jassub/dist/wasm/jassub-worker.wasm?url').then((m) => m.default),
      import('jassub/dist/wasm/jassub-worker.js?url').then((m) => m.default),
      import('jassub/dist/wasm/jassub-worker-modern.wasm?url').then((m) => m.default),
      import('jassub/dist/wasm/jassub-worker-modern.js?url').then((m) => m.default),
      import('jassub/dist/default.woff2?url').then((m) => m.default),
      // Licence notice for the WASM build travels with it.
      import('jassub/LICENSE?url').catch(() => null),
    ]);
    if (this.destroyed) return;
    const abs = (u: string) => new URL(u, window.location.href).href;
    const j = new JASSUB({
      video: this.o.video,
      subContent: this.o.content,
      workerUrl: abs(workerUrl),
      wasmUrl: abs(wasmUrl),
      wasmWorkerUrl: abs(wasmWorkerUrl),
      modernWasmUrl: abs(modernWasmUrl),
      modernWasmWorkerUrl: abs(modernWasmWorkerUrl),
      availableFonts: { 'liberation sans': abs(fontUrl) },
      defaultFont: 'liberation sans',
      fonts: this.o.fonts.map(abs),
      timeOffset: this.o.timeOffset,
      // Weak TVs: cap the canvas resolution and let the compositor scale it up.
      ...(this.o.lowPower ? { maxRenderHeight: 720 } : {}),
      // No local-font permission prompt and no Google Fonts lookups: embedded fonts + the bundled default only.
      queryFonts: false,
    });
    this.jassub = j;
    // A worker that fails to load never settles `ready`; report it like any other failure.
    j._worker.addEventListener('error', (e) => {
      if (!this.destroyed) this.o.onError?.(e.error ?? new Error(e.message || 'jassub worker failed to load'));
    });
    await j.ready;
  }

  setContent(content: string) {
    void this.ready
      .then(async () => {
        if (this.destroyed || !this.jassub) return;
        await this.jassub.renderer.setTrack(content);
      })
      .catch((e) => console.warn('libass: could not update the track', e));
  }

  setTimeOffset(seconds: number) {
    void this.ready
      .then(async () => {
        const j = this.jassub;
        if (this.destroyed || !j) return;
        j.timeOffset = seconds;
        // Re-render the current frame now (matters while paused; playing video re-renders on the next frame anyway).
        if (j._lastDemandTime) await j.manualRender(j._lastDemandTime, true);
      })
      .catch(() => {
        /* reported through ready */
      });
  }

  resize() {
    const j = this.jassub;
    if (!j) return;
    void j.ready.then(() => j.resize()).catch(() => {
      /* not ready / destroyed */
    });
  }

  destroy() {
    this.destroyed = true;
    const j = this.jassub;
    this.jassub = null;
    if (j) void j.destroy().catch(() => {
      /* ignore */
    });
  }
}
