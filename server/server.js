// Express & Socket.io Server Entry
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { rooms } from './rooms.js';
import { searchSongs, getRecommendations } from './search.js';
import { resolveAudioStream, streamAudioToClient, getYoutubeAudioFormat } from './audioResolver.js';

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
    // Pre-warm newly elevated track in queue
    if (room.queue.length > 0) {
      getYoutubeAudioFormat(room.queue[0].id).catch(() => {});
    }
  } else if (room.settings?.autoSuggest && room.currentTrack) {
    const recommended = await getRecommendations(room.currentTrack, room.history);
    if (recommended) {
      rooms.playTrack(roomId, recommended);
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

// (Re)schedule the server-side end-of-track timer so the queue advances
// even if the host's tab is closed or backgrounded.
function scheduleAutoAdvance(roomId) {
  const room = rooms.getRoom(roomId);
  if (!room) return;
  if (room.autoAdvanceTimer) {
    clearTimeout(room.autoAdvanceTimer);
    room.autoAdvanceTimer = null;
  }
  const duration = room.currentTrack?.durationSeconds || 0;
  if (!room.currentTrack || !room.playback.isPlaying || duration <= 0) return;

  const remainingSec = Math.max(0, duration - rooms.getCurrentPosition(room));
  const trackId = room.currentTrack.id;

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

// API: Instant Fast Search with Cache + Predictive Background Stream Warmup
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.json([]);
  }
  const startTime = Date.now();
  const results = await searchSongs(query);
  const duration = Date.now() - startTime;
  res.setHeader('X-Response-Time-Ms', duration);

  // Predictive background warmup for top results: user typically clicks top result within 1-3s
  if (Array.isArray(results) && results.length > 0) {
    getYoutubeAudioFormat(results[0].id).catch(() => {});
    if (results.length > 1) {
      getYoutubeAudioFormat(results[1].id).catch(() => {});
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

// WebSocket Connection Handlers
io.on('connection', (socket) => {
  let currentRoomId = null;

  // Clock sync: client measures RTT against this to compute an accurate offset
  socket.on('time-ping', (cb) => {
    if (typeof cb === 'function') cb({ serverTime: Date.now() });
  });

  // Join or Create Room
  socket.on('join-room', ({ roomId, username, clientId, isCreating }, callback) => {
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
        callback({ success: false, error: `Room "${cleanId}" does not exist. Check the code or create a new room.` });
      }
      return;
    }

    currentRoomId = cleanId;

    socket.join(cleanId);
    const { room, user, isNewUser } = rooms.addUser(cleanId, socket.id, cleanUsername, clientId);

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

    room.settings = { ...room.settings, ...newSettings };
    io.to(currentRoomId).emit('room-state', rooms.serializeRoom(room));
    io.to(currentRoomId).emit('notification', {
      type: 'info',
      text: 'Room permissions updated'
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

  // Toggle Auto-Suggest Setting
  socket.on('toggle-auto-suggest', ({ enabled }) => {
    if (!currentRoomId) return;
    const room = rooms.getRoom(currentRoomId);
    if (room) {
      room.settings.autoSuggest = Boolean(enabled);
      io.to(currentRoomId).emit('room-state', rooms.serializeRoom(room));
      io.to(currentRoomId).emit('notification', {
        type: 'info',
        text: `Auto-Suggest ${enabled ? 'enabled' : 'disabled'}`
      });
    }
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

    const room = rooms.getRoom(currentRoomId);
    const user = room?.users.get(socket.id);
    io.to(currentRoomId).emit('reaction-received', {
      emoji: emoji || '🔥',
      username: user?.username || 'Guest',
      color: user?.avatarColor || '#ec4899',
      id: Math.random().toString(36).substring(2, 8)
    });
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

// Fallback to SPA index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎵 JamLock Server running on http://localhost:${PORT}`);
});
