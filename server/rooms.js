// In-Memory Room Management & Realtime Sync Engine

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  getOrCreateRoom(roomId) {
    const id = roomId.trim().toUpperCase();
    if (!this.rooms.has(id)) {
      this.rooms.set(id, {
        id,
        createdAt: Date.now(),
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
        settings: {
          djMode: 'anyone', // 'anyone' | 'host-only'
          autoSuggest: true // Automatic smart recommendation when queue ends
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

  addUser(roomId, socketId, username, clientId) {
    const room = this.getOrCreateRoom(roomId);
    const resolvedClientId = clientId || socketId;
    const isFirstUser = room.users.size === 0;

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

    // Generate distinctive avatar color for brand-new human
    const colors = ['#f43f5e', '#ec4899', '#d946ef', '#a855f7', '#8b5cf6', '#6366f1', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b'];
    const avatarColor = colors[Math.floor(Math.random() * colors.length)];

    const user = {
      clientId: resolvedClientId,
      username: username || `Guest #${Math.floor(1000 + Math.random() * 9000)}`,
      isHost: isFirstUser,
      avatarColor,
      sockets: new Set([socketId]),
      joinedAt: Date.now()
    };

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
        }

        // If other tabs are still open in the same browser, do not kick user out of room
        if (user.sockets && user.sockets.size > 0) {
          return { room, user, isFullyDisconnected: false };
        }

        // Clean up any remaining references
        for (const [sId, u] of room.users.entries()) {
          if (u.clientId === user.clientId) {
            room.users.delete(sId);
          }
        }

        // If host left, elect the next user as host
        const uniqueUsers = this.getUniqueUsers(room);
        if (user.isHost && uniqueUsers.length > 0) {
          uniqueUsers[0].isHost = true;
        }

        // Clean up empty rooms after 10 minutes
        if (room.users.size === 0) {
          setTimeout(() => {
            if (room.users.size === 0) {
              this.rooms.delete(roomId);
            }
          }, 1000 * 60 * 10);
        }

        return { room, user, isFullyDisconnected: true };
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

    if (playNext) {
      room.queue.unshift(track);
    } else {
      room.queue.push(track);
    }
    return room;
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
      settings: room.settings
    };
  }
}

export const rooms = new RoomManager();
