/**
 * Player add-ons for skip segments and content advice:
 *  - ParentalGuideCard: the rating and parental guide severities for a few seconds when a title starts
 *    (Settings → Playback → "Show the parental guide when a title starts").
 *  - SegmentSubmit: admins mark where the intro / recap / credits start and end while watching and save it for
 *    everyone, optionally sending it on to IntroDB (Sync & delay panel).
 */
import { useEffect, useState } from 'react';
import type { Marker, ParentalGuide, SubmitMarkerRequest } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useToast } from '../state/toast';
import { formatClock } from '../utils/format';

const CATEGORY_LABEL: Record<ParentalGuide['categories'][number]['category'], string> = {
  violence: 'Violence', nudity: 'Sex & nudity', profanity: 'Language', alcohol: 'Alcohol & drugs', frightening: 'Frightening scenes',
};
const SHOW_MS = 8000;

export function ParentalGuideCard({ itemId, positionMs }: { itemId: string; positionMs: number }) {
  const [guide, setGuide] = useState<ParentalGuide | null>(null);
  const [shownAt, setShownAt] = useState<number | null>(null);
  useEffect(() => {
    setGuide(null);
    setShownAt(null);
    const ctrl = new AbortController();
    api.segments.parentalGuide(itemId, ctrl.signal).then(setGuide).catch(() => {});
    return () => ctrl.abort();
  }, [itemId]);
  // Starts counting once the picture is moving, so a slow start doesn't eat the card.
  useEffect(() => {
    if (guide && shownAt == null && positionMs > 0) setShownAt(positionMs);
  }, [guide, positionMs, shownAt]);
  if (!guide || shownAt == null || positionMs - shownAt > SHOW_MS || positionMs < shownAt) return null;
  const notable = guide.categories.filter((c) => c.severity !== 'none');
  if (!guide.contentRating && !notable.length) return null;
  return (
    <div className="parental-guide" role="status" aria-label="Parental guide">
      {guide.contentRating && <span className="parental-guide-rating">{guide.contentRating}</span>}
      {notable.length > 0 && (
        <ul>
          {notable.map((c) => (
            <li key={c.category}><span>{CATEGORY_LABEL[c.category]}</span><b className={`sev-${c.severity}`}>{c.severity}</b></li>
          ))}
        </ul>
      )}
    </div>
  );
}

type SegType = SubmitMarkerRequest['type'];

export function SegmentSubmit({ itemId, positionMs, onSaved }: { itemId: string; positionMs: number; onSaved: (m: Marker[]) => void }) {
  const toast = useToast();
  const [type, setType] = useState<SegType>('intro');
  const [start, setStart] = useState<number | null>(null);
  const [end, setEnd] = useState<number | null>(null);
  const [upstream, setUpstream] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setStart(null);
    setEnd(null);
  }, [itemId, type]);
  const save = async () => {
    if (start == null || end == null) return;
    setBusy(true);
    try {
      const r = await api.segments.submit(itemId, { type, startMs: start, endMs: end, upstream });
      onSaved(r.markers);
      toast.show(r.upstream ? (r.upstream.sent ? `Saved, and sent to IntroDB.` : `Saved here. ${r.upstream.message ?? 'Not sent to IntroDB.'}`) : 'Saved for everyone on this server.');
      setStart(null);
      setEnd(null);
    } catch (e) {
      toast.show(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="segment-submit" role="group" aria-label="Mark a segment">
      <span className="sync-label">Mark segment<small>admins: saved for everyone</small></span>
      <div className="segment-submit-row">
        <select className="select select-sm" value={type} onChange={(e) => setType(e.target.value as SegType)} aria-label="Segment">
          <option value="intro">Intro</option>
          <option value="recap">Recap</option>
          <option value="credits">End credits</option>
        </select>
        <button className="btn btn-glass btn-sm" onClick={() => setStart(Math.round(positionMs))}>Starts {start != null ? formatClock(start) : 'here'}</button>
        <button className="btn btn-glass btn-sm" onClick={() => setEnd(Math.round(positionMs))} disabled={start == null}>Ends {end != null ? formatClock(end) : 'here'}</button>
      </div>
      <div className="segment-submit-row">
        <label className="check"><input type="checkbox" checked={upstream} onChange={(e) => setUpstream(e.target.checked)} /> Also send to IntroDB</label>
        <button className="btn btn-primary btn-sm" disabled={busy || start == null || end == null || end <= start} onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}
