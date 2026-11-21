// Discord Notifications — an example Kinora plugin (events + routes + admin page + settings).
/** @type {import('../../sdk/index').ActivateFn} */
export async function activate(ctx) {
  const sent = () => ctx.storage.get('sent', 0);

  async function post(content) {
    const url = ctx.settings.get('webhookUrl');
    if (!url) return false;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ctx.settings.get('username') || 'Kinora', content: String(content).slice(0, 1900) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Discord returned HTTP ${res.status}`);
    ctx.storage.set('sent', sent() + 1);
    return true;
  }

  ctx.events.on('library.new', async ({ itemIds }) => {
    if (!ctx.settings.get('newMedia')) return;
    const titles = itemIds.slice(0, 10).map((id) => ctx.library.getItem(id)).filter(Boolean)
      .map((i) => `• ${i.title}${i.year ? ` (${i.year})` : ''}`);
    if (titles.length) await post(`🎬 **New on the server**\n${titles.join('\n')}${itemIds.length > 10 ? `\n…and ${itemIds.length - 10} more` : ''}`);
  });

  ctx.events.on('playback.start', async (s) => {
    if (ctx.settings.get('playback')) await post(`▶️ **${s.ctx.user.displayName}** started *${s.title}* on ${s.ctx.device.deviceName}`);
  });

  ctx.events.on('request.created', async (r) => {
    if (ctx.settings.get('requests')) await post(`🙋 **${r.requestedBy.displayName}** requested *${r.title}*${r.year ? ` (${r.year})` : ''}`);
  });

  ctx.http.route('GET', '/status', () => ({ configured: !!ctx.settings.get('webhookUrl'), sent: sent() }), { auth: 'admin' });
  ctx.http.route('POST', '/test', async () => ({ ok: await post('✅ Kinora test message — the Discord plugin is working.') }), { auth: 'admin' });
  ctx.log.info('Discord notifications ready');
}

export function deactivate() {}
