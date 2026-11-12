// Regression tests for the shared Piped/Invidious host cooldown logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstanceHealth } from '../server/instanceHealth.js';

test('instance health cools a host after the failure threshold', () => {
  let now = 1000;
  const health = createInstanceHealth({ cooldownMs: 100, failureThreshold: 2, now: () => now });
  const a = 'https://a.example';
  const b = 'https://b.example';

  assert.deepEqual(health.available([a, b]), [a, b]);

  health.recordFailure(a);
  assert.deepEqual(health.available([a, b]), [a, b]);
  health.recordFailure(a);
  assert.deepEqual(health.available([a, b]), [b]);

  // Cooldown expires and the host is eligible again.
  now = 1101;
  assert.deepEqual(health.available([a, b]), [a, b]);
});

test('instance health probes only the soonest host when all are cooling', () => {
  let now = 1000;
  const health = createInstanceHealth({ cooldownMs: 100, failureThreshold: 1, now: () => now });
  const a = 'https://a.example';
  const b = 'https://b.example';
  const c = 'https://c.example';

  health.recordFailure(a); // cooling until 1100
  now = 1020;
  health.recordFailure(b); // cooling until 1120
  now = 1040;
  health.recordFailure(c); // cooling until 1140

  now = 1050;
  assert.deepEqual(health.available([a, b, c]), [a]);
});

test('a successful request clears the host cooldown', () => {
  let now = 1000;
  const health = createInstanceHealth({ cooldownMs: 100, failureThreshold: 1, now: () => now });
  const a = 'https://a.example';

  health.recordFailure(a);
  assert.deepEqual(health.available([a, 'https://b.example']), ['https://b.example']);
  health.recordSuccess(a);
  assert.deepEqual(health.available([a, 'https://b.example']), [a, 'https://b.example']);
});
