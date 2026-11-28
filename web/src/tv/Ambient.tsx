/**
 * TV ambient mode: after the viewer's idle time (Settings → Playback → TV ambient mode) the screen turns into a slow
 * slideshow of backdrops (with logos) from their own libraries. Any key, click or touch brings the screen back. Only in
 * TV mode, never during playback or while music plays (the music screensaver covers that).
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { Item } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { Img } from '../components/ui';
import { isTvMode } from '../player/NowPlaying';
import { useMusic } from '../player/music';

const SLIDE_MS = 12000;

export function AmbientMode() {
  const { user } = useApp();
  const music = useMusic();
  const location = useLocation();
  const minutes = user?.preferences.ambientMinutes ?? 0;
  const [on, setOn] = useState(false);
  const [slides, setSlides] = useState<Item[]>([]);
  const [i, setI] = useState(0);
  const timer = useRef(0);
  /** The slideshow is really on screen (on, with slides): only then is a waking key swallowed. */
  const shownRef = useRef(false);
  const blocked = !isTvMode() || !minutes || location.pathname.startsWith('/play') || location.pathname.startsWith('/live') || !!music.playing;

  // Idle timer: any input restarts it (and wakes the screen).
  useEffect(() => {
    if (blocked) {
      setOn(false);
      return;
    }
    const arm = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setOn(true), minutes * 60000);
    };
    const wake = (e: Event) => {
      // The key that wakes the screen shouldn't also act on the page behind it (only when the slideshow was showing).
      if (shownRef.current && e.type === 'keydown') {
        e.preventDefault();
        e.stopPropagation();
      }
      shownRef.current = false;
      setOn(false);
      arm();
    };
    const evs = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'] as const;
    evs.forEach((t) => window.addEventListener(t, wake, { capture: true }));
    arm();
    return () => {
      window.clearTimeout(timer.current);
      evs.forEach((t) => window.removeEventListener(t, wake, { capture: true }));
    };
  }, [blocked, minutes]);

  useEffect(() => {
    if (!on) return;
    api.items.query({ type: 'movie,show', sort: 'random', limit: 30 }).then((r) => setSlides(r.items.filter((x) => x.backdropUrl))).catch(() => setSlides([]));
    setI(0);
    const t = window.setInterval(() => setI((n) => n + 1), SLIDE_MS);
    return () => window.clearInterval(t);
  }, [on]);

  shownRef.current = on && slides.length > 0;
  if (!on || !slides.length) return null;
  const cur = slides[i % slides.length];
  return (
    <div className="ambient" aria-hidden="true">
      <div key={cur.id} className="ambient-slide">
        <Img src={cur.backdropUrl} width={1920} alt="" />
      </div>
      <div className="ambient-caption">
        {cur.logoUrl ? <Img src={cur.logoUrl} width={480} alt="" className="ambient-logo" /> : <strong>{cur.title}</strong>}
        <span className="ambient-clock">{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    </div>
  );
}
