import type { ClientEvent, ServerEvent } from '@mediamax/shared';
import { getToken } from './client';

type Handler = (ev: ServerEvent) => void;

class Realtime {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private statusHandlers = new Set<(open: boolean) => void>();
  private retry = 0;
  private timer: number | null = null;
  private pingTimer: number | null = null;
  private wanted = false;
  private queue: ClientEvent[] = [];
  open = false;

  connect() {
    this.wanted = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const token = getToken();
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/api/v1/ws?token=${encodeURIComponent(token)}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setOpen(true);
      const q = this.queue;
      this.queue = [];
      q.forEach((e) => this.send(e));
      this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), 30000);
    };
    ws.onmessage = (msg) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(String(msg.data)) as ServerEvent;
      } catch {
        return;
      }
      this.handlers.forEach((h) => {
        try {
          h(ev);
        } catch (e) {
          console.error('[ws handler]', e);
        }
      });
    };
    ws.onclose = () => {
      if (this.pingTimer) window.clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      this.setOpen(false);
      if (this.wanted) this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private setOpen(open: boolean) {
    this.open = open;
    this.statusHandlers.forEach((h) => h(open));
  }

  private scheduleReconnect() {
    if (this.timer) return;
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.wanted) this.connect();
    }, delay);
  }

  disconnect() {
    this.wanted = false;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
  }

  reconnect() {
    this.disconnect();
    this.connect();
  }

  send(ev: ClientEvent) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(ev));
    else if (ev.type !== 'ping') {
      this.queue.push(ev);
      this.connect();
    }
  }

  subscribe(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  onStatus(h: (open: boolean) => void): () => void {
    this.statusHandlers.add(h);
    return () => this.statusHandlers.delete(h);
  }
}

export const realtime = new Realtime();
