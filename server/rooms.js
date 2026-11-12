// In-Memory Room Management & Realtime Sync Engine
import crypto from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(crypto.scrypt);
const MAX_QUEUE_LENGTH = 100;
const MAX_USERS_PER_ROOM = 50;

class RoomManager {
  constructor() {
    this.rooms = new Map();
    // Background periodic sweep for abandoned empty rooms (runs every 60s, 30m TTL)
    setInterval(() => {
      this.cleanupExpiredRooms(30 * 60 * 1000);
    }, 60 * 1000).unref?.();
  }

  touch(roomId) {
    const room = this.getRoom(roomId);
    if (room) {
      room.lastActivityAt = Date.now();
    }
  }

  cleanupExpiredRooms(emptyTtlMs = 30 * 60 * 1000) {
    const now = Date.now();
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.users.size === 0) {
        if (!room.emptySince) {
          room.emptySince = now;
        } else if (now - room.emptySince >= emptyTtlMs) {
          this.rooms.delete(roomId);
        }
      } else {
        room.emptySince = null;
      }
    }
  }

  getOrCreateRoom(roomId) {
    const id = roomId.trim().toUpperCase();
    if (!this.rooms.has(id)) {
      this.rooms.set(id, {
        id,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        emptySince: null,
        users: new Map(), // socketId -> { id, username, isHost, avatarColor }
        currentTrack: null, // { id, title, artist, duration, durationSeconds, thumbnail, addedBy }
        queue: [], // Array of tracks
        history: [], // Last 20 played tracks
        playback: {
          isPlaying: false,
          positionSec: 0,
          updatedAt: Date.now(),
        },
        chat: [], // Last 50 messages: { id, user, text, timestamp }
        trackReactions: [], // Pinned timeline reactions for current track: { id, emoji, positionSec, username, color }
        skipVotes: new Set(), // Set of clientIds who voted to skip current track
        // Room access PIN is stored only as a salted scrypt hash; the plaintext is never kept
        // or serialized. hasPin tells clients whether to show the PIN prompt.
        hasPin: false,
        pinSalt: null,
        pinHash: null,
        settings: {
          djMode: 'anyone', // 'anyone' | 'host-only'
          queueMode: 'anyone', // 'anyone' | 'host-only'
          autoSuggest: true, // Automatic smart recommendation when queue ends
          theme: 'electric' // 'electric' | 'cyber' | 'sunset' | 'midnight'
        }
      });
    }
    return this.rooms.get(id);
  }

  getRoom(roomId) {
    if (!roomId) return null;
    return this.rooms.get(roomId.trim().toUpperCase());
  }

  hasRoom(roomId) {
    if (!roomId) return false;
    return this.rooms.has(roomId.trim().toUpperCase());
  }

  async setRoomPin(roomId, pin) {
    const room = this.getRoom(roomId);
    if (!room) return null;

    const normalized = pin == null ? '' : String(pin).trim();
    if (!normalized) {
      room.hasPin = false;
      room.pinSalt = null;
      room.pinHash = null;
      return room;
    }

    if (!/^\d{4,8}$/.test(normalized)) return null;
    const salt = crypto.randomBytes(16);
    // Compute both locally, then assign together. Two overlapping PIN changes must not
    // interleave a salt from one call with a hash from another.
    const pinSalt = salt.toString('hex');
    const pinHash = (await scryptAsync(normalized, salt, 32)).toString('hex');
    room.pinSalt = pinSalt;
    room.pinHash = pinHash;
    room.hasPin = true;
    return room;
  }

  async verifyRoomPin(room, providedPin) {
    if (!room?.hasPin) return true;
    if (!room.pinHash || !room.pinSalt) return false;

    const candidate = String(providedPin ?? '').trim().slice(0, 8);
    if (!/^\d{4,8}$/.test(candidate)) return false;

    // Snapshot the stored values before awaiting so a concurrent PIN change cannot
    // produce a partial comparison.
    const expected = Buffer.from(room.pinHash, 'hex');
    const salt = Buffer.from(room.pinSalt, 'hex');
    const actual = await scryptAsync(candidate, salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  async addUser(roomId, socketId, username, clientId, providedPin) {
    const room = this.getOrCreateRoom(roomId);
    room.emptySince = null;
    const resolvedClientId = clientId || socketId;
    const isFirstUser = room.users.size === 0;

    // Verify room PIN if room is private and requester is not already recognized
    if (room.hasPin && !isFirstUser) {
      let isExistingRecognizedUser = false;
      for (const u of room.users.values()) {
        if (u.clientId === resolvedClientId) {
          isExistingRecognizedUser = true;
          break;
        }
      }
      if (!isExistingRecognizedUser && !(await this.verifyRoomPin(room, providedPin))) {
        return { error: 'invalid_pin', message: 'This room is private. Incorrect or missing PIN.' };
      }
    }

    // Check if user already exists from another tab in the same browser
    let existingUser = null;
    for (const u of room.users.values()) {
      if (u.clientId === resolvedClientId) {
        existingUser = u;
        break;
      }
    }

    if (existingUser) {
      if (!existingUser.sockets) {
        existingUser.sockets = new Set();
      }
      existingUser.sockets.add(socketId);
      // Map socketId back to the same user
      room.users.set(socketId, existingUser);
      return { room, user: existingUser, isNewUser: false };
    }

    if (this.getUniqueUsers(room).length >= MAX_USERS_PER_ROOM) {
      return { error: 'room_full', message: `This room is full (${MAX_USERS_PER_ROOM} listeners max).` };
    }

    // Generate distinctive avatar color for brand-new human
    const colors = ['#f43f5e', '#ec4899', '#d946ef', '#a855f7', '#8b5cf6', '#6366f1', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b'];
    const avatarColor = colors[Math.floor(Math.random() * colors.length)];

    let baseUsername = (username || `Guest #${Math.floor(1000 + Math.random() * 9000)}`).trim();
    // Reject duplicate display names in the same room with an intelligent suggestion
    let nameConflict = false;
    for (const u of room.users.values()) {
      if (u.clientId !== resolvedClientId && u.username && u.username.toLowerCase() === baseUsername.toLowerCase()) {
        nameConflict = true;
        break;
      }
    }

    if (nameConflict) {
      const existingLower = new Set(Array.from(room.users.values()).map(u => (u.username || '').toLowerCase()));
      let k = 2;
      while (existingLower.has(`${baseUsername.toLowerCase()} (${k})`)) {
        k++;
      }
      return {
        error: 'name_taken',
        message: `Display name "${baseUsername}" is already taken in this room.`,
        suggestion: `${baseUsername} (${k})`
      };
    }

    const user = {
      clientId: resolvedClientId,
      username: baseUsername,
      isHost: isFirstUser,
      avatarColor,
      sockets: new Set([socketId]),
      joinedAt: Date.now()
    };

    room.lastActivityAt = Date.now();
    room.users.set(socketId, user);
    return { room, user, isNewUser: true };
  }

  removeUser(socketId) {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.users.has(socketId)) {
        const user = room.users.get(socketId);
        room.users.delete(socketId);

        if (user.sockets) {
          user.sockets.delete(socketId);
          // Prune any socket handles no longer active in room.users
          for (const s of user.sockets) {
            if (!room.users.has(s)) {
              user.sockets.delete(s);
            }
          }
        }

        // If other tabs are still active in the same browser, do not kick user out of room
        if (user.sockets && user.sockets.size > 0) {
          return { room, user, isFullyDisconnected: false };
        }

        // Clean up any remaining references for this client
        for (const [sId, u] of room.users.entries()) {
          if (u.clientId === user.clientId) {
            room.users.delete(sId);
          }
        }

        let newHost = null;
        // If host left, elect the earliest-joined remaining user as host
        if (user.isHost && room.users.size > 0) {
          let candidate = null;
          for (const u of room.users.values()) {
            if (!candidate || (u.joinedAt && u.joinedAt < candidate.joinedAt)) {
              candidate = u;
            }
          }
          if (candidate) {
            candidate.isHost = true;
            newHost = candidate;
          }
        }

        // Clean up empty rooms after 10 minutes. Stop playback/timers immediately so an
        // abandoned room does not keep resolving recommendations in the background.
        if (room.users.size === 0) {
          room.emptySince = Date.now();
          if (room.autoAdvanceTimer) {
            clearTimeout(room.autoAdvanceTimer);
            room.autoAdvanceTimer = null;
          }
          if (room.autoSuggestTimer) {
            clearTimeout(room.autoSuggestTimer);
            room.autoSuggestTimer = null;
          }
          room.playback = { isPlaying: false, positionSec: room.playback?.positionSec || 0, updatedAt: Date.now() };
          setTimeout(() => {
            if (room.users.size === 0) {
              this.rooms.delete(roomId);
            }
          }, 1000 * 60 * 10);
        }

        return { room, user, isFullyDisconnected: true, newHost };
      }
    }
    return null;
  }

  getUniqueUsers(room) {
    if (!room) return [];
    const seen = new Set();
    const result = [];
    for (const u of room.users.values()) {
      if (!seen.has(u.clientId)) {
        seen.add(u.clientId);
        result.push({
          clientId: u.clientId,
          username: u.username,
          isHost: u.isHost,
          avatarColor: u.avatarColor,
          joinedAt: u.joinedAt
        });
      }
    }
    return result;
  }

  // Calculate synchronized current playback timestamp
  getCurrentPosition(room) {
    if (!room.currentTrack) return 0;
    if (!room.playback.isPlaying) return room.playback.positionSec;

    const elapsedSec = (Date.now() - room.playback.updatedAt) / 1000;
    const estimated = room.playback.positionSec + elapsedSec;
    return Math.min(estimated, room.currentTrack.durationSeconds || estimated);
  }

  playTrack(roomId, track) {
    const room = this.getRoom(roomId);
    if (!room) return null;

    if (room.currentTrack) {
      room.history.unshift(room.currentTrack);
      if (room.history.length > 20) room.history.pop();
    }

    room.currentTrack = track;
    room._autoSuggestedTrackId = null;
    room.trackReactions = [];
    room.skipVotes = new Set();
    room.playback = {
      isPlaying: true,
      positionSec: 0,
      updatedAt: Date.now()
    };
    return room;
  }

  setPlaybackState(roomId, isPlaying, positionSec) {
    const room = this.getRoom(roomId);
    if (!room) return null;

    const targetPos = typeof positionSec === 'number' && !isNaN(positionSec)
      ? Math.max(0, positionSec)
      : this.getCurrentPosition(room);

    room.playback = {
      isPlaying: Boolean(isPlaying),
      positionSec: targetPos,
      updatedAt: Date.now()
    };
    return room;
  }

  seek(roomId, positionSec) {
    return this.setPlaybackState(roomId, this.getRoom(roomId)?.playback.isPlaying, positionSec);
  }

  addToQueue(roomId, track, playNext = false) {
    const room = this.getRoom(roomId);
    if (!room) return null;

    if (!room.currentTrack) {
      return this.playTrack(roomId, track);
    }

    if (room.queue.length >= MAX_QUEUE_LENGTH) return null;

    if (playNext) {
      room.queue.unshift(track);
    } else if (!track.isAutoSuggested) {
      // Human tracks take priority: place before any auto-suggested filler tracks
      const autoIndex = room.queue.findIndex(t => t.isAutoSuggested);
      if (autoIndex !== -1) {
        room.queue.splice(autoIndex, 0, track);
      } else {
        room.queue.push(track);
      }
    } else {
      room.queue.push(track);
    }
    return room;
  }

  evictAutoSuggestedTracks(roomId) {
    const room = this.getRoom(roomId);
    if (!room) return null;
    const initialLen = room.queue.length;
    room.queue = room.queue.filter(t => !t.isAutoSuggested);
    return room.queue.length !== initialLen ? room : null;
  }

  removeFromQueue(roomId, trackIndex) {
    const room = this.getRoom(roomId);
    if (!room || trackIndex < 0 || trackIndex >= room.queue.length) return null;
    room.queue.splice(trackIndex, 1);
    return room;
  }

  skipTrack(roomId) {
    const room = this.getRoom(roomId);
    if (!room) return null;

    room.trackReactions = [];
    room.skipVotes = new Set();

    if (room.queue.length > 0) {
      const next = room.queue.shift();
      return this.playTrack(roomId, next);
    } else {
      // Nothing in queue, stop
      room.currentTrack = null;
      room.playback = { isPlaying: false, positionSec: 0, updatedAt: Date.now() };
      return room;
    }
  }

  addTrackReaction(roomId, reaction) {
    const room = this.getRoom(roomId);
    if (!room) return null;
    if (!room.trackReactions) room.trackReactions = [];
    room.trackReactions.push(reaction);
    if (room.trackReactions.length > 100) room.trackReactions.shift();
    return reaction;
  }

  addSkipVote(roomId, clientId) {
    const room = this.getRoom(roomId);
    if (!room) return { votes: 0, required: 1, shouldSkip: false };
    if (!room.skipVotes) room.skipVotes = new Set();
    room.skipVotes.add(clientId);

    const uniqueUsers = this.getUniqueUsers(room);
    const required = Math.max(1, Math.ceil(uniqueUsers.length / 2));
    const shouldSkip = room.skipVotes.size >= required;
    return { votes: room.skipVotes.size, required, shouldSkip };
  }

  stopAtStart(roomId) {
    const room = this.getRoom(roomId);
    if (!room) return null;
    room.playback = { isPlaying: false, positionSec: 0, updatedAt: Date.now() };
    return room;
  }

  addChatMessage(roomId, user, text) {
    const room = this.getRoom(roomId);
    if (!room || !text.trim()) return null;

    const message = {
      id: Math.random().toString(36).substring(2, 9),
      user: {
        username: user.username,
        avatarColor: user.avatarColor,
        isHost: user.isHost
      },
      text: text.trim().slice(0, 300),
      timestamp: Date.now()
    };

    room.chat.push(message);
    if (room.chat.length > 50) room.chat.shift();
    return message;
  }

  kickUser(roomId, hostSocketId, targetClientId) {
    const room = this.getRoom(roomId);
    if (!room) return null;
    const hostUser = room.users.get(hostSocketId);
    if (!hostUser || !hostUser.isHost) return null;

    let targetUser = null;
    for (const u of room.users.values()) {
      if (u.clientId === targetClientId) {
        targetUser = u;
        break;
      }
    }
    if (!targetUser || targetUser.isHost) return null;

    const socketIds = targetUser.sockets ? Array.from(targetUser.sockets) : [];
    for (const sId of socketIds) {
      room.users.delete(sId);
    }
    return { room, targetUser, socketIds };
  }

  changeUsername(roomId, socketId, newUsername) {
    const room = this.getRoom(roomId);
    if (!room) return { error: 'room_not_found', message: 'Room not found' };
    const user = room.users.get(socketId);
    if (!user) return { error: 'user_not_found', message: 'User not found in room' };

    const clean = String(newUsername || '').trim().slice(0, 25);
    if (!clean) return { error: 'invalid_name', message: 'Display name cannot be empty' };

    for (const u of room.users.values()) {
      if (u.clientId !== user.clientId && u.username && u.username.toLowerCase() === clean.toLowerCase()) {
        const existingLower = new Set(Array.from(room.users.values()).map(x => (x.username || '').toLowerCase()));
        let k = 2;
        while (existingLower.has(`${clean.toLowerCase()} (${k})`)) {
          k++;
        }
        return {
          error: 'name_taken',
          message: `Display name "${clean}" is already taken in this room.`,
          suggestion: `${clean} (${k})`
        };
      }
    }

    user.username = clean;
    this.touch(roomId);
    return { room, user };
  }

  serializeRoom(room) {
    if (!room) return null;
    return {
      id: room.id,
      users: this.getUniqueUsers(room),
      currentTrack: room.currentTrack,
      queue: room.queue,
      history: room.history,
      playback: {
        isPlaying: room.playback.isPlaying,
        positionSec: this.getCurrentPosition(room),
        serverTime: Date.now()
      },
      settings: {
        ...room.settings,
        hasPin: Boolean(room.hasPin)
      },
      chat: (room.chat || []).slice(-50),
      trackReactions: room.trackReactions || [],
      skipVotes: {
        count: room.skipVotes ? room.skipVotes.size : 0,
        required: Math.max(1, Math.ceil(this.getUniqueUsers(room).length / 2))
      }
    };
  }
}

export const rooms = new RoomManager();
