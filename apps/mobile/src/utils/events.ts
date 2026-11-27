/** Tiny app-wide event bus (userdata updates, recording updates, etc.). */
import type { Recording, UserItemData } from '@/api/types';

type AppEvents = {
  userdata: { itemId: string; userData: UserItemData };
  recording: Recording;
  libraryUpdated: { libraryId: string };
  sessionTerminated: { sessionId: string; reason: string };
  /** A phone paired with (or unpaired from) this device. */
  pairUpdated: { status: string };
  /** A new in-app notification arrived (or the unread count changed). */
  notification: { unread: number };
};

type Handler<T> = (payload: T) => void;
const handlers: { [K in keyof AppEvents]?: Set<Handler<AppEvents[K]>> } = {};

export function emit<K extends keyof AppEvents>(name: K, payload: AppEvents[K]) {
  (handlers[name] as Set<Handler<AppEvents[K]>> | undefined)?.forEach((h) => h(payload));
}

export function on<K extends keyof AppEvents>(name: K, h: Handler<AppEvents[K]>): () => void {
  let set = handlers[name] as Set<Handler<AppEvents[K]>> | undefined;
  if (!set) {
    set = new Set();
    (handlers as Record<string, unknown>)[name] = set;
  }
  set.add(h);
  return () => set!.delete(h);
}
