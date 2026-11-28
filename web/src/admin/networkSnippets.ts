/** Copy-ready configs for the common proxies. `up` is how the proxy reaches Vibe. */
export function proxySnippets(domain: string, up: string): { id: string; label: string; code: string }[] {
  let host = up;
  let port = '8484';
  try {
    const address = new URL(`http://${up}`);
    host = address.hostname;
    port = address.port || '80';
  } catch {
    // Keep the examples editable while the user is part-way through typing an address.
  }
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
  - traefik.http.routers.vibe.rule=Host(\`${domain}\`)
  - traefik.http.routers.vibe.entrypoints=websecure
  - traefik.http.routers.vibe.tls.certresolver=letsencrypt
  - traefik.http.services.vibe.loadbalancer.server.port=8484` },
    { id: 'npm', label: 'Nginx Proxy Manager', code: `Proxy Host → Details
  Domain:            ${domain}
  Scheme / host:     http  /  ${host}
  Port:              ${port}
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
    use_backend vibe if { req.hdr(host) -i ${domain} }

backend vibe
    timeout tunnel 1h
    server vibe ${up}` },
    { id: 'cloudflared', label: 'Cloudflare Tunnel', code: `# config.yml for cloudflared
ingress:
  - hostname: ${domain}
    service: http://${up}
  - service: http_status:404
# Note: Cloudflare's terms limit video through the free CDN/tunnel. Fine for the
# web UI and music; for heavy video use a direct port or Tailscale instead.` },
  ];
}
