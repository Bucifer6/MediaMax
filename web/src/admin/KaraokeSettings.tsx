/** Server settings → Karaoke & lyrics: AI stems model (download / verify) and .lrc sidecar writing. */
import { useEffect, useState } from 'react';
import type { KaraokeSettings, StemsStatus } from '@mediamax/shared';
import { karaokeApi } from '../api/karaoke';
import { Field, Switch } from '../components/ui';
import { useToast } from '../state/toast';

export const KARAOKE_DEFAULTS: KaraokeSettings = { stemsEnabled: false, stemsModelUrl: null, stemsModelSha256: null, writeLrcSidecars: false };
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
  useEffect(() => {
    if (!st?.model?.downloading) return;
    const iv = window.setInterval(refresh, 1000);
    return () => clearInterval(iv);
  }, [st?.model?.downloading]);
  const model = st?.model;
  return (
    <div className="form-grid">
      <p className="muted">
        Lyrics come from edits made here, <code>.lrc</code>/<code>.txt</code> files next to the music, tags embedded in the files (including synced ID3 SYLT),
        then LRCLIB (Metadata tab). Karaoke works on any stereo track with quick vocal reduction; AI stems give clean instrumentals.
        AI separation runs in an administrator's browser (open the web app on a computer and press <strong>Prepare (AI)</strong> in the player);
        the stems are stored on this server so every device, including TVs, can play the karaoke version. Nothing leaves your server.
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
              <Field label="Model SHA-256" hint="Strongly recommended: the download is rejected when it doesn't match.">
                <input className="input mono" value={k.stemsModelSha256 ?? ''} onChange={(e) => set({ stemsModelSha256: e.target.value.trim() || null })} />
              </Field>
            )}
          </div>
          {model && !dirty && (
            <div className="card karaoke-model-card">
              <strong>{model.name}</strong>
              <div className="muted">
                {model.ready ? `Downloaded (${mb(model.bytes)}), ${model.verified ? 'SHA-256 verified' : 'not pinned by SHA-256'}` : model.downloading ? `Downloading… ${mb(model.downloading.received)} of ${mb(model.downloading.total)}` : 'Not downloaded yet'}
                {!st?.ort && ' · onnxruntime-web is not installed on the server (optional npm dependency)'}
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
