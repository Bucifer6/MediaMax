/**
 * TV mode for the web app (Samsung Tizen, LG webOS, Fire TV/Android TV browsers, set-top boxes).
 *
 * Turned on by `?tv=1` (remembered), a TV user agent, or the Tizen/webOS wrapper apps in /tv.
 * - Arrow keys move focus to the nearest focusable element in that direction (spatial navigation).
 * - Enter/OK clicks; the remote's Back key goes back (or closes a dialog).
 * - Media keys (play/pause/stop/ff/rew) are forwarded as the keyboard shortcuts the players already understand.
 * - `html.tv` enables the 10-foot CSS (bigger focus rings, larger hit targets, no hover-only controls).
 */

const KEY = 'mm.tv';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), video[controls]';

// Remote key codes: Tizen (10009 back, 10252 play/pause, 415 play, 19 pause, 413 stop, 417 ff, 412 rew), webOS (461 back).
const BACK = new Set([10009, 461, 8]);
const MEDIA: Record<number, string> = { 10252: ' ', 415: ' ', 19: ' ', 179: ' ', 413: 'Escape', 417: 'ArrowRight', 412: 'ArrowLeft', 228: 'ArrowRight', 227: 'ArrowLeft' };

export function detectTv(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get('tv');
    if (q === '1') localStorage.setItem(KEY, '1');
    if (q === '0') localStorage.removeItem(KEY);
    if (localStorage.getItem(KEY) === '1') return true;
  } catch {
    /* storage blocked */
  }
  return /SMART-TV|Tizen|Web0S|WebOS|NetCast|AFT[A-Z]|BRAVIA|HbbTV|CrKey|GoogleTV|Android TV/i.test(navigator.userAgent);
}

type Dir = 'up' | 'down' | 'left' | 'right';

function visible(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
}

/** The scope focus should stay in: the top-most open dialog, otherwise the whole document. */
function scope(): ParentNode {
  const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')].filter(visible);
  return dialogs[dialogs.length - 1] ?? document;
}

function candidates(): HTMLElement[] {
  return [...scope().querySelectorAll(FOCUSABLE)].filter(visible).filter((el) => !el.closest('[aria-hidden="true"], [inert]'));
}

function best(from: DOMRect, dir: Dir, els: HTMLElement[], current: Element | null): HTMLElement | null {
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let pick: HTMLElement | null = null;
  let score = Infinity;
  for (const el of els) {
    if (el === current) continue;
    const r = el.getBoundingClientRect();
    const ex = r.left + r.width / 2;
    const ey = r.top + r.height / 2;
    const dx = ex - cx;
    const dy = ey - cy;
    // Must lie in the requested half-plane (with a little tolerance for overlapping edges).
    if (dir === 'right' && r.left < from.right - 4) continue;
    if (dir === 'left' && r.right > from.left + 4) continue;
    if (dir === 'down' && r.top < from.bottom - 4) continue;
    if (dir === 'up' && r.bottom > from.top + 4) continue;
    const primary = dir === 'left' || dir === 'right' ? Math.abs(dx) : Math.abs(dy);
    // Overlap on the cross axis keeps rows/columns together.
    const overlap = dir === 'left' || dir === 'right'
      ? Math.max(0, Math.min(from.bottom, r.bottom) - Math.max(from.top, r.top))
      : Math.max(0, Math.min(from.right, r.right) - Math.max(from.left, r.left));
    const cross = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    // Without overlap, stay within a ~30° cone so focus never jumps to the far corner of the screen.
    if (overlap <= 0 && cross > primary * 0.6) continue;
    const s = primary + (overlap > 0 ? 0 : cross * 2.5);
    if (s < score) {
      score = s;
      pick = el;
    }
  }
  return pick;
}

function isTextInput(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(el.type);
}

function move(dir: Dir): boolean {
  const els = candidates();
  if (!els.length) return false;
  const cur = document.activeElement instanceof HTMLElement && document.activeElement !== document.body && els.includes(document.activeElement) ? document.activeElement : null;
  if (!cur) {
    // Nothing focused yet: start in the page content (not the sidebar/top bar), at the first element on screen.
    const onScreen = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.top < window.innerHeight;
    };
    const main = document.querySelector('main');
    const first = els.find((el) => main?.contains(el) && onScreen(el) && el.matches('.btn-primary')) ?? els.find((el) => main?.contains(el) && onScreen(el)) ?? els.find(onScreen) ?? els[0];
    first.focus({ preventScroll: false });
    return true;
  }
  const next = best(cur.getBoundingClientRect(), dir, els, cur);
  if (!next) return false;
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  return true;
}

const DIRS: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

export function installTvMode() {
  document.documentElement.classList.add('tv');
  // Ask the platforms for the media keys (they're swallowed by the system otherwise).
  const w = window as unknown as { tizen?: { tvinputdevice?: { registerKeyBatch?: (k: string[]) => void } } };
  try {
    w.tizen?.tvinputdevice?.registerKeyBatch?.(['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind']);
  } catch {
    /* not on Tizen */
  }

  window.addEventListener('keydown', (e) => {
    const target = e.target as Element | null;
    const inPlayer = !!document.querySelector('video') && !!document.querySelector('.player, .live-player, .mv-shell');

    // Back key.
    if (BACK.has(e.keyCode) && !(e.keyCode === 8 && isTextInput(target))) {
      e.preventDefault();
      // An open dialog/picker closes on Escape; otherwise go back a page (players exit the same way).
      if (scope() !== document) (target ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      else if (window.history.length > 1) window.history.back();
      return;
    }
    // Media keys → the shortcuts the players use.
    const mk = MEDIA[e.keyCode];
    if (mk && !DIRS[e.key]) {
      e.preventDefault();
      (target ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: mk, bubbles: true, cancelable: true }));
      return;
    }
    const dir = DIRS[e.key];
    if (!dir || e.altKey || e.ctrlKey || e.metaKey) return;
    // Let text fields keep left/right for the caret, ranges/selects their own arrows, and the video players their seek/volume keys.
    if (isTextInput(target) && (dir === 'left' || dir === 'right')) return;
    if (target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type === 'range')) return;
    if (inPlayer && (!target || target === document.body || target.tagName === 'VIDEO')) return;
    if (move(dir)) e.preventDefault();
  }, true);

  // Enter on a focused non-button element (cards are often divs with onClick + tabindex).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented) return;
    const el = document.activeElement as HTMLElement | null;
    if (el && el !== document.body && el.getAttribute('role') !== 'textbox' && !isTextInput(el) && !(el instanceof HTMLButtonElement) && !(el instanceof HTMLAnchorElement)) {
      e.preventDefault();
      el.click();
    }
  });
}
