// Phone ↔ TV pairing by QR: token lifecycle (one-time, expiry, rate limits), same-user and cross-user pairing (with
// acceptance on the TV), revocation, `remote.key` routed only along an active pairing, guest limits on
// `remote.command`, and the second-screen / browse routes' authorisation.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ServerEvent } from '@mediamax/shared';

const { db } = await import('../src/db.ts');
const { createUser, issueToken, logout, authenticate } = await import('../src/services/auth.ts');
const pairing = await import('../src/services/pairing.ts');
const { buildApp } = await import('../src/app.ts');
const { WebSocket } = await import('ws');

const owner = createUser({ username: 'pair-owner', password: 'pw-123456' });
const guest = createUser({ username: 'pair-guest', password: 'pw-123456' });
const stranger = createUser({ username: 'pair-stranger', password: 'pw-123456' });
const dev = (id: string, name = id) => ({ deviceId: id, deviceName: name, platform: 'web' as const });
const tvTok = issueToken(owner.id, dev('tv', 'Living room TV')).token;
const myPhoneTok = issueToken(owner.id, dev('my-phone', 'My phone')).token;
const otherOwnDevTok = issueToken(owner.id, dev('laptop', 'Laptop')).token;
const guestTok = issueToken(guest.id, dev('guest-phone', 'Guest phone')).token;
const strangerTok = issueToken(stranger.id, dev('stranger-phone')).token;
const ctx = (t: string) => authenticate(t)!;

// Content: one movie in a library the guest can't see on their own (the TV user's library).
const now = new Date().toISOString();
db.run("INSERT INTO libraries (id, name, type, paths, fetch_metadata, created_at) VALUES ('pl-movies', 'Movies', 'movies', '[]', 0, ?)", now);
db.insert('items', { id: 'pm1', library_id: 'pl-movies', type: 'movie', title: 'Pair Movie', sort_title: 'pair movie', added_at: now, updated_at: now });
db.run("UPDATE users SET library_ids = ? WHERE id = ?", JSON.stringify([]), guest.id);

const app = await buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
const port = (app.server.address() as AddressInfo).port;
const sockets: InstanceType<typeof WebSocket>[] = [];
after(async () => {
  for (const s of sockets) s.close();
  await app.close();
});
const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
const post = (url: string, t: string, body: unknown = {}) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: auth(t), payload: JSON.stringify(body) });
const get = (url: string, t: string) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: auth(t) });

/** A connected socket that records every event it receives. */
async function connect(token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=${token}`);
  sockets.push(ws);
  const got: ServerEvent[] = [];
  ws.on('message', (m: Buffer) => got.push(JSON.parse(m.toString())));
  await once(ws, 'open');
  await waitFor(() => got.some((e) => e.type === 'hello'));
  return { ws, got, send: (ev: unknown) => ws.send(JSON.stringify(ev)) };
}
async function waitFor(pred: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 120));

const tvDeviceId = ctx(tvTok).deviceRowId;

test('pairing code: needs a session, is one-time, and the QR token and short code both work', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/pair/start' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/pair/claim', payload: { code: 'AAAAAA' } })).statusCode, 401);
  const s = await post('/pair/start', tvTok);
  assert.equal(s.statusCode, 200, s.body);
  const start = s.json();
  assert.match(start.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.ok(start.token.length >= 40);
  assert.equal(start.path, `/pair?c=${start.code}&t=${encodeURIComponent(start.token)}`);
  // The TV can't pair with itself.
  assert.equal((await post('/pair/claim', tvTok, { token: start.token })).statusCode, 400);
  const c = await post('/pair/claim', myPhoneTok, { token: start.token });
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(c.json().status, 'paired');
  assert.equal(c.json().crossUser, false);
  assert.equal(c.json().targetDeviceId, tvDeviceId);
  // One-time: neither the token nor the code works again.
  assert.equal((await post('/pair/claim', otherOwnDevTok, { token: start.token })).statusCode, 404);
  assert.equal((await post('/pair/claim', otherOwnDevTok, { code: start.code })).statusCode, 404);
  // The short code works (lower-case and spaces tolerated).
  const s2 = (await post('/pair/start', tvTok)).json();
  const c2 = await post('/pair/claim', otherOwnDevTok, { code: ` ${s2.code.toLowerCase().slice(0, 3)} ${s2.code.toLowerCase().slice(3)} ` });
  assert.equal(c2.json().status, 'paired');
  // A new code replaces the TV's previous unused one.
  const a = (await post('/pair/start', tvTok)).json();
  const b = (await post('/pair/start', tvTok)).json();
  assert.equal((await post('/pair/claim', myPhoneTok, { token: a.token })).statusCode, 404);
  assert.equal((await post('/pair/claim', myPhoneTok, { token: b.token })).statusCode, 200);
});

test('pairing code: expires, and wrong guesses are rate limited', async () => {
  const ttl = pairing.PAIR_LIMITS.codeTtlMs;
  pairing.PAIR_LIMITS.codeTtlMs = 30;
  const s = (await post('/pair/start', tvTok)).json();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await post('/pair/claim', myPhoneTok, { token: s.token })).statusCode, 404);
  pairing.PAIR_LIMITS.codeTtlMs = ttl;
  // Brute-forcing short codes: after N failures the user gets 429 even for a valid code.
  const valid = (await post('/pair/start', tvTok)).json();
  let last = 0;
  for (let i = 0; i < pairing.PAIR_LIMITS.failedClaimsPerWindow; i++) last = (await post('/pair/claim', strangerTok, { code: 'ZZZZZ9' })).statusCode;
  assert.equal(last, 404);
  assert.equal((await post('/pair/claim', strangerTok, { code: valid.code })).statusCode, 429);
  // Starting codes is limited per TV too.
  const tv2 = issueToken(owner.id, dev('tv2')).token;
  const codes: number[] = [];
  for (let i = 0; i <= pairing.PAIR_LIMITS.startsPerWindow; i++) codes.push((await post('/pair/start', tv2)).statusCode);
  assert.equal(codes.at(-1), 429);
  assert.ok(codes.slice(0, -1).every((c) => c === 200));
});

test('cross-user pairing waits for the TV user to accept on that TV; decline and expiry end it', async () => {
  const tv = await connect(tvTok);
  const phone = await connect(guestTok);
  // Decline first.
  let s = (await post('/pair/start', tvTok)).json();
  let c = await post('/pair/claim', guestTok, { token: s.token });
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(c.json().status, 'pending');
  assert.equal(c.json().crossUser, true);
  assert.equal(c.json().ownerName, 'pair-owner');
  const reqId = c.json().requestId;
  await waitFor(() => tv.got.some((e) => e.type === 'pair.request' && e.request.id === reqId));
  const pr = tv.got.find((e) => e.type === 'pair.request') as Extract<ServerEvent, { type: 'pair.request' }>;
  assert.equal(pr.request.fromUserName, 'pair-guest');
  assert.equal(pr.request.fromDeviceName, 'Guest phone');
  // Only the TV itself can answer: not the guest, not the owner's other devices.
  assert.equal((await post(`/pair/requests/${reqId}`, guestTok, { accept: true })).statusCode, 404);
  assert.equal((await post(`/pair/requests/${reqId}`, myPhoneTok, { accept: true })).statusCode, 404);
  assert.equal((await get(`/pair/requests/${reqId}`, guestTok)).json().status, 'pending');
  assert.equal((await post(`/pair/requests/${reqId}`, tvTok, { accept: false })).json().status, 'declined');
  await waitFor(() => phone.got.some((e) => e.type === 'pair.updated' && e.requestId === reqId && e.status === 'declined'));
  assert.equal(pairing.activePairing(ctx(guestTok).deviceRowId, tvDeviceId), null);

  // Expiry of an unanswered request.
  const rt = pairing.PAIR_LIMITS.requestTtlMs;
  pairing.PAIR_LIMITS.requestTtlMs = 30;
  s = (await post('/pair/start', tvTok)).json();
  const expiring = (await post('/pair/claim', guestTok, { token: s.token })).json().requestId;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await get(`/pair/requests/${expiring}`, guestTok)).json().status, 'expired');
  assert.equal((await post(`/pair/requests/${expiring}`, tvTok, { accept: true })).json().status, 'expired');
  pairing.PAIR_LIMITS.requestTtlMs = rt;

  // Accept.
  s = (await post('/pair/start', tvTok)).json();
  c = await post('/pair/claim', guestTok, { code: s.code });
  const ok = await post(`/pair/requests/${c.json().requestId}`, tvTok, { accept: true });
  assert.equal(ok.json().status, 'paired');
  await waitFor(() => phone.got.some((e) => e.type === 'pair.updated' && e.status === 'paired'));
  await waitFor(() => phone.got.some((e) => e.type === 'pair.targets' && e.targets.some((t) => t.id === tvDeviceId && t.crossUser)));
  const p = pairing.activePairing(ctx(guestTok).deviceRowId, tvDeviceId)!;
  assert.ok(p);
  assert.ok(Date.parse(p.expires_at) - Date.now() <= pairing.PAIR_LIMITS.crossUserTtlMs);
  // Both users see it in their lists, with the right role.
  const mine = (await get('/pair/pairings', tvTok)).json();
  assert.ok(mine.some((x: any) => x.role === 'tv' && x.otherUserName === 'pair-guest' && x.crossUser));
  const theirs = (await get('/pair/pairings', guestTok)).json();
  assert.ok(theirs.some((x: any) => x.role === 'controller' && x.otherUserName === 'pair-owner'));
  assert.equal((await get('/pair/pairings', strangerTok)).json().length, 0);
  tv.ws.close();
  phone.ws.close();
});

test('a cross-user claim needs the TV online', async () => {
  await settle();
  const s = (await post('/pair/start', tvTok)).json();
  const other = issueToken(createUser({ username: 'pair-other', password: 'pw-123456' }).id, dev('other-phone')).token;
  const c = await post('/pair/claim', other, { token: s.token });
  assert.equal(c.statusCode, 409, c.body);
});

test('remote.key reaches only a paired TV; guests get transport only and allowed titles only', async () => {
  const tv = await connect(tvTok);
  const laptop = await connect(otherOwnDevTok);
  const myPhone = await connect(myPhoneTok);
  const guestPhone = await connect(guestTok);
  const stranger = await connect(strangerTok);
  const unpairedOwnTok = issueToken(owner.id, dev('tablet')).token;
  const tablet = await connect(unpairedOwnTok);
  const keys = () => tv.got.filter((e) => e.type === 'remote.key') as Extract<ServerEvent, { type: 'remote.key' }>[];

  myPhone.send({ type: 'remote.key', targetDeviceId: tvDeviceId, key: 'up' });
  guestPhone.send({ type: 'remote.key', targetDeviceId: tvDeviceId, key: 'text', text: 'star wars' });
  await waitFor(() => keys().length === 2);
  assert.deepEqual(keys().map((k) => [k.key, k.text, k.fromDeviceName]), [['up', undefined, 'My phone'], ['text', 'star wars', 'Guest phone']]);
  // Not paired: a stranger, and even the owner's own unpaired tablet (key injection needs the QR pairing).
  stranger.send({ type: 'remote.key', targetDeviceId: tvDeviceId, key: 'ok' });
  tablet.send({ type: 'remote.key', targetDeviceId: tvDeviceId, key: 'ok' });
  // Unknown keys are dropped.
  myPhone.send({ type: 'remote.key', targetDeviceId: tvDeviceId, key: 'rm -rf' });
  await waitFor(() => stranger.got.some((e) => e.type === 'error') && tablet.got.some((e) => e.type === 'error'));
  await settle();
  assert.equal(keys().length, 2);
  // Keys never go to the other devices of the TV user.
  assert.equal(laptop.got.filter((e) => e.type === 'remote.key').length, 0);
  // The paired direction only: the TV can't send keys to the phone.
  tv.send({ type: 'remote.key', targetDeviceId: ctx(myPhoneTok).deviceRowId, key: 'ok' });
  await settle();
  assert.equal(myPhone.got.filter((e) => e.type === 'remote.key').length, 0);

  // remote.command: own devices keep full "Play on…"; the guest gets transport, tracks and allowed titles.
  const cmds = () => tv.got.filter((e) => e.type === 'remote.command') as Extract<ServerEvent, { type: 'remote.command' }>[];
  tablet.send({ type: 'remote.command', targetDeviceId: tvDeviceId, action: 'playChannel', channelId: 'c1' });
  guestPhone.send({ type: 'remote.command', targetDeviceId: tvDeviceId, action: 'togglePause' });
  guestPhone.send({ type: 'remote.command', targetDeviceId: tvDeviceId, action: 'setSubtitleTrack', trackIndex: null });
  guestPhone.send({ type: 'remote.command', targetDeviceId: tvDeviceId, action: 'playItem', itemId: 'pm1' });
  guestPhone.send({ type: 'remote.command', targetDeviceId: tvDeviceId, action: 'playChannel', channelId: 'c1' });
  guestPhone.send({ type: 'remote.command', targetDeviceId: tvDeviceId, action: 'playItem', itemId: 'does-not-exist' });
  stranger.send({ type: 'remote.command', targetDeviceId: tvDeviceId, action: 'pause' });
  await waitFor(() => cmds().length >= 4);
  await settle();
  assert.deepEqual(cmds().map((c) => [c.action, c.fromDeviceName]), [
    ['playChannel', 'tablet'], ['togglePause', 'Guest phone'], ['setSubtitleTrack', 'Guest phone'], ['playItem', 'Guest phone'],
  ]);
  assert.equal(cmds()[2].trackIndex, null);

  // Second screen: the TV reports state with extras; the paired guest sees it (sanitised), the stranger is refused.
  tv.send({ type: 'remote.state', state: { itemId: 'pm1', channelId: null, title: 'Pair Movie', subtitle: null, posterUrl: null, positionMs: 61000, durationMs: 7200000, paused: false, volume: 80,
    audioTracks: [{ index: 1, label: 'English 5.1' }, { index: 2, label: 'x'.repeat(500) }], audioIndex: 1, subtitleTracks: [], subtitleIndex: null, skip: { type: 'intro', label: 'Skip intro' } } });
  await waitFor(() => guestPhone.got.some((e) => e.type === 'pair.targets' && e.targets.some((t) => t.state?.itemId === 'pm1')));
  const pt = [...guestPhone.got].reverse().find((e) => e.type === 'pair.targets') as Extract<ServerEvent, { type: 'pair.targets' }>;
  assert.equal(pt.targets[0].state!.audioTracks![1].label.length, 80);
  assert.deepEqual(pt.targets[0].state!.skip, { type: 'intro', label: 'Skip intro' });
  const now2 = await get(`/pair/targets/${tvDeviceId}/now`, guestTok);
  assert.equal(now2.statusCode, 200, now2.body);
  assert.equal(now2.json().item.title, 'Pair Movie');
  assert.equal(now2.json().item.media, undefined, 'a guest never gets file details');
  assert.equal(now2.json().item.userData.positionMs, 0, 'nor the TV user’s progress');
  assert.equal((await get(`/pair/targets/${tvDeviceId}/now`, strangerTok)).statusCode, 403);
  // Browsing: the TV user's allowed titles (the guest's own access doesn't matter), no history for guests.
  const br = (await get(`/pair/targets/${tvDeviceId}/browse`, guestTok)).json();
  assert.ok(br.items.some((i: any) => i.id === 'pm1'));
  assert.deepEqual(br.continueWatching, []);
  assert.equal((await get('/api/v1/items/pm1'.replace('/api/v1', ''), guestTok)).statusCode, 404, 'the guest still has no access of their own');
  assert.equal((await get(`/pair/targets/${tvDeviceId}/browse?q=pair`, strangerTok)).statusCode, 403);

  for (const s of [tv, laptop, myPhone, guestPhone, stranger, tablet]) s.ws.close();
});

test('revocation by either side, and sign-out, end the pairing', async () => {
  const tv = await connect(tvTok);
  const guestPhone = await connect(guestTok);
  const p = pairing.activePairing(ctx(guestTok).deviceRowId, tvDeviceId)!;
  assert.ok(p);
  // A stranger can't revoke it.
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/pair/pairings/${p.id}`, headers: auth(strangerTok) })).statusCode, 404);
  const r = await app.inject({ method: 'DELETE', url: `/api/v1/pair/pairings/${p.id}`, headers: auth(tvTok) });
  assert.equal(r.statusCode, 200, r.body);
  await waitFor(() => guestPhone.got.some((e) => e.type === 'pair.updated' && e.pairingId === p.id && e.status === 'revoked'));
  assert.equal(pairing.activePairing(ctx(guestTok).deviceRowId, tvDeviceId), null);
  guestPhone.send({ type: 'remote.key', targetDeviceId: tvDeviceId, key: 'ok' });
  await waitFor(() => guestPhone.got.some((e) => e.type === 'error'));
  assert.equal(tv.got.filter((e) => e.type === 'remote.key').length, 0);
  assert.equal((await get(`/pair/targets/${tvDeviceId}/now`, guestTok)).statusCode, 403);
  // The phone revokes its own pairing too.
  const myP = pairing.activePairing(ctx(myPhoneTok).deviceRowId, tvDeviceId)!;
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/pair/pairings/${myP.id}`, headers: auth(myPhoneTok) })).statusCode, 200);
  // Sign-out deletes the device row, and its pairings with it.
  const laptopId = ctx(otherOwnDevTok).deviceRowId;
  assert.ok(pairing.activePairing(laptopId, tvDeviceId));
  logout(ctx(otherOwnDevTok));
  assert.equal(db.get('SELECT COUNT(*) n FROM remote_pairings WHERE ctl_device_id = ?', laptopId)!.n, 0);
  tv.ws.close();
  guestPhone.ws.close();
});
