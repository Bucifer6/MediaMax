/**
 * "A DJ mix is playing" flag for the nav's live dot. Kept apart from djEngine so the app shell doesn't load (and
 * construct) the whole DJ engine just to show a dot: the engine publishes here once someone opens DJ mode.
 */
type Listener = (live: boolean) => void;
const listeners = new Set<Listener>();
let live = false;

export const djLive = {
  get: () => live,
  set(v: boolean) {
    if (v === live) return;
    live = v;
    for (const l of listeners) l(v);
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    fn(live);
    return () => {
      listeners.delete(fn);
    };
  },
};
