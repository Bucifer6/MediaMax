/** Auto-reconnecting realtime socket (`/api/v1/ws?token=`). */
import type { ClientEvent, ServerEvent } from './types';

type Listener = (e: ServerEvent) => void;

export class RealtimeSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private retry = 0;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private url: string) {}

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
    };
    this.ws.onmessage = (msg) => {
      try {
        const evt = JSON.parse(String(msg.data)) as ServerEvent;
        this.listeners.forEach((l) => l(evt));
      } catch {
        /* ignore malformed frames */
      }
    };
    this.ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
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

  send(evt: ClientEvent) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(evt));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  stop() {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
