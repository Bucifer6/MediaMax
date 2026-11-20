/**
 * Two <video> elements for seamless stream switches: the "standby" element loads the new stream (another bitrate, or
 * direct play ↔ transcode) while the active one keeps playing from its buffer; then they swap.
 * Elements are created imperatively inside a host <div> owned by the player.
 */
export class VideoPair {
  private els: [HTMLVideoElement, HTMLVideoElement];
  private activeIdx = 0;

  constructor(host: HTMLElement, className: string) {
    const make = () => {
      const v = document.createElement('video');
      v.className = className;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.crossOrigin = 'anonymous';
      v.preload = 'auto';
      v.setAttribute('x-webkit-airplay', 'allow');
      host.appendChild(v);
      return v;
    };
    this.els = [make(), make()];
    this.els[1].classList.add('standby');
  }

  get active(): HTMLVideoElement {
    return this.els[this.activeIdx];
  }

  get standby(): HTMLVideoElement {
    return this.els[1 - this.activeIdx];
  }

  /** Make the standby element the active one (visible, on top); the old one is hidden and emptied by the caller. */
  swap(): HTMLVideoElement {
    this.active.classList.add('standby');
    this.activeIdx = 1 - this.activeIdx;
    this.active.classList.remove('standby');
    return this.active;
  }

  destroy() {
    for (const v of this.els) {
      try {
        v.pause();
        v.removeAttribute('src');
        v.load();
      } catch {
        /* ignore */
      }
      v.remove();
    }
  }
}

/** Resolve when `el` can play at its current position, or false after `timeoutMs`. */
export function whenPlayable(el: HTMLMediaElement, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (el.readyState >= 3 && !el.seeking) return resolve(true);
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.clearTimeout(t);
      el.removeEventListener('canplay', check);
      el.removeEventListener('seeked', check);
      el.removeEventListener('error', fail);
      resolve(ok);
    };
    const check = () => {
      if (el.readyState >= 3 && !el.seeking) finish(true);
    };
    const fail = () => finish(false);
    const t = window.setTimeout(() => finish(false), timeoutMs);
    el.addEventListener('canplay', check);
    el.addEventListener('seeked', check);
    el.addEventListener('error', fail);
  });
}

/** Seconds buffered ahead of the playhead. */
export function bufferAhead(v: HTMLMediaElement): number {
  const t = v.currentTime;
  for (let i = 0; i < v.buffered.length; i++) {
    if (v.buffered.start(i) <= t + 0.25 && v.buffered.end(i) >= t) return v.buffered.end(i) - t;
  }
  return 0;
}
