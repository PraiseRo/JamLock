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

function updateClockOffset(serverTime) {
  if (typeof serverTime === 'number' && !isNaN(serverTime)) {
    clockOffset = serverTime - Date.now();
  }
}

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
let currentVolume = parseInt(localStorage.getItem('jamlock_volume') || localStorage.getItem('beatsync_volume') || '100', 10);
let isMuted = false;

if (volumeSlider) {
  volumeSlider.value = currentVolume;
  volumeSlider.addEventListener('input', (e) => {
    currentVolume = parseInt(e.target.value, 10);
    localStorage.setItem('jamlock_volume', currentVolume);
    isMuted = false;
    updateVolumeUI();
    if (ytReady && ytPlayer && typeof ytPlayer.setVolume === 'function') {
      ytPlayer.unMute();
      ytPlayer.setVolume(currentVolume);
    }
  });
}

if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
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
      usernameInput?.focus();
      showToast(`Enter your display name to enter room ${targetRoom.toUpperCase()}`, 'info');
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
  joinRoom(generatedCode, username);
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
  joinRoom(code, username);
});

function getBrowserClientId() {
  let cid = localStorage.getItem('jamlock_client_id');
  if (!cid) {
    cid = 'cid_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    localStorage.setItem('jamlock_client_id', cid);
  }
  return cid;
}

function joinRoom(roomId, explicitUsername) {
  const username = explicitUsername || usernameInput?.value.trim();
  if (!username) {
    requireValidUsername();
    return;
  }
  localStorage.setItem('jamlock_username', username);

  const clientId = getBrowserClientId();

  socket.emit('join-room', { roomId, username, clientId }, (response) => {
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
      showToast(response.error, 'error');
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
  localStorage.removeItem('jamlock_current_room');
  localStorage.removeItem('beatsync_current_room');
  document.documentElement.classList.remove('in-room-loading');
  document.body.classList.remove('in-room-mode');
  window.location.href = window.location.origin + window.location.pathname;
});

copyRoomLinkBtn?.addEventListener('click', () => {
  navigator.clipboard.writeText(window.location.href);
  showToast('Invite link copied! Share with friends.', 'success');
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

// --- 6. SYNCHRONIZATION & DRIFT ENGINE ---
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
      onStateChange: (event) => {
        if (event.data === YT.PlayerState.PLAYING) {
          try {
            if (!isMuted) {
              ytPlayer.unMute();
              ytPlayer.setVolume(currentVolume);
            }
          } catch (e) {}
          showAudioPrompt(false);
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
    // Server timeline drives the UI, independent of the YouTube iframe
    let effectiveTime = calculateServerPosition();
    const roomPlaying = currentRoom.playback.isPlaying;

    if (ytReady && ytPlayer) {
      try {
        const state = ytPlayer.getPlayerState();
        const local = ytPlayer.getCurrentTime() || 0;
        const isActive = state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING;

        if (roomPlaying) {
          if (state === YT.PlayerState.PLAYING) {
            if (Math.abs(local - effectiveTime) > 1.25) ytPlayer.seekTo(effectiveTime, true);
          } else if (!isActive && Date.now() - lastPlayKick > 3000) {
            lastPlayKick = Date.now();
            ytPlayer.playVideo();
          }

          // Autoplay blocked? Offer a one-tap fix
          if (!isActive) {
            if (!notPlayingSince) notPlayingSince = Date.now();
            else if (Date.now() - notPlayingSince > 2000) showAudioPrompt(true);
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
  };

  syncInterval = setInterval(runSyncTick, 400);

  // Background tab optimization: reduce wakeups & battery drain when phone is locked or tab is hidden
  if (!window._visibilityListenerAttached) {
    window._visibilityListenerAttached = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (syncInterval) clearInterval(syncInterval);
        // Run slow 2.5s drift checks in background
        syncInterval = setInterval(runSyncTick, 2500);
      } else {
        if (syncInterval) clearInterval(syncInterval);
        runSyncTick(); // Immediate sync on foregrounding
        syncInterval = setInterval(runSyncTick, 400);
      }
    });
  }
}

function calculateServerPosition() {
  if (!currentRoom?.playback) return 0;
  if (!currentRoom.playback.isPlaying) return currentRoom.playback.positionSec;

  // Use server-aligned clock so guests with a skewed device clock stay in sync
  const elapsed = Math.max(0, (Date.now() + clockOffset - currentRoom.playback.serverTime) / 1000);
  return currentRoom.playback.positionSec + elapsed;
}

// Load the room's current track into the YT player (once per track id)
function loadCurrentTrack(room) {
  if (!ytReady || !ytPlayer || !room?.currentTrack) return;
  const trackId = room.currentTrack.id;
  if (loadedTrackId === trackId) return;
  loadedTrackId = trackId;

  try {
    const startSec = calculateServerPosition();
    ytPlayer.loadVideoById({ videoId: trackId, startSeconds: startSec });
    setTimeout(() => {
      // Re-assert room state and restore volume
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
  } catch (e) {
    console.warn(e);
    loadedTrackId = null;
  }
}

// "Tap to enable audio" pill shown when the browser blocks autoplay
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
    el.textContent = '🔊 Tap to enable audio';
    el.style.cssText = 'position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 9000; height: 44px; padding: 0 20px; border-radius: 999px; border: 0; background: var(--lime); color: #0A0A0D; font-weight: 700; font-size: 14px; box-shadow: 0 0 24px rgba(200,255,61,0.5); cursor: pointer';
    el.addEventListener('click', () => {
      try {
        ytPlayer.unMute();
        ytPlayer.seekTo(calculateServerPosition(), true);
        ytPlayer.playVideo();
      } catch (e) {}
      notPlayingSince = 0;
      el.style.display = 'none';
    });
    document.body.appendChild(el);
  }
  el.style.display = 'block';
}

// Any first user gesture can unlock playback and un-mute if the room is playing
const unlockAudioOnGesture = () => {
  if (!ytReady || !ytPlayer) return;
  try {
    if (!isMuted) {
      ytPlayer.unMute();
      ytPlayer.setVolume(currentVolume);
    }
    if (currentRoom?.currentTrack && currentRoom.playback?.isPlaying) {
      const state = ytPlayer.getPlayerState();
      if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) {
        ytPlayer.seekTo(calculateServerPosition(), true);
        ytPlayer.playVideo();
      }
    }
  } catch (e) {}
};
document.addEventListener('pointerdown', unlockAudioOnGesture, { passive: true });
document.addEventListener('keydown', unlockAudioOnGesture, { passive: true });

function applyRoomPlayback(playback) {
  if (!playback) return;

  // Update UI icons first regardless of iframe ready status
  if (playback.isPlaying) {
    playIcon?.classList.add('hidden');
    pauseIcon?.classList.remove('hidden');
    playerStatusBadge.textContent = 'NOW PLAYING';
  } else {
    playIcon?.classList.remove('hidden');
    pauseIcon?.classList.add('hidden');
    playerStatusBadge.textContent = 'PAUSED';
  }

  if (!ytReady || !ytPlayer) return;
  const serverPos = calculateServerPosition();

  try {
    if (playback.isPlaying) {
      const state = typeof ytPlayer.getPlayerState === 'function' ? ytPlayer.getPlayerState() : -1;
      if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) {
        ytPlayer.seekTo(serverPos, true);
        const playPromise = ytPlayer.playVideo();
        // If playVideo returns a promise, catch unhandled autoplay rejections
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch((e) => console.warn('Autoplay blocked:', e));
        }
      } else {
        const drift = Math.abs(ytPlayer.getCurrentTime() - serverPos);
        if (drift > 1.25) {
          ytPlayer.seekTo(serverPos, true);
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
  if (!currentRoom?.currentTrack) {
    showToast('Search a song below to start playing!', 'info');
    return;
  }
  const isPlaying = currentRoom.playback.isPlaying;
  let currentPos = currentRoom.playback.positionSec;
  try {
    if (ytReady && ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
      const t = ytPlayer.getCurrentTime();
      if (typeof t === 'number' && !isNaN(t) && t > 0) currentPos = t;
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
    if (data && ytReady && ytPlayer) {
      updateClockOffset(data.serverTime);
      currentRoom.playback = data;
      loadCurrentTrack(currentRoom);
      ytPlayer.seekTo(data.positionSec, true);
      if (data.isPlaying) ytPlayer.playVideo();
      showToast('Resynchronized with host!', 'success');
    }
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
  }, 180);
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
    return `
      <div class="row">
        <button type="button" onclick="handlePlayNow('${songEncoded}')" class="art" style="border: 0; padding: 0; cursor: pointer; position: relative; overflow: hidden; background: url('${song.thumbnail}') center/cover" title="Play Now">
          <div style="position: absolute; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.15s" onmouseenter="this.style.opacity=1" onmouseleave="this.style.opacity=0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--lime)"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </button>
        <div style="flex: 1; min-width: 0; cursor: pointer" onclick="handlePlayNow('${songEncoded}')">
          <div class="t">${escapeHtml(song.cleanTitle || song.title)}</div>
          <div class="s">${escapeHtml(song.artist)}</div>
        </div>
        <span class="mono">${song.duration}</span>
        <button type="button" class="ghost" onclick="handleQueueSong('${songEncoded}', false)" style="height: 36px; padding: 0 16px; border-radius: 999px; border: 1px solid var(--border-outline); background: transparent; color: var(--text-main); font-size: 13px; font-weight: 600">
          + Queue
        </button>
      </div>
    `;
  }).join('');
}

// Quick Trending & Chip Search Listeners
document.querySelectorAll('.sample-chip, .quick-search-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const q = btn.dataset.query;
    if (inlineSearchInput && q) {
      inlineSearchInput.value = q;
      inlineSearchInput.dispatchEvent(new Event('input'));
    }
  });
});

window.handlePlayNow = (songEncodedStr) => {
  try {
    const song = JSON.parse(decodeURIComponent(songEncodedStr));
    socket.emit('play-now', { track: song });
  } catch (e) {
    console.error(e);
  }
};

window.handleQueueSong = (songEncodedStr, playNext) => {
  try {
    const song = JSON.parse(decodeURIComponent(songEncodedStr));
    socket.emit('add-to-queue', { track: song, playNext });
    showToast(`Added "${song.title.slice(0, 28)}..." to queue`, 'success');
  } catch (e) {
    console.error(e);
  }
};

// Global Shortcut: / or Ctrl+K to search
window.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== inlineSearchInput && document.activeElement !== chatInput) {
    e.preventDefault();
    inlineSearchInput?.focus();
    inlineSearchInput?.select();
  }
});

// --- 9. REACTIONS & COUNTER BADGES ---
document.querySelectorAll('.reaction-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
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

  // Post reaction notice into chat
  appendReactionChat(data.username, data.emoji);
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

// --- 12. UI STATE RENDERING ---
function renderRoomState(room) {
  if (!room) return;

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

    // Dynamic Ambient Backdrop from Album Color
    if (heroBanner) {
      heroBanner.style.background = `
        linear-gradient(180deg, rgba(0,0,0,0.0), #0A0A0D 98%),
        radial-gradient(700px 420px at 20% 30%, rgba(200,255,61,0.32), transparent 65%),
        radial-gradient(700px 480px at 85% 10%, rgba(255,90,78,0.32), transparent 65%),
        #14141A
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
    if (ytReady && ytPlayer && typeof ytPlayer.stopVideo === 'function') {
      try { ytPlayer.stopVideo(); } catch (e) {}
    }
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
  const bgBorder = type === 'success' ? 'border: 1px solid var(--lime); color: var(--lime)' : 'border: 1px solid var(--border-outline); color: var(--text-main)';
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
