/** Auto-reconnecting realtime socket (`/api/v1/ws?token=`). */
import type { ClientEvent, ServerEvent } from './types';

type Listener = (e: ServerEvent) => void;

/** Close code the server uses for a missing, revoked or no-longer-valid session (server/src/routes/ws.ts). */
export const WS_UNAUTHORIZED = 4001;

export class RealtimeSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private openListeners = new Set<() => void>();
  private retry = 0;
  private closed = false;
  /** Stopped after an auth rejection, waiting for resume(). */
  private paused = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * `onUnauthorized`: the server closed the socket with WS_UNAUTHORIZED. The socket stops reconnecting (it would be
   * rejected forever) until `resume()`; the owner checks the session (sign out on 401, else resume).
   */
  constructor(private url: string, private opts: { onUnauthorized?: () => void } = {}) {}

  start() {
    this.closed = false;
    this.open();
  }

  private open() {
    if (this.closed) return;
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.retry = 0;
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 25000);
      this.openListeners.forEach((l) => l());
    };
    this.ws.onmessage = (msg) => {
      try {
        const evt = JSON.parse(String(msg.data)) as ServerEvent;
        this.listeners.forEach((l) => l(evt));
      } catch {
        /* ignore malformed frames */
      }
    };
    this.ws.onclose = (e) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (e?.code === WS_UNAUTHORIZED && this.opts.onUnauthorized) {
        this.paused = true;
        this.opts.onUnauthorized();
        return;
      }
      this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  /** Reconnect (with the usual backoff) after onUnauthorized found the session still valid or could not check it. */
  resume() {
    if (this.closed || !this.paused) return;
    this.paused = false;
    this.scheduleReconnect();
  }

  send(evt: ClientEvent) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(evt));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Called on every (re)connect, e.g. to rejoin a watch-together room. */
  onOpen(l: () => void): () => void {
    this.openListeners.add(l);
    return () => this.openListeners.delete(l);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  stop() {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
