/**
 * Programme reminders ("Remind me" in the guide). Kept on this device (localStorage); while Vibe is open, a toast
 * (and a system notification when the viewer allowed them) fires a minute before the programme starts.
 * The watcher arms itself when this module is first imported.
 */
import type { Channel, Program } from '@mediamax/shared';

export interface Reminder {
  programId: string;
  channelId: string;
  channelName: string;
  title: string;
  start: string;
}

const KEY = 'vibe.reminders';
const LEAD_MS = 60000;
const listeners = new Set<() => void>();

function read(): Reminder[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]') as Reminder[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function write(list: Reminder[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode: reminders last for this page only */
  }
  mem = list;
  listeners.forEach((l) => l());
}
let mem: Reminder[] = read();

export const reminders = () => mem;
export const hasReminder = (programId: string) => mem.some((r) => r.programId === programId);
export function subscribeReminders(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function toggleReminder(p: Program, c: Pick<Channel, 'id' | 'name'> | null): boolean {
  if (hasReminder(p.id)) {
    write(mem.filter((r) => r.programId !== p.id));
    return false;
  }
  write([...mem.filter((r) => Date.parse(r.start) > Date.now() - 3600000), { programId: p.id, channelId: p.channelId, channelName: c?.name ?? '', title: p.title, start: p.start }]);
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission().catch(() => undefined);
  return true;
}

function check() {
  const now = Date.now();
  const due = mem.filter((r) => Date.parse(r.start) - LEAD_MS <= now);
  if (!due.length) return;
  write(mem.filter((r) => !due.includes(r)));
  for (const r of due) {
    if (Date.parse(r.start) < now - 30 * 60000) continue; // long gone (the tab was closed)
    const message = `${r.title} starts ${Date.parse(r.start) > now ? 'in a minute' : 'now'}${r.channelName ? ` on ${r.channelName}` : ''}`;
    window.dispatchEvent(new CustomEvent('mm:toast', { detail: { message, kind: 'info', ms: 12000 } }));
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        const n = new Notification(r.title, { body: message, tag: `vibe-remind-${r.programId}` });
        n.onclick = () => {
          window.focus();
          window.location.assign(`/watch/live/${encodeURIComponent(r.channelId)}`);
        };
      }
    } catch {
      /* notifications unavailable */
    }
  }
}

if (typeof window !== 'undefined') {
  window.setInterval(check, 15000);
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      mem = read();
      listeners.forEach((l) => l());
    }
  });
}
