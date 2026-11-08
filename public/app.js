// Frontend Client Orchestrator with Sub-second Drift Correction
const socket = io({
  transports: ['websocket', 'polling']
});

// Global HTML Escaper
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
window.escapeHtml = escapeHtml;

// State
let currentRoom = null;
let currentUser = null;
let ytPlayer = null;
let ytReady = false;
let isSeeking = false;
let syncInterval = null;
let searchDebounceTimer = null;
let lastKnownSyncTime = 0;

// Playback sync state
let clockOffset = 0;            // serverNow = Date.now() + clockOffset
let loadedTrackId = null;       // track id currently loaded in the YT player
let lastPlaybackKey = '';       // trackId:isPlaying last applied from room-state
let lastPlayKick = 0;           // throttle for retrying playVideo()
let notPlayingSince = 0;        // when the player first failed to play while room is playing

let clockSynced = false;         // true once a measured (RTT-compensated) offset exists
let lastRtt = 0;                 // RTT of the best clock-sync sample (debug)

// Rough one-sample offset. Only used until the measured sync below completes,
// because a single message sample ignores network latency and is very jittery.
function updateClockOffset(serverTime) {
  if (clockSynced) return;
  if (typeof serverTime === 'number' && !isNaN(serverTime)) {
    clockOffset = serverTime - Date.now();
  }
}

// NTP-style clock sync: several pings, keep the lowest-RTT sample (least noisy)
function syncClock() {
  if (!socket.connected) return;
  const samples = [];
  let sent = 0;
  const sendOne = () => {
    const t0 = Date.now();
    socket.emit('time-ping', (res) => {
      const t1 = Date.now();
      if (res && typeof res.serverTime === 'number') {
        const rtt = t1 - t0;
        samples.push({ rtt, offset: res.serverTime + rtt / 2 - t1 });
      }
      if (++sent < 8) {
        setTimeout(sendOne, 120);
      } else if (samples.length) {
        const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        clockOffset = best.offset;
        lastRtt = best.rtt;
        clockSynced = true;
      }
    });
  };
  sendOne();
}
socket.on('connect', syncClock);
setInterval(syncClock, 30000);

// Reaction Counts State
const reactionCounts = {
  '🔥': 0,
  '❤️': 0,
  '⚡': 0,
  '✨': 0
};

// DOM Elements: Navigation & Lobby
const lobbyView = document.getElementById('lobby-view');
const roomView = document.getElementById('room-view');
const usernameInput = document.getElementById('username-input');
const saveUsernameBtn = document.getElementById('save-username-btn');
const joinCodeInput = document.getElementById('join-code-input');
const createRoomBtn = document.getElementById('create-room-btn');
const joinRoomBtn = document.getElementById('join-room-btn');
const roomBadge = document.getElementById('room-badge');
const roomCodeDisplay = document.getElementById('room-code-display');
const copyRoomLinkBtn = document.getElementById('copy-room-link-btn');
const leaveRoomBtn = document.getElementById('leave-room-btn');
const usersStrip = document.getElementById('users-strip');
const listeningCountDisplay = document.getElementById('listening-count-display');

// Hero DOM
const heroBanner = document.getElementById('hero-banner');
const trackArt = document.getElementById('track-art');
const emptyHeroArt = document.getElementById('empty-hero-art');
const trackTitle = document.getElementById('track-title');
const trackArtist = document.getElementById('track-artist');
const playerStatusBadge = document.getElementById('player-status-badge');
const addedByBadge = document.getElementById('added-by-badge');
const addedByAvatar = document.getElementById('added-by-avatar');
const addedByText = document.getElementById('added-by-text');
const currentTimeDisplay = document.getElementById('current-time');
const totalDurationDisplay = document.getElementById('total-duration');
const waveformContainer = document.getElementById('waveform-container');
const playPauseBtn = document.getElementById('play-pause-btn');
const playIcon = document.getElementById('play-icon');
const pauseIcon = document.getElementById('pause-icon');
const skipBtn = document.getElementById('skip-btn');
const forceResyncBtn = document.getElementById('force-resync-btn');
const ambientGlow = document.getElementById('ambient-glow');
const ambientArtBg = document.getElementById('ambient-art-bg');

// Volume Controls DOM
const muteBtn = document.getElementById('mute-btn');
const volumeSlider = document.getElementById('volume-slider');
const volumeHighIcon = document.getElementById('volume-high-icon');
const volumeMuteIcon = document.getElementById('volume-mute-icon');

// Search & Queue DOM
const inlineSearchInput = document.getElementById('inline-search-input');
const searchResultsSection = document.getElementById('search-results-section');
const searchResultsList = document.getElementById('search-results-list');
const searchEmptyPrompt = document.getElementById('search-empty-prompt');
const trendingSection = document.getElementById('trending-section');
const searchSpinner = document.getElementById('search-spinner');
const queueList = document.getElementById('queue-list');
const queueCountBadge = document.getElementById('queue-count-badge');
const autoSuggestSwitchBtn = document.getElementById('auto-suggest-switch-btn');
const autoSuggestSwitchKnob = document.getElementById('auto-suggest-switch-knob');

// Chat DOM
const chatMessages = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const reactionsContainer = document.getElementById('reactions-container');

// Settings & Leave Modals DOM
const hostSettingsBtn = document.getElementById('host-settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsModalBtn = document.getElementById('close-settings-modal-btn');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const settingDjMode = document.getElementById('setting-dj-mode');
const settingQueueMode = document.getElementById('setting-queue-mode');
const leaveConfirmModal = document.getElementById('leave-confirm-modal');
const cancelLeaveBtn = document.getElementById('cancel-leave-btn');
const confirmLeaveBtn = document.getElementById('confirm-leave-btn');

// --- 1. DYNAMIC WAVY PROGRESS BAR SETUP (Unified PC & Mobile) ---
const wavyContainer = document.getElementById('wavy-progress-container');
const waveBasePath = document.getElementById('wave-base-path');
const waveActivePath = document.getElementById('wave-active-path');
const waveClipRect = document.getElementById('wave-clip-rect');
const wavyKnob = document.getElementById('wavy-scrubber-knob');

let isScrubbingWave = false;

// Generate high-resolution audio sine wave path (1000px coordinate space)
function generateWavySVGPath(totalWidth = 1000, height = 32, numWaves = 36, amplitude = 7) {
  const midY = height / 2;
  const step = totalWidth / (numWaves * 2);
  let d = `M 0 ${midY}`;

  // Use varying organic amplitudes to resemble authentic sound wave dynamics
  const ampVariations = [0.8, 1.1, 0.6, 1.3, 0.9, 1.4, 0.7, 1.2, 1.0, 0.5, 1.25, 0.85];

  for (let i = 0; i < numWaves * 2; i++) {
    const varIdx = i % ampVariations.length;
    const currentAmp = amplitude * ampVariations[varIdx];
    const isUp = i % 2 === 0;
    const cpX = (i + 0.5) * step;
    const cpY = midY + (isUp ? -currentAmp : currentAmp);
    const endX = (i + 1) * step;
    const endY = midY;
    d += ` Q ${cpX.toFixed(1)} ${cpY.toFixed(1)}, ${endX.toFixed(1)} ${endY.toFixed(1)}`;
  }
  return d;
}

function initWavyBar() {
  if (!wavyContainer || !waveBasePath || !waveActivePath) return;

  const pathData = generateWavySVGPath(1000, 32, 34, 7);
  waveBasePath.setAttribute('d', pathData);
  waveActivePath.setAttribute('d', pathData);

  // Seeking via pointer events (mouse click/drag, mobile touch tap/drag)
  const seekFromPointer = (e) => {
    if (!currentRoom?.currentTrack) return;
    const rect = wavyContainer.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clickX = clientX - rect.left;
    const pct = Math.max(0, Math.min(1, clickX / rect.width));
    const newPositionSec = pct * (currentRoom.currentTrack.durationSeconds || 100);
    
    // Immediate optimistic UI update
    updateWaveformProgress(pct * 100);
    socket.emit('seek', { positionSec: newPositionSec });
  };

  wavyContainer.addEventListener('mousedown', (e) => {
    isScrubbingWave = true;
    wavyContainer.classList.add('is-dragging');
    seekFromPointer(e);
  });

  window.addEventListener('mousemove', (e) => {
    if (isScrubbingWave) {
      seekFromPointer(e);
    }
  });

  window.addEventListener('mouseup', () => {
    if (isScrubbingWave) {
      isScrubbingWave = false;
      wavyContainer.classList.remove('is-dragging');
    }
  });

  // Touch support for Mobile
  wavyContainer.addEventListener('touchstart', (e) => {
    isScrubbingWave = true;
    wavyContainer.classList.add('is-dragging');
    seekFromPointer(e);
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (isScrubbingWave && e.touches) {
      seekFromPointer(e);
    }
  }, { passive: true });

  window.addEventListener('touchend', () => {
    if (isScrubbingWave) {
      isScrubbingWave = false;
      wavyContainer.classList.remove('is-dragging');
    }
  });
}
initWavyBar();

function updateWaveformProgress(progressPercent) {
  const boundedPct = Math.max(0, Math.min(100, progressPercent));

  // Update SVG clip width (0 to 1000 in viewBox space)
  if (waveClipRect) {
    waveClipRect.setAttribute('width', (boundedPct * 10).toString());
  }

  // Update Scrubber Knob position (0% to 100%)
  if (wavyKnob) {
    wavyKnob.style.left = `${boundedPct}%`;
  }

  // Toggle subtle active pulse class when playing
  if (wavyContainer) {
    if (currentRoom?.playback?.isPlaying && boundedPct > 0) {
      wavyContainer.classList.add('is-playing');
    } else {
      wavyContainer.classList.remove('is-playing');
    }
  }
}

// --- 2. VOLUME CONTROLS ---
const nativeAudio = document.getElementById('native-audio-player');
// Default engine: If hosted on Render/cloud, YouTube direct iframe is 100% reliable without datacenter proxy blocks
const isCloudHosted = window.location.hostname.includes('render.com') || window.location.hostname.includes('koyeb') || window.location.hostname.includes('railway');
let activeEngine = isCloudHosted ? 'yt' : 'audio'; // 'audio' (native HTML5 <audio>) | 'yt' (YouTube IFrame)
let currentVolume = parseInt(localStorage.getItem('jamlock_volume') || localStorage.getItem('beatsync_volume') || '100', 10);
let isMuted = false;

if (nativeAudio) {
  nativeAudio.volume = Math.max(0, Math.min(1, currentVolume / 100));
}

if (volumeSlider) {
  volumeSlider.value = currentVolume;
  volumeSlider.addEventListener('input', (e) => {
    currentVolume = parseInt(e.target.value, 10);
    localStorage.setItem('jamlock_volume', currentVolume);
    isMuted = false;
    updateVolumeUI();
    if (nativeAudio) {
      nativeAudio.muted = false;
      nativeAudio.volume = Math.max(0, Math.min(1, currentVolume / 100));
    }
    if (ytReady && ytPlayer && typeof ytPlayer.setVolume === 'function') {
      ytPlayer.unMute();
      ytPlayer.setVolume(currentVolume);
    }
  });
}

if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    if (nativeAudio) {
      nativeAudio.muted = isMuted;
      if (!isMuted) nativeAudio.volume = Math.max(0, Math.min(1, currentVolume / 100));
    }
    if (ytReady && ytPlayer) {
      if (isMuted) {
        ytPlayer.mute();
      } else {
        ytPlayer.unMute();
        ytPlayer.setVolume(currentVolume);
      }
    }
    updateVolumeUI();
  });
}

function updateVolumeUI() {
  if (isMuted || currentVolume === 0) {
    volumeHighIcon?.classList.add('hidden');
    volumeMuteIcon?.classList.remove('hidden');
  } else {
    volumeHighIcon?.classList.remove('hidden');
    volumeMuteIcon?.classList.add('hidden');
  }
}

// --- 3. AUTO-SUGGEST SWITCH (Custom Pill Switch) ---
let autoSuggestEnabled = true;

if (autoSuggestSwitchBtn) {
  autoSuggestSwitchBtn.addEventListener('click', () => {
    autoSuggestEnabled = !autoSuggestEnabled;
    syncAutoSuggestUI(autoSuggestEnabled);
    socket.emit('toggle-auto-suggest', { enabled: autoSuggestEnabled });
  });
}

function syncAutoSuggestUI(enabled) {
  autoSuggestEnabled = enabled;
  if (!autoSuggestSwitchBtn || !autoSuggestSwitchKnob) return;
  autoSuggestSwitchBtn.setAttribute('aria-checked', enabled ? 'true' : 'false');
  if (enabled) {
    autoSuggestSwitchBtn.style.background = 'var(--lime)';
    autoSuggestSwitchKnob.style.right = '3px';
    autoSuggestSwitchKnob.style.left = 'auto';
  } else {
    autoSuggestSwitchBtn.style.background = '#2E2E38';
    autoSuggestSwitchKnob.style.left = '3px';
    autoSuggestSwitchKnob.style.right = 'auto';
  }
}

// --- 4. ROOM RESTORATION & NAVIGATION ---
function getRandomNickname() {
  const vibes = ['Groovy', 'Neon', 'Cosmic', 'Hyper', 'Velvet', 'Electric', 'Funky', 'Sonic', 'Astral', 'Chill', 'Glitch', 'Retro', 'Bass'];
  const icons = ['Fox', 'Panda', 'Tiger', 'Falcon', 'Vibe', 'Echo', 'Drifter', 'Nomad', 'Rhythm', 'Wave', 'Hawk', 'Otter', 'Rider'];
  const num = Math.floor(Math.random() * 89) + 10;
  return `${vibes[Math.floor(Math.random() * vibes.length)]}${icons[Math.floor(Math.random() * icons.length)]}${num}`;
}

const quickJoinModal = document.getElementById('quick-join-modal');
const quickJoinForm = document.getElementById('quick-join-form');
const quickJoinUsername = document.getElementById('quick-join-username');
const quickJoinRoomCode = document.getElementById('quick-join-room-code');
const quickJoinRandomizeBtn = document.getElementById('quick-join-randomize-btn');

quickJoinRandomizeBtn?.addEventListener('click', () => {
  if (quickJoinUsername) {
    quickJoinUsername.value = getRandomNickname();
    quickJoinUsername.focus();
    quickJoinUsername.select();
  }
});

window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  const storedRoom = localStorage.getItem('jamlock_current_room') || localStorage.getItem('beatsync_current_room');
  const targetRoom = roomParam || storedRoom;

  const savedName = localStorage.getItem('jamlock_username') || localStorage.getItem('beatsync_username');
  if (savedName && usernameInput) usernameInput.value = savedName;

  usernameInput?.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (val) {
      localStorage.setItem('jamlock_username', val);
    }
  });

  saveUsernameBtn?.addEventListener('click', () => {
    const val = usernameInput?.value.trim();
    if (!val) {
      showToast('Please enter a display name', 'error');
      return;
    }
    localStorage.setItem('jamlock_username', val);
    saveUsernameBtn.style.transform = 'scale(1.25)';
    setTimeout(() => {
      saveUsernameBtn.style.transform = 'scale(1)';
    }, 200);
    showToast(`Display name saved as "${val}"`, 'success');
  });

  if (targetRoom) {
    if (joinCodeInput) joinCodeInput.value = targetRoom.toUpperCase();
    if (savedName) {
      joinRoom(targetRoom.toUpperCase(), savedName);
    } else {
      document.documentElement.classList.remove('in-room-loading');
      // If arriving directly via ?room= invite link without a username, present Quick Join Modal
      if (roomParam && quickJoinModal) {
        if (quickJoinRoomCode) quickJoinRoomCode.textContent = targetRoom.toUpperCase();
        if (quickJoinUsername) quickJoinUsername.value = getRandomNickname();
        quickJoinModal.classList.remove('hidden');
        quickJoinModal.style.display = 'flex';
        setTimeout(() => {
          quickJoinUsername?.focus();
          quickJoinUsername?.select();
        }, 150);

        quickJoinForm?.addEventListener('submit', (ev) => {
          ev.preventDefault();
          const chosenName = quickJoinUsername?.value.trim() || getRandomNickname();
          localStorage.setItem('jamlock_username', chosenName);
          if (usernameInput) usernameInput.value = chosenName;
          quickJoinModal.classList.add('hidden');
          quickJoinModal.style.display = 'none';
          joinRoom(targetRoom.toUpperCase(), chosenName);
        });
      } else {
        usernameInput?.focus();
        showToast(`Enter your display name to enter room ${targetRoom.toUpperCase()}`, 'info');
      }
    }
  }
});

function requireValidUsername() {
  const username = usernameInput?.value.trim();
  if (!username) {
    usernameInput?.classList.add('input-error');
    usernameInput?.focus();
    setTimeout(() => {
      usernameInput?.classList.remove('input-error');
    }, 400);
    showToast('Display name is required to enter a room', 'error');
    return null;
  }
  return username;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous 0, O, 1, I
  let p1 = '';
  let p2 = '';
  for (let i = 0; i < 4; i++) p1 += chars.charAt(Math.floor(Math.random() * chars.length));
  for (let i = 0; i < 4; i++) p2 += chars.charAt(Math.floor(Math.random() * chars.length));
  return `${p1}-${p2}`;
}

createRoomBtn?.addEventListener('click', () => {
  const username = requireValidUsername();
  if (!username) return;
  const generatedCode = generateRoomCode();
  joinRoom(generatedCode, username, true);
});

joinCodeInput?.addEventListener('input', (e) => {
  let raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length > 8) raw = raw.slice(0, 8);
  if (raw.length > 4) {
    e.target.value = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  } else {
    e.target.value = raw;
  }
});

joinRoomBtn?.addEventListener('click', () => {
  const username = requireValidUsername();
  if (!username) return;
  const code = joinCodeInput.value.trim().toUpperCase();
  if (!code) {
    showToast('Please enter a room code', 'error');
    joinCodeInput?.focus();
    return;
  }
  joinRoom(code, username, false);
});

function getBrowserClientId() {
  let cid = localStorage.getItem('jamlock_client_id');
  if (!cid) {
    cid = 'cid_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    localStorage.setItem('jamlock_client_id', cid);
  }
  return cid;
}

function joinRoom(roomId, explicitUsername, isCreating = false) {
  const username = explicitUsername || usernameInput?.value.trim();
  if (!username) {
    requireValidUsername();
    return;
  }
  localStorage.setItem('jamlock_username', username);

  const clientId = getBrowserClientId();

  socket.emit('join-room', { roomId, username, clientId, isCreating }, (response) => {
    if (response?.success) {
      currentUser = response.user;
      currentRoom = response.room;
      updateClockOffset(response.room?.playback?.serverTime ?? response.serverTime);

      localStorage.setItem('jamlock_current_room', roomId);
      window.history.pushState({}, '', `?room=${roomId}`);

      document.body.classList.add('in-room-mode');
      lobbyView?.classList.add('hidden');
      roomView?.classList.remove('hidden');
      roomBadge?.classList.remove('hidden');
      roomCodeDisplay.textContent = roomId;

      renderRoomState(response.room);
      startSyncEngine();
      // Remove loading state with a smooth dissolve once room state is hydrated
      document.documentElement.classList.remove('in-room-loading');
      showToast(`Connected to room ${roomId}`, 'success');
    } else if (response?.error) {
      document.documentElement.classList.remove('in-room-loading');
      localStorage.removeItem('jamlock_current_room');
      localStorage.removeItem('beatsync_current_room');
      if (window.location.search) {
        window.history.replaceState({}, '', window.location.pathname);
      }
      showToast(response.error, 'error');
      joinCodeInput?.focus();
    }
  });
}

// Leave confirmation modal
leaveRoomBtn?.addEventListener('click', () => {
  leaveConfirmModal?.classList.remove('hidden');
});

cancelLeaveBtn?.addEventListener('click', () => {
  leaveConfirmModal?.classList.add('hidden');
});

confirmLeaveBtn?.addEventListener('click', () => {
  try {
    socket.emit('leave-room');
  } catch (e) {}
  localStorage.removeItem('jamlock_current_room');
  localStorage.removeItem('beatsync_current_room');
  document.documentElement.classList.remove('in-room-loading');
  document.body.classList.remove('in-room-mode');
  window.location.href = window.location.origin + window.location.pathname;
});

// Instant departure notification if user closes or navigates away
window.addEventListener('beforeunload', () => {
  if (currentRoom) {
    try {
      socket.emit('leave-room');
    } catch (e) {}
  }
});

copyRoomLinkBtn?.addEventListener('click', async () => {
  const shareData = {
    title: 'JamLock — Listen Together',
    text: `Join my live music room (${currentRoom?.id || 'JamLock'})!`,
    url: window.location.href
  };

  if (navigator.share && /mobile|android|iphone|ipad/i.test(navigator.userAgent)) {
    try {
      await navigator.share(shareData);
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return; // User closed share sheet
    }
  }

  try {
    await navigator.clipboard.writeText(window.location.href);
    showToast('Invite link copied to clipboard! 📋', 'success');
  } catch (err) {
    showToast('Failed to copy link', 'error');
  }
});

// --- 5. HOST SETTINGS MODAL ---
hostSettingsBtn?.addEventListener('click', () => {
  if (currentRoom?.settings) {
    if (settingDjMode) settingDjMode.value = currentRoom.settings.djMode || 'anyone';
    if (settingQueueMode) settingQueueMode.value = currentRoom.settings.queueMode || 'anyone';
  }
  settingsModal?.classList.remove('hidden');
});

closeSettingsModalBtn?.addEventListener('click', () => {
  settingsModal?.classList.add('hidden');
});

saveSettingsBtn?.addEventListener('click', () => {
  socket.emit('update-room-settings', {
    djMode: settingDjMode?.value || 'anyone',
    queueMode: settingQueueMode?.value || 'anyone'
  });
  settingsModal?.classList.add('hidden');
});

// --- 6. SYNCHRONIZATION, HYBRID AUDIO ENGINE & LOCK-SCREEN MEDIA SESSION ---
const DRIFT_HARD_SEEK_SEC = 0.4;   // only seek when this far off
const DRIFT_SETTLE_SEC = 0.25;     // tighter check right after a track starts
const SEEK_COOLDOWN_MS = 2500;     // never seek more often than this (prevents seek storms)
let lastSeekAt = 0;
let seekIssuedAt = 0;
let seekLagSec = 0.25;             // measured delay between seekTo() and audio resuming
let settlePending = false;         // one corrective check after a new track starts playing
let loadRequestToken = 0;          // guards async stream-source resolution against track changes
let wakeLockSentinel = null;       // Screen Wake Lock handle for mobile foreground
const recentSeeks = [];

// Screen Wake Lock (keeps phone screen awake while room is playing in foreground)
async function syncWakeLock(shouldHold) {
  if (!('wakeLock' in navigator)) return;
  try {
    if (shouldHold && !document.hidden) {
      if (!wakeLockSentinel) {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
          wakeLockSentinel = null;
        });
      }
    } else if (!shouldHold && wakeLockSentinel) {
      await wakeLockSentinel.release();
      wakeLockSentinel = null;
    }
  } catch (e) {}
}

// OS Lock-Screen & Notification Shade Controls (Media Session API)
function updateMediaSessionMetadata(track) {
  if (!('mediaSession' in navigator)) return;
  try {
    if (!track) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.cleanTitle || track.title || 'JamLock Track',
      artist: track.artist || 'JamLock Room',
      album: currentRoom?.id ? `JamLock • ${currentRoom.id}` : 'JamLock',
      artwork: track.thumbnail
        ? [
            { src: track.thumbnail, sizes: '320x180', type: 'image/jpeg' },
            { src: track.thumbnail, sizes: '512x512', type: 'image/jpeg' }
          ]
        : []
    });
  } catch (e) {}
}

function setupMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;
  const safeSet = (action, fn) => {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) {}
  };
  safeSet('play', () => {
    if (!currentRoom?.currentTrack) return;
    socket.emit('play', { positionSec: calculateServerPosition() });
  });
  safeSet('pause', () => {
    if (!currentRoom?.currentTrack) return;
    socket.emit('pause', { positionSec: calculateServerPosition() });
  });
  safeSet('nexttrack', () => {
    socket.emit('skip-track');
  });
  safeSet('seekto', (details) => {
    if (details && typeof details.seekTime === 'number') {
      socket.emit('seek', { positionSec: details.seekTime });
    }
  });
}
setupMediaSessionHandlers();

// --- AUDIO DIAGNOSTICS: console + ring buffer (window.__jamlockAudioLog) + on-screen panel with ?debug=1 ---
const audioLogBuf = (window.__jamlockAudioLog = []);
const AUDIO_DEBUG_PANEL = new URLSearchParams(window.location.search).get('debug') === '1';
let audioLogPanel = null;

function audioLog(event, detail) {
  let text = '';
  if (detail !== undefined) {
    try { text = typeof detail === 'string' ? detail : JSON.stringify(detail); } catch (e) { text = String(detail); }
  }
  audioLogBuf.push(`${new Date().toISOString().slice(11, 23)} ${event} ${text}`);
  if (audioLogBuf.length > 60) audioLogBuf.shift();
  console.log('[JamLock Audio]', event, detail !== undefined ? detail : '');
  if (AUDIO_DEBUG_PANEL) renderAudioLogPanel();
}

function renderAudioLogPanel() {
  if (!audioLogPanel) {
    audioLogPanel = document.createElement('div');
    audioLogPanel.style.cssText = 'position: fixed; top: 8px; left: 8px; right: 8px; max-height: 32vh; overflow: hidden; z-index: 99999; padding: 6px 10px; border-radius: 8px; background: rgba(0,0,0,0.85); color: #C8FF3D; font: 10px/1.35 "JetBrains Mono", monospace; pointer-events: none; white-space: pre-wrap; word-break: break-all';
    document.body.appendChild(audioLogPanel);
  }
  audioLogPanel.textContent = audioLogBuf.slice(-8).join('\n');
}

function nativeAudioSnapshot() {
  if (!nativeAudio) return {};
  return {
    paused: nativeAudio.paused,
    readyState: nativeAudio.readyState,
    networkState: nativeAudio.networkState,
    t: Number((nativeAudio.currentTime || 0).toFixed(2)),
    muted: nativeAudio.muted,
    vol: Number(nativeAudio.volume.toFixed(2)),
    hidden: document.hidden,
    src: (nativeAudio.currentSrc || '').replace(window.location.origin, '')
  };
}

function logPlayReject(where, e) {
  audioLog('play-rejected', { where, name: e?.name, message: e?.message });
}

// After a native <audio> error, ask the server why (it returns a safe `reason` code, never raw errors)
async function probeAudioEndpoint(trackId) {
  try {
    const res = await fetch(`/api/audio/${encodeURIComponent(trackId)}`, { headers: { Range: 'bytes=0-1' } });
    let reason = '';
    if (!res.ok) {
      try { reason = (await res.json()).reason || ''; } catch (e) {}
    }
    audioLog('probe', { status: res.status, reason });
    try { res.body?.cancel(); } catch (e) {}
  } catch (e) {
    audioLog('probe-failed', e?.message || String(e));
  }
}

// --- NATIVE STALL WATCHDOG ---
// The direct stream can hang without ever firing an `error` event (e.g. YouTube blocks the server's IP).
// If the native <audio> has received NO data 6s after the room starts playing, switch to the YouTube
// player and keep using it for the rest of this page session (a reload retries native).
// Note: audio that loaded but is blocked by browser autoplay (readyState >= 2) is NOT a stall;
// that case is handled by the "Tap to Tune In" prompt.
let nativeAudioFailed = false;
let nativeStallTimer = null;
const NATIVE_STALL_MS = 6000;

function disarmNativeStallWatchdog() {
  if (nativeStallTimer) {
    clearTimeout(nativeStallTimer);
    nativeStallTimer = null;
  }
}

function armNativeStallWatchdog() {
  if (nativeStallTimer || nativeAudioFailed || activeEngine !== 'audio') return;
  if (!nativeAudio.paused && nativeAudio.readyState >= 3) return; // already playing fine, nothing to guard
  const token = loadRequestToken;
  nativeStallTimer = setTimeout(() => {
    nativeStallTimer = null;
    if (token !== loadRequestToken || activeEngine !== 'audio' || !currentRoom?.currentTrack) return;
    if (!currentRoom.playback?.isPlaying) return;

    const advancing = !nativeAudio.paused && nativeAudio.readyState >= 3 && (nativeAudio.currentTime || 0) > 0;
    if (advancing) {
      audioLog('watchdog: audio advancing OK', nativeAudioSnapshot());
      return;
    }
    if (nativeAudio.readyState >= 2) {
      audioLog('watchdog: data loaded but not advancing (autoplay prompt / buffering); not falling back', nativeAudioSnapshot());
      return;
    }
    audioLog('watchdog: STALLED, no data received -> falling back to YouTube', nativeAudioSnapshot());
    nativeAudioFailed = true;
    fallbackToYouTubeTrack(currentRoom, 'stall-watchdog');
  }, NATIVE_STALL_MS);
}

// Wire native <audio> events (enables true background play on iOS/Android)
if (nativeAudio) {
  nativeAudio.addEventListener('playing', () => {
    if (activeEngine !== 'audio') return;
    disarmNativeStallWatchdog();
    showAudioPrompt(false);
    notPlayingSince = 0;

    if (seekIssuedAt) {
      const lag = (Date.now() - seekIssuedAt) / 1000;
      seekLagSec = Math.max(0.02, Math.min(0.6, seekLagSec * 0.5 + lag * 0.5));
      seekIssuedAt = 0;
    }
    if (settlePending && currentRoom?.playback?.isPlaying) {
      settlePending = false;
      const drift = (nativeAudio.currentTime || 0) - calculateServerPosition();
      if (Math.abs(drift) > DRIFT_SETTLE_SEC) driftSeek(calculateServerPosition(), true);
    }
  });

  nativeAudio.addEventListener('ended', () => {
    if (activeEngine !== 'audio') return;
    if (currentUser?.isHost && currentRoom?.currentTrack) {
      socket.emit('skip-track', { endedTrackId: currentRoom.currentTrack.id });
    }
  });

  // Diagnostics only: log the native audio lifecycle (no behaviour change)
  ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'waiting', 'stalled', 'pause', 'ended'].forEach((ev) => {
    nativeAudio.addEventListener(ev, () => {
      if (activeEngine === 'audio') audioLog(`audio:${ev}`, nativeAudioSnapshot());
    });
  });

  // Automatic fallback to YouTube IFrame if direct stream ever errors
  nativeAudio.addEventListener('error', () => {
    if (activeEngine !== 'audio' || !currentRoom?.currentTrack) return;
    const mediaErr = nativeAudio.error;
    const labels = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
    audioLog('audio:ERROR', {
      code: mediaErr?.code,
      label: labels[mediaErr?.code] || 'unknown',
      message: mediaErr?.message,
      ...nativeAudioSnapshot()
    });
    probeAudioEndpoint(currentRoom.currentTrack.id);
    nativeAudioFailed = true;
    fallbackToYouTubeTrack(currentRoom, 'native-audio-error');
  });

  // If mobile OS briefly pauses audio during app-switch or screen-lock transition while room is playing, resume
  nativeAudio.addEventListener('pause', () => {
    if (activeEngine !== 'audio' || !currentRoom?.currentTrack) return;
    if (currentRoom.playback?.isPlaying && !nativeAudio.ended && document.hidden) {
      setTimeout(() => {
        if (activeEngine === 'audio' && currentRoom?.playback?.isPlaying && nativeAudio.paused) {
          nativeAudio.play().catch(() => {});
        }
      }, 120);
    }
  });
}

// Single place that seeks for drift correction. Compensates for seek latency.
function driftSeek(targetSec, force = false) {
  const now = Date.now();
  if (!force && now - lastSeekAt < SEEK_COOLDOWN_MS) return false;
  lastSeekAt = now;
  seekIssuedAt = now;
  recentSeeks.push(now);
  if (activeEngine === 'audio' && nativeAudio) {
    try { nativeAudio.currentTime = Math.max(0, targetSec + 0.08); } catch (e) {}
  } else {
    try { ytPlayer.seekTo(Math.max(0, targetSec + seekLagSec), true); } catch (e) {}
  }
  return true;
}

window.onYouTubeIframeAPIReady = () => {
  ytPlayer = new YT.Player('yt-player', {
    height: '100%',
    width: '100%',
    playerVars: {
      autoplay: 1,
      controls: 0,
      modestbranding: 1,
      rel: 0,
      fs: 0,
      playsinline: 1,
      enablejsapi: 1,
      origin: window.location.origin
    },
    events: {
      onReady: () => {
        ytReady = true;
        audioLog('yt:ready', { activeEngine });
        try {
          if (!isMuted) {
            ytPlayer.unMute();
            ytPlayer.setVolume(currentVolume);
          } else {
            ytPlayer.mute();
          }
        } catch (e) {}

        if (currentRoom?.currentTrack) {
          loadCurrentTrack(currentRoom);
          applyRoomPlayback(currentRoom.playback);
        }
      },
      onError: (event) => {
        const meanings = {
          2: 'invalid video id/parameter',
          5: 'HTML5 player error',
          100: 'video not found / removed / private',
          101: 'embedding disabled by owner',
          150: 'embedding disabled by owner'
        };
        audioLog('yt:ERROR', { code: event.data, meaning: meanings[event.data] || 'unknown', activeEngine });
      },
      onStateChange: (event) => {
        if (activeEngine !== 'yt') return;
        audioLog('yt:state', event.data); // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
        if (event.data === YT.PlayerState.PLAYING) {
          try {
            ytPlayer.unMute();
            ytPlayer.setVolume(currentVolume);
          } catch (e) {}
          showAudioPrompt(false);

          // Learn how long seeks take to resume audio on this device
          if (seekIssuedAt) {
            const lag = (Date.now() - seekIssuedAt) / 1000;
            seekLagSec = Math.max(0.05, Math.min(1.0, seekLagSec * 0.5 + lag * 0.5));
            seekIssuedAt = 0;
          }

          // First PLAYING after a track load: one corrective alignment, no seek loops
          if (settlePending && currentRoom?.playback?.isPlaying) {
            settlePending = false;
            try {
              const drift = ytPlayer.getCurrentTime() - calculateServerPosition();
              if (Math.abs(drift) > DRIFT_SETTLE_SEC) driftSeek(calculateServerPosition(), true);
            } catch (e) {}
          }
        } else if (event.data === YT.PlayerState.ENDED) {
          // Server timer is authoritative; this is a fallback for tracks with unknown duration
          if (currentUser?.isHost && currentRoom?.currentTrack) {
            socket.emit('skip-track', { endedTrackId: currentRoom.currentTrack.id });
          }
        }
      }
    }
  });
};

function startSyncEngine() {
  if (syncInterval) clearInterval(syncInterval);

  const runSyncTick = () => {
    if (!currentRoom?.currentTrack || isSeeking) return;

    const duration = currentRoom.currentTrack.durationSeconds || 1;
    // Server timeline drives the UI, independent of the media engine
    let effectiveTime = calculateServerPosition();
    const roomPlaying = currentRoom.playback.isPlaying;

    if (activeEngine === 'audio' && nativeAudio && nativeAudio.src) {
      const local = nativeAudio.currentTime || 0;
      const isPlayingAudio = !nativeAudio.paused && !nativeAudio.ended && nativeAudio.readyState >= 2;
      const isBufferingAudio = !nativeAudio.paused && nativeAudio.readyState < 2;

      if (roomPlaying) {
        if (isPlayingAudio) {
          if (Math.abs(local - effectiveTime) > DRIFT_HARD_SEEK_SEC) driftSeek(effectiveTime);
          notPlayingSince = 0;
          showAudioPrompt(false);
        } else if (!isBufferingAudio && Date.now() - lastPlayKick > 2200) {
          lastPlayKick = Date.now();
          nativeAudio.play().catch((e) => {
            if (!notPlayingSince) {
              notPlayingSince = Date.now();
              logPlayReject('sync-tick', e); // logged once per stall, not every retry
            } else if (Date.now() - notPlayingSince > 1500) showAudioPrompt(true);
          });
        }
      } else {
        if (!nativeAudio.paused) {
          try { nativeAudio.pause(); } catch (e) {}
        }
        notPlayingSince = 0;
        showAudioPrompt(false);
      }
    } else if (activeEngine === 'yt' && ytReady && ytPlayer && !document.hidden) {
      try {
        const state = ytPlayer.getPlayerState();
        const local = ytPlayer.getCurrentTime() || 0;
        const isActive = state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING;

        if (roomPlaying) {
          if (state === YT.PlayerState.PLAYING) {
            // Cooldown + tight threshold; never seek while buffering/loading
            if (Math.abs(local - effectiveTime) > DRIFT_HARD_SEEK_SEC) driftSeek(effectiveTime);
          } else if (!isActive && Date.now() - lastPlayKick > 3000) {
            lastPlayKick = Date.now();
            ytPlayer.playVideo();
          }

        // Autoplay blocked? Offer a one-tap fix with zero delay
        if (!isActive) {
          if (!notPlayingSince) notPlayingSince = Date.now();
          else if (Date.now() - notPlayingSince > 800) showAudioPrompt(true);
        } else {
          notPlayingSince = 0;
          showAudioPrompt(false);
        }
        } else {
          notPlayingSince = 0;
          showAudioPrompt(false);
        }
      } catch (e) {}
    }

    effectiveTime = Math.max(0, Math.min(effectiveTime, duration));
    currentTimeDisplay.textContent = formatTime(effectiveTime);
    updateWaveformProgress((effectiveTime / duration) * 100);

    // Keep OS lock-screen position bar synchronized
    if ('mediaSession' in navigator && typeof navigator.mediaSession.setPositionState === 'function' && duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: Math.max(duration, effectiveTime),
          playbackRate: 1,
          position: Math.max(0, Math.min(effectiveTime, duration))
        });
      } catch (e) {}
    }

    updateDebugOverlay();
  };

  syncInterval = setInterval(runSyncTick, 400);

  // Background & foreground transitions: native <audio> continues playing in background;
  // when returning to the app, resync clock and align immediately.
  if (!window._visibilityListenerAttached) {
    window._visibilityListenerAttached = true;
    const handleVisibilityOrReturn = () => {
      if (document.hidden) {
        if (syncInterval) clearInterval(syncInterval);
        // Keep a light 1.5s sync check for background <audio> drift
        syncInterval = setInterval(runSyncTick, 1500);
      } else {
        if (syncInterval) clearInterval(syncInterval);
        syncClock();
        if (currentRoom?.currentTrack && currentRoom.playback?.isPlaying) {
          syncWakeLock(true);
          const serverPos = calculateServerPosition();

          if (activeEngine === 'audio' && nativeAudio) {
            const drift = Math.abs((nativeAudio.currentTime || 0) - serverPos);
            // Only seek if genuinely drifted outside tolerance (avoid audio hitch)
            if (drift > DRIFT_HARD_SEEK_SEC) {
              driftSeek(serverPos);
            }
            if (nativeAudio.paused) {
              nativeAudio.play().catch(() => {});
            }
          } else if (activeEngine === 'yt' && ytReady && ytPlayer) {
            try {
              const local = (typeof ytPlayer.getCurrentTime === 'function' ? ytPlayer.getCurrentTime() : 0) || 0;
              const state = typeof ytPlayer.getPlayerState === 'function' ? ytPlayer.getPlayerState() : -1;
              const drift = Math.abs(local - serverPos);

              // Never blindly seek if already playing smoothly within drift tolerance
              if (drift > DRIFT_HARD_SEEK_SEC) {
                driftSeek(serverPos);
              }
              if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) {
                ytPlayer.playVideo();
              }
            } catch (e) {}
          }
        }
        runSyncTick();
        syncInterval = setInterval(runSyncTick, 400);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityOrReturn);
    window.addEventListener('pageshow', handleVisibilityOrReturn);
  }
}

function calculateServerPosition() {
  if (!currentRoom?.playback) return 0;
  if (!currentRoom.playback.isPlaying) return currentRoom.playback.positionSec;

  // Use server-aligned clock so guests with a skewed device clock stay in sync
  const elapsed = Math.max(0, (Date.now() + clockOffset - currentRoom.playback.serverTime) / 1000);
  return currentRoom.playback.positionSec + elapsed;
}

function fallbackToYouTubeTrack(room, reason = 'unspecified') {
  if (!room?.currentTrack) return;
  audioLog('fallback-yt', { reason, id: room.currentTrack.id, ytReady });
  activeEngine = 'yt';
  disarmNativeStallWatchdog();
  if (nativeAudio) {
    try {
      nativeAudio.pause();
      nativeAudio.removeAttribute('src');
      nativeAudio.load();
    } catch (e) {}
  }
  if (!ytReady || !ytPlayer) {
    // YouTube API not ready yet: forget the loaded id so onReady re-runs loadCurrentTrack for this track
    loadedTrackId = null;
    audioLog('fallback-yt deferred', 'YouTube player not ready yet; will load on ready');
    return;
  }
  try {
    const startSec = calculateServerPosition();
    settlePending = true;
    lastSeekAt = Date.now();
    ytPlayer.loadVideoById({ videoId: room.currentTrack.id, startSeconds: startSec });
    setTimeout(() => {
      if (!isMuted) {
        try {
          ytPlayer.unMute();
          ytPlayer.setVolume(currentVolume);
        } catch (e) {}
      }
      if (currentRoom?.playback?.isPlaying) {
        try { ytPlayer.playVideo(); } catch (e) {}
      } else {
        try { ytPlayer.pauseVideo(); } catch (e) {}
      }
    }, 150);
  } catch (e) {}
}

// Load the room's current track into the Hybrid Audio Engine (Synchronous Native <audio> first, YouTube IFrame fallback)
function loadCurrentTrack(room) {
  if (!room?.currentTrack) return;
  const track = room.currentTrack;
  const trackId = track.id;
  if (loadedTrackId === trackId) return;
  loadedTrackId = trackId;
  settlePending = true;
  lastSeekAt = Date.now(); // no drift seeks while the new track is loading
  ++loadRequestToken;

  updateMediaSessionMetadata(track);
  syncWakeLock(Boolean(room.playback?.isPlaying));

  // If on cloud (Render) or native has failed, play via YouTube immediately within user click gesture
  if (isCloudHosted || nativeAudioFailed || !nativeAudio) {
    fallbackToYouTubeTrack(room, isCloudHosted ? 'cloud-direct-yt' : 'native-disabled-this-session');
    return;
  }

  if (nativeAudio && trackId && !nativeAudioFailed) {
    activeEngine = 'audio';
    // Stop YouTube iframe so it never double-plays
    if (ytReady && ytPlayer && typeof ytPlayer.stopVideo === 'function') {
      try { ytPlayer.stopVideo(); } catch (e) {}
    }
    // Fade out ambient artwork back to dark theme
    if (ambientArtBg) {
      ambientArtBg.style.opacity = '0';
    }

    const startPos = Math.max(0, calculateServerPosition());
    nativeAudio.src = `/api/audio/${encodeURIComponent(trackId)}`;
    nativeAudio.muted = isMuted;
    nativeAudio.volume = Math.max(0, Math.min(1, currentVolume / 100));
    audioLog('load-native', {
      id: trackId,
      startPos: Number(startPos.toFixed(1)),
      roomPlaying: Boolean(currentRoom?.playback?.isPlaying),
      isMuted,
      vol: currentVolume
    });

    // Active watchdog: if no data arrives within NATIVE_STALL_MS, fall back to the YouTube player
    disarmNativeStallWatchdog();
    armNativeStallWatchdog();

    // Seek to server position as soon as metadata is ready
    const onLoadedMeta = () => {
      nativeAudio.removeEventListener('loadedmetadata', onLoadedMeta);
      const target = Math.max(0, calculateServerPosition());
      if (target > 0.5) {
        try { nativeAudio.currentTime = target; } catch (e) {}
      }
      if (currentRoom?.playback?.isPlaying && nativeAudio.paused) {
        nativeAudio.play().catch((e) => {
          logPlayReject('loadedmetadata', e);
          showAudioPrompt(true);
        });
      }
    };
    nativeAudio.addEventListener('loadedmetadata', onLoadedMeta);

    if (startPos > 0.5) {
      try { nativeAudio.currentTime = startPos; } catch (e) {}
    }

    if (currentRoom?.playback?.isPlaying) {
      nativeAudio.play().catch((e) => {
        logPlayReject('load', e);
        showAudioPrompt(true);
      });
    } else {
      nativeAudio.pause();
    }
    return;
  }

  fallbackToYouTubeTrack(room, nativeAudioFailed ? 'native-disabled-this-session' : 'no-native-audio-element');
}

// "Tap to tune in / enable audio" pill shown when the browser blocks autoplay on reload
function showAudioPrompt(show) {
  let el = document.getElementById('audio-unblock-pill');
  if (!show) {
    if (el) el.style.display = 'none';
    return;
  }
  if (!el) {
    el = document.createElement('button');
    el.id = 'audio-unblock-pill';
    el.type = 'button';
    el.innerHTML = '<span style="font-size: 16px; margin-right: 6px">🔊</span><span>Room is Live • Tap to Tune In</span>';
    el.style.cssText = 'position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 99999; height: 48px; padding: 0 24px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.2); background: var(--lime); color: #0A0A0D; font-weight: 700; font-size: 14px; letter-spacing: -0.01em; box-shadow: 0 0 32px rgba(200,255,61,0.6), 0 8px 24px rgba(0,0,0,0.5); cursor: pointer; display: flex; align-items: center; justify-content: center; animation: pulseTuneIn 1.8s infinite ease-in-out';
    
    // Inject animation keyframes if not present
    if (!document.getElementById('pulse-tune-in-style')) {
      const style = document.createElement('style');
      style.id = 'pulse-tune-in-style';
      style.textContent = `
        @keyframes pulseTuneIn {
          0%, 100% { transform: translateX(-50%) scale(1); box-shadow: 0 0 24px rgba(200,255,61,0.5); }
          50% { transform: translateX(-50%) scale(1.04); box-shadow: 0 0 36px rgba(200,255,61,0.85); }
        }
      `;
      document.head.appendChild(style);
    }

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      tuneIntoLiveRoom();
    });
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
}

// Instant sync & un-mute to live room playback
function tuneIntoLiveRoom() {
  notPlayingSince = 0;
  const promptEl = document.getElementById('audio-unblock-pill');
  if (promptEl) promptEl.style.display = 'none';

  const livePos = calculateServerPosition();
  try {
    if (activeEngine === 'audio' && nativeAudio) {
      nativeAudio.muted = isMuted;
      nativeAudio.volume = Math.max(0, Math.min(1, currentVolume / 100));
      nativeAudio.currentTime = livePos;
      nativeAudio.play().catch(() => {});
    } else if (ytReady && ytPlayer) {
      ytPlayer.unMute();
      ytPlayer.setVolume(currentVolume);
      ytPlayer.seekTo(livePos, true);
      ytPlayer.playVideo();
    }
  } catch (e) {}
}

// Any first user gesture can unlock playback and un-mute if the room is playing.
// Calls tuneIntoLiveRoom() to guarantee instant drift-free alignment.
const unlockAudioOnGesture = () => {
  if (currentRoom?.currentTrack && currentRoom?.playback?.isPlaying) {
    const isPaused = activeEngine === 'audio'
      ? (nativeAudio?.paused || !nativeAudio?.src)
      : (ytPlayer?.getPlayerState?.() !== YT.PlayerState.PLAYING);
    if (isPaused) {
      tuneIntoLiveRoom();
      return;
    }
  }

  try {
    if (activeEngine === 'audio' && nativeAudio) {
      nativeAudio.muted = isMuted;
      if (!isMuted) nativeAudio.volume = Math.max(0, Math.min(1, currentVolume / 100));
      return;
    }
    if (!ytReady || !ytPlayer) return;
    if (!isMuted) {
      ytPlayer.unMute();
      ytPlayer.setVolume(currentVolume);
    }
  } catch (e) {}
};
document.addEventListener('pointerdown', unlockAudioOnGesture, { passive: true });
document.addEventListener('keydown', unlockAudioOnGesture, { passive: true });

// Optional ?debug=1 overlay to verify sync on real devices
const SYNC_DEBUG = new URLSearchParams(window.location.search).get('debug') === '1';
let debugEl = null;
function updateDebugOverlay() {
  if (!SYNC_DEBUG) return;
  if (!debugEl) {
    debugEl = document.createElement('div');
    debugEl.style.cssText = 'position: fixed; left: 8px; bottom: 8px; z-index: 99999; padding: 6px 10px; border-radius: 8px; background: rgba(0,0,0,0.8); color: #C8FF3D; font: 11px/1.4 "JetBrains Mono", monospace; pointer-events: none; white-space: pre';
    document.body.appendChild(debugEl);
  }
  try {
    const now = Date.now();
    while (recentSeeks.length && now - recentSeeks[0] > 60000) recentSeeks.shift();
    const local = activeEngine === 'audio' ? (nativeAudio?.currentTime || 0) : (ytPlayer?.getCurrentTime?.() || 0);
    const drift = local - calculateServerPosition();
    const stateLabel = activeEngine === 'audio'
      ? `audio:${nativeAudio?.paused ? 'paused' : 'playing'}`
      : `yt:${ytPlayer?.getPlayerState?.()}`;
    debugEl.textContent =
      `offset ${Math.round(clockOffset)}ms${clockSynced ? '' : ' (rough)'}  rtt ${lastRtt}ms\n` +
      `drift ${(drift * 1000).toFixed(0)}ms  ${stateLabel}\n` +
      `seeks/min ${recentSeeks.length}  seekLag ${(seekLagSec * 1000).toFixed(0)}ms`;
  } catch (e) {}
}

function applyRoomPlayback(playback) {
  if (!playback) return;

  // Update UI icons first regardless of engine ready status
  if (playback.isPlaying) {
    playIcon?.classList.add('hidden');
    pauseIcon?.classList.remove('hidden');
    playerStatusBadge.textContent = 'NOW PLAYING';
  } else {
    playIcon?.classList.remove('hidden');
    pauseIcon?.classList.add('hidden');
    playerStatusBadge.textContent = 'PAUSED';
  }

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = playback.isPlaying ? 'playing' : 'paused';
    } catch (e) {}
  }
  syncWakeLock(Boolean(playback.isPlaying));

  const serverPos = calculateServerPosition();

  // Native <audio> engine path (supports background & lock-screen play)
  if (activeEngine === 'audio' && nativeAudio && nativeAudio.src) {
    try {
      if (playback.isPlaying) {
        armNativeStallWatchdog(); // no-op if already armed / native already playing
        const drift = Math.abs((nativeAudio.currentTime || 0) - serverPos);
        if (drift > DRIFT_HARD_SEEK_SEC) {
          driftSeek(serverPos, nativeAudio.paused);
        }
        if (nativeAudio.paused) {
          nativeAudio.play().catch((e) => console.warn('Audio autoplay blocked:', e) || logPlayReject('applyRoomPlayback', e));
        }
      } else {
        nativeAudio.pause();
        if (typeof playback.positionSec === 'number' && playback.positionSec >= 0) {
          nativeAudio.currentTime = playback.positionSec;
        }
      }
    } catch (err) {}
    return;
  }

  if (!ytReady || !ytPlayer) return;

  try {
    if (playback.isPlaying) {
      const state = typeof ytPlayer.getPlayerState === 'function' ? ytPlayer.getPlayerState() : -1;
      if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
        // Already running: only correct real drift, with cooldown
        if (state === YT.PlayerState.PLAYING) {
          const drift = Math.abs(ytPlayer.getCurrentTime() - serverPos);
          if (drift > DRIFT_HARD_SEEK_SEC) driftSeek(serverPos);
        }
      } else {
        // PAUSED = settled player resuming: align once. UNSTARTED/CUED = still loading: never seek.
        if (state === YT.PlayerState.PAUSED &&
            Math.abs(ytPlayer.getCurrentTime() - serverPos) > DRIFT_HARD_SEEK_SEC) {
          driftSeek(serverPos, true);
        }
        if (Date.now() - lastPlayKick > 1000) {
          lastPlayKick = Date.now();
          const playPromise = ytPlayer.playVideo();
          // If playVideo returns a promise, catch unhandled autoplay rejections
          if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch((e) => console.warn('Autoplay blocked:', e));
          }
        }
      }
    } else {
      if (typeof ytPlayer.pauseVideo === 'function') {
        ytPlayer.pauseVideo();
      }
      if (typeof playback.positionSec === 'number' && playback.positionSec >= 0) {
        ytPlayer.seekTo(playback.positionSec, true);
      }
    }
  } catch (err) {
    console.warn('Playback adjustment:', err);
  }
}

// Audio Fade In / Out
let volumeFadeTimer = null;
function fadeAudio(targetVolume, durationMs = 350, onComplete) {
  if (!ytReady || !ytPlayer || typeof ytPlayer.getVolume !== 'function') {
    if (onComplete) onComplete();
    return;
  }
  if (volumeFadeTimer) clearInterval(volumeFadeTimer);

  const startVolume = ytPlayer.getVolume();
  const stepCount = 12;
  const interval = durationMs / stepCount;
  const delta = (targetVolume - startVolume) / stepCount;
  let currentStep = 0;

  volumeFadeTimer = setInterval(() => {
    currentStep++;
    const newVol = Math.round(startVolume + delta * currentStep);
    try {
      ytPlayer.setVolume(Math.max(0, Math.min(100, newVol)));
    } catch (e) {}

    if (currentStep >= stepCount) {
      clearInterval(volumeFadeTimer);
      volumeFadeTimer = null;
      try {
        ytPlayer.setVolume(targetVolume);
      } catch (e) {}
      if (onComplete) onComplete();
    }
  }, interval);
}

// --- 7. PLAYBACK CONTROLS ---
playPauseBtn?.addEventListener('click', () => {
  if (document.activeElement === playPauseBtn) {
    playPauseBtn.blur();
  }
  if (!currentRoom?.currentTrack) {
    showToast('Search a song below to start playing!', 'info');
    return;
  }
  const isPlaying = currentRoom.playback.isPlaying;
  let currentPos = currentRoom.playback.positionSec;
  try {
    if (activeEngine === 'audio' && nativeAudio) {
      const t = nativeAudio.currentTime;
      if (typeof t === 'number' && !isNaN(t) && t >= 0) currentPos = t;
    } else if (ytReady && ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
      const t = ytPlayer.getCurrentTime();
      if (typeof t === 'number' && !isNaN(t) && t >= 0) currentPos = t;
    }
  } catch (e) {}

  if (isPlaying) {
    socket.emit('pause', { positionSec: currentPos });
  } else {
    socket.emit('play', { positionSec: currentPos });
  }
});

skipBtn?.addEventListener('click', () => {
  socket.emit('skip-track');
});

forceResyncBtn?.addEventListener('click', () => {
  socket.emit('sync-request', (data) => {
    syncClock();
    if (!data) return;
    updateClockOffset(data.serverTime);
    currentRoom.playback = data;
    loadCurrentTrack(currentRoom);
    if (activeEngine === 'audio' && nativeAudio && nativeAudio.src) {
      nativeAudio.currentTime = data.positionSec;
      if (data.isPlaying) nativeAudio.play().catch(() => {});
    } else if (ytReady && ytPlayer) {
      ytPlayer.seekTo(data.positionSec, true);
      if (data.isPlaying) ytPlayer.playVideo();
    }
    showToast('Resynchronized with host!', 'success');
  });
});

// --- 8. REALTIME SEARCH & TRENDING CHIPS ---
const CLIENT_SEARCH_CACHE = new Map();
let searchAbortController = null;

inlineSearchInput?.addEventListener('input', (e) => {
  clearTimeout(searchDebounceTimer);
  const q = e.target.value.trim();

  if (q.length < 2) {
    searchResultsSection?.classList.add('hidden');
    searchEmptyPrompt?.classList.remove('hidden');
    return;
  }

  searchEmptyPrompt?.classList.add('hidden');

  // Instant Client Cache hit
  const cached = CLIENT_SEARCH_CACHE.get(q.toLowerCase());
  if (cached) {
    renderSearchResults(cached);
    return;
  }

  // Show skeleton placeholder rows while fetching
  renderSearchSkeletons();
  searchSpinner?.classList.remove('hidden');
  if (searchAbortController) searchAbortController.abort();
  searchAbortController = new AbortController();

  searchDebounceTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
        signal: searchAbortController.signal
      });
      const results = await res.json();
      CLIENT_SEARCH_CACHE.set(q.toLowerCase(), results);
      renderSearchResults(results);
    } catch (err) {
      if (err.name !== 'AbortError') console.error('Search error:', err);
    } finally {
      searchSpinner?.classList.add('hidden');
    }
  }, 260);
});

function renderSearchSkeletons(count = 4) {
  if (!searchResultsList) return;
  trendingSection?.classList.add('hidden');
  searchResultsSection?.classList.remove('hidden');

  let skeletons = '';
  for (let i = 0; i < count; i++) {
    skeletons += `
      <div class="row" style="opacity: 0.9">
        <div class="skeleton-box" style="width: 44px; height: 44px; border-radius: 12px; flex-shrink: 0"></div>
        <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px">
          <div class="skeleton-box" style="height: 14px; width: ${60 + (i % 3) * 15}%;"></div>
          <div class="skeleton-box" style="height: 11px; width: ${30 + (i % 2) * 20}%;"></div>
        </div>
        <div class="skeleton-box" style="width: 38px; height: 12px; margin-right: 6px"></div>
        <div class="skeleton-box" style="width: 72px; height: 34px; border-radius: 999px; flex-shrink: 0"></div>
      </div>
    `;
  }
  searchResultsList.innerHTML = skeletons;
}

function getDisplayTitle(song) {
  let t = song.cleanTitle || song.title || 'Untitled Track';
  if (song.artist && t.includes(' - ')) {
    const parts = t.split(' - ');
    const p0 = parts[0].trim().toLowerCase();
    const a = song.artist.trim().toLowerCase();
    if (a.includes(p0) || p0.includes(a)) {
      t = parts.slice(1).join(' - ').trim();
    }
  }
  return t;
}

function renderSearchResults(items) {
  if (!searchResultsList) return;
  trendingSection?.classList.add('hidden');
  searchResultsSection?.classList.remove('hidden');

  if (!items || items.length === 0) {
    searchResultsList.innerHTML = `
      <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px">
        No songs found. Try another track title or artist.
      </div>
    `;
    return;
  }

  searchResultsList.innerHTML = items.map((song) => {
    const songEncoded = encodeURIComponent(JSON.stringify(song));
    const displayTitle = getDisplayTitle(song);
    return `
      <div class="row" onmouseenter="handleWarmup('${song.id}')" ontouchstart="handleWarmup('${song.id}')">
        <button type="button" onclick="handlePlayNow('${songEncoded}')" class="art-btn" style="background-image: url('${song.thumbnail}')" title="Play Now">
          <div class="play-hint">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--lime)"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </button>
        <div style="flex: 1; min-width: 0; cursor: pointer" onclick="handlePlayNow('${songEncoded}')">
          <div class="t" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</div>
          <div class="s">${escapeHtml(song.artist)}</div>
        </div>
        <span class="mono" style="margin-right: 4px">${song.duration}</span>
        <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0">
          <button type="button" class="search-action-btn" onclick="handleQueueSong('${songEncoded}', false)" title="Add to Queue">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            <span class="search-btn-label">Queue</span>
          </button>
          <button type="button" class="search-action-btn icon-only" title="Play Next" onclick="handleQueueSong('${songEncoded}', true)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// Track Stream Pre-Warm Cache
const warmedUpTracks = new Set();
window.handleWarmup = (songId) => {
  if (!songId || warmedUpTracks.has(songId)) return;
  warmedUpTracks.add(songId);
  try {
    fetch(`/api/warmup/${encodeURIComponent(songId)}`, { priority: 'low' }).catch(() => {});
  } catch (e) {}
};

// Quick Trending & Chip Search Listeners
document.querySelectorAll('.sample-chip, .quick-search-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    btn.blur();
    const q = btn.dataset.query;
    if (inlineSearchInput && q) {
      inlineSearchInput.value = q;
      inlineSearchInput.dispatchEvent(new Event('input'));
    }
  });
});

window.handlePlayNow = (songEncodedStr) => {
  try {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    const song = JSON.parse(decodeURIComponent(songEncodedStr));

    // Optimistic audio pipeline preload within user click gesture for instant playback
    if (nativeAudio && song?.id && !isCloudHosted && !nativeAudioFailed) {
      const audioUrl = `/api/audio/${encodeURIComponent(song.id)}`;
      if (!nativeAudio.src.endsWith(audioUrl)) {
        nativeAudio.src = audioUrl;
        nativeAudio.currentTime = 0;
        nativeAudio.load();
        const playPromise = nativeAudio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {});
        }
      }
    }

    socket.emit('play-now', { track: song });
  } catch (e) {
    console.error(e);
  }
};

window.handleQueueSong = (songEncodedStr, playNext) => {
  try {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    const song = JSON.parse(decodeURIComponent(songEncodedStr));
    socket.emit('add-to-queue', { track: song, playNext });
    showToast(`Added "${song.title.slice(0, 28)}..." to queue`, 'success');
  } catch (e) {
    console.error(e);
  }
};

// Global Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
  // Spacebar: Toggle play/pause
  if (e.code === 'Space' || e.key === ' ') {
    const activeEl = document.activeElement;
    const tag = activeEl?.tagName?.toLowerCase();
    const isEditable = tag === 'input' || tag === 'textarea' || activeEl?.isContentEditable;

    // Allow normal typing inside input and textarea fields
    if (isEditable) return;

    // Prevent page scroll and prevent re-triggering focused button
    e.preventDefault();
    if (activeEl && typeof activeEl.blur === 'function') {
      activeEl.blur();
    }

    // Toggle playback if a track is active in the room
    if (currentRoom?.currentTrack) {
      playPauseBtn?.click();
    }
    return;
  }

  // Global Shortcut: / or Ctrl+K to search
  if ((e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) && document.activeElement !== inlineSearchInput && document.activeElement !== chatInput) {
    e.preventDefault();
    inlineSearchInput?.focus();
    inlineSearchInput?.select();
  }
});

// --- 9. REACTIONS & COUNTER BADGES (Burst Rate Limited) ---
let localReactionBurstCount = 0;
let reactionCooldownTimer = null;

document.querySelectorAll('.reaction-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (localReactionBurstCount >= 5) {
      // Temporarily throttle clicks
      btn.style.transform = 'scale(0.9)';
      setTimeout(() => { btn.style.transform = ''; }, 150);
      return;
    }

    localReactionBurstCount++;
    if (!reactionCooldownTimer) {
      reactionCooldownTimer = setTimeout(() => {
        localReactionBurstCount = 0;
        reactionCooldownTimer = null;
      }, 2000);
    }

    const emoji = btn.dataset.emoji;
    socket.emit('send-reaction', { emoji });
  });
});

function spawnFloatingReaction(emoji) {
  const el = document.createElement('span');
  el.className = 'fl text-2xl';
  el.textContent = emoji;

  // Random bottom position near reaction cluster
  const randomX = Math.random() * 80 + 10;
  el.style.left = `${randomX}%`;
  el.style.top = `-20px`;

  reactionsContainer.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// --- 10. CHAT ---
chatForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput?.value.trim();
  if (!text) return;
  socket.emit('chat-message', { text });
  chatInput.value = '';
});

// --- 11. WEBSOCKET EVENTS ---
socket.on('room-state', (roomData) => {
  currentRoom = roomData;
  updateClockOffset(roomData?.playback?.serverTime);
  renderRoomState(roomData);
});

socket.on('playback-sync', (playbackData) => {
  if (currentRoom) {
    updateClockOffset(playbackData?.serverTime);
    currentRoom.playback = playbackData;
    applyRoomPlayback(playbackData);
  }
});

socket.on('reaction-received', (data) => {
  spawnFloatingReaction(data.emoji);

  // Increment reaction badge
  if (reactionCounts[data.emoji] !== undefined) {
    reactionCounts[data.emoji]++;
    const idMap = { '🔥': 'rx-fire-count', '❤️': 'rx-love-count', '⚡': 'rx-zap-count', '✨': 'rx-star-count' };
    const badge = document.getElementById(idMap[data.emoji]);
    if (badge) {
      const count = reactionCounts[data.emoji];
      if (count > 0) {
        badge.textContent = count;
        badge.classList.add('has-count');
      } else {
        badge.classList.remove('has-count');
      }
    }
  }
});

let activeMobileTabName = 'queue';
let unreadChatCount = 0;
const mobileChatUnread = document.getElementById('mobile-chat-unread');

socket.on('chat-message-received', (msg) => {
  appendChatMessage(msg);

  // If user is on mobile and not currently in the Chat tab, show unread badge
  if (activeMobileTabName !== 'chat') {
    unreadChatCount++;
    if (mobileChatUnread) {
      mobileChatUnread.textContent = unreadChatCount > 99 ? '99+' : unreadChatCount;
      mobileChatUnread.classList.remove('hidden');
    }
  }
});

socket.on('notification', ({ text, type }) => {
  showToast(text, type || 'info');
});

// Realtime User Departure & Host Promotion Listeners
socket.on('user-left', ({ user }) => {
  if (user?.username && user.username !== currentUser?.username) {
    showToast(`${user.username} left the room`, 'info');
  }
});

socket.on('host-changed', ({ newHost }) => {
  if (currentUser && newHost && (newHost.clientId === currentUser.clientId || newHost.username === currentUser.username)) {
    currentUser.isHost = true;
    if (hostSettingsBtn) hostSettingsBtn.classList.remove('hidden');
    showToast('You are now the room host! 👑', 'success');
  } else if (newHost?.username) {
    showToast(`${newHost.username} is now the room host`, 'info');
  }
});

// --- 12. UI STATE RENDERING ---
function renderRoomState(room) {
  if (!room) return;

  // Sync current user's host status with room user list
  if (currentUser && Array.isArray(room.users)) {
    const myUserRecord = room.users.find(u => u.clientId === currentUser.clientId || u.username === currentUser.username);
    if (myUserRecord && typeof myUserRecord.isHost === 'boolean') {
      currentUser.isHost = myUserRecord.isHost;
    }
  }

  // Listening count
  if (listeningCountDisplay) {
    const count = room.users.length;
    listeningCountDisplay.textContent = count === 1 ? '1 listening' : `${count} listening`;
  }

  // User Avatars Strip
  if (usersStrip) {
    usersStrip.innerHTML = room.users.map((u, i) => `
      <span class="av" style="background: ${u.avatarColor}; margin-left: ${i > 0 ? '-8px' : '0'}; border: 2px solid #0A0A0D" title="${escapeHtml(u.username)} ${u.isHost ? '(Host)' : ''}">
        ${u.username.charAt(0).toUpperCase()}
      </span>
    `).join('');
  }

  // Host Settings Button Visibility
  if (hostSettingsBtn) {
    if (currentUser?.isHost) {
      hostSettingsBtn.classList.remove('hidden');
    } else {
      hostSettingsBtn.classList.add('hidden');
    }
  }

  // Auto-Suggest switch sync
  if (room.settings && typeof room.settings.autoSuggest === 'boolean') {
    syncAutoSuggestUI(room.settings.autoSuggest);
  }

  // Queue List Rendering
  queueCountBadge.textContent = room.queue.length;
  const mobileQueueCount = document.getElementById('mobile-queue-count');
  if (mobileQueueCount) {
    mobileQueueCount.textContent = room.queue.length;
  }
  if (room.queue.length === 0) {
    queueList.innerHTML = `
      <div style="padding: 24px 0; text-align: center; color: var(--text-muted); font-size: 13px">
        No tracks queued up. Search songs below to add!
      </div>
    `;
  } else {
    queueList.innerHTML = room.queue.map((track, idx) => {
      const trackEncoded = encodeURIComponent(JSON.stringify(track));
      const isAuto = track.isAutoSuggested;
      return `
        <div class="row">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9A98A6" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="cursor: grab; flex: none">
            <circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/>
            <circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/>
            <circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>
          </svg>
          <img src="${track.thumbnail}" alt="" class="art">
          <div style="flex: 1; min-width: 0; cursor: pointer" onclick="handlePlayNow('${trackEncoded}')">
            <div class="t">${escapeHtml(track.title)}</div>
            <div class="s">${escapeHtml(track.artist)} • ${track.duration}</div>
          </div>
          <span class="av" style="background: ${isAuto ? '#3A3A46' : 'var(--sky)'}; color: ${isAuto ? '#F4F2EA' : '#0A0A0D'}" title="${isAuto ? 'Auto-suggested' : 'Queued by member'}">
            ${isAuto ? 'B' : 'M'}
          </span>
          <button type="button" class="ghost" onclick="handleRemoveQueueItem(${idx})" style="background: none; border: 0; color: var(--text-muted); cursor: pointer; padding: 4px" title="Remove">✕</button>
        </div>
      `;
    }).join('');
  }

  // Hero Section: Empty vs Playing State
  if (room.currentTrack) {
    emptyHeroArt.style.display = 'none';
    trackArt.style.display = 'block';
    trackArt.src = room.currentTrack.thumbnail;
    trackTitle.textContent = room.currentTrack.title;
    trackArtist.textContent = room.currentTrack.artist;
    totalDurationDisplay.textContent = room.currentTrack.duration || '0:00';
    playerStatusBadge.textContent = 'NOW PLAYING';

    // Added by chip
    if (addedByBadge) {
      addedByBadge.style.display = 'flex';
      addedByText.textContent = room.currentTrack.addedBy || 'host';
    }

    // Dynamic Ambient Backdrop from Album Cover Art
    if (ambientArtBg && room.currentTrack.thumbnail) {
      ambientArtBg.style.backgroundImage = `url("${room.currentTrack.thumbnail}")`;
      ambientArtBg.style.opacity = '0.52';
    }

    if (heroBanner) {
      heroBanner.style.background = `
        linear-gradient(180deg, rgba(0,0,0,0.0), #0A0A0D 98%),
        radial-gradient(700px 420px at 20% 30%, rgba(200,255,61,0.24), transparent 65%),
        radial-gradient(700px 480px at 85% 10%, rgba(255,90,78,0.24), transparent 65%),
        rgba(20,20,26,0.6)
      `;
    }

    // Load track in YT player if different (once per track id)
    loadCurrentTrack(room);

    // Only re-apply playback when the track or play/pause state actually changed;
    // the sync tick handles drift for everything else.
    const playKey = `${room.currentTrack.id}:${room.playback.isPlaying}`;
    if (playKey !== lastPlaybackKey) {
      lastPlaybackKey = playKey;
      applyRoomPlayback(room.playback);
    }
  } else {
    // Empty state: stop audio on every client
    if (nativeAudio) {
      try {
        nativeAudio.pause();
        nativeAudio.removeAttribute('src');
        nativeAudio.load();
      } catch (e) {}
    }
    if (ytReady && ytPlayer && typeof ytPlayer.stopVideo === 'function') {
      try { ytPlayer.stopVideo(); } catch (e) {}
    }
    // Fade out ambient artwork back to dark theme
    if (ambientArtBg) {
      ambientArtBg.style.opacity = '0';
    }
    updateMediaSessionMetadata(null);
    syncWakeLock(false);
    loadedTrackId = null;
    lastPlaybackKey = '';
    notPlayingSince = 0;
    showAudioPrompt(false);
    playIcon?.classList.remove('hidden');
    pauseIcon?.classList.add('hidden');
    emptyHeroArt.style.display = 'flex';
    trackArt.style.display = 'none';
    trackTitle.textContent = 'No track playing';
    trackArtist.textContent = '';
    totalDurationDisplay.textContent = '0:00';
    currentTimeDisplay.textContent = '0:00';
    playerStatusBadge.textContent = 'ROOM READY';
    if (addedByBadge) addedByBadge.style.display = 'none';
    updateWaveformProgress(0);
  }
}

window.handleRemoveQueueItem = (idx) => {
  socket.emit('remove-from-queue', { index: idx });
};

function appendChatMessage(msg) {
  const isMe = msg.user.username === currentUser?.username;
  const div = document.createElement('div');
  div.style.display = 'flex';
  div.style.gap = '10px';
  div.style.alignItems = 'flex-start';

  if (isMe) {
    div.style.alignSelf = 'flex-end';
    div.innerHTML = `
      <div style="background: var(--lime); color: #0A0A0D; border-radius: 16px 4px 16px 16px; padding: 8px 14px; font-size: 14px; font-weight: 500">
        ${escapeHtml(msg.text)}
      </div>
    `;
  } else {
    div.innerHTML = `
      <span class="av" style="background: ${msg.user.avatarColor}">${escapeHtml(msg.user.username.charAt(0).toUpperCase())}</span>
      <div style="background: var(--surface-raised); border-radius: 4px 16px 16px 16px; padding: 8px 14px; font-size: 14px">
        <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 2px">${escapeHtml(msg.user.username)}</div>
        ${escapeHtml(msg.text)}
      </div>
    `;
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendReactionChat(username, emoji) {
  const emojiNames = { '🔥': 'fire', '❤️': 'love', '⚡': 'energy', '✨': 'sparkles' };
  const name = emojiNames[emoji] || 'good vibes';
  const div = document.createElement('div');
  div.style.alignSelf = 'center';
  div.style.fontSize = '12px';
  div.style.color = 'var(--text-muted)';
  div.style.background = 'var(--surface-raised)';
  div.style.borderRadius = '999px';
  div.style.padding = '4px 12px';
  div.textContent = `${username} reacted with ${name}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  const bgBorder = type === 'success' 
    ? 'border: 1px solid var(--lime); color: var(--lime)' 
    : (type === 'error' ? 'border: 1px solid #f43f5e; color: #f43f5e' : 'border: 1px solid var(--border-outline); color: var(--text-main)');
  toast.style.cssText = `padding: 10px 16px; border-radius: 12px; background: rgba(19,19,24,0.95); backdrop-filter: blur(8px); ${bgBorder}; font-size: 13px; font-weight: 500; box-shadow: 0 10px 30px rgba(0,0,0,0.5); pointer-events: auto; animation: scaleUp 0.2s ease`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.25s ease';
    setTimeout(() => toast.remove(), 260);
  }, 3000);
}

function formatTime(sec) {
  if (isNaN(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// --- 13. MOBILE SEGMENTED TABS CONTROLLER ---
const tabBtnQueue = document.getElementById('tab-btn-queue');
const tabBtnChat = document.getElementById('tab-btn-chat');
const tabBtnSearch = document.getElementById('tab-btn-search');
const panelQueue = document.getElementById('panel-queue');
const panelChat = document.getElementById('panel-chat');
const panelSearch = document.getElementById('panel-search');

function setMobileTab(activeTab) {
  activeMobileTabName = activeTab;

  // Clear unread chat badge when entering Chat tab
  if (activeTab === 'chat') {
    unreadChatCount = 0;
    if (mobileChatUnread) {
      mobileChatUnread.textContent = '0';
      mobileChatUnread.classList.add('hidden');
    }
  }

  const tabs = [
    { btn: tabBtnQueue, panel: panelQueue, name: 'queue' },
    { btn: tabBtnChat, panel: panelChat, name: 'chat' },
    { btn: tabBtnSearch, panel: panelSearch, name: 'search' }
  ];

  tabs.forEach(({ btn, panel, name }) => {
    if (name === activeTab) {
      panel?.classList.add('active-tab-panel');
      if (btn) {
        btn.style.background = 'var(--text-main)';
        btn.style.color = '#0A0A0D';
        btn.style.fontWeight = '700';
      }
    } else {
      panel?.classList.remove('active-tab-panel');
      if (btn) {
        btn.style.background = 'transparent';
        btn.style.color = 'var(--text-secondary)';
        btn.style.fontWeight = '600';
      }
    }
  });
}

tabBtnQueue?.addEventListener('click', () => setMobileTab('queue'));
tabBtnChat?.addEventListener('click', () => setMobileTab('chat'));
tabBtnSearch?.addEventListener('click', () => setMobileTab('search'));

// Default to queue on load
setMobileTab('queue');

// Auto-switch to search tab if user clicks search input or sample chip
inlineSearchInput?.addEventListener('focus', () => {
  if (window.innerWidth < 768) {
    setMobileTab('search');
  }
});
document.querySelectorAll('.sample-chip, .quick-search-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (window.innerWidth < 768) {
      setMobileTab('search');
    }
  });
});
