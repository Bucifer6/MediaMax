import { Fragment, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { isTypingTarget } from '../hooks';
import { REMOTE_HELP } from '../tv/spatial';
import { Modal } from './ui';
import { Icon } from './Icon';

const OPEN_EVENT = 'mm:shortcuts';
/** Open the shortcuts dialog from anywhere (e.g. the Help Centre's "Keyboard shortcuts" button). */
export const openShortcuts = () => window.dispatchEvent(new CustomEvent(OPEN_EVENT));

type Row = [keys: string[], action: string];
interface Group { title: string; rows: Row[] }

/* Gathered from the key handlers: components/Layout.tsx (/), player/VideoPlayer.tsx, player/LivePlayer.tsx, player/Multiview.tsx. */
const GLOBAL: Group = {
  title: 'Everywhere',
  rows: [
    [['/'], 'Search'],
    [['?'], 'Show this list'],
    [['Esc'], 'Close a dialog or menu'],
  ],
};

const VIDEO: Group = {
  title: 'Video player',
  rows: [
    [['Space', 'K'], 'Play / pause'],
    [['←', 'J'], 'Back 10 seconds (Shift: 30)'],
    [['→', 'L'], 'Forward 10 seconds (Shift: 30)'],
    [['↑', '↓'], 'Volume up / down'],
    [['0', '…', '9'], 'Jump to 0–90 %'],
    [['F'], 'Fullscreen'],
    [['M'], 'Mute'],
    [['P'], 'Picture-in-picture'],
    [['C'], 'Next subtitle track'],
    [['A'], 'Next audio track'],
    [['G', 'H'], 'Subtitles 0.1 s earlier / later'],
    [['<', '>'], 'Slower / faster'],
    [['N'], 'Next episode'],
    [['I'], 'Stats for nerds'],
    [['Esc'], 'Close a menu, or leave the player'],
  ],
};

const LIVE: Group = {
  title: 'Live TV player',
  rows: [
    [['↑', '↓'], 'Previous / next channel (also Page Up / Page Down)'],
    [['0', '…', '9'], 'Type a channel number'],
    [['Enter'], 'Switch to the channel now'],
    [['Space', 'K'], 'Play / pause'],
    [['←', '→'], 'Catch-up: back / forward 10 seconds'],
    [['L', 'I'], 'Channel list'],
    [['G'], 'TV guide'],
    [['C'], 'Captions on / off'],
    [['F'], 'Fullscreen'],
    [['M'], 'Mute'],
    [['Esc'], 'Close the list, or leave'],
  ],
};

const MULTIVIEW: Group = {
  title: 'Multiview',
  rows: [
    [['1', '…', '4'], 'Give a tile the sound'],
    [['Tab'], 'Next tile (Shift: previous)'],
    [['F'], 'Fullscreen'],
    [['Esc'], 'Leave multiview'],
  ],
};

function groupsFor(path: string): Group[] {
  if (path.startsWith('/play/')) return [VIDEO, GLOBAL];
  if (path.startsWith('/watch/live')) return [LIVE, GLOBAL];
  if (path.startsWith('/watch/multiview')) return [MULTIVIEW, GLOBAL];
  return [GLOBAL, VIDEO, LIVE];
}

/** Listens for "?" (never while typing) and shows the keyboard shortcuts, or the remote-control guide in TV mode. */
export function ShortcutsHost() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    const ev = () => setOpen(true);
    window.addEventListener('keydown', key);
    window.addEventListener(OPEN_EVENT, ev);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener(OPEN_EVENT, ev);
    };
  }, []);
  useEffect(() => setOpen(false), [loc.pathname]);
  if (!open) return null;
  const tv = document.documentElement.classList.contains('tv');
  // In a fullscreen player the dialog must live inside the fullscreen element to be visible.
  const container = document.fullscreenElement ?? undefined;
  return (
    <Modal open onClose={() => setOpen(false)} title={tv ? 'Remote control' : 'Keyboard shortcuts'} size="lg" className="shortcuts-modal" container={container}>
      {tv ? (
        <>
          <p className="muted">Arrow keys move the highlight, <kbd>OK</kbd> selects, <kbd>Back</kbd> goes back.</p>
          <dl className="shortcut-list">
            {REMOTE_HELP.map((k) => <Fragment key={k.keys}><dt>{k.keys}</dt><dd>{k.action}</dd></Fragment>)}
          </dl>
        </>
      ) : (
        <div className="shortcut-groups">
          {groupsFor(loc.pathname).map((g) => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              <dl className="shortcut-list">
                {g.rows.map(([keys, action]) => (
                  <Fragment key={action}>
                    <dt>{keys.map((k, i) => (k === '…' ? <span key={i} className="muted">–</span> : <kbd key={i}>{k}</kbd>))}</dt>
                    <dd>{action}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
      <p className="shortcuts-foot muted small">
        <Link to={tv ? '/help/remote-buttons' : '/help/playing-videos'} onClick={() => setOpen(false)}><Icon name="help" size={14} /> {tv ? 'Remote control buttons' : 'More in the Help Centre'}</Link>
      </p>
    </Modal>
  );
}
