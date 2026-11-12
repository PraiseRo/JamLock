// Regression tests for the server security fixes.
// Run with: npm test  (Node 24+, built-in test runner + global WebSocket)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rooms } from '../server/rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3900 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_SECRET = 'test-admin-secret';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let child;
let serverOutput = '';

before(async () => {
  child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_SECRET,
      IDENTITY_SECRET: 'test-identity-secret',
      APP_ORIGIN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const capture = (chunk) => {
    serverOutput += String(chunk);
    if (serverOutput.length > 20000) serverOutput = serverOutput.slice(-10000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/ping`);
      if (res.ok) return;
    } catch (e) {
      // not listening yet
    }
    await sleep(150);
  }
  throw new Error(`Server failed to start. Output:\n${serverOutput}`);
});

after(() => {
  if (child && !child.killed) {
    try { child.kill(); } catch (e) {}
  }
});

function uniqueRoom(prefix = 'T') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase().slice(0, 20);
}

function connectSocket() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=websocket`);
  const ackWaiters = new Map();
  const eventWaiters = [];
  let nextAckId = 1;

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket open timeout')), 8000);
    ws.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      if (data === '2') {
        ws.send('3');
        return;
      }
      if (data.startsWith('0')) {
        ws.send('40');
        return;
      }
      if (data.startsWith('40')) {
        clearTimeout(timer);
        resolve();
        return;
      }
      if (data.startsWith('43')) {
        const match = data.slice(2).match(/^\d+/);
        if (!match) return;
        const id = Number(match[0]);
        const rest = data.slice(2 + match[0].length);
        let args = [];
        try { args = JSON.parse(rest); } catch (e) {}
        const waiter = ackWaiters.get(id);
        if (waiter) {
          ackWaiters.delete(id);
          clearTimeout(waiter.timer);
          waiter.resolve(args[0]);
        }
        return;
      }
      if (data.startsWith('42')) {
        let args;
        try { args = JSON.parse(data.slice(2)); } catch (e) { return; }
        const [eventName, ...payload] = args;
        for (let i = eventWaiters.length - 1; i >= 0; i--) {
          const waiter = eventWaiters[i];
          if (waiter.eventName === eventName) {
            eventWaiters.splice(i, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(payload[0]);
          }
        }
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('socket connection error'));
    });
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      for (const waiter of ackWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('socket closed'));
      }
      ackWaiters.clear();
      for (const waiter of eventWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('socket closed'));
      }
    });
  });

  return {
    ws,
    ready,
    emit(eventName, payload) {
      ws.send(`42${JSON.stringify([eventName, payload])}`);
    },
    request(eventName, payload, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const id = nextAckId++;
        const timer = setTimeout(() => {
          ackWaiters.delete(id);
          reject(new Error(`ack timeout for ${eventName}`));
        }, timeoutMs);
        ackWaiters.set(id, { resolve, reject, timer });
        const args = payload === undefined ? [eventName] : [eventName, payload];
        ws.send(`42${id}${JSON.stringify(args)}`);
      });
    },
    once(eventName, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const waiter = {
          eventName,
          resolve,
          reject,
          timer: setTimeout(() => {
            const idx = eventWaiters.indexOf(waiter);
            if (idx !== -1) eventWaiters.splice(idx, 1);
            reject(new Error(`event timeout for ${eventName}`));
          }, timeoutMs)
        };
        eventWaiters.push(waiter);
      });
    },
    close() {
      try { ws.send('41'); } catch (e) {}
      try { ws.close(); } catch (e) {}
    }
  };
}

async function join(client, roomId, username, extra = {}) {
  return client.request('join-room', { roomId, username, isCreating: true, ...extra });
}

// --- Unit tests: room state / PIN handling ---

test('room serialization never includes the plaintext PIN', async () => {
  const roomId = uniqueRoom('P');
  rooms.getOrCreateRoom(roomId);
  await rooms.setRoomPin(roomId, '1234');

  const room = rooms.getRoom(roomId);
  const serialized = rooms.serializeRoom(room);
  assert.equal(serialized.settings.hasPin, true);
  assert.equal(Object.prototype.hasOwnProperty.call(serialized.settings, 'pin'), false);
  assert.equal(JSON.stringify(serialized).includes('"1234"'), false);

  assert.equal(await rooms.verifyRoomPin(room, '1234'), true);
  assert.equal(await rooms.verifyRoomPin(room, '9999'), false);

  await rooms.setRoomPin(roomId, null);
  assert.equal(rooms.serializeRoom(room).settings.hasPin, false);
});

test('rooms add users with PIN verification and never grant host to a second user', async () => {
  const roomId = uniqueRoom('U');
  const host = await rooms.addUser(roomId, 'sock-host', 'Host', 'cid_unit_host');
  assert.equal(host.user.isHost, true);

  await rooms.setRoomPin(roomId, '4321');
  const wrong = await rooms.addUser(roomId, 'sock-guest', 'Guest', 'cid_unit_guest', '1111');
  assert.equal(wrong.error, 'invalid_pin');

  const guest = await rooms.addUser(roomId, 'sock-guest', 'Guest', 'cid_unit_guest', '4321');
  assert.equal(guest.user.isHost, false);
  assert.equal(rooms.getUniqueUsers(rooms.getRoom(roomId)).length, 2);
});

test('queue length is capped at 100 tracks', () => {
  const roomId = uniqueRoom('Q');
  rooms.getOrCreateRoom(roomId);
  rooms.playTrack(roomId, { id: 'current', title: 'Current', durationSeconds: 120 });
  for (let i = 0; i < 100; i++) {
    const updated = rooms.addToQueue(roomId, { id: `track-${i}`, title: `Track ${i}` }, false);
    assert.ok(updated, `track ${i} should fit`);
  }
  assert.equal(rooms.getRoom(roomId).queue.length, 100);
  assert.equal(rooms.addToQueue(roomId, { id: 'overflow', title: 'Overflow' }, false), null);
});

// --- HTTP tests: auth, headers, telemetry XSS ---

test('admin stats require the configured secret and reject the old default', async () => {
  const unauth = await fetch(`${BASE}/api/admin/stats`);
  assert.equal(unauth.status, 401);

  const oldDefault = await fetch(`${BASE}/api/admin/stats?key=jamlock-secret-admin`);
  assert.equal(oldDefault.status, 401);

  const ok = await fetch(`${BASE}/api/admin/stats`, { headers: { 'x-admin-key': ADMIN_SECRET } });
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.ok(data.allTime);
});

test('telemetry requires Basic auth and never returns unescaped payload HTML', async () => {
  const unauth = await fetch(`${BASE}/api/telemetry`);
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate') || '', /Basic/i);

  const client = connectSocket();
  await client.ready;
  client.emit('client-audio-telemetry', {
    event: '<img src=x onerror=alert(1)>',
    engine: 'audio',
    detail: '<script>alert("xss")</script>',
    hidden: false
  });
  await sleep(200);
  client.close();

  const auth = `Basic ${Buffer.from(`admin:${ADMIN_SECRET}`).toString('base64')}`;
  const res = await fetch(`${BASE}/api/telemetry`, { headers: { authorization: auth } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);
  assert.equal(html.includes('<script>alert("xss")</script>'), false);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('baseline security headers are present and wildcard CORS is gone', async () => {
  const res = await fetch(`${BASE}/api/ping`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

// --- Socket tests: crash safety, host takeover, PIN join flow ---

test('a malformed play payload cannot crash the server', async () => {
  const roomId = uniqueRoom('C');
  const host = connectSocket();
  await host.ready;
  const ack = await join(host, roomId, 'Crash Tester');
  assert.equal(ack.success, true);

  // This exact payload used to throw "Cannot destructure property 'positionSec' of null".
  host.emit('play', null);
  await sleep(250);

  const ping = await fetch(`${BASE}/api/ping`);
  assert.equal(ping.status, 200);

  // The same socket still works after the malformed event.
  const sync = await host.request('sync-request', undefined, 3000);
  assert.ok(sync && typeof sync.serverTime === 'number');
  host.close();
});

test('a public clientId in the join payload cannot take over the host', async () => {
  const roomId = uniqueRoom('H');
  const host = connectSocket();
  await host.ready;
  const hostAck = await join(host, roomId, 'Real Host');
  assert.equal(hostAck.success, true);
  assert.equal(hostAck.user.isHost, true);
  const publicClientId = hostAck.user.clientId;

  const attacker = connectSocket();
  await attacker.ready;
  const attackerAck = await attacker.request('join-room', {
    roomId,
    username: 'Attacker',
    isCreating: false,
    clientId: publicClientId
  });
  assert.equal(attackerAck.success, true);
  assert.equal(attackerAck.user.isHost, false);
  assert.notEqual(attackerAck.user.clientId, publicClientId);
  assert.equal(attackerAck.room.users.length, 2);

  // The attacker cannot change room settings.
  const notification = attacker.once('notification');
  attacker.emit('update-room-settings', { theme: 'cyber' });
  const note = await notification;
  assert.match(note.text, /Only the host/i);

  host.close();
  attacker.close();
});

test('room PIN is required to join, is not leaked over HTTP, and can be removed', async () => {
  const roomId = uniqueRoom('S');
  const host = connectSocket();
  await host.ready;
  const hostAck = await join(host, roomId, 'PIN Host');
  assert.equal(hostAck.success, true);

  host.emit('update-room-settings', { pin: '2468' });
  await sleep(250);

  const roomRes = await fetch(`${BASE}/api/room/${roomId}`);
  assert.equal(roomRes.status, 200);
  const roomJson = await roomRes.json();
  assert.equal(roomJson.settings.hasPin, true);
  assert.equal(Object.prototype.hasOwnProperty.call(roomJson.settings, 'pin'), false);
  assert.equal(JSON.stringify(roomJson).includes('"pin":"2468"'), false);

  const guest = connectSocket();
  await guest.ready;
  const denied = await guest.request('join-room', {
    roomId,
    username: 'Guest',
    isCreating: false,
    pin: '0000'
  });
  assert.equal(denied.success, false);
  assert.equal(denied.code, 'invalid_pin');

  const allowed = await guest.request('join-room', {
    roomId,
    username: 'Guest',
    isCreating: false,
    pin: '2468'
  });
  assert.equal(allowed.success, true);

  // Host removes the PIN; a fresh guest can now join without one.
  host.emit('update-room-settings', { pin: null });
  await sleep(250);
  const afterRemove = await (await fetch(`${BASE}/api/room/${roomId}`)).json();
  assert.equal(afterRemove.settings.hasPin, false);

  const noPinGuest = connectSocket();
  await noPinGuest.ready;
  const noPinAck = await noPinGuest.request('join-room', {
    roomId,
    username: 'NoPinGuest',
    isCreating: false
  });
  assert.equal(noPinAck.success, true);

  host.close();
  guest.close();
  noPinGuest.close();
});

test('host-only DJ mode blocks guest playback', async () => {
  const roomId = uniqueRoom('D');
  const host = connectSocket();
  await host.ready;
  const hostAck = await join(host, roomId, 'DJHost');
  assert.equal(hostAck.success, true);

  const guest = connectSocket();
  await guest.ready;
  const guestAck = await guest.request('join-room', {
    roomId,
    username: 'DJGuest',
    isCreating: false
  });
  assert.equal(guestAck.success, true);

  host.emit('update-room-settings', { djMode: 'host-only' });
  await sleep(250);

  const denied = guest.once('notification');
  guest.emit('play', { positionSec: 0 });
  const deniedNote = await denied;
  assert.match(deniedNote.text, /restricted to the room host/i);

  // The host still has control.
  host.emit('play', { positionSec: 0 });
  await sleep(200);
  const room = await (await fetch(`${BASE}/api/room/${roomId}`)).json();
  assert.equal(room.settings.djMode, 'host-only');
  assert.equal(room.playback.isPlaying, true);

  host.close();
  guest.close();
});

test('a stale skip report cannot advance the queue twice', async () => {
  const roomId = uniqueRoom('K');
  const host = connectSocket();
  await host.ready;
  const hostAck = await join(host, roomId, 'SkipHost');
  assert.equal(hostAck.success, true);

  const makeTrack = (id, title) => ({
    id,
    title,
    artist: 'Test Artist',
    durationSeconds: 200,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
  });

  host.emit('play-now', { track: makeTrack('AAAAAAAAAAA', 'Track A') });
  await sleep(1500);
  let room = await (await fetch(`${BASE}/api/room/${roomId}`)).json();
  assert.equal(room.currentTrack?.id, 'AAAAAAAAAAA');

  host.emit('add-to-queue', { track: makeTrack('BBBBBBBBBBB', 'Track B') });
  host.emit('add-to-queue', { track: makeTrack('CCCCCCCCCCC', 'Track C') });
  await sleep(300);
  room = await (await fetch(`${BASE}/api/room/${roomId}`)).json();
  assert.deepEqual(room.queue.map((t) => t.id), ['BBBBBBBBBBB', 'CCCCCCCCCCC']);

  // Both reports refer to the track that was current when the skip started. The
  // second one must not skip the newly promoted Track B as well.
  host.emit('skip-track', { endedTrackId: 'AAAAAAAAAAA' });
  host.emit('skip-track', { endedTrackId: 'AAAAAAAAAAA' });
  await sleep(400);
  room = await (await fetch(`${BASE}/api/room/${roomId}`)).json();
  assert.equal(room.currentTrack?.id, 'BBBBBBBBBBB');
  assert.deepEqual(room.queue.map((t) => t.id), ['CCCCCCCCCCC']);

  host.close();
});

// Keep this last: a PIN lockout is keyed by client IP, which is shared by every
// socket in this test process.
test('repeated wrong PIN attempts lock the client IP', async () => {
  const roomId = uniqueRoom('L');
  const host = connectSocket();
  await host.ready;
  const hostAck = await join(host, roomId, 'LockHost');
  assert.equal(hostAck.success, true);

  host.emit('update-room-settings', { pin: '9876' });
  await sleep(250);

  const guesser = connectSocket();
  await guesser.ready;
  for (let i = 0; i < 8; i++) {
    const res = await guesser.request('join-room', {
      roomId,
      username: 'Guesser',
      isCreating: false,
      pin: '0000'
    });
    assert.equal(res.success, false);
    assert.equal(res.code, 'invalid_pin');
  }

  // Even the correct PIN is refused once the lockout is active.
  const locked = await guesser.request('join-room', {
    roomId,
    username: 'Guesser',
    isCreating: false,
    pin: '9876'
  });
  assert.equal(locked.success, false);
  assert.equal(locked.code, 'pin_locked');

  host.close();
  guesser.close();
});
