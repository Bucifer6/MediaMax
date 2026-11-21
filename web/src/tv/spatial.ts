/**
 * TV mode for the web app (Samsung Tizen, LG webOS, Fire TV/Android TV browsers, set-top boxes).
 *
 * Turned on by `?tv=1` (remembered), a TV user agent, or the Tizen/webOS wrapper apps in /tv.
 * - Arrow keys move focus to the nearest focusable element in that direction (spatial navigation).
 * - Enter/OK clicks; the remote's Back key goes back (or closes a dialog). On the home screen the first Back shows
 *   "Press Back again to exit" and a second Back within 2 s leaves the app (web/src/tv/backExit.ts).
 * - Media keys (play/pause/stop/ff/rew) are forwarded as the keyboard shortcuts the players already understand.
 * - `html.tv` enables the 10-foot CSS (bigger focus rings, larger hit targets, no hover-only controls).
 */

import { createBackToExit, EXIT_MESSAGE, EXIT_WINDOW_MS, exitApp, isHomeScreen } from './backExit';

const KEY = 'mm.tv';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), video[controls]';

// Remote key codes: Tizen (10009 back, 10182 exit), webOS (461 back), plus Backspace.
const BACK = new Set([10009, 461, 8]);

/**
 * TV remote / HDMI-CEC / Bluetooth remote keys, normalised to KeyboardEvent.key names. Browsers on Android TV and
 * Fire TV already send the standard `key` values; Tizen and webOS send vendor key codes.
 */
const REMOTE: Record<number, string> = {
  10252: 'MediaPlayPause', 179: 'MediaPlayPause', 415: 'MediaPlay', 19: 'MediaPause', 413: 'MediaStop', 178: 'MediaStop',
  417: 'MediaFastForward', 228: 'MediaFastForward', 412: 'MediaRewind', 227: 'MediaRewind',
  10233: 'MediaTrackNext', 176: 'MediaTrackNext', 10232: 'MediaTrackPrevious', 177: 'MediaTrackPrevious',
  427: 'ChannelUp', 428: 'ChannelDown',
  403: 'ColorF0Red', 404: 'ColorF1Green', 405: 'ColorF2Yellow', 406: 'ColorF3Blue',
  457: 'Info', 458: 'Guide', 10221: 'ClosedCaptionToggle', 10073: 'ChannelList',
};
const REMOTE_KEYS = new Set(Object.values(REMOTE).concat(['MediaPlay', 'MediaPause', 'Subtitle']));

/** Keys the Tizen wrapper / web app register (`tizen.tvinputdevice.registerKey`); unknown names are skipped. */
export const TIZEN_KEYS = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind', 'MediaTrackNext', 'MediaTrackPrevious',
  'ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info', 'Guide', 'Caption', 'ChannelList',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** On-screen help for the remote (TV mode help dialog / Settings). */
export const REMOTE_HELP: { keys: string; action: string }[] = [
  { keys: 'Play / Pause / Stop', action: 'Control playback (Stop leaves the player)' },
  { keys: 'Fast-forward / Rewind', action: 'Skip 10 s forward / back' },
  { keys: 'Next / Previous', action: 'Next episode · previous: back 30 s (Live TV: next / previous channel)' },
  { keys: 'Channel + / −', action: 'Change channel in Live TV' },
  { keys: '0–9', action: 'Live TV: type a channel number · videos: jump to 0–90 %' },
  { keys: 'Info', action: 'Show the info overlay (playback details, HDR format)' },
  { keys: 'Guide', action: 'Open the TV guide' },
  { keys: 'Red', action: 'Subtitles on / next language' },
  { keys: 'Green', action: 'Next audio track' },
  { keys: 'Yellow', action: 'Skip intro / credits / ad break' },
  { keys: 'Blue', action: 'Info overlay (Live TV: channel list)' },
  { keys: 'Back', action: 'Close a menu, leave the player, or go back (on Home: press twice to exit)' },
];

const send = (target: Element | null, key: string, shiftKey = false) =>
  (target ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));

function goTo(path: string) {
  // React Router (BrowserRouter) follows popstate.
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Translate a remote key into the shortcuts the players already understand. Returns true when handled. */
function handleRemote(key: string, target: Element | null): boolean {
  const video = document.querySelector('video');
  const live = !!document.querySelector('.live-player');
  const player = !!video && !!document.querySelector('.player, .live-player, .mv-shell');
  const clickSkip = () => {
    const b = document.querySelector<HTMLButtonElement>('.skip-btn');
    if (b) b.click();
    return !!b;
  };
  switch (key) {
    case 'MediaPlayPause': if (!player) return false; send(target, ' '); return true;
    case 'MediaPlay': if (!player) return false; if (video?.paused) send(target, ' '); return true;
    case 'MediaPause': if (!player) return false; if (video && !video.paused) send(target, ' '); return true;
    case 'MediaStop': if (!player) return false; send(target, 'Escape'); return true;
    case 'MediaFastForward': if (!player) return false; send(target, 'ArrowRight'); return true;
    case 'MediaRewind': if (!player) return false; send(target, 'ArrowLeft'); return true;
    case 'MediaTrackNext': if (!player) return false; send(target, live ? 'ChannelDown' : 'n'); return true;
    case 'MediaTrackPrevious': if (!player) return false; send(target, live ? 'ChannelUp' : 'ArrowLeft', !live); return true;
    case 'ChannelUp': case 'ChannelDown':
      if (live) { send(target, key); return true; }
      return false;
    case 'Info': case 'ColorF3Blue':
      if (player) { send(target, 'i'); return true; }
      return false;
    case 'Guide': case 'ChannelList':
      if (live && key === 'ChannelList') { send(target, 'l'); return true; }
      goTo('/livetv/guide');
      return true;
    case 'ColorF0Red': case 'ClosedCaptionToggle': case 'Subtitle': case 'Caption':
      if (player) { send(target, 'c'); return true; }
      return false;
    case 'ColorF1Green':
      if (player && !live) { send(target, 'a'); return true; }
      return false;
    case 'ColorF2Yellow':
      return player ? clickSkip() : false;
  }
  return false;
}

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
  // Non-modal panels (aria-modal="false", e.g. the "What's new" card) don't capture the D-pad.
  const dialogs = [...document.querySelectorAll('[role="dialog"]:not([aria-modal="false"]), [aria-modal="true"], dialog[open]')].filter(visible);
  return dialogs[dialogs.length - 1] ?? document;
}

function candidates(): HTMLElement[] {
  // tabindex="-1" marks controls that are deliberately out of the focus order (hover-only card buttons, row arrows).
  return [...scope().querySelectorAll(FOCUSABLE)].filter(visible).filter((el) => el.getAttribute('tabindex') !== '-1' && !el.closest('[aria-hidden="true"], [inert]'));
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
  const w = window as unknown as { tizen?: { tvinputdevice?: { registerKey?: (k: string) => void } } };
  try {
    // Register one by one so a key a model lacks doesn't fail the whole batch.
    for (const k of TIZEN_KEYS) {
      try {
        w.tizen?.tvinputdevice?.registerKey?.(k);
      } catch {
        /* key not on this model */
      }
    }
  } catch {
    /* not on Tizen */
  }

  const backToExit = createBackToExit();
  window.addEventListener('keydown', (e) => {
    const target = e.target as Element | null;
    const inPlayer = !!document.querySelector('video') && !!document.querySelector('.player, .live-player, .mv-shell');

    // Back key.
    if (BACK.has(e.keyCode) && !(e.keyCode === 8 && isTextInput(target))) {
      e.preventDefault();
      // One press is one step back: the players also listen for Backspace, and both handling it went back twice
      // (player → home instead of player → title page).
      e.stopImmediatePropagation();
      // An open dialog/picker, or a player (its menus first, then the player itself), handles it as Escape;
      // otherwise go back a page.
      if (inPlayer && document.fullscreenElement && scope() === document) void document.exitFullscreen().catch(() => undefined);
      else if (scope() !== document || inPlayer) (target ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      else if (isHomeScreen(window.location.pathname, import.meta.env.BASE_URL)) {
        // Home is the root: Back has nowhere left to go in the app, so it asks before leaving it.
        if (backToExit.press() === 'exit') exitApp(window as unknown as Parameters<typeof exitApp>[0]);
        else window.dispatchEvent(new CustomEvent('mm:toast', { detail: { message: EXIT_MESSAGE, kind: 'info', ms: EXIT_WINDOW_MS } }));
      } else if (window.history.length > 1) window.history.back();
      return;
    }
    // Remote keys (media, channel, colour, info/guide) → the shortcuts the players use.
    if (!e.isTrusted) return; // our own re-dispatched shortcuts
    const rk = REMOTE[e.keyCode] ?? (REMOTE_KEYS.has(e.key) ? e.key : null);
    if (rk && !DIRS[e.key] && !isTextInput(target)) {
      if (handleRemote(rk, target)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    const dir = DIRS[e.key];
    if (!dir || e.altKey || e.ctrlKey || e.metaKey) return;
    // Let text fields keep left/right for the caret, ranges/selects their own arrows, and the video players their seek/volume keys.
    if (isTextInput(target) && (dir === 'left' || dir === 'right')) return;
    // Sliders keep left/right. Selects don't keep any arrow: on a remote that would trap focus in the first select
    // (up/down only changed its value); OK opens the list instead (below).
    if (target instanceof HTMLInputElement && target.type === 'range' && (dir === 'left' || dir === 'right')) return;
    // A focused seek bar (role=slider) steps the position itself, with a trickplay preview.
    if ((dir === 'left' || dir === 'right') && target?.getAttribute?.('role') === 'slider') return;
    // Elements that use the arrows themselves (e.g. the music visualiser stage: left/right switch styles).
    if (target instanceof HTMLElement && target.dataset.ownArrows !== undefined && (dir === 'left' || dir === 'right')) return;
    if (inPlayer && (!target || target === document.body || target.tagName === 'VIDEO')) return;
    if (move(dir)) e.preventDefault();
  }, true);

  // Enter on a focused non-button element (cards are often divs with onClick + tabindex).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented) return;
    const el = document.activeElement as HTMLElement | null;
    if (el instanceof HTMLSelectElement) {
      // OK on a select opens its list (TV browsers also do this natively; showPicker covers desktop Chromium).
      try {
        el.showPicker();
        e.preventDefault();
      } catch {
        /* not supported: leave it to the browser */
      }
      return;
    }
    if (el && el !== document.body && el.getAttribute('role') !== 'textbox' && !isTextInput(el) && !(el instanceof HTMLButtonElement) && !(el instanceof HTMLAnchorElement)) {
      e.preventDefault();
      el.click();
    }
  });
}
