import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxySnippets } from '../src/admin/networkSnippets.ts';

test('proxy examples use Vibe labels and support both current and legacy Docker addresses', () => {
  for (const upstream of ['vibe:8484', 'mediamax:8484', '127.0.0.1:8484']) {
    const snippets = proxySnippets('media.example.com', upstream);
    assert.equal(snippets.length, 7);
    for (const id of ['nginx', 'caddy', 'apache', 'haproxy', 'cloudflared']) {
      assert.ok(snippets.find((s) => s.id === id)!.code.includes(upstream), `${id}: ${upstream}`);
    }
    const traefik = snippets.find((s) => s.id === 'traefik')!.code;
    assert.match(traefik, /routers\.vibe\.rule/);
    assert.match(traefik, /services\.vibe\.loadbalancer/);
    assert.doesNotMatch(traefik, /mediamax/);
  }
});

test('proxy-manager examples preserve custom ports and partially typed targets do not break the page', () => {
  const npm = proxySnippets('media.example.com', 'server.lan:9000').find((s) => s.id === 'npm')!.code;
  assert.match(npm, /http  \/  server\.lan/);
  assert.match(npm, /Port:\s+9000/);
  assert.doesNotThrow(() => proxySnippets('media.example.com', ':'));
});
