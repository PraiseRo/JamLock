// Express & Socket.io Server Entry
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { rooms } from './rooms.js';
import { searchSongs, getRecommendations, getMultipleRecommendations } from './search.js';
import { resolveAudioStream, streamAudioToClient, getYoutubeAudioFormat } from './audioResolver.js';
import { metrics } from './metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const ALLOWED_ORIGIN = process.env.APP_ORIGIN || '';
const IDENTITY_SECRET = process.env.IDENTITY_SECRET || crypto.randomBytes(32).toString('hex');
const IDENTITY_COOKIE = 'jl_identity';
const IDENTITY_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  ...(ALLOWED_ORIGIN ? { cors: { origin: ALLOWED_ORIGIN, methods: ['GET', 'POST'] } } : {})
});

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Cross-origin access is opt-in; the app itself is same-origin, so no CORS is needed by default.
if (ALLOWED_ORIGIN) app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '32kb' }));

// Baseline security headers (no CSP yet: the app intentionally uses inline styles)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// --- Anonymous, server-signed browser identity ---
// clientId values are public (they appear in room state), so they must never be trusted as credentials.
// Only a value carrying a valid HMAC signature is accepted. Multi-tab and reconnects share the cookie.
function parseCookieHeader(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch (e) {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function signClientId(clientId) {
  return crypto.createHmac('sha256', IDENTITY_SECRET).update(String(clientId)).digest('base64url').slice(0, 32);
}

function verifySignedClientId(value) {
  if (typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const clientId = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!/^cid_[a-f0-9]{32}$/.test(clientId) || !/^[A-Za-z0-9_-]{32}$/.test(signature)) return null;
  const expected = signClientId(clientId);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? clientId : null;
}

function getRequestClientId(req) {
  const cookies = parseCookieHeader(req?.headers?.cookie || '');
  return verifySignedClientId(cookies[IDENTITY_COOKIE]);
}

function ensureIdentityCookie(req, res, next) {
  if (!getRequestClientId(req)) {
    const clientId = 'cid_' + crypto.randomBytes(16).toString('hex');
    const value = `${clientId}.${signClientId(clientId)}`;
    const isHttps = Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https');
    const secureFlag = isHttps ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${IDENTITY_COOKIE}=${encodeURIComponent(value)}; Max-Age=${Math.floor(IDENTITY_MAX_AGE_MS / 1000)}; Path=/; HttpOnly; SameSite=Lax${secureFlag}`
    );
  }
  next();
}

app.use(ensureIdentityCookie);

io.use((socket, next) => {
  // Raw clients without the signed cookie get a unique per-socket identity.
  socket.data.clientId = getRequestClientId(socket.request) || ('cid_' + crypto.randomBytes(16).toString('hex'));
  next();
});

// Serve static frontend files
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));

// --- Server-authoritative helpers ---

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function cleanText(value, maxLength = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Validate/normalise a client-supplied track so clients can't inject arbitrary objects
function sanitizeTrack(t, addedBy) {
  if (!t || typeof t.id !== 'string' || !/^[\w-]{6,20}$/.test(t.id)) return null;
  const thumb = typeof t.thumbnail === 'string' && /^https:\/\/[^'"\s<>()]{1,300}$/.test(t.thumbnail)
    ? t.thumbnail
    : `https://i.ytimg.com/vi/${t.id}/hqdefault.jpg`;
  const title = cleanText(t.title || 'Untitled Track', 200);
  return {
    id: t.id,
    title,
    cleanTitle: cleanText(t.cleanTitle || title, 200),
    artist: cleanText(t.artist || 'Unknown Artist', 120),
    duration: cleanText(t.duration || '0:00', 12),
    durationSeconds: Math.max(0, Math.min(Number(t.durationSeconds) || 0, 6 * 3600)),
    thumbnail: thumb,
    url: `https://www.youtube.com/watch?v=${t.id}`,
    addedBy: addedBy ? cleanText(addedBy, 25) : undefined
  };
}

// Every socket event goes through this boundary so one malformed payload can never
// take down the process (Socket.IO does not catch listener exceptions).
function reportSocketError(socket, event, err) {
  console.error(`[socket:${event}]`, err?.stack || err);
  try {
    socket.emit('notification', {
      type: 'error',
      text: 'Something went wrong on the server. Please try again.'
    });
  } catch (e) {}
}

function safeOn(socket, event, handler) {
  socket.on(event, (...args) => {
    try {
      const result = handler(...args);
      if (result && typeof result.then === 'function') {
        result.catch((err) => reportSocketError(socket, event, err));
      }
    } catch (err) {
      const ack = args.find((arg) => typeof arg === 'function');
      if (ack) {
        try { ack({ success: false, error: 'Server error' }); } catch (e) {}
      }
      reportSocketError(socket, event, err);
    }
  });
}

// Advance to the next track (queue -> auto-suggest -> stop) and broadcast
async function advanceTrack(roomId) {
  const room = rooms.getRoom(roomId);
  if (!room) return;

  if (room.queue.length > 0) {
    rooms.skipTrack(roomId);
    metrics.recordSongPlayed();
    // Pre-warm newly elevated track in queue
    if (room.queue.length > 0) {
      getYoutubeAudioFormat(room.queue[0].id).catch(() => {});
    }
  } else if (room.settings?.autoSuggest && room.currentTrack) {
    const recommended = await getRecommendations(room.currentTrack, room.history);
    if (recommended) {
      rooms.playTrack(roomId, recommended);
      metrics.recordSongPlayed();
      io.to(roomId).emit('notification', {
        type: 'queue',
        text: `✨ Auto-suggested: ${recommended.title}`
      });
    } else {
      rooms.stopAtStart(roomId);
    }
  } else {
    rooms.stopAtStart(roomId);
  }

  io.to(roomId).emit('room-state', rooms.serializeRoom(room));
  io.to(roomId).emit('track-changed', {
    currentTrack: room.currentTrack,
    playback: room.playback
  });
  scheduleAutoAdvance(roomId);
}

// Background Auto-Suggest Pre-Queue: Pre-fetches and pre-warms the next recommended song
// halfway through the current track so transitions are completely gapless with 0ms silence
async function prepareEarlyAutoSuggest(roomId) {
  const room = rooms.getRoom(roomId);
  if (!room || !room.currentTrack || !room.playback?.isPlaying) return;
  if (!room.settings?.autoSuggest) return;
  // If queue already has tracks or already prepared for this track, skip
  if (room.queue.length > 0) return;
  if (room._autoSuggestedTrackId === room.currentTrack.id) return;

  const currentTrackId = room.currentTrack.id;
  room._autoSuggestedTrackId = currentTrackId;

  try {
    const recommended = await getRecommendations(room.currentTrack, room.history);
    const activeRoom = rooms.getRoom(roomId);
    if (!activeRoom || !activeRoom.settings?.autoSuggest) return;
    // Ensure track has not changed and queue is still empty
    if (activeRoom.currentTrack?.id !== currentTrackId) return;
    if (activeRoom.queue.length > 0) return;

    if (recommended) {
      const payload = {
        ...recommended,
        isAutoSuggested: true,
        addedBy: 'Auto-Suggest'
      };
      rooms.addToQueue(roomId, payload, false);
      // Pre-warm audio format immediately so client transitions with 0ms delay
      getYoutubeAudioFormat(recommended.id).catch(() => {});

      io.to(roomId).emit('room-state', rooms.serializeRoom(activeRoom));
      io.to(roomId).emit('notification', {
        type: 'queue',
        text: `✨ Auto-suggest queued next: ${recommended.title}`
      });
    }
  } catch (err) {
    console.warn(`[auto-suggest] background preparation error in room ${roomId}:`, err?.message || err);
  }
}

// (Re)schedule the server-side end-of-track timer so the queue advances
// even if the host's tab is closed or backgrounded.
function scheduleAutoAdvance(roomId) {
  const room = rooms.getRoom(roomId);
  if (!room) return;
  if (room.autoAdvanceTimer) {
    clearTimeout(room.autoAdvanceTimer);
    room.autoAdvanceTimer = null;
  }
  if (room.autoSuggestTimer) {
    clearTimeout(room.autoSuggestTimer);
    room.autoSuggestTimer = null;
  }

  const duration = room.currentTrack?.durationSeconds || 0;
  if (!room.currentTrack || !room.playback.isPlaying || duration <= 0) return;

  const elapsed = rooms.getCurrentPosition(room);
  const remainingSec = Math.max(0, duration - elapsed);
  const trackId = room.currentTrack.id;

  // Background Auto-Suggest Pre-Queue: trigger at ~45% through (or 40s before finish)
  if (room.settings?.autoSuggest && room.queue.length === 0 && room._autoSuggestedTrackId !== trackId) {
    const triggerSec = Math.min(duration * 0.45, Math.max(0, duration - 40));
    const delayMs = Math.max(500, Math.round((triggerSec - elapsed) * 1000));
    room.autoSuggestTimer = setTimeout(() => {
      room.autoSuggestTimer = null;
      prepareEarlyAutoSuggest(roomId).catch(() => {});
    }, delayMs);
  }

  // Seamless queue transition: pre-warm upcoming queued track 25s before track ends
  if (room.queue.length > 0) {
    if (remainingSec <= 25) {
      getYoutubeAudioFormat(room.queue[0].id).catch(() => {});
    } else {
      setTimeout(() => {
        const curRoom = rooms.getRoom(roomId);
        if (curRoom?.queue?.length > 0) {
          getYoutubeAudioFormat(curRoom.queue[0].id).catch(() => {});
        }
      }, Math.max(500, (remainingSec - 25) * 1000));
    }
  }

  room.autoAdvanceTimer = setTimeout(() => {
    room.autoAdvanceTimer = null;
    // Only advance if the same track is still playing
    if (room.currentTrack?.id !== trackId || !room.playback.isPlaying) return;
    advanceTrack(roomId).catch(() => {});
  }, remainingSec * 1000 + 800);
}

// --- PER-IP TOKEN BUCKET RATE LIMITER & SERVER SEARCH CACHE ---
// 20 requests per minute per IP token bucket
class SearchTokenBucket {
  constructor(capacity = 20, fillPerMinute = 20) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.fillRate = fillPerMinute / 60000; // tokens per millisecond
    this.lastFill = Date.now();
  }

  tryConsume(count = 1) {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.lastFill);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.fillRate);
    this.lastFill = now;

    const remaining = Math.max(0, Math.floor(this.tokens));
    const resetSec = Math.max(1, Math.ceil((this.capacity - this.tokens) / (this.fillRate * 1000)));

    if (this.tokens >= count) {
      this.tokens -= count;
      return {
        allowed: true,
        remaining: Math.max(0, Math.floor(this.tokens)),
        resetSec
      };
    }

    const retryAfterSec = Math.max(1, Math.ceil((count - this.tokens) / (this.fillRate * 1000)));
    return {
      allowed: false,
      remaining: 0,
      resetSec,
      retryAfterSec
    };
  }
}

const searchBuckets = new Map();
function checkSearchRateLimit(ip) {
  let bucket = searchBuckets.get(ip);
  if (!bucket) {
    bucket = new SearchTokenBucket(20, 20);
    searchBuckets.set(ip, bucket);
  }
  return bucket.tryConsume(1);
}

// --- Socket join throttle & PIN brute-force lockout ---
const joinBuckets = new Map();
const pinFailures = new Map();
const PIN_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const PIN_MAX_FAILURES = 8;
const PIN_LOCK_MS = 10 * 60 * 1000;

function getSocketIp(socket) {
  const forwarded = socket?.handshake?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return socket?.handshake?.address || 'unknown';
}

function checkJoinRateLimit(ip) {
  let bucket = joinBuckets.get(ip);
  if (!bucket) {
    bucket = new SearchTokenBucket(30, 30);
    joinBuckets.set(ip, bucket);
  }
  return bucket.tryConsume(1);
}

function isPinLocked(ip) {
  const record = pinFailures.get(ip);
  if (!record) return false;
  if (record.lockedUntil && record.lockedUntil > Date.now()) return true;
  if (record.lockedUntil && record.lockedUntil <= Date.now()) {
    pinFailures.delete(ip);
  }
  return false;
}

function recordPinFailure(ip) {
  const now = Date.now();
  let record = pinFailures.get(ip);
  if (!record || now - record.firstAt > PIN_FAILURE_WINDOW_MS) {
    record = { count: 0, firstAt: now, lockedUntil: 0 };
  }
  record.count += 1;
  if (record.count >= PIN_MAX_FAILURES) {
    record.lockedUntil = now + PIN_LOCK_MS;
  }
  pinFailures.set(ip, record);
}

function clearPinFailures(ip) {
  pinFailures.delete(ip);
}

// Prune inactive IP buckets every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of searchBuckets.entries()) {
    if (now - bucket.lastFill > 10 * 60 * 1000) {
      searchBuckets.delete(ip);
    }
  }
  for (const [ip, bucket] of joinBuckets.entries()) {
    if (now - bucket.lastFill > 10 * 60 * 1000) {
      joinBuckets.delete(ip);
    }
  }
  for (const [ip, record] of pinFailures.entries()) {
    if (now - record.firstAt > PIN_FAILURE_WINDOW_MS && record.lockedUntil <= now) {
      pinFailures.delete(ip);
    }
  }
}, 10 * 60 * 1000).unref?.();

// --- Admin authentication helpers ---
function getAdminKey(req) {
  return req.headers['x-admin-key'] || '';
}

function adminAuth(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(503).json({
      error: 'Admin access is not configured. Set the ADMIN_SECRET environment variable.'
    });
  }
  if (!timingSafeStringEqual(getAdminKey(req), ADMIN_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Admin Secret' });
  }
  next();
}

function telemetryAuth(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(503).send('Telemetry is disabled. Set the ADMIN_SECRET environment variable.');
  }
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const password = decoded.slice(decoded.indexOf(':') + 1);
      if (timingSafeStringEqual(password, ADMIN_SECRET)) return next();
    } catch (e) {}
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="JamLock Telemetry", charset="UTF-8"');
  return res.status(401).send('Authentication required');
}

// In-Memory Server Response Cache (5-minute TTL)
const SERVER_SEARCH_CACHE = new Map();
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of SERVER_SEARCH_CACHE.entries()) {
    if (now >= entry.expiresAt) {
      SERVER_SEARCH_CACHE.delete(key);
    }
  }
}, 5 * 60 * 1000);

// API: Instant Fast Search with Server Cache, Token Bucket, and Stream Warmup
app.get('/api/search', async (req, res) => {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const rateLimit = checkSearchRateLimit(clientIp);

  res.setHeader('X-RateLimit-Limit', '20');
  res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));
  res.setHeader('X-RateLimit-Reset', String(rateLimit.resetSec));

  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSec));
    return res.status(429).json({ error: 'Too many search requests. Please slow down.' });
  }

  let rawQuery = String(req.query.q || '').trim();
  if (!rawQuery) {
    return res.json([]);
  }
  // Hard cap q length to 100 characters to prevent expensive string processing attacks
  if (rawQuery.length > 100) {
    rawQuery = rawQuery.slice(0, 100).trim();
  }

  const normalizedKey = rawQuery.toLowerCase();
  res.setHeader('Cache-Control', 'public, max-age=60');

  // Check Server Cache
  const cached = SERVER_SEARCH_CACHE.get(normalizedKey);
  if (cached && Date.now() < cached.expiresAt) {
    res.setHeader('X-Cache', 'HIT');
    console.log(`[SEARCH] Query: "${rawQuery}" | Cache: HIT | Results: ${cached.results?.length || 0}`);
    return res.json(cached.results);
  }

  res.setHeader('X-Cache', 'MISS');
  const startTime = Date.now();
  let results;
  try {
    results = await searchSongs(rawQuery);
  } catch (err) {
    console.error('[SEARCH] Provider error:', err?.message || err);
    return res.status(502).json({ error: 'Search is temporarily unavailable. Please try again.' });
  }
  const duration = Date.now() - startTime;
  res.setHeader('X-Response-Time-Ms', duration);
  console.log(`[SEARCH] Query: "${rawQuery}" | Cache: MISS | Time: ${duration}ms | Results: ${results?.length || 0}`);

  if (Array.isArray(results)) {
    SERVER_SEARCH_CACHE.set(normalizedKey, {
      results,
      expiresAt: Date.now() + SEARCH_CACHE_TTL_MS
    });

    // Predictive background warmup for top results
    if (results.length > 0) {
      getYoutubeAudioFormat(results[0].id).catch(() => {});
      if (results.length > 1) {
        getYoutubeAudioFormat(results[1].id).catch(() => {});
      }
    }
  }

  return res.json(results);
});

// API: Fast Stream Format Warmup (triggered on hover/focus)
app.get('/api/warmup/:videoId', (req, res) => {
  const videoId = String(req.params.videoId || '').trim();
  if (/^[\w-]{6,20}$/.test(videoId)) {
    getYoutubeAudioFormat(videoId).catch(() => {});
  }
  res.status(204).end();
});

// API: Room info check
app.get('/api/room/:roomId', (req, res) => {
  const room = rooms.getRoom(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  return res.json(rooms.serializeRoom(room));
});

// API: Direct Audio Stream Proxy (HTTP 206 Byte-Range M4A for iOS Safari & Android background playback)
app.get('/api/audio/:videoId', (req, res) => {
  streamAudioToClient(req, res);
});

// API: Direct Audio Stream Resolver for Mobile Background Playback (with YT IFrame fallback)
app.get('/api/stream-source', async (req, res) => {
  try {
    const videoId = String(req.query.id || '').trim();
    const title = String(req.query.title || '').trim();
    const artist = String(req.query.artist || '').trim();
    const durationSeconds = Number(req.query.duration) || 0;

    if (!videoId && !title) {
      return res.json({ mode: 'iframe', url: null, source: 'missing-params' });
    }

    const result = await resolveAudioStream({ videoId, title, artist, durationSeconds });
    return res.json(result);
  } catch (e) {
    return res.json({ mode: 'iframe', url: null, source: 'error-fallback' });
  }
});

// In-memory rolling ring buffer of client mobile audio telemetry events (last 100 events)
const MOBILE_TELEMETRY_LOG = [];

// API: Real-Time Mobile Telemetry View (View on your PC while testing on your phone)
app.get('/api/telemetry', telemetryAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const format = req.query.format;
  if (format === 'json') {
    return res.json(MOBILE_TELEMETRY_LOG);
  }
  // Clean HTML view for easy PC browser viewing. Every field is escaped: these values
  // originate from unauthenticated socket payloads and must never be treated as markup.
  const rows = MOBILE_TELEMETRY_LOG.slice().reverse().map(item => `
    <tr style="border-bottom: 1px solid #222; font-family: monospace; font-size: 13px;">
      <td style="padding: 6px 10px; color: #888;">${escapeHtml(item.time)}</td>
      <td style="padding: 6px 10px; color: #00e5ff; font-weight: bold;">${escapeHtml(item.user || 'anon')}</td>
      <td style="padding: 6px 10px; color: #ffeb3b; font-weight: bold;">${escapeHtml(item.event)}</td>
      <td style="padding: 6px 10px; color: ${item.engine === 'audio' ? '#C8FF3D' : '#ff4081'}; font-weight: bold;">${escapeHtml(item.engine)}</td>
      <td style="padding: 6px 10px; color: ${item.hidden ? '#ff5252' : '#69f0ae'}; font-weight: bold;">${item.hidden ? 'HIDDEN' : 'VISIBLE'}</td>
      <td style="padding: 6px 10px; color: #ddd; word-break: break-all;">${escapeHtml(item.detail)}</td>
    </tr>
  `).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>JamLock Mobile Telemetry</title>
      <meta http-equiv="refresh" content="2">
      <style>body { background: #0A0A0D; color: #F4F2EA; font-family: sans-serif; padding: 20px; }</style>
    </head>
    <body>
      <h2 style="color: #C8FF3D; margin-bottom: 4px;">📱 JamLock Live Mobile Audio Telemetry</h2>
      <p style="color: #888; font-size: 13px; margin-top: 0;">Auto-refreshes every 2 seconds. Switch apps or lock your phone and observe events below.</p>
      <table style="width: 100%; border-collapse: collapse; text-align: left; background: #141418; border-radius: 8px; overflow: hidden;">
        <thead>
          <tr style="background: #1c1c22; color: #aaa; font-size: 12px; text-transform: uppercase;">
            <th style="padding: 8px 10px;">Time</th>
            <th style="padding: 8px 10px;">User</th>
            <th style="padding: 8px 10px;">Event</th>
            <th style="padding: 8px 10px;">Engine</th>
            <th style="padding: 8px 10px;">Tab State</th>
            <th style="padding: 8px 10px;">Detail / Snapshot</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="6" style="padding: 20px; text-align: center; color: #666;">No mobile telemetry received yet. Open room on phone to start streaming.</td></tr>'}
        </tbody>
      </table>
    </body>
    </html>
  `);
});

// API: Admin Telemetry Stats (requires ADMIN_SECRET; disabled when unset)
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const snapshot = metrics.getSnapshot(rooms);
  snapshot.mobileTelemetry = MOBILE_TELEMETRY_LOG.slice(-30);
  return res.json(snapshot);
});

// WebSocket Connection Handlers
io.on('connection', (socket) => {
  let currentRoomId = null;

  // Clock sync: client measures RTT against this to compute an accurate offset
  safeOn(socket, 'time-ping', (cb) => {
    if (typeof cb === 'function') cb({ serverTime: Date.now() });
  });

  // Join or Create Room
  safeOn(socket, 'join-room', (payload, maybeCallback) => {
    const callback = typeof maybeCallback === 'function'
      ? maybeCallback
      : (typeof payload === 'function' ? payload : null);
    const data = isPlainObject(payload) ? payload : {};
    const roomId = typeof data.roomId === 'string' ? data.roomId.trim() : '';
    const username = typeof data.username === 'string' ? data.username : '';
    const isCreating = Boolean(data.isCreating);
    const pin = typeof data.pin === 'string' ? data.pin : '';
    const ip = getSocketIp(socket);

    if (isPinLocked(ip)) {
      const message = 'Too many incorrect PIN attempts. Please wait 10 minutes and try again.';
      if (callback) callback({ success: false, code: 'pin_locked', error: message });
      socket.emit('join-error', { code: 'pin_locked', message });
      return;
    }

    const joinRate = checkJoinRateLimit(ip);
    if (!joinRate.allowed) {
      const message = 'Too many join attempts. Please wait a moment and try again.';
      if (callback) callback({ success: false, code: 'rate_limited', error: message });
      socket.emit('join-error', { code: 'rate_limited', message });
      return;
    }

    if (!roomId) {
      if (callback) callback({ success: false, error: 'Room code is required' });
      return;
    }
    const cleanUsername = username.trim().slice(0, 25);
    if (!cleanUsername) {
      if (callback) {
        callback({ success: false, error: 'Display name is required' });
      }
      return;
    }

    const cleanId = roomId.trim().toUpperCase();

    // Validate format (alphanumeric and dashes, 3-20 chars)
    if (!/^[A-Z0-9\-]{3,20}$/.test(cleanId)) {
      if (callback) {
        callback({ success: false, error: 'Invalid room code format' });
      }
      return;
    }

    // Verify room existence if joining an existing room
    if (!isCreating && !rooms.hasRoom(cleanId)) {
      if (callback) {
        callback({ success: false, code: 'room_not_found', error: `Room "${cleanId}" does not exist or has expired.` });
      }
      socket.emit('room-not-found', { roomId: cleanId, message: `Room "${cleanId}" does not exist or has expired.` });
      return;
    }

    const wasExisting = rooms.hasRoom(cleanId);
    // Identity always comes from the server-verified cookie/session, never from payload.clientId.
    const joinRes = rooms.addUser(cleanId, socket.id, cleanUsername, socket.data.clientId, pin);
    if (joinRes?.error) {
      if (joinRes.error === 'invalid_pin') recordPinFailure(ip);
      if (callback) {
        callback({
          success: false,
          code: joinRes.error,
          error: joinRes.message || 'Access denied',
          suggestion: joinRes.suggestion
        });
      }
      socket.emit('join-error', {
        code: joinRes.error,
        message: joinRes.message || 'Access denied',
        suggestion: joinRes.suggestion
      });
      return;
    }
    clearPinFailures(ip);

    currentRoomId = cleanId;
    socket.join(cleanId);
    const { room, user, isNewUser } = joinRes;

    // If returning to a track that finished playing while away, advance to next song
    if (
      room.currentTrack &&
      room.playback.isPlaying &&
      room.currentTrack.durationSeconds > 0 &&
      rooms.getCurrentPosition(room) >= room.currentTrack.durationSeconds - 0.5
    ) {
      advanceTrack(cleanId).catch(() => {});
    }

    // Record Telemetry
    metrics.recordVisitor(socket.data.clientId);
    if (isCreating && !wasExisting) metrics.recordRoomCreated();

    // Notify room of user join only if it's a new human listener
    io.to(cleanId).emit('room-state', rooms.serializeRoom(room));
    if (isNewUser) {
      io.to(cleanId).emit('user-joined', { user, message: `${user.username} joined the party!` });
    }

    if (callback) {
      callback({
        success: true,
        user,
        room: rooms.serializeRoom(room),
        serverTime: Date.now()
      });
    }
  });

  // Helper: Check DJ permission
  const canControlDJ = (room, socketId) => {
    if (!room) return false;
    if (room.settings?.djMode === 'host-only') {
      const user = room.users.get(socketId);
      return Boolean(user?.isHost);
    }
    return true;
  };

  const canQueueSong = (room, socketId) => {
    if (!room) return false;
    if (room.settings?.queueMode === 'host-only') {
      const user = room.users.get(socketId);
      return Boolean(user?.isHost);
    }
    return true;
  };

  // Play / Resume
  safeOn(socket, 'play', (payload) => {
    if (!currentRoomId) return;
    const room = rooms.getRoom(currentRoomId);
    if (!canControlDJ(room, socket.id)) {
      socket.emit('notification', { type: 'error', text: 'DJ controls are restricted to the room host' });
      return;
    }
    const requestedPos = Number(payload?.positionSec);
    const updated = rooms.setPlaybackState(
      currentRoomId,
      true,
      Number.isFinite(requestedPos) ? Math.max(0, requestedPos) : undefined
    );
    if (updated) {
      scheduleAutoAdvance(currentRoomId);
      io.to(currentRoomId).emit('playback-sync', {
        isPlaying: true,
        positionSec: updated.playback.positionSec,
        serverTime: Date.now()
      });
    }
  });

  // Pause
  safeOn(socket, 'pause', (payload) => {
    if (!currentRoomId) return;
    const room = rooms.getRoom(currentRoomId);
    if (!canControlDJ(room, socket.id)) {
      socket.emit('notification', { type: 'error', text: 'DJ controls are restricted to the room host' });
      return;
    }
    const requestedPos = Number(payload?.positionSec);
    const updated = rooms.setPlaybackState(
      currentRoomId,
      false,
      Number.isFinite(requestedPos) ? Math.max(0, requestedPos) : undefined
    );
    if (updated) {
      scheduleAutoAdvance(currentRoomId);
      io.to(currentRoomId).emit('playback-sync', {
        isPlaying: false,
        positionSec: updated.playback.positionSec,
        serverTime: Date.now()
      });
    }
  });

  // Seek
  safeOn(socket, 'seek', (payload) => {
    if (!currentRoomId) return;
    const room = rooms.getRoom(currentRoomId);
    if (!canControlDJ(room, socket.id)) {
      socket.emit('notification', { type: 'error', text: 'DJ controls are restricted to the room host' });
      return;
    }
    const requestedPos = Number(payload?.positionSec);
    if (!Number.isFinite(requestedPos)) return;
    const duration = room?.currentTrack?.durationSeconds || 0;
    const clampedPos = Math.max(0, duration > 0 ? Math.min(requestedPos, duration) : requestedPos);
    const updated = rooms.seek(currentRoomId, clampedPos);
    if (updated) {
      scheduleAutoAdvance(currentRoomId);
      io.to(currentRoomId).emit('playback-sync', {
        isPlaying: updated.playback.isPlaying,
        positionSec: updated.playback.positionSec,
        serverTime: Date.now()
      });
    }
  });

  // Queue track / Play immediately
  safeOn(socket, 'add-to-queue', (payload) => {
    const track = payload?.track;
    const playNext = Boolean(payload?.playNext);
    if (!currentRoomId || !track) return;
    const room = rooms.getRoom(currentRoomId);
    if (!room) return;
    if (!canQueueSong(room, socket.id)) {
      socket.emit('notification', { type: 'error', text: 'Adding songs is restricted to the room host' });
      return;
    }

    const queuer = room.users.get(socket.id);
    const cleanTrack = sanitizeTrack(track, queuer?.username);
    if (!cleanTrack) return;

    const updated = rooms.addToQueue(currentRoomId, cleanTrack, playNext);
    if (!updated) {
      socket.emit('notification', { type: 'error', text: 'Queue is full (100 tracks max). Let the music play first!' });
      return;
    }
    getYoutubeAudioFormat(cleanTrack.id).catch(() => {});
    scheduleAutoAdvance(currentRoomId);
    io.to(currentRoomId).emit('room-state', rooms.serializeRoom(room));
    io.to(currentRoomId).emit('notification', {
      type: 'queue',
      text: `${cleanTrack.title} added to ${playNext ? 'play next' : 'queue'}`
    });
  });

  // Play immediately (Cover Click / Instant Play)
  safeOn(socket, 'play-now', async (payload) => {
    const track = payload?.track;
    if (!currentRoomId || !track) return;
    const room = rooms.getRoom(currentRoomId);
    if (!room) return;
    if (!canControlDJ(room, socket.id)) {
      socket.emit('notification', { type: 'error', text: 'Playing songs directly is restricted to the room host' });
      return;
    }

    const player = room.users.get(socket.id);
    const cleanTrack = sanitizeTrack(track, player?.username);
    if (!cleanTrack) return;

    // Fast resolution check: if stream format is not yet cached, resolve format concurrently
    // with a short 1.2s bounded race so the room playback clock starts precisely when the stream is ready
    const t0 = Date.now();
    let formatResolved = false;
    try {
      await Promise.race([
        getYoutubeAudioFormat(cleanTrack.id).then(() => { formatResolved = true; }),
        new Promise((resolve) => setTimeout(resolve, 1200))
      ]);
    } catch (e) {}
    const raceMs = Date.now() - t0;
    console.log(`[PLAY-NOW] Room ${currentRoomId}: Track "${cleanTrack.title}" (${cleanTrack.id}) format resolved: ${formatResolved} in ${raceMs}ms`);

    rooms.playTrack(currentRoomId, cleanTrack);
    metrics.recordSongPlayed();
    // Background pre-warm next track in queue (if any)
    if (room.queue.length > 0) {
      getYoutubeAudioFormat(room.queue[0].id).catch(() => {});
    }

    scheduleAutoAdvance(currentRoomId);
    io.to(currentRoomId).emit('room-state', rooms.serializeRoom(room));
    io.to(currentRoomId).emit('track-changed', {
      currentTrack: room.currentTrack,
      playback: room.playback
    });
    io.to(currentRoomId).emit('notification', {
      type: 'play',
      text: `Now playing: ${cleanTrack.title}`
    });
  });

  // Remove track from queue
  safeOn(socket, 'remove-from-queue', (payload) => {
    if (!currentRoomId) return;
    const index = Number(payload?.index);
    if (!Number.isInteger(index) || index < 0) return;
    const room = rooms.getRoom(currentRoomId);
    if (!canQueueSong(room, socket.id)) {
      socket.emit('notification', { type: 'error', text: 'Queue editing is restricted to the room host' });
      return;
    }
    rooms.removeFromQueue(currentRoomId, index);
    io.to(currentRoomId).emit('room-state', rooms.serializeRoom(room));
  });

  // Update Room Settings (Host Only)
  safeOn(socket, 'update-room-settings', (payload) => {
    if (!currentRoomId || !isPlainObject(payload)) return;
    const room = rooms.getRoom(currentRoomId);
    const user = room?.users.get(socket.id);
    if (!user?.isHost) {
      socket.emit('notification', { type: 'error', text: 'Only the host can modify room settings' });
      return;
    }

    const patch = {};
    if (typeof payload.djMode !== 'undefined') {
      patch.djMode = payload.djMode === 'host-only' ? 'host-only' : 'anyone';
    }
    if (typeof payload.queueMode !== 'undefined') {
      patch.queueMode = payload.queueMode === 'host-only' ? 'host-only' : 'anyone';
    }
    if (typeof payload.theme !== 'undefined') {
      const allowedThemes = new Set(['electric', 'cyber', 'sunset', 'midnight']);
      if (allowedThemes.has(payload.theme)) patch.theme = payload.theme;
    }

    let pinAction; // undefined = leave unchanged, null = remove, string = set new
    if (Object.prototype.hasOwnProperty.call(payload, 'pin')) {
      const rawPin = payload.pin == null ? '' : String(payload.pin).trim();
      if (!rawPin) {
        pinAction = null;
      } else if (/^\d{4,8}$/.test(rawPin)) {
        pinAction = rawPin;
      } else {
        socket.emit('notification', { type: 'error', text: 'Room PIN must be 4–8 digits.' });
        return;
      }
    }

    Object.assign(room.settings, patch);
    if (pinAction !== undefined) {
      rooms.setRoomPin(currentRoomId, pinAction);
    }
    io.to(currentRoomId).emit('room-state', rooms.serializeRoom(room));
    io.to(currentRoomId).emit('notification', {
      type: 'info',
      text: 'Room settings & permissions updated'
    });
  });

  // Skip Current Track (manual skip or client-reported track end)
  safeOn(socket, 'skip-track', async (payload) => {
    if (!currentRoomId) return;
    const room = rooms.getRoom(currentRoomId);
    if (!room) return;
    if (!canControlDJ(room, socket.id)) {
      socket.emit('notification', { type: 'error', text: 'Skipping is restricted to the room host' });
      return;
    }
    // Ignore stale "track ended" reports (server timer may have already advanced)
    const endedId = payload && typeof payload.endedTrackId === 'string' ? payload.endedTrackId : null;
    if (endedId && room.currentTrack?.id !== endedId) return;

    await advanceTrack(currentRoomId);
  });

  // Democratic Skip Voting (for guests and members)
  safeOn(socket, 'vote-skip', async () => {
    if (!currentRoomId) return;
    const room = rooms.getRoom(currentRoomId);
    if (!room || !room.currentTrack) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    // If host votes skip, execute immediately
    if (user.isHost) {
      await advanceTrack(currentRoomId);
      return;
    }

    const { votes, required, shouldSkip } = rooms.addSkipVote(currentRoomId, user.clientId);
    if (shouldSkip) {
      io.to(currentRoomId).emit('notification', {
        type: 'play',
        text: `⏭️ Vote passed (${votes}/${required}). Skipping track!`
      });
      await advanceTrack(currentRoomId);
    } else {
      io.to(currentRoomId).emit('skip-votes-updated', { votes, required });
      io.to(currentRoomId).emit('notification', {
        type: 'info',
        text: `🗳️ ${user.username} voted to skip (${votes}/${required})`
      });
    }
  });

  // Toggle Auto-Suggest Setting (host-only; this is a room-wide playback setting)
  safeOn(socket, 'toggle-auto-suggest', (payload) => {
    if (!currentRoomId || !isPlainObject(payload)) return;
    const room = rooms.getRoom(currentRoomId);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user?.isHost) {
      socket.emit('notification', { type: 'error', text: 'Only the host can change auto-suggest' });
      return;
    }

    const enabled = Boolean(payload.enabled);
    room.settings.autoSuggest = enabled;
    if (!enabled) {
      if (room.autoSuggestTimer) {
        clearTimeout(room.autoSuggestTimer);
        room.autoSuggestTimer = null;
      }
      rooms.evictAutoSuggestedTracks(currentRoomId);
    } else {
      scheduleAutoAdvance(currentRoomId);
    }
    io.to(currentRoomId).emit('room-state', rooms.serializeRoom(room));
    io.to(currentRoomId).emit('notification', {
      type: 'info',
      text: `Auto-Suggest ${enabled ? 'enabled' : 'disabled'}`
    });
  });

  // Mobile Client Audio Telemetry for live background debugging
  safeOn(socket, 'client-audio-telemetry', (data) => {
    if (!isPlainObject(data)) return;
    const room = currentRoomId ? rooms.getRoom(currentRoomId) : null;
    const user = room?.users.get(socket.id);
    const username = cleanText(user?.username || data.username || 'Mobile Guest', 25);
    const timeStr = new Date().toISOString().slice(11, 23);
    let detailStr = '';
    if (isPlainObject(data.detail) || Array.isArray(data.detail)) {
      try {
        detailStr = JSON.stringify(data.detail).slice(0, 1000);
      } catch (e) {
        detailStr = '';
      }
    } else {
      detailStr = cleanText(data.detail || '', 1000);
    }

    const record = {
      time: timeStr,
      user: username,
      event: cleanText(data.event || 'unknown', 60),
      engine: cleanText(data.engine || 'unknown', 20),
      hidden: Boolean(data.hidden),
      detail: detailStr,
      state: data.state || null
    };

    MOBILE_TELEMETRY_LOG.push(record);
    if (MOBILE_TELEMETRY_LOG.length > 100) MOBILE_TELEMETRY_LOG.shift();

    // Pretty terminal log with distinct emoji colors
    console.log(
      `📱 [MOBILE TELEMETRY] ${timeStr} | ${username} | event=${record.event} | engine=${record.engine} | hidden=${record.hidden} | ${detailStr}`
    );
  });

  // Realtime Live Reactions with rate limiting (max 5 per 2 seconds per socket)
  const reactionTimestamps = [];
  const ALLOWED_REACTIONS = new Set(['🔥', '❤️', '⚡', '✨']);
  safeOn(socket, 'send-reaction', (payload) => {
    if (!currentRoomId || !isPlainObject(payload)) return;

    const now = Date.now();
    // Keep only timestamps from the last 2000ms
    while (reactionTimestamps.length > 0 && reactionTimestamps[0] <= now - 2000) {
      reactionTimestamps.shift();
    }

    if (reactionTimestamps.length >= 5) {
      // Exceeded burst limit, silently drop to protect room
      return;
    }
    reactionTimestamps.push(now);
    metrics.recordReaction();

    const room = rooms.getRoom(currentRoomId);
    const user = room?.users.get(socket.id);
    const pos = rooms.getCurrentPosition(room);
    const reactionData = {
      emoji: ALLOWED_REACTIONS.has(payload.emoji) ? payload.emoji : '🔥',
      username: user?.username || 'Guest',
      color: user?.avatarColor || '#ec4899',
      positionSec: Number(pos.toFixed(1)),
      id: Math.random().toString(36).substring(2, 8)
    };
    rooms.addTrackReaction(currentRoomId, reactionData);

    io.to(currentRoomId).emit('reaction-received', reactionData);
  });

  // Auto-Queue 3 Similar Tracks
  safeOn(socket, 'queue-similar-tracks', async () => {
    if (!currentRoomId) return;
    const room = rooms.getRoom(currentRoomId);
    if (!room || !room.currentTrack) {
      socket.emit('notification', { type: 'info', text: 'Play a song first to find similar tracks' });
      return;
    }

    if (!canQueueSong(room, socket.id)) {
      socket.emit('notification', { type: 'error', text: 'Queueing is restricted to the room host' });
      return;
    }

    try {
      socket.emit('notification', { type: 'info', text: 'Finding 3 similar tracks...' });
      const current = room.currentTrack;
      const existingTracks = [
        ...room.queue,
        ...room.history
      ];

      const freshTracks = await getMultipleRecommendations(current, 3, existingTracks);

      if (freshTracks.length === 0) {
        socket.emit('notification', { type: 'info', text: 'No new similar tracks found' });
        return;
      }

      const user = room.users.get(socket.id);
      const addedBy = user?.username || 'Auto-Suggest';

      let addedCount = 0;
      for (const t of freshTracks) {
        const clean = sanitizeTrack(t, addedBy);
        if (!clean) continue;
        if (!rooms.addToQueue(currentRoomId, clean, false)) break;
        addedCount++;
      }

      if (addedCount === 0) {
        socket.emit('notification', { type: 'info', text: 'Queue is full (100 tracks max). Let the music play first!' });
        return;
      }

      io.to(currentRoomId).emit('room-state', rooms.serializeRoom(room));
      io.to(currentRoomId).emit('notification', {
        type: 'success',
        text: `✨ Added ${addedCount} track${addedCount === 1 ? '' : 's'} similar to "${current.title}"`
      });
    } catch (err) {
      console.error('[SimilarTracks] Error finding similar tracks:', err);
    }
  });

  // In-room Chat Message
  safeOn(socket, 'chat-message', (payload) => {
    if (!currentRoomId || !isPlainObject(payload) || typeof payload.text !== 'string') return;
    const text = cleanText(payload.text, 300);
    if (!text) return;
    const room = rooms.getRoom(currentRoomId);
    const user = room?.users.get(socket.id);
    if (!user) return;

    const msg = rooms.addChatMessage(currentRoomId, user, text);
    if (msg) {
      io.to(currentRoomId).emit('chat-message-received', msg);
    }
  });

  // Host Kick / Eviction Moderation
  safeOn(socket, 'kick-user', (payload) => {
    const targetClientId = payload?.targetClientId;
    if (!currentRoomId || typeof targetClientId !== 'string' || targetClientId.length > 64) return;
    const kickResult = rooms.kickUser(currentRoomId, socket.id, targetClientId);
    if (!kickResult) return;

    const { room, targetUser, socketIds } = kickResult;
    for (const sId of socketIds) {
      io.to(sId).emit('you-were-kicked', { message: 'You were removed by the room host.' });
      const s = io.sockets.sockets.get(sId);
      if (s) {
        s.leave(currentRoomId);
      }
    }

    io.to(currentRoomId).emit('room-state', rooms.serializeRoom(room));
    io.to(currentRoomId).emit('notification', {
      type: 'info',
      text: `Host removed ${targetUser.username} from the room`
    });
  });

  // In-Room Username Rename
  safeOn(socket, 'change-username', (payload) => {
    const newUsername = typeof payload?.newUsername === 'string'
      ? cleanText(payload.newUsername, 25)
      : '';
    if (!currentRoomId || !newUsername) return;
    const res = rooms.changeUsername(currentRoomId, socket.id, newUsername);
    if (!res || res.error) {
      socket.emit('rename-error', {
        code: res?.error || 'error',
        message: res?.message || 'Could not change username',
        suggestion: res?.suggestion
      });
      return;
    }

    const { room, user } = res;
    io.to(currentRoomId).emit('room-state', rooms.serializeRoom(room));
    socket.emit('username-changed', { username: user.username });
    io.to(currentRoomId).emit('notification', {
      type: 'info',
      text: `Username updated to "${user.username}"`
    });
  });

  // Request sync timestamp
  safeOn(socket, 'sync-request', async (callback) => {
    if (!currentRoomId) return;
    const room = rooms.getRoom(currentRoomId);
    if (!room) return;

    // Check if current track has exceeded its duration
    if (
      room.currentTrack &&
      room.playback.isPlaying &&
      room.currentTrack.durationSeconds > 0 &&
      rooms.getCurrentPosition(room) >= room.currentTrack.durationSeconds - 0.5
    ) {
      await advanceTrack(currentRoomId).catch(() => {});
    }

    if (callback) {
      callback({
        isPlaying: room.playback.isPlaying,
        positionSec: rooms.getCurrentPosition(room),
        serverTime: Date.now()
      });
    }
  });

  // Realtime User Departure (Explicit Leave or Socket Disconnect)
  const handleLeave = () => {
    if (!currentRoomId) return;
    const roomId = currentRoomId;
    currentRoomId = null;
    socket.leave(roomId);

    const result = rooms.removeUser(socket.id);
    if (result && result.isFullyDisconnected) {
      io.to(result.room.id).emit('room-state', rooms.serializeRoom(result.room));
      io.to(result.room.id).emit('user-left', { user: result.user });

      if (result.newHost) {
        io.to(result.room.id).emit('host-changed', { newHost: result.newHost });
        io.to(result.room.id).emit('notification', {
          type: 'info',
          text: `👑 ${result.newHost.username} is now the room host!`
        });
      }
    } else if (result?.room) {
      io.to(result.room.id).emit('room-state', rooms.serializeRoom(result.room));
    }
  };

  safeOn(socket, 'leave-room', handleLeave);
  safeOn(socket, 'disconnect', handleLeave);
});

// Health check & Free Tier Keep-Alive Endpoint
app.get('/api/ping', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSec: Math.floor(process.uptime()),
    timestamp: Date.now()
  });
});

// Clean Per-Room Route: /r/:roomId (Supports social preview crawlers and human visitors)
app.get('/r/:roomId', (req, res) => {
  const roomId = (req.params.roomId || '').trim().toUpperCase();
  const userAgent = req.headers['user-agent'] || '';
  const isCrawler = /bot|crawler|spider|crawling|facebookexternalhit|twitterbot|discordbot|whatsapp|telegrambot|slackbot|applebot/i.test(userAgent);

  const indexPath = path.join(publicDir, 'index.html');

  if (!isCrawler) {
    return res.sendFile(indexPath);
  }

  // Generate dynamic OpenGraph tags for Discord/Twitter/WhatsApp crawlers
  try {
    let html = fs.readFileSync(indexPath, 'utf-8');
    const room = rooms.getRoom(roomId);

    const safeRoomId = escapeHtml(roomId);
    let title = `Join Room ${safeRoomId} on JamLock`;
    let desc = `Listen to music together in real-time. Zero logins, zero setup.`;
    let image = 'https://jamlock.onrender.com/browser_header.webp';

    if (room && room.currentTrack) {
      const trackTitle = escapeHtml(room.currentTrack.cleanTitle || room.currentTrack.title || 'Untitled Track');
      const artist = escapeHtml(room.currentTrack.artist || 'Unknown Artist');
      title = `▶ ${trackTitle} — ${artist}`;
      const listenerCount = room.users?.size || 1;
      desc = `Currently playing in JamLock Room ${safeRoomId} with ${listenerCount} listener${listenerCount === 1 ? '' : 's'}. Join in!`;
      if (room.currentTrack.thumbnail && /^https:\/\/[^'"\s<>()]{1,300}$/.test(room.currentTrack.thumbnail)) {
        image = room.currentTrack.thumbnail;
      }
    }

    const safeImage = escapeHtml(image);
    const roomUrl = `https://jamlock.onrender.com/r/${encodeURIComponent(roomId)}`;
    const ogType = (room && room.currentTrack) ? 'music.song' : 'website';

    html = html.replace(/<title>.*?<\/title>/, `<title>${title} | JamLock</title>`);
    html = html.replace(/<meta property="og:type" content=".*?">/, `<meta property="og:type" content="${ogType}">`);
    html = html.replace(/<meta property="og:url" content=".*?">/, `<meta property="og:url" content="${roomUrl}">`);
    html = html.replace(/<meta property="og:title" content=".*?">/, `<meta property="og:title" content="${title}">`);
    html = html.replace(/<meta property="og:description" content=".*?">/, `<meta property="og:description" content="${desc}">`);
    html = html.replace(/<meta property="og:image" content=".*?">/, `<meta property="og:image" content="${safeImage}">`);
    html = html.replace(/<meta name="twitter:url" content=".*?">/, `<meta name="twitter:url" content="${roomUrl}">`);
    html = html.replace(/<meta name="twitter:title" content=".*?">/, `<meta name="twitter:title" content="${title}">`);
    html = html.replace(/<meta name="twitter:description" content=".*?">/, `<meta name="twitter:description" content="${desc}">`);
    html = html.replace(/<meta name="twitter:image" content=".*?">/, `<meta name="twitter:image" content="${safeImage}">`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    return res.sendFile(indexPath);
  }
});

// Search Engine Crawlers & Sitemaps
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: https://jamlock.onrender.com/sitemap.xml\n');
});

app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://jamlock.onrender.com/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`);
});

// Fallback to SPA index.html (except /admin)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Periodic Playback Time Accumulator (runs every 5 seconds)
setInterval(() => {
  for (const room of rooms.rooms.values()) {
    if (room.playback?.isPlaying && room.currentTrack && room.users?.size > 0) {
      metrics.recordPlaybackTime(5);
    }
  }
}, 5000);

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 JamLock Server running on http://0.0.0.0:${PORT}`);
});
