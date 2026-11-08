// Lightweight In-Memory & File-Backed Telemetry Engine
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {}
}

class MetricsCollector {
  constructor() {
    this.serverStartedAt = Date.now();
    this.totalSongsPlayed = 0;
    this.totalPlaybackSeconds = 0;
    this.totalRoomsCreated = 0;
    this.totalReactionsFired = 0;
    this.uniqueVisitors = new Set();
    this.lastFlushTime = Date.now();

    this.loadStats();

    // Periodic disk flush every 25 seconds
    setInterval(() => this.flushStats(), 25000);
  }

  loadStats() {
    try {
      if (fs.existsSync(STATS_FILE)) {
        const raw = fs.readFileSync(STATS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        this.totalSongsPlayed = data.totalSongsPlayed || 0;
        this.totalPlaybackSeconds = data.totalPlaybackSeconds || 0;
        this.totalRoomsCreated = data.totalRoomsCreated || 0;
        this.totalReactionsFired = data.totalReactionsFired || 0;
        if (Array.isArray(data.uniqueVisitors)) {
          this.uniqueVisitors = new Set(data.uniqueVisitors);
        }
      }
    } catch (err) {
      console.warn('[Metrics] Could not load stats file, starting fresh:', err.message);
    }
  }

  flushStats() {
    try {
      const data = {
        totalSongsPlayed: this.totalSongsPlayed,
        totalPlaybackSeconds: Math.round(this.totalPlaybackSeconds),
        totalRoomsCreated: this.totalRoomsCreated,
        totalReactionsFired: this.totalReactionsFired,
        uniqueVisitors: Array.from(this.uniqueVisitors),
        updatedAt: Date.now()
      };
      fs.writeFileSync(STATS_FILE, JSON.stringify(data, null, 2), 'utf-8');
      this.lastFlushTime = Date.now();
    } catch (err) {
      console.error('[Metrics] Error flushing stats to disk:', err.message);
    }
  }

  recordVisitor(clientId) {
    if (!clientId) return;
    const sizeBefore = this.uniqueVisitors.size;
    this.uniqueVisitors.add(clientId);
    if (this.uniqueVisitors.size > sizeBefore) {
      this.flushStats();
    }
  }

  recordRoomCreated() {
    this.totalRoomsCreated++;
  }

  recordSongPlayed() {
    this.totalSongsPlayed++;
  }

  recordPlaybackTime(seconds) {
    if (typeof seconds === 'number' && seconds > 0) {
      this.totalPlaybackSeconds += seconds;
    }
  }

  recordReaction() {
    this.totalReactionsFired++;
  }

  getSnapshot(roomsManager) {
    let liveRoomsCount = 0;
    let liveListenersCount = 0;
    let activeRoomsList = [];

    if (roomsManager && roomsManager.rooms) {
      liveRoomsCount = roomsManager.rooms.size;
      for (const [id, r] of roomsManager.rooms.entries()) {
        const listeners = r.users ? r.users.size : 0;
        liveListenersCount += listeners;
        activeRoomsList.push({
          id,
          listeners,
          currentTrack: r.currentTrack ? {
            title: r.currentTrack.cleanTitle || r.currentTrack.title,
            artist: r.currentTrack.artist,
            duration: r.currentTrack.duration
          } : null,
          isPlaying: Boolean(r.playback?.isPlaying),
          queueLength: r.queue?.length || 0,
          theme: r.settings?.theme || 'electric'
        });
      }
    }

    const uptimeMs = Date.now() - this.serverStartedAt;
    const uptimeHours = (uptimeMs / (1000 * 60 * 60)).toFixed(1);
    const playbackHours = (this.totalPlaybackSeconds / 3600).toFixed(2);
    const playbackMinutes = Math.round(this.totalPlaybackSeconds / 60);

    return {
      allTime: {
        totalUniqueVisitors: this.uniqueVisitors.size,
        totalSongsPlayed: this.totalSongsPlayed,
        totalPlaybackSeconds: Math.round(this.totalPlaybackSeconds),
        totalPlaybackMinutes: playbackMinutes,
        totalPlaybackHours: playbackHours,
        totalRoomsCreated: this.totalRoomsCreated,
        totalReactionsFired: this.totalReactionsFired
      },
      live: {
        liveRoomsCount,
        liveListenersCount,
        uptimeHours,
        serverStartedAt: this.serverStartedAt,
        activeRooms: activeRoomsList
      }
    };
  }
}

export const metrics = new MetricsCollector();
