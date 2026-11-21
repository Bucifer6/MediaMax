import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SongIdResponse } from '@mediamax/shared';
import { Icon } from '../components/Icon';
import { Img, Spinner } from '../components/ui';
import { pairApi } from './api';

const RECORD_MS = 10_000;

/**
 * "What's this song?" — first from the playing file on the server (no microphone needed), with a ~10 s microphone
 * recording as the fallback (title without a local file, no match, or the user prefers it).
 */
export function SongId({ identify }: { identify: () => Promise<SongIdResponse> }) {
  const [busy, setBusy] = useState<null | 'file' | 'mic'>(null);
  const [res, setRes] = useState<SongIdResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);

  const fromFile = async () => {
    setBusy('file');
    setError(null);
    setRes(null);
    try {
      setRes(await identify());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not identify the song');
    } finally {
      setBusy(null);
    }
  };

  const fromMic = async () => {
    setError(null);
    setRes(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('This browser can’t record audio (the microphone needs HTTPS).');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch {
      setError('Microphone access was blocked.');
      return;
    }
    setBusy('mic');
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const started = Date.now();
    const tick = window.setInterval(() => setProgress(Math.min(1, (Date.now() - started) / RECORD_MS)), 200);
    const stopAll = () => {
      window.clearInterval(tick);
      stream.getTracks().forEach((t) => t.stop());
    };
    stopRef.current = () => {
      if (rec.state !== 'inactive') rec.stop();
      stopAll();
    };
    rec.onstop = async () => {
      stopAll();
      setProgress(0);
      try {
        setRes(await pairApi.identifyClip(new Blob(chunks, { type: rec.mimeType || 'audio/webm' })));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not identify the song');
      } finally {
        setBusy(null);
      }
    };
    rec.start();
    window.setTimeout(() => rec.state !== 'inactive' && rec.stop(), RECORD_MS);
  };

  const m = res?.match;
  return (
    <section className="ss-card song-id" aria-live="polite">
      <h3><Icon name="music" size={18} /> What’s this song?</h3>
      {!m && (
        <div className="song-actions">
          <button className="btn btn-primary" disabled={!!busy} onClick={() => void fromFile()}>
            {busy === 'file' ? <Spinner size={16} /> : <Icon name="sparkles" size={16} />} {busy === 'file' ? 'Listening to the scene…' : 'Identify'}
          </button>
          <button className="btn btn-ghost" disabled={!!busy} onClick={() => void fromMic()}>
            <Icon name="audio" size={16} /> {busy === 'mic' ? `Recording… ${Math.ceil((1 - progress) * RECORD_MS / 1000)} s` : 'Use microphone'}
          </button>
        </div>
      )}
      {busy === 'mic' && <div className="song-rec" style={{ transform: `scaleX(${progress})` }} />}
      {res && !res.available && <p className="muted">{res.reason}</p>}
      {res?.available && !m && <p className="muted">No match{res.source === 'file' ? ' from the soundtrack here. Try the microphone, close to the speakers.' : '. Try again a little closer to the speakers.'}</p>}
      {m && (
        <div className="song-match">
          <div className="song-cover"><Img src={m.coverUrl} width={160} alt="" fallback={<Icon name="music" size={28} />} /></div>
          <div className="song-text">
            <strong>{m.title}</strong>
            <span>{m.artists.join(', ')}</span>
            {m.album && <span className="muted">{m.album}</span>}
            {m.libraryTrack ? (
              <Link className="btn btn-sm btn-primary" to={`/item/${encodeURIComponent(m.libraryTrack.albumId ?? m.libraryTrack.id)}`}><Icon name="music" size={14} /> In your library</Link>
            ) : m.recordingMbid ? (
              <a className="btn btn-sm btn-ghost" href={`https://musicbrainz.org/recording/${m.recordingMbid}`} target="_blank" rel="noopener noreferrer"><Icon name="external" size={14} /> MusicBrainz</a>
            ) : null}
          </div>
          <button className="btn-icon" aria-label="Identify another" onClick={() => setRes(null)}><Icon name="refresh" size={18} /></button>
        </div>
      )}
      {error && <p className="pair-error" role="alert">{error}</p>}
    </section>
  );
}
