// Regression tests for resolver cache expiry helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../server/audioResolver.js';

const { cacheExpiryFor } = __test;

test('cacheExpiryFor respects a Googlevideo expire timestamp', () => {
  const now = Date.now();
  const fallback = now + 20 * 60 * 1000;
  const expireSec = Math.floor((now + 10 * 60 * 1000) / 1000);
  const url = `https://rr1.googlevideo.com/videoplayback?expire=${expireSec}&id=test`;

  const expiry = cacheExpiryFor(url, fallback);
  assert.equal(expiry, expireSec * 1000 - 60 * 1000);
  assert.ok(expiry < fallback);
});

test('cacheExpiryFor never extends the fallback TTL', () => {
  const now = Date.now();
  const fallback = now + 20 * 60 * 1000;
  const expireSec = Math.floor((now + 60 * 60 * 1000) / 1000);

  assert.equal(
    cacheExpiryFor(`https://rr1.googlevideo.com/videoplayback?expire=${expireSec}`, fallback),
    fallback
  );
});

test('cacheExpiryFor falls back for missing or malformed expire values', () => {
  const fallback = Date.now() + 20 * 60 * 1000;
  assert.equal(cacheExpiryFor('https://example.com/audio', fallback), fallback);
  assert.equal(cacheExpiryFor('https://example.com/audio?expire=nope', fallback), fallback);
  assert.equal(cacheExpiryFor('not a url', fallback), fallback);
  assert.equal(cacheExpiryFor('https://example.com/audio?expire=0', fallback), fallback);
});
