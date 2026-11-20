import { useEffect, useState } from 'react';
import type { HwDetectReport, HwMethodResult, HwTestResult, ServerSettings } from '@mediamax/shared';
import { http } from '../api/client';
import { useToast } from '../state/toast';
import { Badge, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import '../styles/hwdetect.css';

type T = ServerSettings['transcoding'];

/** True when this result card describes the accelerator and device currently set in the form. */
function isCurrent(m: HwMethodResult, t: T) {
  if (m.hwAccel !== t.hwAccel) return false;
  if (m.device && (m.hwAccel === 'vaapi' || m.hwAccel === 'qsv')) return m.device === t.vaapiDevice;
  if (m.gpuIndex != null) return m.gpuIndex === (t.gpuIndex ?? 0);
  return true;
}

function Test({ label, r }: { label: string; r: HwTestResult | null }) {
  if (!r) return null;
  const tone = r.works ? 'success' : r.skipped ? 'muted' : 'danger';
  return (
    <li className="hwd-test" title={r.error ?? undefined}>
      <Icon name={r.works ? 'check' : r.skipped ? 'minus' : 'x'} size={14} className={`hwd-${tone}`} />
      <span>{label}</span>
      {r.works && r.fps ? <span className="muted">{Math.round(r.fps)} fps</span> : !r.works && r.error ? <span className="muted hwd-err">{r.error}</span> : null}
    </li>
  );
}

function Card({ m, current, onUse }: { m: HwMethodResult; current: boolean; onUse: () => void }) {
  const tm = m.toneMapping;
  return (
    <div className={`hwd-card${m.works ? '' : ' hwd-card-off'}${m.recommended ? ' hwd-card-rec' : ''}`}>
      <div className="hwd-head">
        <div>
          <div className="hwd-title">{m.label}</div>
          <div className="muted hwd-dev">{[m.deviceName, m.device, m.gpuIndex != null ? `GPU ${m.gpuIndex}` : null].filter(Boolean).join(' · ') || '—'}</div>
        </div>
        <div className="hwd-badges">
          {m.recommended && <Badge tone="primary">Recommended</Badge>}
          {current && <Badge tone="accent">In use</Badge>}
          <Badge tone={m.works ? 'success' : m.available ? 'danger' : 'muted'}>{m.works ? 'Works' : m.available ? 'Failed' : 'Not available'}</Badge>
        </div>
      </div>
      {m.available ? (
        <ul className="hwd-tests">
          <Test label="H.264 encode" r={m.encode.h264} />
          {m.hwAccel !== 'none' && <Test label="HEVC encode" r={m.encode.hevc} />}
          {m.hwAccel !== 'none' && <Test label="AV1 encode" r={m.encode.av1} />}
          <Test label={m.hwAccel === 'none' ? 'Decode → encode' : 'Hardware decode → encode'} r={m.decode} />
          <Test label="10-bit HEVC decode" r={m.tenBit} />
          <li className="hwd-test" title={tm.tried.map((x) => `${x.path}: ${x.works ? 'works' : x.error}`).join('\n')}>
            <Icon name={tm.path ? 'check' : 'x'} size={14} className={tm.path ? 'hwd-success' : 'hwd-danger'} />
            <span>HDR → SDR tone-mapping</span>
            <span className="muted">{tm.path ?? (tm.tried.length ? 'none works' : 'not tested')}</span>
          </li>
        </ul>
      ) : null}
      {m.error && !m.works && <p className="hwd-error">{m.error}</p>}
      {m.notes.map((n) => <p key={n} className="muted hwd-note">{n}</p>)}
      {m.works && !current && (
        <button type="button" className="btn btn-sm hwd-use" onClick={onUse}><Icon name="check" size={14} /> Use this</button>
      )}
    </div>
  );
}

/** Server settings → Transcoding: run the hardware detection and apply a working method. */
export function HardwareDetect({ value, onUse }: { value: T; onUse: (patch: Partial<T>) => void }) {
  const toast = useToast();
  const [report, setReport] = useState<HwDetectReport | null>(null);
  const [running, setRunning] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    http.get<{ report: HwDetectReport | null }>('/admin/transcoding/detect').then((r) => setReport(r.report)).catch(() => {});
  }, []);

  const run = async () => {
    setRunning(true);
    try {
      const r = await http.post<{ report: HwDetectReport }>('/admin/transcoding/detect');
      setReport(r.report);
    } catch (e) {
      toast.error(e);
    } finally {
      setRunning(false);
    }
  };

  const use = (m: HwMethodResult) => {
    const patch: Partial<T> = { hwAccel: m.hwAccel };
    if (m.device && (m.hwAccel === 'vaapi' || m.hwAccel === 'qsv')) patch.vaapiDevice = m.device;
    if (m.gpuIndex != null) patch.gpuIndex = m.gpuIndex;
    onUse(patch);
    toast.success(`${m.label} selected — save changes to apply`);
  };

  const methods = report?.methods ?? [];
  const visible = showAll ? methods : methods.filter((m) => m.available);
  const hidden = methods.length - visible.length;

  return (
    <section className="hwd">
      <div className="hwd-bar">
        <div>
          <strong>Hardware detection</strong>
          <div className="muted hwd-sub">
            {running ? 'Running test transcodes on every encoder — this can take up to a minute…'
              : report ? `Last run ${new Date(report.ranAt).toLocaleTimeString()} · ffmpeg ${report.ffmpeg.version ?? '?'} · ${(report.durationMs / 1000).toFixed(1)} s`
                : 'Finds GPUs and runs a short test transcode with each method.'}
          </div>
        </div>
        <button type="button" className="btn" onClick={() => void run()} disabled={running}>
          {running ? <Spinner size={16} /> : <Icon name={report ? 'refresh' : 'zap'} size={16} />} {report ? 'Re-run detection' : 'Detect hardware'}
        </button>
      </div>
      {report && (
        <>
          <p className="hwd-rec"><Icon name="info" size={14} /> {report.recommendation.reason}</p>
          <div className="hwd-grid">
            {visible.map((m) => <Card key={m.id} m={m} current={isCurrent(m, value)} onUse={() => use(m)} />)}
          </div>
          {(hidden > 0 || showAll) && (
            <button type="button" className="btn btn-sm hwd-more" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Hide unavailable methods' : `Show ${hidden} unavailable method${hidden === 1 ? '' : 's'}`}
            </button>
          )}
          <details className="hwd-details">
            <summary className="muted">ffmpeg capabilities</summary>
            <p className="mono">hwaccels: {report.ffmpeg.hwaccels.join(', ') || 'none'}</p>
            <p className="mono">encoders: {report.ffmpeg.encoders.join(', ') || 'none'}</p>
            <p className="mono">filters: {report.ffmpeg.filters.join(', ') || 'none'}</p>
            <p className="mono">devices: {report.devices.map((d) => `${d.name}${d.path ? ` (${d.path})` : ''}`).join(', ') || 'none found'}</p>
          </details>
        </>
      )}
    </section>
  );
}
