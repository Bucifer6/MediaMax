/**
 * Outbound notification agents: Discord, Slack, Telegram, ntfy, Gotify, Pushover, email (SMTP) and a JSON webhook.
 * Each agent has per-event toggles (ServerSettings.notificationAgents). Self-contained so a later reporting/notifications
 * effort can add events or agents here.
 */
import type { NotificationAgent, NotificationTestResult, NotifyEvent } from '@mediamax/shared';
import { getKv, getSettings } from '../settings.js';
import { config } from '../../config.js';
import { logger } from '../../util/log.js';
import { sendMail } from './smtp.js';

const log = logger('notify');

export interface NotifyMessage {
  event: NotifyEvent;
  title: string;
  body: string;
  /** Absolute link (when the server's public URL is known). */
  url?: string | null;
  imageUrl?: string | null;
  fields?: { name: string; value: string }[];
  /** Extra JSON for the webhook agent. */
  data?: Record<string, unknown>;
}

const UA = () => `Kinora/${config.version}`;

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA(), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}${await res.text().then((t) => (t ? `: ${t.slice(0, 200)}` : '')).catch(() => '')}`);
}

const COLORS: Partial<Record<NotifyEvent, number>> = {
  'request.pending': 0xf5a623, 'request.auto_approved': 0x5b8def, 'request.approved': 0x5b8def, 'request.available': 0x2ecc71,
  'request.declined': 0x95a5a6, 'request.failed': 0xe74c3c, 'issue.created': 0xe67e22, 'issue.resolved': 0x2ecc71,
};

const plain = (m: NotifyMessage) => [m.body, ...(m.fields ?? []).map((f) => `${f.name}: ${f.value}`), m.url ?? ''].filter(Boolean).join('\n');
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The server's app icon (uploaded in Branding, else the stock Kinora icon) as an absolute URL, when the public URL is known. */
function avatarUrl(): string | null {
  const base = getSettings().publicUrl?.replace(/\/+$/, '');
  if (!base) return null;
  const icon = getKv<{ appIconUrl?: string | null }>('branding', {}).appIconUrl;
  return icon ? (/^https?:/.test(icon) ? icon : base + icon) : `${base}/icon-192.png`;
}

/** Send one message through one agent (throws on failure). */
export async function sendWith(agent: NotificationAgent, m: NotifyMessage): Promise<void> {
  const c = agent.config ?? {};
  switch (agent.kind) {
    case 'discord':
      return post(c.webhookUrl, {
        username: c.username || getSettings().serverName || 'Kinora',
        ...(avatarUrl() ? { avatar_url: avatarUrl() } : {}),
        embeds: [{
          title: m.title, description: m.body, url: m.url || undefined, color: COLORS[m.event] ?? 0x9198ff,
          fields: (m.fields ?? []).slice(0, 10).map((f) => ({ name: f.name, value: f.value.slice(0, 1000) || '—', inline: true })),
          ...(m.imageUrl ? { thumbnail: { url: m.imageUrl } } : {}), timestamp: new Date().toISOString(),
        }],
      });
    case 'slack':
      return post(c.webhookUrl, { text: `*${m.title}*\n${plain(m)}` });
    case 'telegram':
      return post(`https://api.telegram.org/bot${encodeURIComponent(c.botToken)}/sendMessage`, {
        chat_id: c.chatId, parse_mode: 'HTML', disable_web_page_preview: true,
        text: `<b>${escHtml(m.title)}</b>\n${escHtml(plain(m))}`,
      });
    case 'ntfy': {
      const server = (c.server || 'https://ntfy.sh').replace(/\/+$/, '');
      return post(server, { topic: c.topic, title: m.title, message: plain(m), ...(m.url ? { click: m.url } : {}), tags: [m.event.split('.')[0]] }, c.token ? { Authorization: `Bearer ${c.token}` } : {});
    }
    case 'gotify':
      return post(`${c.server.replace(/\/+$/, '')}/message`, { title: m.title, message: plain(m), priority: Number(c.priority) || 5 }, { 'X-Gotify-Key': c.token });
    case 'pushover':
      return post('https://api.pushover.net/1/messages.json', { token: c.token, user: c.userKey, title: m.title, message: plain(m), ...(m.url ? { url: m.url } : {}) });
    case 'email': {
      const to = String(c.to || '').split(/[,;\s]+/).filter((x) => /@/.test(x));
      if (!to.length) throw new Error('No recipients');
      return sendMail({
        host: c.host, port: Number(c.port) || 587, username: c.username || null, password: c.password || null, insecure: /^(1|true|yes)$/i.test(c.insecure ?? ''),
      }, { from: c.from, to, subject: m.title, text: plain(m) });
    }
    case 'webhook':
      return post(c.url, { event: m.event, title: m.title, message: m.body, url: m.url ?? null, image: m.imageUrl ?? null, fields: m.fields ?? [], ...(m.data ?? {}), at: new Date().toISOString() }, c.authHeader ? { Authorization: c.authHeader } : {});
  }
}

/** Fan a message out to every enabled agent subscribed to its event (fire-and-forget). Returns the agent count. */
export function dispatch(m: NotifyMessage): Promise<{ id: string; ok: boolean; error?: string }[]> {
  const agents = (getSettings().notificationAgents ?? []).filter((a) => a.enabled && a.events.includes(m.event));
  return Promise.all(agents.map((a) => sendWith(a, m).then(() => ({ id: a.id, ok: true })).catch((e) => {
    log.warn(`${a.kind} agent "${a.name}" failed for ${m.event}: ${(e as Error).message}`);
    return { id: a.id, ok: false, error: (e as Error).message };
  })));
}

/** Test button: send a sample message through an agent (the saved one with this id, or an unsaved draft). */
export async function testAgent(agent: NotificationAgent): Promise<NotificationTestResult> {
  try {
    await sendWith(agent, {
      event: 'test', title: `Test from ${getSettings().serverName || 'Kinora'}`, body: 'Notifications from Kinora work. 🎬',
      fields: [{ name: 'Agent', value: agent.name || agent.kind }],
    });
    return { ok: true, message: 'Sent' };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Absolute link for a path when the public URL is set. */
export const publicLink = (path: string) => {
  const base = getSettings().publicUrl?.replace(/\/+$/, '');
  return base ? `${base}${path}` : null;
};
