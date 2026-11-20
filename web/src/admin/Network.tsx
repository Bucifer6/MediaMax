import { useEffect, useMemo, useState } from 'react';
import type { NetworkSettings, NetworkStatus } from '@mediamax/shared';
import { http } from '../api/client';
import { useToast } from '../state/toast';
import { Badge, ErrorState, Field, Skeleton, Spinner, useConfirm } from '../components/ui';
import { AdminHeader } from './AdminRoutes';

const api = {
  status: () => http.get<NetworkStatus>('/admin/network'),
  save: (s: Partial<NetworkSettings>) => http.put<NetworkSettings>('/admin/network', s),
};

type Mode = NetworkSettings['mode'];
const MODES: { id: Mode; title: string; text: string }[] = [
  { id: 'direct', title: 'Direct', text: 'Clients connect straight to MediaMax on port 8484 (home network, VPN, Tailscale, or a port forward). The default.' },
  { id: 'proxy', title: 'Behind my reverse proxy', text: 'You already run Nginx, Traefik, Caddy, Nginx Proxy Manager, SWAG or Cloudflare Tunnel. MediaMax only needs to trust it.' },
  { id: 'builtin', title: 'Built-in HTTPS', text: 'MediaMax runs Caddy itself and gets a free Let’s Encrypt certificate. Needs ports 80 and 443 and a domain pointing here.' },
];

/** Copy-ready configs for the common proxies. `up` is how the proxy reaches MediaMax. */
function snippets(domain: string, up: string): { id: string; label: string; code: string }[] {
  return [
    { id: 'nginx', label: 'Nginx', code: `server {
    listen 443 ssl;
    http2 on;
    server_name ${domain};
    # ssl_certificate / ssl_certificate_key …

    client_max_body_size 0;          # uploads, subtitle and artwork changes
    location / {
        proxy_pass http://${up};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;      # live updates, SyncPlay
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;                          # smooth streaming
        proxy_read_timeout 1h;
    }
}
# in the http {} block:
map $http_upgrade $connection_upgrade { default upgrade; '' close; }` },
    { id: 'caddy', label: 'Caddy', code: `${domain} {
    reverse_proxy ${up} {
        flush_interval -1
    }
}` },
    { id: 'traefik', label: 'Traefik (Docker labels)', code: `labels:
  - traefik.enable=true
  - traefik.http.routers.mediamax.rule=Host(\`${domain}\`)
  - traefik.http.routers.mediamax.entrypoints=websecure
  - traefik.http.routers.mediamax.tls.certresolver=letsencrypt
  - traefik.http.services.mediamax.loadbalancer.server.port=8484` },
    { id: 'npm', label: 'Nginx Proxy Manager', code: `Proxy Host → Details
  Domain:            ${domain}
  Scheme / host:     http  /  ${up.split(':')[0]}
  Port:              8484
  Websockets support: ON     Block common exploits: ON
SSL → Request a new certificate, Force SSL, HTTP/2
Advanced (optional):
  proxy_buffering off;
  client_max_body_size 0;` },
    { id: 'apache', label: 'Apache', code: `<VirtualHost *:443>
    ServerName ${domain}
    ProxyPreserveHost On
    ProxyPass        / http://${up}/ upgrade=websocket
    ProxyPassReverse / http://${up}/
    RequestHeader set X-Forwarded-Proto "https"
</VirtualHost>` },
    { id: 'haproxy', label: 'HAProxy', code: `frontend https
    bind :443 ssl crt /etc/haproxy/certs/
    http-request set-header X-Forwarded-Proto https
    option forwardfor
    use_backend mediamax if { req.hdr(host) -i ${domain} }

backend mediamax
    timeout tunnel 1h
    server mm ${up}` },
    { id: 'cloudflared', label: 'Cloudflare Tunnel', code: `# config.yml for cloudflared
ingress:
  - hostname: ${domain}
    service: http://${up}
  - service: http_status:404
# Note: Cloudflare's terms limit video through the free CDN/tunnel. Fine for the
# web UI and music; for heavy video use a direct port or Tailscale instead.` },
  ];
}

function TrustEditor({ value, onChange, locked }: { value: string[]; onChange: (v: string[]) => void; locked: boolean }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const parts = draft.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length) onChange([...new Set([...value, ...parts])]);
    setDraft('');
  };
  return (
    <div>
      <div className="chip-row net-chips">
        {value.map((v) => (
          <span key={v} className="net-chip mono">
            {v}
            {!locked && <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>×</button>}
          </span>
        ))}
        {!value.length && <span className="muted small">Nobody: X-Forwarded-For is ignored.</span>}
      </div>
      {!locked && (
        <div className="form-row">
          <input className="input mono" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} placeholder="172.18.0.0/16, 10.0.0.5, loopback…" aria-label="Add a trusted proxy" />
          <button type="button" className="btn" onClick={add} disabled={!draft.trim()}>Add</button>
        </div>
      )}
    </div>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn btn-sm btn-ghost" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

export function NetworkAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<NetworkStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<NetworkSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [snip, setSnip] = useState('nginx');

  const load = async () => {
    try {
      const d = await api.status();
      setData(d); setError(null);
      setDraft((cur) => cur ?? d.settings);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void load(); }, []);
  // While built-in HTTPS is starting, poll for the certificate.
  useEffect(() => {
    if (data?.settings.mode !== 'builtin' || data.builtin.certificate?.ok) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [data?.settings.mode, data?.builtin.certificate?.ok]);

  const dirty = useMemo(() => !!draft && !!data && JSON.stringify(draft) !== JSON.stringify(data.settings), [draft, data]);

  if (error && !data) return <div><AdminHeader title="Network" /><ErrorState message={error} onRetry={() => void load()} /></div>;
  if (!data || !draft) return <div><AdminHeader title="Network" /><Skeleton h={180} /><Skeleton h={260} style={{ marginTop: 16 }} /></div>;

  const set = (p: Partial<NetworkSettings>) => setDraft({ ...draft, ...p });
  const setB = (p: Partial<NetworkSettings['builtinHttps']>) => setDraft({ ...draft, builtinHttps: { ...draft.builtinHttps, ...p } });
  const you = data.you;
  const b = data.builtin;
  const domain = draft.builtinHttps.domain || (data.publicUrl ? new URL(data.publicUrl).host : 'media.example.com');
  const upstream = `${you.host && !/^(localhost|127\.)/.test(you.host) && draft.mode === 'direct' ? you.host.split(':')[0] : 'mediamax'}:8484`;
  const list = snippets(domain, upstream);
  const shown = list.find((s) => s.id === snip) ?? list[0];

  const save = async () => {
    if (draft.mode === 'builtin' && data.settings.mode !== 'builtin') {
      const ok = await confirm({
        title: 'Turn on built-in HTTPS?',
        message: `MediaMax will listen on ports ${draft.builtinHttps.httpPort} and ${draft.builtinHttps.httpsPort} and ask Let's Encrypt for a certificate for ${draft.builtinHttps.domain}. Make sure the domain points at this server and those ports are forwarded, and that no other proxy is already using them.`,
        confirmLabel: 'Turn on',
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      const s = await api.save(draft);
      setDraft(s);
      toast.success(s.mode === 'builtin' ? 'Saved. Built-in HTTPS is starting.' : 'Network settings saved');
      await load();
    } catch (e) { toast.error(e); } finally { setSaving(false); }
  };

  const forwarded = !!you.forwardedFor;
  const check = forwarded && draft.mode !== 'proxy' && !you.proxyTrusted
    ? { tone: 'warn', text: `Your request came through a proxy at ${you.socketAddress}. If that's your reverse proxy, choose "Behind my reverse proxy" so MediaMax sees visitors' real addresses (now everyone looks like ${you.ip}).` }
    : forwarded
    ? you.proxyTrusted
      ? { tone: 'good', text: `Your request came through a trusted proxy (${you.socketAddress}); MediaMax sees your real address ${you.ip} over ${you.protocol.toUpperCase()}.` }
      : { tone: 'bad', text: `Your request came through a proxy at ${you.socketAddress}, but it isn't trusted, so MediaMax sees every visitor as ${you.ip}. Add ${you.socketAddress} (or its subnet) below.` }
    : { tone: draft.mode === 'proxy' ? 'warn' : 'good', text: draft.mode === 'proxy' ? `This request didn't come through a proxy (it came straight from ${you.ip}). Open this page through your proxy's address to check it.` : `You're connected directly from ${you.ip}.` };

  return (
    <div className="net-page">
      <AdminHeader
        title="Network"
        subtitle="How people reach this server. The built-in reverse proxy is off unless you turn it on here, so MediaMax runs happily behind your existing setup."
        actions={<button className="btn btn-primary" onClick={() => void save()} disabled={!dirty || saving}>{saving ? <Spinner size={16} /> : 'Save'}</button>}
      />

      <section className="sec-card">
        <h2>Connection mode</h2>
        <div className="net-modes" role="radiogroup" aria-label="Connection mode">
          {MODES.map((m) => (
            <label key={m.id} className={`net-mode ${draft.mode === m.id ? 'active' : ''}`}>
              <input type="radio" name="net-mode" checked={draft.mode === m.id} onChange={() => set({ mode: m.id })} />
              <strong>{m.title}</strong>
              <span className="muted small">{m.text}</span>
              {m.id === 'builtin' && !b.available && <span className="small warn">Caddy isn't installed here (it's bundled in the Docker image and release downloads).</span>}
            </label>
          ))}
        </div>
      </section>

      <section className="sec-card">
        <h2>Connection check</h2>
        <p className={`net-check net-${check.tone}`}>{check.text}</p>
        <dl className="net-facts small">
          <dt>Address MediaMax uses</dt><dd className="mono">{you.ip}</dd>
          <dt>Connected from</dt><dd className="mono">{you.socketAddress}</dd>
          <dt>X-Forwarded-For</dt><dd className="mono">{you.forwardedFor ?? '—'}</dd>
          <dt>Protocol</dt><dd className="mono">{you.protocol}{you.forwardedProto ? ` (X-Forwarded-Proto: ${you.forwardedProto})` : ''}</dd>
          <dt>Host</dt><dd className="mono">{you.host}</dd>
          <dt>Public URL</dt><dd className="mono">{data.publicUrl ?? <span className="muted">not set (Server settings)</span>}</dd>
        </dl>
      </section>

      {draft.mode === 'proxy' && <section className="sec-card">
        <h2>Trusted proxies</h2>
        <p className="muted small">
          MediaMax believes the X-Forwarded-For and X-Forwarded-Proto headers only from these addresses, so visitors can't fake their IP
          to dodge sign-in limits and bans. <span className="mono">loopback</span>, <span className="mono">linklocal</span> and <span className="mono">uniquelocal</span> cover
          this machine and private networks (Docker networks included), which suits most setups.
        </p>
        {data.envTrustedProxies && <p className="small warn">Set by MEDIAMAX_TRUSTED_PROXIES in the environment; remove that variable to edit the list here.</p>}
        <TrustEditor value={data.envTrustedProxies ?? draft.trustedProxies} onChange={(v) => set({ trustedProxies: v })} locked={!!data.envTrustedProxies} />
        {!data.envTrustedProxies && (
          <div className="form-row">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ trustedProxies: ['loopback', 'linklocal', 'uniquelocal'] })}>Reset to private networks</button>
            {forwarded && !you.proxyTrusted && <button type="button" className="btn btn-sm" onClick={() => set({ trustedProxies: [...new Set([...draft.trustedProxies, you.socketAddress])] })}>Trust {you.socketAddress}</button>}
          </div>
        )}
      </section>}

      {draft.mode === 'proxy' && (
        <section className="sec-card">
          <h2>Proxy configuration</h2>
          <p className="muted small">Point your proxy at MediaMax on port 8484 with buffering off and WebSockets on. Ready-made examples for <span className="mono">{domain}</span>:</p>
          <div className="segmented" role="tablist">
            {list.map((s) => <button key={s.id} role="tab" aria-selected={s.id === shown.id} className={s.id === shown.id ? 'active' : ''} onClick={() => setSnip(s.id)} style={{ textTransform: 'none' }}>{s.label}</button>)}
          </div>
          <div className="net-code">
            <Copy text={shown.code} />
            <pre className="mono">{shown.code}</pre>
          </div>
          <p className="muted small">Then set the public URL in Server settings to <span className="mono">https://{domain}</span> so invites, share links and app QR codes use it.</p>
        </section>
      )}

      {draft.mode === 'builtin' && (
        <section className="sec-card">
          <h2>Built-in HTTPS</h2>
          <div className="form-grid">
            <Field label="Domain" hint="A DNS name that points at this server, e.g. media.example.com"><input className="input mono" value={draft.builtinHttps.domain ?? ''} onChange={(e) => setB({ domain: e.target.value.trim() || null })} placeholder="media.example.com" /></Field>
            <Field label="Email (optional)" hint="Let's Encrypt writes here before a certificate expires"><input className="input" type="email" value={draft.builtinHttps.email ?? ''} onChange={(e) => setB({ email: e.target.value.trim() || null })} /></Field>
            <Field label="HTTP port" hint="80 for certificates; inside Docker map it with -p 80:80"><input className="input" type="number" min={1} max={65535} value={draft.builtinHttps.httpPort} onChange={(e) => setB({ httpPort: Number(e.target.value) })} /></Field>
            <Field label="HTTPS port"><input className="input" type="number" min={1} max={65535} value={draft.builtinHttps.httpsPort} onChange={(e) => setB({ httpsPort: Number(e.target.value) })} /></Field>
          </div>
          <label className="check-inline net-opt"><input type="checkbox" checked={draft.builtinHttps.hsts} onChange={(e) => setB({ hsts: e.target.checked })} /> Send HSTS (browsers always use HTTPS for this domain)</label>
          <label className="check-inline net-opt"><input type="checkbox" checked={draft.builtinHttps.staging} onChange={(e) => setB({ staging: e.target.checked })} /> Test mode: Let's Encrypt staging (untrusted certificate, no rate limits)</label>

          {data.settings.mode === 'builtin' && (
            <div className="net-status">
              <h3>Status</h3>
              <p>
                {b.running ? <Badge tone="success">Running</Badge> : <Badge tone="danger">Stopped</Badge>}{' '}
                {b.version && <span className="muted small">Caddy {b.version}</span>}
              </p>
              {b.error && <p className="form-error">{b.error}</p>}
              {b.certificate && (b.certificate.ok
                ? <p className="small">Certificate from {b.certificate.issuer ?? 'unknown issuer'}, valid for {b.certificate.daysLeft} more days. Caddy renews it automatically.</p>
                : <p className="small warn">No valid certificate yet{b.certificate.error ? `: ${b.certificate.error}` : ''}. This can take a minute after the domain resolves here.</p>)}
              {!!b.log.length && <pre className="net-log mono small">{b.log.join('\n')}</pre>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
