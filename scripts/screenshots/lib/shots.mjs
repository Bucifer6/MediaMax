import fs from 'node:fs';
import path from 'node:path';
import { THEMES } from './catalog.mjs';
import { sleep } from './server.mjs';

const MAX_BYTES = 600 * 1024;

/** CSS injected into every screenshot page: no caret blink, no transient toasts, no scrollbars. */
const SHOT_CSS = `
*, *::before, *::after { caret-color: transparent !important; }
::-webkit-scrollbar { display: none !important; }
html { scrollbar-width: none !important; }
`;

export class Shooter {
  constructor({ browser, base, out, state, log }) {
    Object.assign(this, { browser, base, out, state, log });
    this.problems = [];
  }

  async init() {
    this.enc = await this.browser.newPage();
    await this.enc.goto('about:blank');
  }

  /** PNG buffer → JPEG at `width` px (high-quality downscale in Chromium), quality stepped down to stay under 600 KB. */
  async saveJpeg(png, name, width) {
    const b64 = await this.enc.evaluate(async ({ data, width, max }) => {
      const blob = await (await fetch('data:image/png;base64,' + data)).blob();
      const bmp = await createImageBitmap(blob);
      const w = width || bmp.width;
      const h = Math.round((bmp.height * w) / bmp.width);
      // Two-step downscale keeps text crisp.
      let src = bmp;
      if (bmp.width >= w * 2 && bmp.width > w) {
        const mid = new OffscreenCanvas(w * 2, h * 2);
        const mc = mid.getContext('2d');
        mc.imageSmoothingQuality = 'high';
        mc.drawImage(bmp, 0, 0, w * 2, h * 2);
        src = mid;
      }
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, w, h);
      let q = 0.82;
      let out;
      for (;;) {
        out = await c.convertToBlob({ type: 'image/jpeg', quality: q });
        if (out.size <= max || q <= 0.6) break;
        q -= 0.04;
      }
      const bytes = new Uint8Array(await out.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }, { data: png.toString('base64'), width, max: MAX_BYTES });
    const file = path.join(this.out, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    this.log(`  ✓ ${name} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
  }

  async context({ width = 1440, height = 900, dsf = 2, token = this.state.token, mobile = false, extraCss = '' } = {}) {
    const ctx = await this.browser.newContext({ viewport: { width, height }, deviceScaleFactor: dsf, isMobile: mobile, hasTouch: mobile, locale: 'en-GB', timezoneId: 'Europe/London', colorScheme: 'dark' });
    await ctx.addInitScript(({ token, css }) => {
      try {
        if (token) localStorage.setItem('mm.token', token);
      } catch {}
      const add = () => {
        const s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
      };
      if (document.head) add();
      else document.addEventListener('DOMContentLoaded', add);
    }, { token, css: SHOT_CSS + extraCss });
    // Put the featured title first in the hero so the home shots are deterministic.
    await ctx.route('**/api/v1/home*', async (route) => {
      const res = await route.fetch();
      let body = await res.text();
      try {
        const j = JSON.parse(body);
        const rows = j.rows ?? j;
        const hero = rows.find?.((r) => r.type === 'hero');
        if (hero && this.state.heroId) {
          const i = hero.items.findIndex((x) => x.id === this.state.heroId);
          if (i > 0) hero.items.unshift(...hero.items.splice(i, 1));
          else if (i < 0) hero.items.unshift(await this.state.admin.get(`/items/${this.state.heroId}`));
        }
        body = JSON.stringify(j);
      } catch {}
      await route.fulfill({ response: res, body });
    });
    // Work around a server bug: resized variants (?w=) of PNG artwork are re-encoded as JPEG, so transparent logos
    // get a black box. Logos are requested at full size instead (see the report / README notes).
    const logos = new Set(this.state.logoUrls ?? []);
    if (logos.size) {
      await ctx.route('**/api/v1/images/**', (route) => {
        const u = new URL(route.request().url());
        if (u.searchParams.has('w') && logos.has(u.pathname)) {
          u.searchParams.delete('w');
          return route.continue({ url: u.toString() });
        }
        return route.continue();
      });
    }
    const page = await ctx.newPage();
    page.on('pageerror', (e) => this.problems.push(`${page.url().replace(this.base, '')}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/404|Failed to load resource|play\(\) request was interrupted|NotAllowedError/.test(m.text())) this.problems.push(`${page.url().replace(this.base, '')}: ${m.text().slice(0, 160)}`);
    });
    return { ctx, page };
  }

  /** Wait for the network to settle, fonts, visible images, and spinners to go away. */
  async settle(page, extra = 700) {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    await page.evaluate(async () => {
      await document.fonts.ready;
      const visible = [...document.images].filter((i) => {
        const r = i.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.width > 0;
      });
      for (const i of visible) i.loading = 'eager';
      await Promise.race([Promise.all(visible.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })))), new Promise((r) => setTimeout(r, 8000))]);
    });
    await page.waitForFunction(() => ![...document.querySelectorAll('.spinner, .skeleton, .page-loader')].some((s) => {
      const r = s.getBoundingClientRect();
      return r.width > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(s).visibility !== 'hidden';
    }), null, { timeout: 12000 }).catch(() => this.problems.push(`${page.url().replace(this.base, '')}: still loading when captured`));
    await sleep(extra);
  }

  async goto(page, p, extra) {
    await page.goto(this.base + p, { waitUntil: 'domcontentloaded' });
    await this.settle(page, extra);
  }

  async capture(page, name, width = 1440, opts = {}) {
    await page.mouse.move(opts.mouseX ?? 2, opts.mouseY ?? 2).catch(() => undefined);
    if (!opts.keepPointer) await sleep(150);
    const png = await page.screenshot({ type: 'png', fullPage: false, animations: opts.animations ?? 'disabled' });
    await this.saveJpeg(png, name, width);
  }
}

/* ------------------------------------------------------------------ */
/* The shot list                                                       */
/* ------------------------------------------------------------------ */

export const SHOTS = {
  async home(s) {
    const { ctx, page } = await s.context();
    await s.goto(page, '/', 2500);
    await s.capture(page, 'home.jpg');
    await ctx.close();
  },

  async 'item-movie'(s) {
    const { ctx, page } = await s.context();
    await s.goto(page, `/item/${s.state.M['neon-meridian']}`, 1200);
    await s.capture(page, 'item-movie.jpg');
    await ctx.close();
  },

  async 'item-show'(s) {
    const { ctx, page } = await s.context();
    await s.goto(page, `/item/${s.state.S['quiet-frontier']}`, 1200);
    await s.capture(page, 'item-show.jpg');
    await ctx.close();
  },

  async player(s) {
    const { ctx, page } = await s.context();
    await page.goto(`${s.base}/play/${s.state.M['crimson-freight']}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && v.readyState >= 2 && v.currentTime > 1;
    }, null, { timeout: 30000 }).catch(() => s.problems.push('player: video never started'));
    await sleep(5000);
    await page.mouse.move(700, 500);
    await page.mouse.move(720, 640);
    await sleep(600);
    await s.capture(page, 'player.jpg', 1440, { mouseX: 720, mouseY: 640, keepPointer: true });
    await ctx.close();
  },

  async 'livetv-guide'(s) {
    const { ctx, page } = await s.context();
    await s.goto(page, '/livetv/guide', 1500);
    await s.capture(page, 'livetv-guide.jpg');
    await ctx.close();
  },

  async multiview(s) {
    const { ctx, page } = await s.context();
    const ids = ['Meridian News 24', 'Pulse Sports', 'Wildscape', 'Popcorn Kids'].map((n) => s.state.channels.find((c) => c.name === n)?.id).filter(Boolean);
    await page.goto(`${s.base}/watch/multiview?ch=${ids.join(',')}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((n) => [...document.querySelectorAll('video')].filter((v) => v.readyState >= 2).length >= n, ids.length, { timeout: 40000 }).catch(() => s.problems.push('multiview: not all tiles played'));
    await sleep(3500);
    await s.capture(page, 'multiview.jpg', 1440, { mouseX: 1100, mouseY: 25 });
    await ctx.close();
  },

  async music(s) {
    const { ctx, page } = await s.context();
    const album = s.state.albums.find((a) => a.title === 'Afterglow Avenue');
    await s.goto(page, `/item/${album.id}`, 800);
    await page.getByRole('button', { name: /^Play/ }).first().click();
    await page.waitForSelector('.eq', { timeout: 20000 }).catch(() => s.problems.push('music: playback never started'));
    await sleep(3500);
    await s.capture(page, 'music.jpg');
    await ctx.close();
  },

  async 'dj-ask'(s) {
    const { ctx, page } = await s.context();
    await s.goto(page, '/dj', 1000);
    await page.getByLabel('Describe your mix').fill('sunset synthwave into deep house, about an hour');
    await sleep(300);
    await s.capture(page, 'dj-ask.jpg');
    await ctx.close();
  },

  async dj(s) {
    const { ctx, page } = await s.context();
    await s.goto(page, '/dj', 800);
    await page.getByLabel('Describe your mix').fill('deep house for a summer evening');
    await page.getByRole('button', { name: 'Play it' }).click();
    await page.waitForFunction(() => window.mediamaxDj?.snapshot().status === 'playing', null, { timeout: 30000 });
    await sleep(1500);
    // Jump close to the first mix point and capture mid-transition.
    const mixOut = await page.evaluate(() => window.mediamaxDj.snapshot().queue[1]?.transition?.mixOutMs ?? null);
    if (mixOut) {
      await page.evaluate((ms) => { window.mediamaxDj.decks[window.mediamaxDj.snapshot().live].audio.currentTime = Math.max(0, ms / 1000 - 2.5); }, mixOut);
      await page.waitForFunction(() => window.mediamaxDj.snapshot().transitioning, null, { timeout: 15000 }).catch(() => s.problems.push('dj: transition never started'));
      // Half-way through the blend: both decks playing, crossfader near the middle.
      const xf = await page.evaluate(() => window.mediamaxDj.snapshot().queue[1]?.transition?.crossfadeMs ?? 4000);
      await sleep(Math.min(6000, xf / 2));
    } else s.problems.push('dj: no mix point in queue');
    await sleep(300);
    await s.capture(page, 'dj.jpg', 1440, { animations: 'allow' });
    await ctx.close();
  },

  async calendar(s) {
    // The demo has no TMDB key; hide the "add a TMDB key" setup notice (upcoming episodes are seeded instead).
    const { ctx, page } = await s.context({ extraCss: '.cal-notice{display:none!important}' });
    await s.goto(page, '/calendar', 1000);
    await s.capture(page, 'calendar.jpg');
    await ctx.close();
  },

  async 'my-list'(s) {
    const { ctx, page } = await s.context();
    await s.goto(page, '/my-list', 1000);
    await s.capture(page, 'my-list.jpg');
    await ctx.close();
  },

  async 'admin-dashboard'(s) {
    const { ctx, page } = await s.context();
    // Two people watching right now, so the dashboard shows live sessions.
    const sessions = [];
    for (const [c, id, frac] of [[s.state.alex, s.state.M['hollow-choir'], 0.36], [s.state.kids, s.state.M['sock-rebellion'], 0.42]]) {
      try {
        const info = await c.post(`/playback/${id}`, {});
        const item = await c.get(`/items/${id}`);
        await c.post(`/playback/sessions/${info.sessionId}/progress`, { positionMs: Math.round((item.durationMs ?? 6e6) * frac), durationMs: item.durationMs, state: 'playing' });
        sessions.push([c, info.sessionId, item, frac]);
      } catch (e) {
        s.problems.push('admin-dashboard: could not start a session: ' + e.message);
      }
    }
    for (const x of await s.state.admin.get('/sessions').catch(() => [])) if (x.userId === s.state.adminId) await s.state.admin.del(`/playback/sessions/${x.id}`).catch(() => undefined);
    await s.goto(page, '/admin', 2000);
    await page.evaluate(() => window.scrollTo(0, 230));
    await s.settle(page, 600);
    await s.capture(page, 'admin-dashboard.jpg');
    for (const [c, id] of sessions) await c.del(`/playback/sessions/${id}`).catch(() => undefined);
    await ctx.close();
  },

  async 'admin-security'(s) {
    const { ctx, page } = await s.context();
    await s.goto(page, '/admin/security', 1500);
    await s.capture(page, 'admin-security.jpg');
    await ctx.close();
  },

  // The studio puts the editor and the live preview side by side from 1641 px, so these two are captured at
  // 1680×1050 and scaled to 1440 px wide.
  async 'branding-studio'(s) {
    const { ctx, page } = await s.context({ width: 1680, height: 1050 });
    await s.goto(page, '/admin/branding', 1000);
    await page.locator('.studio-tabs').getByText('Theme', { exact: true }).first().click();
    await s.settle(page, 1200);
    await s.capture(page, 'branding-studio.jpg');
    await ctx.close();
  },

  async 'starter-looks'(s) {
    const { ctx, page } = await s.context({ width: 1680, height: 1050 });
    await s.goto(page, '/admin/branding', 1000);
    await page.locator('.studio-tabs').getByText('Starter looks').first().click();
    await s.settle(page, 1000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
    await s.capture(page, 'starter-looks.jpg');
    await ctx.close();
  },

  async 'mobile-home'(s) {
    const { ctx, page } = await s.context({ width: 390, height: 844, dsf: 3, mobile: true });
    await s.goto(page, '/', 1500);
    await s.capture(page, 'mobile-home.jpg', 780);
    await ctx.close();
  },

  async 'tv-mode'(s) {
    const { ctx, page } = await s.context({ width: 1920, height: 1080, dsf: 1 });
    await s.goto(page, '/?tv=1', 2000);
    // D-pad down until a poster card in a row has focus, then one step right.
    for (let i = 0; i < 8; i++) {
      const onCard = await page.evaluate(() => document.activeElement?.matches?.('a.card'));
      if (onCard) break;
      await page.keyboard.press('ArrowDown');
      await sleep(350);
    }
    await page.keyboard.press('ArrowRight');
    await sleep(500);
    await s.settle(page, 900);
    await s.capture(page, 'tv-mode.jpg', 1920, { mouseX: 1919, mouseY: 1079 });
    await ctx.close();
  },

  async themes(s) {
    for (const id of THEMES) {
      await s.state.admin.patch('/auth/me', { preferences: { themeId: id } });
      const { ctx, page } = await s.context({ width: 1280, height: 800, dsf: 1 });
      await s.goto(page, '/', 1500);
      await s.capture(page, `themes/${id}.jpg`, 1280);
      await ctx.close();
    }
    await s.state.admin.patch('/auth/me', { preferences: { themeId: null } });
  },

  async 'themes-grid'(s) {
    const names = s.state.themeNames ?? {};
    const cells = THEMES.map((id) => {
      const f = path.join(s.out, 'themes', `${id}.jpg`);
      if (!fs.existsSync(f)) return '';
      return `<figure><img src="data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}"><figcaption>${names[id] ?? id}</figcaption></figure>`;
    }).join('');
    const page = await s.browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><style>
      body{margin:0;background:#0b0d12;font-family:'Inter','DejaVu Sans',sans-serif}
      .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:28px 22px;padding:36px 34px 30px}
      figure{margin:0}
      img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:12px;box-shadow:0 10px 30px #0008,0 0 0 1px #ffffff14}
      figcaption{color:#e9ecf3;font-size:20px;font-weight:600;text-align:center;margin-top:12px;letter-spacing:.01em}
    </style></head><body><div class="grid">${cells}</div></body></html>`);
    await page.evaluate(async () => Promise.all([...document.images].map((i) => i.decode().catch(() => null))));
    const h = await page.evaluate(() => document.querySelector('.grid').getBoundingClientRect().height);
    await page.setViewportSize({ width: 1600, height: Math.ceil(h) });
    const png = await page.screenshot({ type: 'png' });
    await s.saveJpeg(png, 'themes-grid.jpg', 1600);
    await page.close();
  },
};
