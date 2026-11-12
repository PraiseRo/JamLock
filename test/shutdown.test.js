// Unit tests for graceful shutdown logic (SIGTERM/SIGINT handling).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGracefulShutdown } from '../server/shutdown.js';

const silentLog = { log() {}, warn() {} };

test('shutdown closes Socket.IO and exits once', () => {
  const exits = [];
  let closeCallback = null;
  const io = { close: (cb) => { closeCallback = cb; } };
  const shutdown = createGracefulShutdown({
    io,
    timeoutMs: 1000,
    exit: (code) => exits.push(code),
    log: silentLog
  });

  assert.equal(shutdown('SIGTERM'), true);
  assert.equal(shutdown('SIGINT'), false, 'second signal is ignored');
  assert.equal(typeof closeCallback, 'function');

  closeCallback();
  assert.deepEqual(exits, [0]);
});

test('shutdown force-exits when Socket.IO close hangs', async () => {
  const exits = [];
  const io = { close: () => {} };
  const shutdown = createGracefulShutdown({
    io,
    timeoutMs: 20,
    exit: (code) => exits.push(code),
    log: silentLog
  });

  shutdown('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(exits, [0]);
});

test('shutdown exits when Socket.IO close throws', () => {
  const exits = [];
  const io = { close: () => { throw new Error('close failed'); } };
  const shutdown = createGracefulShutdown({
    io,
    timeoutMs: 1000,
    exit: (code) => exits.push(code),
    log: silentLog
  });

  assert.equal(shutdown('SIGTERM'), true);
  assert.deepEqual(exits, [0]);
});
