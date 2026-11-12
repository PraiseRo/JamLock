// Tests for persistent identity-secret fallback behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadIdentitySecret } from '../server/identity.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jamlock-identity-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('IDENTITY_SECRET from the environment always wins', () => {
  const dir = makeTempDir();
  try {
    const envSecret = 'x'.repeat(48);
    const secret = loadIdentitySecret({
      env: { IDENTITY_SECRET: envSecret },
      dataDir: dir,
      warn: () => {}
    });
    assert.equal(secret, envSecret);
    assert.equal(fs.existsSync(path.join(dir, 'identity-secret')), false);
  } finally {
    cleanup(dir);
  }
});

test('generated identity secret persists across reloads', () => {
  const dir = makeTempDir();
  try {
    const warnings = [];
    const first = loadIdentitySecret({ env: {}, dataDir: dir, warn: (message) => warnings.push(message) });
    const second = loadIdentitySecret({ env: {}, dataDir: dir, warn: () => {} });

    assert.ok(first.length >= 64);
    assert.equal(first, second);
    assert.equal(fs.readFileSync(path.join(dir, 'identity-secret'), 'utf8').trim(), first);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /persistent key/i);
  } finally {
    cleanup(dir);
  }
});

test('a too-short stored secret is replaced', () => {
  const dir = makeTempDir();
  try {
    const file = path.join(dir, 'identity-secret');
    fs.writeFileSync(file, 'short\n');

    const secret = loadIdentitySecret({ env: {}, dataDir: dir, warn: () => {} });
    assert.notEqual(secret, 'short');
    assert.ok(secret.length >= 64);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), secret);
  } finally {
    cleanup(dir);
  }
});
