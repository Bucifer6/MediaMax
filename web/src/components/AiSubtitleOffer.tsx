import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AutoSubtitleJob } from '@mediamax/shared';
import { aiApi } from '../api/ai';
import { useToast } from '../state/toast';
import { Icon } from './Icon';
import { Spinner } from './ui';

/**
 * Admin-only, in the subtitle search dialog: the provider of last resort. Queues speech-to-text (+ translation)
 * for this title; the job runs one at a time at low priority (Admin → AI shows progress).
 */
export function AiSubtitleOffer({ itemId, languages }: { itemId: string; languages: string }) {
  const toast = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<AutoSubtitleJob[]>([]);
  useEffect(() => {
    aiApi.subtitles().then((s) => setEnabled(s.enabled)).catch(() => setEnabled(null));
  }, []);
  if (enabled == null) return null;
  const langs = Array.from(new Set(languages.split(/[,\s]+/).map((l) => l.trim().toLowerCase()).filter((l) => /^[a-z]{2}$/.test(l))));
  const generate = async () => {
    setBusy(true);
    try {
      const jobs = await Promise.all(langs.map((l) => aiApi.queueSubtitle(itemId, l)));
      setQueued(jobs);
      toast.success(`Queued ${jobs.length > 1 ? `${jobs.length} subtitles` : 'the subtitle'} for generation`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="subsearch-ai">
      <Icon name="sparkles" size={18} />
      <div>
        <strong>Nothing suitable?</strong>{' '}
        <span className="muted">
          {enabled
            ? <>Generate it from the dialogue with speech-to-text{langs.some((l) => l !== 'en') ? ', translated by the AI model' : ''}. It is labelled “Auto-generated (AI)” and runs in the background (<Link to="/admin/ai">Admin → AI</Link>).</>
            : <>Automatic subtitles can be switched on in <Link to="/admin/ai">Admin → AI</Link>.</>}
        </span>
        {queued.length > 0 && <div className="muted">{queued.map((j) => `${j.language.toUpperCase()}: ${j.status}`).join(' · ')}</div>}
      </div>
      {enabled && (
        <button className="btn btn-sm" onClick={() => void generate()} disabled={busy || !langs.length}>
          {busy ? <Spinner size={14} /> : <Icon name="wand" size={14} />} Generate with AI
        </button>
      )}
    </div>
  );
}
