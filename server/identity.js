// Signed-cookie identity secret loading.
// Prefer IDENTITY_SECRET. When it is missing, persist a generated key under data/
// so a normal process restart does not invalidate every browser's room identity.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const SECRET_FILE_NAME = 'identity-secret';
const MIN_SECRET_LENGTH = 32;

export function loadIdentitySecret({
  env = process.env,
  dataDir = path.join(process.cwd(), 'data'),
  warn = console.warn
} = {}) {
  const fromEnv = typeof env.IDENTITY_SECRET === 'string' ? env.IDENTITY_SECRET.trim() : '';
  if (fromEnv) return fromEnv;

  const secretFile = path.join(dataDir, SECRET_FILE_NAME);
  let existingFile = false;

  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    existingFile = true;
    if (existing.length >= MIN_SECRET_LENGTH) {
      warn(`[auth] IDENTITY_SECRET is not set; using the persisted key at ${secretFile}.`);
      return existing;
    }
  } catch (e) {
    // Missing or unreadable: create one below.
  }

  const generated = crypto.randomBytes(48).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    // A too-short/corrupt file is replaced; a missing file is created atomically so
    // two processes starting together still converge on one key.
    fs.writeFileSync(secretFile, `${generated}\n`, existingFile
      ? { mode: 0o600 }
      : { mode: 0o600, flag: 'wx' });

    // If another process won the race, use its key so both workers agree.
    const stored = fs.readFileSync(secretFile, 'utf8').trim();
    if (stored.length >= MIN_SECRET_LENGTH) {
      warn(`[auth] IDENTITY_SECRET is not set; generated a persistent key at ${secretFile}.`);
      return stored;
    }
  } catch (e) {
    try {
      const existing = fs.readFileSync(secretFile, 'utf8').trim();
      if (existing.length >= MIN_SECRET_LENGTH) {
        warn(`[auth] IDENTITY_SECRET is not set; using the persisted key at ${secretFile}.`);
        return existing;
      }
    } catch (readErr) {
      // Fall through to the in-memory key.
    }
  }

  warn('[auth] IDENTITY_SECRET is not set and no persistent key could be saved; using a random key. Room identities will reset on restart.');
  return crypto.randomBytes(48).toString('hex');
}
