/** Server settings → Karaoke & lyrics: AI stems (where they are separated, model download / verify) and .lrc sidecar writing. */
import { useEffect, useState } from 'react';
import type { KaraokeSettings, StemsStatus } from '@mediamax/shared';
import { karaokeApi } from '../api/karaoke';
import { Field, Switch } from '../components/ui';
import { useToast } from '../state/toast';

export const KARAOKE_DEFAULTS: KaraokeSettings = { stemsEnabled: false, stemsModelUrl: null, stemsModelSha256: null, writeLrcSidecars: false, stemsEngine: 'auto', stemsBackend: 'auto', stemsThreads: null };
const mb = (n: number | null | undefined) => (n ? `${Math.round(n / 1048576)} MB` : '?');

export function KaraokeSettingsPanel({ value, onChange, dirty }: { value: KaraokeSettings | undefined; onChange: (v: KaraokeSettings) => void; dirty: boolean }) {
  const k = { ...KARAOKE_DEFAULTS, ...(value ?? {}) };
  const set = (p: Partial<KaraokeSettings>) => onChange({ ...k, ...p });
  const toast = useToast();
  const [st, setSt] = useState<StemsStatus | null>(null);
  const refresh = () => karaokeApi.stemsStatus().then(setSt).catch(() => {});
  useEffect(() => {
    void refresh();
  }, []);
  const busy = !!st?.model?.downloading || st?.native?.download?.state === 'downloading' || st?.ortDownload?.state === 'downloading';
  useEffect(() => {
    if (!busy) return;
    const iv = window.setInterval(refresh, 1000);
    return () => clearInterval(iv);
  }, [busy]);
  const model = st?.model;
  const nat = st?.native;
  const server = st?.engine === 'server';
  return (
    <div className="form-grid">
      <p className="muted">
        Lyrics come from edits made here, <code>.lrc</code>/<code>.txt</code> files next to the music, tags embedded in the files (including synced ID3 SYLT),
        then LRCLIB (Metadata tab). Karaoke works on any stereo track with quick vocal reduction; AI stems give clean instrumentals.
        An administrator presses <strong>Prepare (AI)</strong> in the player: the server separates the track itself (on its GPU when it has one),
        or, where it can't, the administrator's browser does. The stems are stored on this server so every device, including phones and TVs,
        can play the karaoke version. Nothing leaves your server.
      </p>
      <Switch checked={k.writeLrcSidecars} onChange={(v) => set({ writeLrcSidecars: v })} label="Allow writing .lrc files next to the music"
        hint="When saving lyrics, the editor can also write Song.lrc beside the audio file. Needs a writable library folder (media is often mounted read-only)." />
      <Switch checked={k.stemsEnabled} onChange={(v) => set({ stemsEnabled: v })} label="Enable AI stem separation (HT-Demucs)"
        hint="Downloads the separation model (about 100 MB download, 175 MB on disk) the first time it is needed and caches separated stems (FLAC) under the data folder." />
      {k.stemsEnabled && (
        <>
          <div className="form-row">
            <Field label="Model URL" hint="Empty = the default HT-Demucs v4 ONNX export (npm package demucs@1.0.0), pinned by SHA-256. For an archive member use https://…/file.tgz#path/in/archive.onnx">
              <input className="input mono" placeholder="Default (HT-Demucs v4)" value={k.stemsModelUrl ?? ''} onChange={(e) => set({ stemsModelUrl: e.target.value.trim() || null })} />
            </Field>
            {k.stemsModelUrl && (
              <Field label="Model SHA-256" hint="Required for a custom model: the download is rejected when it doesn't match.">
                <input className="input mono" value={k.stemsModelSha256 ?? ''} onChange={(e) => set({ stemsModelSha256: e.target.value.trim() || null })} />
              </Field>
            )}
          </div>
          <div className="form-row">
            <Field label="Separate on" hint="Automatic: on this server when its platform has the native AI runtime (Windows, Linux x64/arm64, Apple silicon Macs), else in the administrator's browser.">
              <select className="input" value={k.stemsEngine ?? 'auto'} onChange={(e) => set({ stemsEngine: e.target.value as KaraokeSettings['stemsEngine'] })}>
                <option value="auto">Automatic</option>
                <option value="server">This server</option>
                <option value="browser">The administrator's browser</option>
              </select>
            </Field>
            {(k.stemsEngine ?? 'auto') !== 'browser' && (
              <>
                <Field label="Server: processor" hint="Automatic uses the GPU when there is one (DirectML on Windows, Core ML on Macs, CUDA on Linux with NVIDIA's libraries) and falls back to the CPU.">
                  <select className="input" value={k.stemsBackend ?? 'auto'} onChange={(e) => set({ stemsBackend: e.target.value as KaraokeSettings['stemsBackend'] })}>
                    <option value="auto">Automatic (GPU when available)</option>
                    <option value="cpu">CPU only</option>
                  </select>
                </Field>
                <Field label="Server: CPU threads" hint="Empty = all cores but two. Separation runs at low priority, one track at a time.">
                  <input className="input" type="number" min={1} max={256} placeholder="Automatic" value={k.stemsThreads ?? ''} onChange={(e) => set({ stemsThreads: e.target.value ? Math.max(1, Math.min(256, Math.round(Number(e.target.value)))) : null })} />
                </Field>
              </>
            )}
          </div>
          {nat && !dirty && (
            <div className="card karaoke-model-card">
              <strong>Separation: {server ? 'on this server' : "in the administrator's browser"}</strong>
              <div className="muted">
                {server
                  ? nat.ready
                    ? `Native AI runtime ${nat.version} ready${nat.lastBackend ? ` · last run on ${nat.lastBackend === 'cpu' ? 'the CPU' : `the GPU (${nat.lastBackend})`}` : ''}${nat.queued ? ` · ${nat.queued} track(s) queued` : ''}`
                    : nat.download?.state === 'downloading'
                      ? `Downloading the native AI runtime… ${mb(nat.download.received)}${nat.download.total ? ` of ${mb(nat.download.total)}` : ''}`
                      : `The native AI runtime (onnxruntime-node ${nat.version}, about 100 MB for this platform) is downloaded the first time a track is prepared`
                  : nat.supported
                    ? 'Set to the browser. This server could separate itself.'
                    : `This server can't run the native AI runtime: ${nat.reason}.`}
              </div>
              {nat.download?.state === 'error' && <div className="karaoke-error">Native AI runtime download failed: {nat.download.error}</div>}
              {server && nat.gpuProblem && <div className="karaoke-error">The GPU gave unusable results ({nat.gpuProblem}), so this server separates on the CPU until it restarts. Choose "CPU only" to skip trying the GPU.</div>}
            </div>
          )}
          {model && !dirty && (
            <div className="card karaoke-model-card">
              <strong>{model.name}</strong>
              <div className="muted">
                {model.ready ? `Downloaded (${mb(model.bytes)}), ${model.verified ? 'SHA-256 verified' : 'not pinned by SHA-256'}` : model.downloading ? `Downloading… ${mb(model.downloading.received)} of ${mb(model.downloading.total)}` : 'Not downloaded yet'}
                {!server && !st?.ort && (st?.ortDownload?.state === 'downloading'
                  ? ` · Downloading the AI runtime… ${mb(st.ortDownload.received)}${st.ortDownload.total ? ` of ${mb(st.ortDownload.total)}` : ''}`
                  : ' · The AI runtime (onnxruntime-web, about 20 MB) is downloaded with the model')}
                {!server && st?.ortDownload?.state === 'error' && <span className="karaoke-error"> · AI runtime download failed: {st.ortDownload.error}</span>}
              </div>
              {model.error && <div className="karaoke-error">{model.error}</div>}
              <small className="muted">{model.licence} {model.homepage && <a href={model.homepage} target="_blank" rel="noreferrer">Project page</a>}</small>
              <div className="form-row">
                {!model.ready && !model.downloading && (
                  <button className="btn btn-sm" onClick={() => karaokeApi.downloadModel().then(refresh).catch((e) => toast.error(e))}>Download model now</button>
                )}
                {model.downloading && <button className="btn btn-sm" onClick={() => karaokeApi.cancelModel().then(refresh)}>Cancel download</button>}
              </div>
            </div>
          )}
          {dirty && <p className="muted">Save to see the model status.</p>}
        </>
      )}
    </div>
  );
}
