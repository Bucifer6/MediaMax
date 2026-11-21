// Seasonal theme schedules: date windows (including ones that wrap the year end) override the default theme server-side.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { createUser, issueToken } = await import('../src/services/auth.ts');
const { getBranding, updateBranding, inDateWindow, activeThemeSchedule, checkThemeSchedule, brandingCss } = await import('../src/services/branding.ts');
const { buildApp } = await import('../src/app.ts');

const app = await buildApp();
after(() => app.close());
const admin = createUser({ username: 'ts-admin', password: 'pass1234', isAdmin: true });
const atok = issueToken(admin.id, { deviceId: 'ts-a', deviceName: 'test', platform: 'web' }).token;
const auth = { authorization: `Bearer ${atok}` };
const on = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12);

test('date windows are inclusive and wrap the year end', () => {
  assert.ok(inDateWindow('10-20', '10-20', '11-01'));
  assert.ok(inDateWindow('11-01', '10-20', '11-01'));
  assert.ok(!inDateWindow('11-02', '10-20', '11-01'));
  assert.ok(!inDateWindow('10-19', '10-20', '11-01'));
  assert.ok(inDateWindow('12-25', '12-01', '01-06'));
  assert.ok(inDateWindow('01-06', '12-01', '01-06'));
  assert.ok(inDateWindow('01-01', '12-01', '01-06'));
  assert.ok(!inDateWindow('01-07', '12-01', '01-06'));
  assert.ok(!inDateWindow('11-30', '12-01', '01-06'));
});

test('admin schedules override the default theme while active, for everyone, via GET /branding', async () => {
  let r = await app.inject({
    method: 'PUT', url: '/api/v1/branding', headers: auth,
    payload: {
      baseThemeId: 'midnight',
      themeSchedules: [
        { name: 'Halloween', start: '10-20', end: '11-01', themeId: 'contrast', enabled: true },
        { name: 'Christmas', start: '12-01', end: '01-06', themeId: 'festive', enabled: true },
        { name: 'Off', start: '01-01', end: '12-31', themeId: 'sakura', enabled: false },
        { name: 'Missing theme', start: '01-01', end: '12-31', themeId: 'no-such-theme', enabled: true },
      ],
    },
  });
  assert.equal(r.statusCode, 200, r.body);
  const b = getBranding(on(2026, 7, 1));
  assert.equal(b.themeSchedules.length, 4);
  assert.ok(b.themeSchedules.every((s) => s.id), 'ids assigned');
  assert.equal(b.defaultThemeId, 'midnight', 'no active window: the default');
  assert.equal(b.activeThemeScheduleId, null);
  assert.equal(getBranding(on(2026, 10, 31)).defaultThemeId, 'contrast');
  assert.equal(getBranding(on(2026, 12, 24)).defaultThemeId, 'festive');
  assert.equal(getBranding(on(2027, 1, 3)).defaultThemeId, 'festive', 'wraps into January');
  assert.equal(getBranding(on(2027, 1, 7)).defaultThemeId, 'midnight');
  assert.equal(getBranding(on(2027, 1, 7)).baseThemeId, 'midnight');
  // The public endpoint (no sign-in, used by every client) carries the resolved theme for today.
  r = await app.inject({ method: 'GET', url: '/api/v1/branding' });
  const now = getBranding();
  assert.equal(r.json().defaultThemeId, now.defaultThemeId);
  assert.equal(r.json().baseThemeId, 'midnight');
});

test('echoing the seasonal theme back does not make it the default; baseThemeId does', () => {
  const nowMd = new Date();
  const md = `${String(nowMd.getMonth() + 1).padStart(2, '0')}-${String(nowMd.getDate()).padStart(2, '0')}`;
  updateBranding({ baseThemeId: 'midnight', themeSchedules: [{ id: 'today', name: 'Today', enabled: true, start: md, end: md, themeId: 'festive' }] });
  let b = getBranding();
  assert.equal(b.defaultThemeId, 'festive');
  assert.equal(b.activeThemeScheduleId, 'today');
  assert.match(brandingCss(), /#d62828/, 'zero-JS CSS follows the seasonal theme too');
  updateBranding({ defaultThemeId: b.defaultThemeId, tagline: 'x' }); // an older admin client saving the whole draft
  b = getBranding();
  assert.equal(b.baseThemeId, 'midnight');
  updateBranding({ baseThemeId: 'sakura' });
  assert.equal(getBranding().baseThemeId, 'sakura');
  assert.equal(getBranding().defaultThemeId, 'festive', 'schedule still wins while active');
});

test('the scheduler bumps the revision when a seasonal theme starts or ends', () => {
  const rev = getBranding().revision;
  checkThemeSchedule();
  const after1 = getBranding().revision;
  assert.equal(checkThemeSchedule(), false, 'no change, no bump');
  assert.equal(getBranding().revision, after1);
  updateBranding({ themeSchedules: [] });
  const r2 = getBranding().revision;
  assert.equal(checkThemeSchedule(), true, 'schedule ended');
  assert.ok(getBranding().revision > r2);
  assert.ok(after1 >= rev);
});

test('invalid schedules are refused', async () => {
  const bad = async (s: object) => (await app.inject({ method: 'PUT', url: '/api/v1/branding', headers: auth, payload: { themeSchedules: [s] } })).statusCode;
  assert.equal(await bad({ name: 'x', start: '13-01', end: '01-06', themeId: 'festive' }), 400);
  assert.equal(await bad({ name: 'x', start: '12-1', end: '01-06', themeId: 'festive' }), 400);
  assert.equal(await bad({ name: 'x', start: '12-01', end: '01-06' }), 400);
  assert.equal(activeThemeSchedule([], getBranding().themes), null);
});
