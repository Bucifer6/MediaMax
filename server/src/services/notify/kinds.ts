/**
 * Notification agent kinds and their settings fields. No runtime imports, so settings.ts can use it for masking.
 */
import type { NotificationAgent, NotificationAgentKind, NotificationAgentKindInfo, NotifyEvent } from '@mediamax/shared';

export const MASK = '••••';

export const AGENT_KINDS: NotificationAgentKindInfo[] = [
  { kind: 'discord', label: 'Discord', fields: [
    { key: 'webhookUrl', label: 'Webhook URL', secret: true, required: true, placeholder: 'https://discord.com/api/webhooks/…', hint: 'Channel settings → Integrations → Webhooks.' },
    { key: 'username', label: 'Bot name', placeholder: 'MediaMax' },
  ] },
  { kind: 'slack', label: 'Slack', fields: [
    { key: 'webhookUrl', label: 'Incoming webhook URL', secret: true, required: true, placeholder: 'https://hooks.slack.com/services/…' },
  ] },
  { kind: 'telegram', label: 'Telegram', fields: [
    { key: 'botToken', label: 'Bot token', secret: true, required: true, hint: 'From @BotFather.' },
    { key: 'chatId', label: 'Chat ID', required: true, placeholder: '-1001234567890' },
  ] },
  { kind: 'ntfy', label: 'ntfy', fields: [
    { key: 'server', label: 'Server', placeholder: 'https://ntfy.sh' },
    { key: 'topic', label: 'Topic', required: true },
    { key: 'token', label: 'Access token', secret: true, hint: 'Optional, for protected topics.' },
  ] },
  { kind: 'gotify', label: 'Gotify', fields: [
    { key: 'server', label: 'Server URL', required: true, placeholder: 'https://gotify.example.com' },
    { key: 'token', label: 'Application token', secret: true, required: true },
    { key: 'priority', label: 'Priority', placeholder: '5' },
  ] },
  { kind: 'pushover', label: 'Pushover', fields: [
    { key: 'token', label: 'Application token', secret: true, required: true },
    { key: 'userKey', label: 'User or group key', secret: true, required: true },
  ] },
  { kind: 'email', label: 'Email (SMTP)', fields: [
    { key: 'host', label: 'SMTP host', required: true, placeholder: 'smtp.example.com' },
    { key: 'port', label: 'Port', placeholder: '587', hint: '465 = TLS; anything else upgrades with STARTTLS when offered.' },
    { key: 'username', label: 'Username' },
    { key: 'password', label: 'Password', secret: true },
    { key: 'from', label: 'From address', required: true, placeholder: 'mediamax@example.com' },
    { key: 'to', label: 'Send to', placeholder: 'admin@example.com, other@example.com', hint: 'Comma separated. Request/issue owners are not emailed individually.' },
    { key: 'insecure', label: 'Allow self-signed certificates', placeholder: 'false' },
  ] },
  { kind: 'webhook', label: 'JSON webhook', fields: [
    { key: 'url', label: 'URL', secret: true, required: true, placeholder: 'https://example.com/hook' },
    { key: 'authHeader', label: 'Authorization header', secret: true, hint: 'Optional, sent as-is.' },
  ] },
];

export const NOTIFY_EVENTS: NotifyEvent[] = [
  'request.pending', 'request.auto_approved', 'request.approved', 'request.declined', 'request.available', 'request.failed', 'request.comment',
  'issue.created', 'issue.comment', 'issue.resolved', 'issue.reopened',
];

const secretKeys = (kind: NotificationAgentKind) => new Set((AGENT_KINDS.find((k) => k.kind === kind)?.fields ?? []).filter((f) => f.secret).map((f) => f.key));

/** Agents as sent to the admin UI: secret fields read back as the mask. */
export function maskAgents(list: NotificationAgent[] | undefined): NotificationAgent[] {
  return (list ?? []).map((a) => {
    const s = secretKeys(a.kind);
    return { ...a, config: Object.fromEntries(Object.entries(a.config ?? {}).map(([k, v]) => [k, s.has(k) && v ? MASK : v])) };
  });
}

/** Normalise agents from a settings save; the mask keeps the stored secret. */
export function mergeAgents(next: unknown, prev: NotificationAgent[] | undefined, newId: () => string): NotificationAgent[] {
  if (!Array.isArray(next)) return prev ?? [];
  return next.slice(0, 50).flatMap((x: any): NotificationAgent[] => {
    const kind = AGENT_KINDS.find((k) => k.kind === x?.kind)?.kind;
    if (!kind) return [];
    const id = typeof x.id === 'string' && x.id ? x.id.slice(0, 64) : newId();
    const old = (prev ?? []).find((p) => p.id === id);
    const fields = AGENT_KINDS.find((k) => k.kind === kind)!.fields;
    const config: Record<string, string> = {};
    for (const f of fields) {
      const v = x.config?.[f.key];
      if (v === MASK) config[f.key] = old?.config?.[f.key] ?? '';
      else if (v != null && v !== '') config[f.key] = String(v).slice(0, 2000);
    }
    return [{
      id, kind, name: String(x.name ?? '').slice(0, 80) || AGENT_KINDS.find((k) => k.kind === kind)!.label, enabled: x.enabled !== false,
      events: Array.isArray(x.events) ? x.events.filter((e: unknown) => NOTIFY_EVENTS.includes(e as NotifyEvent)) : [...NOTIFY_EVENTS], config,
    }];
  });
}
