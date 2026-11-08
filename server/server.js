// Express & Socket.io Server Entry
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { rooms } from './rooms.js';
import { searchSongs, getRecommendations, getMultipleRecommendations } from './search.js';
import { resolveAudioStream, streamAudioToClient, getYoutubeAudioFormat } from './audioResolver.js';
import { metrics } from './metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

// Serve static frontend files
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));

// --- Server-authoritative helpers ---

// Validate/normalise a client-supplied track so clients can't inject arbitrary objects
function sanitizeTrack(t, addedBy) {
  if (!t || typeof t.id !== 'string' || !/^[\w-]{6,20}$/.test(t.id)) return null;
  const thumb = typeof t.thumbnail === 'string' && /^https:\/\/[^'"\s<>()]{1,300}$/.test(t.thumbnail)
    ? t.thumbnail
    : `https://i.ytimg.com/vi/${t.id}/hqdefault.jpg`;
  const title = String(t.title || 'Untitled Track').slice(0, 200);
  return {
    id: t.id,
    title,
    cleanTitle: String(t.cleanTitle || title).slice(0, 200),
    artist: String(t.artist || 'Unknown Artist').slice(0, 120),
    duration: String(t.duration || '0:00').slice(0, 12),
    durationSeconds: Math.max(0, Math.min(Number(t.durationSeconds) || 0, 6 * 3600)),
    thumbnail: thumb,
    url: `https://www.youtube.com/watch?v=${t.id}`,
    addedBy: addedBy ? String(addedBy).slice(0, 25) : undefined
  };
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
    // Only advance if the same track is still playing and someone is listening
    if (room.currentTrack?.id !== trackId || !room.playback.isPlaying) return;
    if (room.users.size === 0) return;
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

// Prune inactive IP buckets every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of searchBuckets.entries()) {
    if (now - bucket.lastFill > 10 * 60 * 1000) {
      searchBuckets.delete(ip);
    }
  }
}, 10 * 60 * 1000);

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
    return res.json(cached.results);
  }

  res.setHeader('X-Cache', 'MISS');
  const startTime = Date.now();
  const results = await searchSongs(rawQuery);
  const duration = Date.now() - startTime;
  res.setHeader('X-Response-Time-Ms', duration);

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
  const videoId = req.params.videoId;
  if (videoId) {
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
app.get('/api/telemetry', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const format = req.query.format;
  if (format === 'json') {
    return res.json(MOBILE_TELEMETRY_LOG);
  }
  // Clean HTML view for easy PC browser viewing
  const rows = MOBILE_TELEMETRY_LOG.slice().reverse().map(item => `
    <tr style="border-bottom: 1px solid #222; font-family: monospace; font-size: 13px;">
      <td style="padding: 6px 10px; color: #888;">${item.time}</td>
      <td style="padding: 6px 10px; color: #00e5ff; font-weight: bold;">${item.user || 'anon'}</td>
      <td style="padding: 6px 10px; color: #ffeb3b; font-weight: bold;">${item.event}</td>
      <td style="padding: 6px 10px; color: ${item.engine === 'audio' ? '#C8FF3D' : '#ff4081'}; font-weight: bold;">${item.engine}</td>
      <td style="padding: 6px 10px; color: ${item.hidden ? '#ff5252' : '#69f0ae'}; font-weight: bold;">${item.hidden ? 'HIDDEN' : 'VISIBLE'}</td>
      <td style="padding: 6px 10px; color: #ddd; word-break: break-all;">${item.detail}</td>
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

// API: Admin Telemetry Stats (Protected with key)
app.get('/api/admin/stats', (req, res) => {
  const adminSecret = process.env.ADMIN_SECRET || 'jamlock-secret-admin';
  const providedKey = req.query.key || req.headers['x-admin-key'];
  if (!providedKey || providedKey !== adminSecret) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Admin Secret' });
  }
  const snapshot = metrics.getSnapshot(rooms);
  snapshot.mobileTelemetry = MOBILE_TELEMETRY_LOG.slice(-30);
  return res.json(snapshot);
});

// WebSocket Connection Handlers
const roomSfxCooldowns = new Map();

io.on('connection', (socket) => {
  let currentRoomId = null;

  // Clock sync: client measures RTT against this to compute an accurate offset
  socket.on('time-ping', (cb) => {
    if (typeof cb === 'function') cb({ serverTime: Date.now() });
  });

  // Join or Create Room
  socket.on('join-room', ({ roomId, username, clientId, isCreating, pin }, callback) => {
    if (!roomId) {
      if (callback) callback({ success: false, error: 'Room code is required' });
      return;
    }
    const cleanUsername = (username || '').trim().slice(0, 25);
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

    const joinRes = rooms.addUser(cleanId, socket.id, cleanUsername, clientId, pin);
    if (joinRes?.error) {
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

    currentRoomId = cleanId;
    socket.join(cleanId);
    const { room, user, isNewUser } = joinRes;

    // Record Telemetry
    if (clientId) metrics.recordVisitor(clientId);
    if (isCreating) metrics.recordRoomCreated();

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
  socket.on('play', ({ positionSec }) => {
    if (!currentRoomId) return;
    const room = rooms.getRoom(currentRoomId);
    if (!canControlDJ(room, socket.id)) {
      socket.emit('notification', { type: 'error', text: 'DJ controls are restricted to the room host' });
      return;
    }
    const updated = rooms.setPlaybackState(currentRoomId, true, positionSec);
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
  socket.on('pause', ({ positionSec }) => {
    if (!currentRoomId) return;
    const room = rooms.getRoom(currentRoomId);
    if (!canControlDJ(room, socket.id)) {
      socket.emit('notification', { type: 'error', text: 'DJ controls are restricted to the room host' });
      return;
    }
    const updated = rooms.setPlaybackState(currentRoomId, false, positionSec);
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
  socket.on('seek', ({ positionSec }) => {
    if (!currentRoomId) return;
    const room = rooms.getRoom(currentRoomId);
    if (!canControlDJ(room, socket.id)) {
      socket.emit('notification', { type: 'error', text: 'DJ controls are restricted to the room host' });
      return;
    }
    const updated = rooms.seek(currentRoomId, positionSec);
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
  socket.on('add-to-queue', ({ track, playNext }) => {
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

    rooms.addToQueue(currentRoomId, cleanTrack, playNext);
    getYoutubeAudioFormat(cleanTrack.id).catch(() => {});
    scheduleAutoAdvance(currentRoomId);
    io.to(currentRoomId).emit('room-state', rooms.serializeRoom(room));
    io.to(currentRoomId).emit('notification', {
      type: 'queue',
      text: `${cleanTrack.title} added to ${playNext ? 'play next' : 'queue'}`
    });
  });

  // Play immediately (Cover Click / Instant Play)
  socket.on('play-now', async ({ track }) => {
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
    try {
      await Promise.race([
        getYoutubeAudioFormat(cleanTrack.id),
        new Promise((resolve) => setTimeout(resolve, 1200))
      ]);
    } catch (e) {}

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
  socket.on('remove-from-queue', ({ index }) => {
    if (!currentRoomId) return;
    const room = rooms.getRoom(currentRoomId);
    if (!canQueueSong(room, socket.id)) {
      socket.emit('notification', { type: 'error', text: 'Queue editing is restricted to the room host' });
      return;
    }
    rooms.removeFromQueue(currentRoomId, index);
    io.to(currentRoomId).emit('room-state', rooms.serializeRoom(room));
  });

  // Update Room Settings (Host Only)
  socket.on('update-room-settings', (newSettings) => {
    if (!currentRoomId) return;
    const room = rooms.getRoom(currentRoomId);
    const user = room?.users.get(socket.id);
    if (!user?.isHost) {
      socket.emit('notification', { type: 'error', text: 'Only the host can modify room settings' });
      return;
    }

    if (newSettings) {
      if (typeof newSettings.pin !== 'undefined') {
        const cleanPin = newSettings.pin ? String(newSettings.pin).trim().slice(0, 8) : null;
        room.pin = cleanPin;
        room.settings.pin = cleanPin;
      }
      room.settings = { ...room.settings, ...newSettings, pin: room.pin };
    }
    io.to(currentRoomId).emit('room-state', rooms.serializeRoom(room));
    io.to(currentRoomId).emit('notification', {
      type: 'info',
      text: 'Room settings & permissions updated'
    });
  });

  // Skip Current Track (manual skip or client-reported track end)
  socket.on('skip-track', async (payload) => {
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
  socket.on('vote-skip', async () => {
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

  // Toggle Auto-Suggest Setting
  socket.on('toggle-auto-suggest', ({ enabled }) => {
    if (!currentRoomId) return;
    const room = rooms.getRoom(currentRoomId);
    if (room) {
      room.settings.autoSuggest = Boolean(enabled);
      if (!room.settings.autoSuggest) {
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
    }
  });

  // Mobile Client Audio Telemetry for live background debugging
  socket.on('client-audio-telemetry', (data) => {
    if (!data) return;
    const room = currentRoomId ? rooms.getRoom(currentRoomId) : null;
    const user = room?.users.get(socket.id);
    const username = user?.username || data.username || 'Mobile Guest';
    const timeStr = new Date().toISOString().slice(11, 23);
    const detailStr = typeof data.detail === 'object' ? JSON.stringify(data.detail) : String(data.detail || '');

    const record = {
      time: timeStr,
      user: username,
      event: data.event || 'unknown',
      engine: data.engine || 'unknown',
      hidden: Boolean(data.hidden),
      detail: detailStr,
      state: data.state || null
    };

    MOBILE_TELEMETRY_LOG.push(record);
    if (MOBILE_TELEMETRY_LOG.length > 100) MOBILE_TELEMETRY_LOG.shift();

    // Pretty terminal log with distinct emoji colors
    console.log(
      `📱 [MOBILE TELEMETRY] ${timeStr} | ${username} | event=${data.event} | engine=${data.engine} | hidden=${data.hidden} | ${detailStr}`
    );
  });

  // Realtime Live Reactions with rate limiting (max 5 per 2 seconds per socket)
  const reactionTimestamps = [];
  socket.on('send-reaction', ({ emoji }) => {
    if (!currentRoomId) return;

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
      emoji: emoji || '🔥',
      username: user?.username || 'Guest',
      color: user?.avatarColor || '#ec4899',
      positionSec: Number(pos.toFixed(1)),
      id: Math.random().toString(36).substring(2, 8)
    };
    rooms.addTrackReaction(currentRoomId, reactionData);

    io.to(currentRoomId).emit('reaction-received', reactionData);
  });

  // DJ Hype Soundboard with Room Cooldown (3.5s anti-spam)
  socket.on('play-sfx', ({ sound }) => {
    if (!currentRoomId) return;
    const room = rooms.getRoom(currentRoomId);
    if (!room) return;

    const validSounds = ['airhorn', 'scratch', 'laser'];
    if (!validSounds.includes(sound)) return;

    const now = Date.now();
    const lastPlayed = roomSfxCooldowns.get(currentRoomId) || 0;
    if (now - lastPlayed < 3500) {
      socket.emit('sfx-cooldown', { remainingMs: 3500 - (now - lastPlayed) });
      return;
    }

    roomSfxCooldowns.set(currentRoomId, now);
    metrics.recordReaction();
    const user = room.users.get(socket.id);
    io.to(currentRoomId).emit('sfx-played', {
      sound,
      username: user?.username || 'DJ'
    });
  });

  // Auto-Queue 3 Similar Tracks
  socket.on('queue-similar-tracks', async () => {
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

      for (const t of freshTracks) {
        room.queue.push({
          ...t,
          addedBy
        });
      }

      io.to(currentRoomId).emit('room-state', rooms.serializeRoom(room));
      io.to(currentRoomId).emit('notification', {
        type: 'success',
        text: `✨ Added ${freshTracks.length} tracks similar to "${current.title}"`
      });
    } catch (err) {
      console.error('[SimilarTracks] Error finding similar tracks:', err);
    }
  });

  // In-room Chat Message
  socket.on('chat-message', ({ text }) => {
    if (!currentRoomId || !text) return;
    const room = rooms.getRoom(currentRoomId);
    const user = room?.users.get(socket.id);
    if (!user) return;

    const msg = rooms.addChatMessage(currentRoomId, user, text);
    if (msg) {
      io.to(currentRoomId).emit('chat-message-received', msg);
    }
  });

  // Host Kick / Eviction Moderation
  socket.on('kick-user', ({ targetClientId }) => {
    if (!currentRoomId || !targetClientId) return;
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
  socket.on('change-username', ({ newUsername }) => {
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
  socket.on('sync-request', (callback) => {
    if (!currentRoomId) return;
    const room = rooms.getRoom(currentRoomId);
    if (room && callback) {
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

  socket.on('leave-room', handleLeave);
  socket.on('disconnect', handleLeave);
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

    let title = `Join Room ${roomId} on JamLock`;
    let desc = `Listen to music together in real-time. Zero logins, zero setup.`;
    let image = 'https://jamlock.onrender.com/browser_header.webp';

    if (room && room.currentTrack) {
      title = `▶ ${room.currentTrack.cleanTitle || room.currentTrack.title} — ${room.currentTrack.artist}`;
      desc = `Currently playing in JamLock Room ${roomId} with ${room.users?.size || 1} listener${room.users?.size === 1 ? '' : 's'}. Join in!`;
      if (room.currentTrack.thumbnail) {
        image = room.currentTrack.thumbnail;
      }
    }

    const roomUrl = `https://jamlock.onrender.com/r/${roomId}`;
    const ogType = (room && room.currentTrack) ? 'music.song' : 'website';

    html = html.replace(/<title>.*?<\/title>/, `<title>${title} | JamLock</title>`);
    html = html.replace(/<meta property="og:type" content=".*?">/, `<meta property="og:type" content="${ogType}">`);
    html = html.replace(/<meta property="og:url" content=".*?">/, `<meta property="og:url" content="${roomUrl}">`);
    html = html.replace(/<meta property="og:title" content=".*?">/, `<meta property="og:title" content="${title}">`);
    html = html.replace(/<meta property="og:description" content=".*?">/, `<meta property="og:description" content="${desc}">`);
    html = html.replace(/<meta property="og:image" content=".*?">/, `<meta property="og:image" content="${image}">`);
    html = html.replace(/<meta name="twitter:url" content=".*?">/, `<meta name="twitter:url" content="${roomUrl}">`);
    html = html.replace(/<meta name="twitter:title" content=".*?">/, `<meta name="twitter:title" content="${title}">`);
    html = html.replace(/<meta name="twitter:description" content=".*?">/, `<meta name="twitter:description" content="${desc}">`);
    html = html.replace(/<meta name="twitter:image" content=".*?">/, `<meta name="twitter:image" content="${image}">`);

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎵 JamLock Server running on http://localhost:${PORT}`);
});
