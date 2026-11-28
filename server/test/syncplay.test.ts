// Watch together: clock offset from ping round trips, the room's expected position, gentle drift correction, and the
// server holding a room while a member buffers (released when they're ready or leave).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sc = await import('../src/services/syncClock.ts');
const { handleSyncPlay, leaveAll } = await import('../src/services/syncplay.ts');
const { createUser } = await import('../src/services/auth.ts');

test('clock offset: shortest round trips win, half the round trip assumed', () => {
  // The server is 1000 ms ahead; the noisy sample (slow reply) must not drag the estimate.
  const s = [
    { sentAt: 0, serverAt: 1050, receivedAt: 100 },
    { sentAt: 200, serverAt: 1220, receivedAt: 240 },
    { sentAt: 400, serverAt: 1900, receivedAt: 1400 },
  ];
  assert.equal(sc.clockOffset(s), 1000);
  assert.equal(sc.clockOffset([]), null);
});

test('expected position follows the room clock; holds while paused or waiting', () => {
  const room = { state: 'playing' as const, positionMs: 60_000, updatedAt: 10_000 };
  assert.equal(sc.expectedPosition(room, 9_500, 1_000), 60_500, 'client clock 1 s behind the server');
  assert.equal(sc.expectedPosition({ ...room, waiting: true }, 20_000, 0), 60_000);
  assert.equal(sc.expectedPosition({ ...room, state: 'paused' }, 20_000, 0), 60_000);
});

test('drift: nothing inside the dead band, ≤5 % rate nudges, seek only when far off', () => {
  assert.deepEqual(sc.driftCorrection(50), { kind: 'none', rate: 1 });
  assert.deepEqual(sc.driftCorrection(400), { kind: 'rate', rate: 0.96 }, 'ahead → slower');
  assert.deepEqual(sc.driftCorrection(-400), { kind: 'rate', rate: 1.04 }, 'behind → faster');
  assert.equal((sc.driftCorrection(2000) as { rate: number }).rate, 0.95, 'capped at 5 %');
  assert.deepEqual(sc.driftCorrection(-3000), { kind: 'seek' });
  assert.deepEqual(sc.driftCorrection(Number.NaN), { kind: 'none', rate: 1 });
});

test('server: a buffering member holds the room; it resumes when they are ready or leave', async () => {
  const a = await createUser({ username: 'sp-a', password: 'pass1234' });
  const b = await createUser({ username: 'sp-b', password: 'pass1234' });
  const inbox = new Map<string, any[]>();
  const client = (userId: string) => {
    const list: any[] = [];
    inbox.set(userId, list);
    return { userId, send: (m: unknown) => list.push(m) } as any;
  };
  const ca = client(a.id);
  const cb = client(b.id);
  handleSyncPlay(ca, { type: 'syncplay.create', itemId: 'x' });
  const room = inbox.get(a.id)!.find((m) => m.type === 'syncplay.state').room;
  handleSyncPlay(cb, { type: 'syncplay.join', room: room.code });
  handleSyncPlay(ca, { type: 'syncplay.command', room: room.id, action: 'play', positionMs: 10_000 });
  const last = (u: string, type: string) => [...inbox.get(u)!].reverse().find((m) => m.type === type);

  handleSyncPlay(cb, { type: 'syncplay.buffering', room: room.id, buffering: true });
  const held = last(a.id, 'syncplay.state').room;
  assert.equal(held.waiting, true);
  assert.equal(held.state, 'playing');
  assert.ok(held.positionMs >= 10_000);
  assert.equal(held.members.find((m: any) => m.userId === b.id).buffering, true);

  handleSyncPlay(cb, { type: 'syncplay.buffering', room: room.id, buffering: false });
  assert.equal(last(a.id, 'syncplay.state').room.waiting, false);

  handleSyncPlay(cb, { type: 'syncplay.buffering', room: room.id, buffering: true });
  assert.equal(last(a.id, 'syncplay.state').room.waiting, true);
  leaveAll(cb);
  assert.equal(last(a.id, 'syncplay.state').room.waiting, false, 'a member who left must not keep the room waiting');

  handleSyncPlay(ca, { type: 'syncplay.ping', sentAt: 123 });
  const pong = last(a.id, 'syncplay.pong');
  assert.equal(pong.sentAt, 123);
  assert.ok(Math.abs(pong.serverAt - Date.now()) < 1000);
  leaveAll(ca);
});

test('server: one user on two devices — the buffering device leaving releases the hold', async () => {
  const u = await createUser({ username: 'sp-two', password: 'pass1234' });
  const o = await createUser({ username: 'sp-host', password: 'pass1234' });
  const seen: any[] = [];
  const mk = (userId: string) => ({ userId, send: (m: unknown) => seen.push(m) }) as any;
  const host = mk(o.id);
  const phone = mk(u.id);
  const tv = mk(u.id);
  handleSyncPlay(host, { type: 'syncplay.create', itemId: 'y' });
  const room = seen.find((m) => m.type === 'syncplay.state').room;
  handleSyncPlay(phone, { type: 'syncplay.join', room: room.code });
  handleSyncPlay(tv, { type: 'syncplay.join', room: room.code });
  handleSyncPlay(host, { type: 'syncplay.command', room: room.id, action: 'play', positionMs: 0 });
  handleSyncPlay(tv, { type: 'syncplay.buffering', room: room.id, buffering: true });
  const last = () => [...seen].reverse().find((m) => m.type === 'syncplay.state').room;
  assert.equal(last().waiting, true);
  leaveAll(tv);
  assert.equal(last().waiting, false, 'the phone (same user) is not buffering');
  assert.equal(last().members.find((m: any) => m.userId === u.id).buffering, false);
  leaveAll(phone);
  leaveAll(host);
});
