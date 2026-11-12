// Frontend Client Orchestrator with Sub-second Drift Correction
const socket = io({
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionDelay: 800,
  reconnectionDelayMax: 8000,
  randomizationFactor: 0.5,
  reconnectionAttempts: 50
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

// High-resolution Click-to-Sound Stopwatch Tracker
let clickStopwatch = {
  active: false,
  trackId: null,
  trackTitle: '',
  t0: 0,
  tWsSent: 0,
  tRoomState: 0,
  tEngineLoad: 0,
  tMetadata: 0,
  tCanPlay: 0,
  tPlaying: 0,
  engine: ''
};

function startClickStopwatch(song) {
  clickStopwatch = {
    active: true,
    trackId: song?.id,
    trackTitle: song?.title || 'Unknown',
    t0: performance.now(),
    tWsSent: performance.now(),
    tRoomState: 0,
    tEngineLoad: 0,
    tMetadata: 0,
    tCanPlay: 0,
    tPlaying: 0,
    engine: ''
  };
  console.log(`⏱️ [STOPWATCH START] Clicked "${song?.title}" at t=0ms`);
}

function recordStopwatchStep(step, detail = '') {
  if (!clickStopwatch.active) return;
  const elapsed = (performance.now() - clickStopwatch.t0).toFixed(0);
  console.log(`⏱️ [STOPWATCH +${elapsed}ms] ${step} ${detail}`);

  if (step === 'ROOM-STATE' && !clickStopwatch.tRoomState) {
    clickStopwatch.tRoomState = performance.now();
  } else if (step === 'ENGINE-LOAD' && !clickStopwatch.tEngineLoad) {
    clickStopwatch.tEngineLoad = performance.now();
    clickStopwatch.engine = detail;
  } else if (step === 'METADATA' && !clickStopwatch.tMetadata) {
    clickStopwatch.tMetadata = performance.now();
  } else if (step === 'CANPLAY' && !clickStopwatch.tCanPlay) {
    clickStopwatch.tCanPlay = performance.now();
  } else if ((step === 'PLAYING' || step === 'AUDIBLE') && !clickStopwatch.tPlaying) {
    clickStopwatch.tPlaying = performance.now();
    clickStopwatch.active = false;
    const totalMs = (clickStopwatch.tPlaying - clickStopwatch.t0).toFixed(0);
    const wsMs = clickStopwatch.tRoomState ? (clickStopwatch.tRoomState - clickStopwatch.t0).toFixed(0) : '?';
    const metaMs = clickStopwatch.tMetadata && clickStopwatch.tEngineLoad ? (clickStopwatch.tMetadata - clickStopwatch.tEngineLoad).toFixed(0) : '?';
    const bufferMs = clickStopwatch.tPlaying && clickStopwatch.tMetadata ? (clickStopwatch.tPlaying - clickStopwatch.tMetadata).toFixed(0) : '?';
    
    console.log(
      `%c🚀 [CLICK-TO-SOUND COMPLETE] Total: ${totalMs}ms | Engine: ${clickStopwatch.engine} | WS Roundtrip: ${wsMs}ms | Stream Metadata: ${metaMs}ms | Audio Buffer/Decode: ${bufferMs}ms`,
      'background: #111; color: #C8FF3D; font-weight: bold; font-size: 13px; padding: 4px 8px; border-radius: 4px; border: 1px solid #C8FF3D;'
    );
  }
}

// Playback sync state
let clockOffset = 0;            // serverNow = Date.now() + clockOffset
let loadedTrackId = null;       // track id currently loaded in the YT player
let lastPlaybackKey = '';       // trackId:isPlaying last applied from room-state
let lastPlayKick = 0;           // throttle for retrying playVideo()
let notPlayingSince = 0;        // when the player first failed to play while room is playing
let localPauseIntentUntil = 0;  // ignore OS/browser pause-then-resume blips right after a user pause
const failedEnginesByTrack = new Map(); // trackId -> Set('audio'|'yt') for fallback logic

let clockSynced = false;         // true once a measured (RTT-compensated) offset exists
let lastRtt = 0;                 // RTT of the best clock-sync sample (debug)

// Rough one-sample offset. Only used until the measured sync below completes,
// because a single message sample ignores network latency and is very jittery.
// Clock offset tracker with exponential moving average drift correction
function updateClockOffset(serverTime) {
  if (typeof serverTime !== 'number' || isNaN(serverTime)) return;
  const rawOffset = serverTime - Date.now();
  if (!clockSynced) {
    clockOffset = rawOffset;
  } else {
    // Continuous gentle EWMA adjustment (weight 0.05) to correct long-term drift without phase jumps
    clockOffset = clockOffset * 0.95 + rawOffset * 0.05;
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

// --- Socket Reconnection & Connection Lifecycle Management ---
let reconnectBanner = null;

function ensureReconnectBanner() {
  if (!reconnectBanner) {
    reconnectBanner = document.createElement('div');
    reconnectBanner.id = 'reconnect-banner';
    reconnectBanner.className = 'reconnect-banner hidden';
    reconnectBanner.innerHTML = `
      <span class="reconnect-spinner"></span>
      <span id="reconnect-status-text">Connection lost. Reconnecting...</span>
    `;
    document.body.appendChild(reconnectBanner);
  }
  return reconnectBanner;
}

function showReconnectBanner(text) {
  const banner = ensureReconnectBanner();
  const textEl = document.getElementById('reconnect-status-text');
  if (textEl && text) textEl.textContent = text;
  banner.classList.remove('hidden');
}

function hideReconnectBanner() {
  if (reconnectBanner) {
    reconnectBanner.classList.add('hidden');
  }
}

socket.on('disconnect', (reason) => {
  console.warn('[socket] Disconnected:', reason);
  showReconnectBanner('Connection lost. Reconnecting...');
  if (reason === 'io server disconnect') {
    socket.connect();
  }
});

socket.on('connect_error', (err) => {
  console.warn('[socket] Connect error:', err?.message || err);
  showReconnectBanner('Network unreachable. Retrying connection...');
});

socket.on('reconnect_attempt', (attempt) => {
  showReconnectBanner(`Reconnecting to room... (attempt ${attempt})`);
});

socket.on('reconnect_failed', () => {
  showReconnectBanner('Unable to reconnect. Click here to retry.');
  if (reconnectBanner) {
    reconnectBanner.onclick = () => {
      socket.connect();
      showReconnectBanner('Retrying connection...');
    };
  }
});

socket.on('connect', () => {
  console.log('[socket] Connected to server');
  hideReconnectBanner();
  syncClock();

  // If client was inside an active room, automatically re-join with same identity
  const activeRoomId = currentRoom?.id || localStorage.getItem('jamlock_current_room');
  const savedUser = currentUser?.username || localStorage.getItem('jamlock_username');
  if (activeRoomId && savedUser) {
    const clientId = getBrowserClientId();
    socket.emit('join-room', { roomId: activeRoomId, username: savedUser, clientId, isCreating: false }, (res) => {
      document.documentElement.classList.remove('in-room-loading');
      if (res?.success) {
        currentUser = res.user;
        currentRoom = res.room;
        if (res.room) {
          renderRoomState(res.room);
          startSyncEngine();
        }
      } else if (res?.error && res.error.includes('does not exist')) {
        showToast('Room has ended or expired.', 'info');
        leaveRoom();
      }
    });
  } else {
    document.documentElement.classList.remove('in-room-loading');
  }
});
setInterval(syncClock, 30000);

// Global failsafe watchdog: never allow html.in-room-loading to stay stuck on screen
setTimeout(() => {
  document.documentElement.classList.remove('in-room-loading');
}, 2500);

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
const renderedChatIds = new Set();
let lastRenderedChatRoomId = null;

// Settings & Leave Modals DOM
const hostSettingsBtn = document.getElementById('host-settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsModalBtn = document.getElementById('close-settings-modal-btn');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const settingDjMode = document.getElementById('setting-dj-mode');
const settingQueueMode = document.getElementById('setting-queue-mode');
const settingTheme = document.getElementById('setting-theme');
const settingRoomPin = document.getElementById('setting-room-pin');
const settingRoomPinRemove = document.getElementById('setting-room-pin-remove');
const roomPinRemoveRow = document.getElementById('room-pin-remove-row');
const roomPinStatus = document.getElementById('room-pin-status');
const leaveConfirmModal = document.getElementById('leave-confirm-modal');
const cancelLeaveBtn = document.getElementById('cancel-leave-btn');
const confirmLeaveBtn = document.getElementById('confirm-leave-btn');

// Keyboard accessibility for dialogs: trap Tab inside the open modal and close on Escape.
function installModalA11y(modal, onClose) {
  if (!modal) return;
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = Array.from(modal.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((el) => el.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const focusOutside = !modal.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || focusOutside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || focusOutside)) {
      e.preventDefault();
      first.focus();
    }
  });
}

installModalA11y(settingsModal, () => {
  closeAllCustomDropdowns();
  settingsModal?.classList.add('hidden');
  hostSettingsBtn?.focus();
});

installModalA11y(leaveConfirmModal, () => {
  leaveConfirmModal?.classList.add('hidden');
  leaveRoomBtn?.focus();
});

// --- 1. DYNAMIC WAVY PROGRESS BAR SETUP (Unified PC & Mobile) ---
const wavyContainer = document.getElementById('wavy-progress-container');
const waveBasePath = document.getElementById('wave-base-path');
const waveActivePath = document.getElementById('wave-active-path');
const waveClipRect = document.getElementById('wave-clip-rect');
const wavyKnob = document.getElementById('wavy-scrubber-knob');
const wavyMarkersLayer = document.getElementById('wavy-reaction-markers');
const skipVotePill = document.getElementById('skip-vote-pill');

let isScrubbingWave = false;
let currentMarkersTrackId = null;

// Dynamic Vibe Meter (Ambient Room Rave Glow)
const recentReactionTimestamps = [];
let vibeDecayTimer = null;

function bumpVibeEnergy() {
  const now = Date.now();
  recentReactionTimestamps.push(now);
  while (recentReactionTimestamps.length > 0 && recentReactionTimestamps[0] < now - 4500) {
    recentReactionTimestamps.shift();
  }

  const count = recentReactionTimestamps.length;
  if (ambientGlow) {
    if (count >= 5) {
      ambientGlow.classList.remove('vibe-warm');
      ambientGlow.classList.add('vibe-hot');
    } else if (count >= 2) {
      ambientGlow.classList.add('vibe-warm');
      ambientGlow.classList.remove('vibe-hot');
    }
  }

  clearTimeout(vibeDecayTimer);
  vibeDecayTimer = setTimeout(() => {
    if (ambientGlow) {
      ambientGlow.classList.remove('vibe-warm', 'vibe-hot');
    }
    recentReactionTimestamps.length = 0;
  }, 4000);
}

function renderWaveReactionMarkers(reactions) {
  if (!wavyMarkersLayer) return;
  wavyMarkersLayer.innerHTML = '';
  if (!reactions || !Array.isArray(reactions) || reactions.length === 0) return;

  const duration = currentRoom?.currentTrack?.durationSeconds || 1;
  reactions.forEach((rx) => {
    addWaveReactionMarker(rx, duration, false);
  });
}

function addWaveReactionMarker(rx, durationSec, animate = true) {
  if (!wavyMarkersLayer) return;
  const dur = durationSec || currentRoom?.currentTrack?.durationSeconds || 1;
  const pct = Math.max(0, Math.min(100, (rx.positionSec / dur) * 100));

  const pin = document.createElement('span');
  pin.className = 'wave-marker-pin';
  pin.dataset.pct = pct.toFixed(2);
  pin.style.left = `${pct}%`;
  pin.textContent = rx.emoji || '🔥';
  pin.title = `${rx.username || 'Listener'} at ${formatTime(rx.positionSec)}`;

  if (animate) {
    pin.classList.add('pulse');
    setTimeout(() => pin.classList.remove('pulse'), 700);
  }

  wavyMarkersLayer.appendChild(pin);
  // Cap visible markers at 60 to prevent DOM clutter
  if (wavyMarkersLayer.children.length > 60) {
    wavyMarkersLayer.removeChild(wavyMarkersLayer.firstChild);
  }
}

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
  // Optimistically updates the UI while dragging; emits a single network 'seek' on release
  let pendingSeekSec = null;
  const updateScrubUI = (e) => {
    if (!currentRoom?.currentTrack) return;
    const rect = wavyContainer.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clickX = clientX - rect.left;
    const pct = Math.max(0, Math.min(1, clickX / rect.width));
    pendingSeekSec = pct * (currentRoom.currentTrack.durationSeconds || 100);
    updateWaveformProgress(pct * 100);
    if (currentTimeDisplay) currentTimeDisplay.textContent = formatTime(pendingSeekSec);
  };

  const commitSeek = () => {
    if (pendingSeekSec != null) {
      socket.emit('seek', { positionSec: pendingSeekSec });
      pendingSeekSec = null;
    }
  };

  wavyContainer.addEventListener('mousedown', (e) => {
    isScrubbingWave = true;
    isSeeking = true;
    wavyContainer.classList.add('is-dragging');
    updateScrubUI(e);
  });

  window.addEventListener('mousemove', (e) => {
    if (isScrubbingWave) {
      updateScrubUI(e);
    }
  });

  window.addEventListener('mouseup', () => {
    if (isScrubbingWave) {
      isScrubbingWave = false;
      isSeeking = false;
      wavyContainer.classList.remove('is-dragging');
      commitSeek();
    }
  });

  // Touch support for Mobile
  wavyContainer.addEventListener('touchstart', (e) => {
    isScrubbingWave = true;
    isSeeking = true;
    wavyContainer.classList.add('is-dragging');
    updateScrubUI(e);
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (isScrubbingWave && e.touches) {
      updateScrubUI(e);
    }
  }, { passive: true });

  window.addEventListener('touchend', () => {
    if (isScrubbingWave) {
      isScrubbingWave = false;
      isSeeking = false;
      wavyContainer.classList.remove('is-dragging');
      commitSeek();
    }
  });
}
initWavyBar();

let lastRenderedPct = -1;
function updateWaveformProgress(progressPercent) {
  const boundedPct = Math.max(0, Math.min(100, progressPercent));

  // Skip redundant DOM/SVG mutations if percentage delta is negligible (<0.15%)
  if (Math.abs(boundedPct - lastRenderedPct) < 0.15 && boundedPct !== 0 && boundedPct !== 100) {
    return;
  }
  lastRenderedPct = boundedPct;

  // Update SVG clip width (0 to 1000 in viewBox space)
  if (waveClipRect) {
    waveClipRect.setAttribute('width', (boundedPct * 10).toString());
  }

  // Update Scrubber Knob position (0% to 100%)
  if (wavyKnob) {
    wavyKnob.style.left = `${boundedPct}%`;
  }

  // Micro-pulse on reaction markers as scrubber glides past them
  if (wavyMarkersLayer) {
    const pins = wavyMarkersLayer.querySelectorAll('.wave-marker-pin');
    pins.forEach((pin) => {
      const pinPct = parseFloat(pin.dataset.pct || 0);
      if (Math.abs(pinPct - boundedPct) < 1.4) {
        if (!pin.classList.contains('pulse')) {
          pin.classList.add('pulse');
          setTimeout(() => pin.classList.remove('pulse'), 600);
        }
      }
    });
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
const isMobileClient = /mobile|android|iphone|ipad|ipod/i.test(navigator.userAgent);
let iosVolumeHintShown = false;
try { iosVolumeHintShown = sessionStorage.getItem('jamlock_ios_volume_hint') === '1'; } catch (e) {}
// Default engine: On desktop cloud, YouTube direct iframe is 100% reliable without proxy stalls.
// On mobile devices, default to native <audio> so background playback and lock-screen controls work without OS suspension.
const isCloudHosted = window.location.hostname.includes('render.com') || window.location.hostname.includes('koyeb') || window.location.hostname.includes('railway');
let activeEngine = (isCloudHosted && !isMobileClient) ? 'yt' : 'audio'; // 'audio' (native HTML5 <audio>) | 'yt' (YouTube IFrame)
let currentVolume = parseInt(localStorage.getItem('jamlock_volume') || localStorage.getItem('beatsync_volume') || '100', 10);
if (!Number.isFinite(currentVolume)) currentVolume = 100;
currentVolume = Math.max(0, Math.min(100, currentVolume));
let isMuted = localStorage.getItem('jamlock_muted') === '1';

if (nativeAudio) {
  nativeAudio.volume = Math.max(0, Math.min(1, currentVolume / 100));
  nativeAudio.muted = isMuted;
}

if (volumeSlider) {
  volumeSlider.value = currentVolume;
  volumeSlider.addEventListener('input', (e) => {
    currentVolume = parseInt(e.target.value, 10);
    localStorage.setItem('jamlock_volume', currentVolume);
    isMuted = false;
    try { localStorage.setItem('jamlock_muted', '0'); } catch (e) {}
    updateVolumeUI();
    if (nativeAudio) {
      nativeAudio.muted = false;
      nativeAudio.volume = Math.max(0, Math.min(1, currentVolume / 100));
    }
    if (ytReady && ytPlayer && typeof ytPlayer.setVolume === 'function') {
      ytPlayer.unMute();
      ytPlayer.setVolume(currentVolume);
    }
    if (isIOS && !iosVolumeHintShown) {
      iosVolumeHintShown = true;
      try { sessionStorage.setItem('jamlock_ios_volume_hint', '1'); } catch (e) {}
      showToast('On iPhone/iPad, use the hardware volume buttons — Safari does not expose system volume.', 'info');
    }
  });
}

if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    try { localStorage.setItem('jamlock_muted', isMuted ? '1' : '0'); } catch (e) {}
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
try {
  autoSuggestEnabled = localStorage.getItem('jamlock_autosuggest') !== '0';
} catch (e) {}

if (autoSuggestSwitchBtn) {
  autoSuggestSwitchBtn.setAttribute('aria-checked', autoSuggestEnabled ? 'true' : 'false');
  autoSuggestSwitchBtn.addEventListener('click', () => {
    if (!currentUser?.isHost) {
      showToast('Only the room host can change auto-suggest', 'info');
      return;
    }
    autoSuggestEnabled = !autoSuggestEnabled;
    syncAutoSuggestUI(autoSuggestEnabled);
    socket.emit('toggle-auto-suggest', { enabled: autoSuggestEnabled });
  });
}

function syncAutoSuggestUI(enabled) {
  autoSuggestEnabled = Boolean(enabled);
  try {
    localStorage.setItem('jamlock_autosuggest', autoSuggestEnabled ? '1' : '0');
  } catch (e) {}
  if (!autoSuggestSwitchBtn) return;
  autoSuggestSwitchBtn.setAttribute('aria-checked', autoSuggestEnabled ? 'true' : 'false');
  const canToggle = Boolean(currentUser?.isHost);
  autoSuggestSwitchBtn.disabled = !canToggle;
  autoSuggestSwitchBtn.setAttribute('aria-disabled', canToggle ? 'false' : 'true');
  autoSuggestSwitchBtn.title = canToggle ? 'Toggle auto-suggest' : 'Only the host can change auto-suggest';
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
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const isCleanPath = pathParts[0] === 'r' && pathParts[1];
  const roomFromPath = isCleanPath ? pathParts[1] : null;
  const roomParam = urlParams.get('room') || roomFromPath;
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

  if (roomParam && joinCodeInput) {
    joinCodeInput.value = roomParam.toUpperCase();
  } else if (joinCodeInput) {
    joinCodeInput.value = '';
  }

  if (targetRoom) {
    const cleanRoomCode = targetRoom.toUpperCase();

    // Pre-flight check: ensure room exists before asking for username or attempting to join
    fetch(`/api/room/${cleanRoomCode}`)
      .then((res) => {
        if (!res.ok) throw new Error('Room not found');
        return res.json();
      })
      .then(() => {
        if (savedName) {
          joinRoom(cleanRoomCode, savedName);
        } else {
          document.documentElement.classList.remove('in-room-loading');
          if (roomParam && quickJoinModal) {
            if (quickJoinRoomCode) quickJoinRoomCode.textContent = cleanRoomCode;
            if (quickJoinUsername) quickJoinUsername.value = getRandomNickname();
            quickJoinModal.classList.remove('hidden');
            quickJoinModal.style.display = 'flex';
            setTimeout(() => {
              quickJoinUsername?.focus();
              quickJoinUsername?.select();
            }, 150);

            quickJoinForm?.addEventListener('submit', (ev) => {
              ev.preventDefault();
              primeNativeAudioForMobile();
              const chosenName = quickJoinUsername?.value.trim() || getRandomNickname();
              localStorage.setItem('jamlock_username', chosenName);
              if (usernameInput) usernameInput.value = chosenName;
              quickJoinModal.classList.add('hidden');
              quickJoinModal.style.display = 'none';
              joinRoom(cleanRoomCode, chosenName);
            });
          } else {
            usernameInput?.focus();
            showToast(`Enter your display name to enter room ${cleanRoomCode}`, 'info');
          }
        }
      })
      .catch(() => {
        // Room does not exist or has expired
        document.documentElement.classList.remove('in-room-loading');
        localStorage.removeItem('jamlock_current_room');
        localStorage.removeItem('beatsync_current_room');
        if (window.location.pathname.startsWith('/r/')) {
          window.history.replaceState({}, '', '/');
        }
        showToast(`Room "${cleanRoomCode}" has ended or does not exist.`, 'info');
      });
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

// Synchronously prime and unlock the native <audio> element during a direct user tap
// so iOS Safari and Android Chrome grant background audio & MediaSession permissions
let nativeAudioPrimed = false;
const SILENT_WAV_DATA_URI = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

function primeNativeAudioForMobile() {
  if (!nativeAudio || nativeAudioPrimed) return;
  try {
    const hasRealTrack = nativeAudio.src && nativeAudio.src.includes('/api/audio/');
    if (!hasRealTrack) {
      nativeAudio.src = SILENT_WAV_DATA_URI;
      const p = nativeAudio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          nativeAudioPrimed = true;
          // Only pause the silent primer if a real track hasn't replaced it in the meantime
          if (nativeAudio.src === SILENT_WAV_DATA_URI) {
            nativeAudio.pause();
          }
        }).catch(() => {});
      } else {
        nativeAudioPrimed = true;
      }
    } else {
      nativeAudioPrimed = true;
    }
  } catch (e) {}
}

createRoomBtn?.addEventListener('click', () => {
  const username = requireValidUsername();
  if (!username) return;
  primeNativeAudioForMobile();
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
  primeNativeAudioForMobile();
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

function joinRoom(roomId, explicitUsername, isCreating = false, pin = null) {
  const username = explicitUsername || usernameInput?.value.trim();
  if (!username) {
    requireValidUsername();
    return;
  }
  localStorage.setItem('jamlock_username', username);

  const clientId = getBrowserClientId();

  socket.emit('join-room', { roomId, username, clientId, isCreating, pin }, (response) => {
    if (response?.success) {
      currentUser = response.user;
      currentRoom = response.room;
      updateClockOffset(response.room?.playback?.serverTime ?? response.serverTime);

      localStorage.setItem('jamlock_current_room', roomId);
      window.history.pushState({}, '', `/r/${roomId}`);

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
      if (response.code === 'name_taken' || response.error?.toLowerCase().includes('already taken')) {
        showToast(response.error, 'error');
        if (response.suggestion) {
          if (usernameInput) usernameInput.value = response.suggestion;
          if (quickJoinUsername) quickJoinUsername.value = response.suggestion;
          localStorage.setItem('jamlock_username', response.suggestion);
          showToast(`Suggested: "${response.suggestion}". Click join to confirm.`, 'info');
        }
        return;
      }
      if (response.error.toLowerCase().includes('pin')) {
        const userPin = prompt('This room is private. Please enter the room PIN:');
        if (userPin) {
          joinRoom(roomId, username, isCreating, userPin.trim());
          return;
        }
      }
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
  cancelLeaveBtn?.focus();
});

cancelLeaveBtn?.addEventListener('click', () => {
  leaveConfirmModal?.classList.add('hidden');
  leaveRoomBtn?.focus();
});

// Unified leave room handler (used by confirm button, kick event, and room-not-found)
function leaveRoom() {
  try {
    socket.emit('leave-room');
  } catch (e) {}
  localStorage.removeItem('jamlock_current_room');
  localStorage.removeItem('beatsync_current_room');
  document.documentElement.classList.remove('in-room-loading');
  document.body.classList.remove('in-room-mode');
  currentRoom = null;
  if (typeof renderedChatIds !== 'undefined') renderedChatIds.clear();
  if (chatMessages) chatMessages.innerHTML = '';
  // Clean URL history to root so reloading or back button never re-joins
  window.history.replaceState({}, '', '/');
  window.location.href = window.location.origin + '/';
}
window.leaveRoom = leaveRoom;

confirmLeaveBtn?.addEventListener('click', () => {
  leaveRoom();
});

// Instant departure notification if user closes or navigates away
window.addEventListener('beforeunload', () => {
  if (currentRoom) {
    try {
      socket.emit('leave-room');
    } catch (e) {}
  }
});

// Mobile Safari/Chrome support: pagehide fires reliably on mobile navigation or tab close
// Note: only emit leave-room if the page is being permanently discarded, not frozen in bfcache / app-switching
window.addEventListener('pagehide', (e) => {
  if (currentRoom && !e.persisted) {
    try {
      socket.emit('leave-room');
    } catch (e) {}
  }
});

copyRoomLinkBtn?.addEventListener('click', async () => {
  const roomCode = currentRoom?.id || '';
  const cleanUrl = `${window.location.origin}/r/${roomCode}`;
  const shareData = {
    title: 'JamLock — Listen Together',
    text: `Join my live music room (${roomCode})!`,
    url: cleanUrl
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
    await navigator.clipboard.writeText(cleanUrl);
    showToast('Invite link copied to clipboard! 📋', 'success');
  } catch (err) {
    showToast('Failed to copy link', 'error');
  }
});

// --- 5. HOST SETTINGS & CUSTOM PILL DROPDOWNS ---
function syncCustomDropdown(wrapId, value) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  const input = wrap.querySelector('input[type="hidden"]');
  const label = wrap.querySelector('.custom-dropdown-label');
  const options = wrap.querySelectorAll('.custom-dropdown-option');

  if (input) input.value = value;

  options.forEach((opt) => {
    const isMatch = opt.getAttribute('data-value') === value;
    opt.classList.toggle('is-selected', isMatch);
    opt.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    if (isMatch && label) {
      const optText = opt.querySelector('.option-text')?.textContent || opt.textContent;
      label.textContent = optText.trim();
    }
  });
}

function closeAllCustomDropdowns() {
  document.querySelectorAll('.custom-dropdown-wrap.is-open').forEach((w) => {
    w.classList.remove('is-open');
    w.querySelector('.custom-dropdown-pill')?.setAttribute('aria-expanded', 'false');
  });
}

function initCustomDropdowns() {
  const wraps = document.querySelectorAll('.custom-dropdown-wrap');
  wraps.forEach((wrap) => {
    const pill = wrap.querySelector('.custom-dropdown-pill');
    const input = wrap.querySelector('input[type="hidden"]');
    const label = wrap.querySelector('.custom-dropdown-label');
    const options = wrap.querySelectorAll('.custom-dropdown-option');

    pill?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = wrap.classList.contains('is-open');
      closeAllCustomDropdowns();
      if (!isOpen) {
        wrap.classList.add('is-open');
        pill.setAttribute('aria-expanded', 'true');
      }
    });

    // Keyboard: ArrowDown opens the menu and moves focus to the selected option.
    pill?.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown') return;
      e.preventDefault();
      e.stopPropagation();
      wrap.classList.add('is-open');
      pill.setAttribute('aria-expanded', 'true');
      const selected = wrap.querySelector('.custom-dropdown-option.is-selected') || options[0];
      selected?.focus();
    });

    options.forEach((opt, index) => {
      opt.tabIndex = 0;
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', opt.classList.contains('is-selected') ? 'true' : 'false');

      const chooseOption = () => {
        const val = opt.getAttribute('data-value');
        if (input) input.value = val;
        const text = opt.querySelector('.option-text')?.textContent || opt.textContent;
        if (label) label.textContent = text.trim();

        options.forEach((o) => {
          const selected = o === opt;
          o.classList.toggle('is-selected', selected);
          o.setAttribute('aria-selected', selected ? 'true' : 'false');
        });
        wrap.classList.remove('is-open');
        pill?.setAttribute('aria-expanded', 'false');
        pill?.focus();
      };

      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        chooseOption();
      });

      opt.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          chooseOption();
          return;
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault();
        const list = Array.from(options);
        let nextIndex = index;
        if (e.key === 'ArrowDown') nextIndex = (index + 1) % list.length;
        else if (e.key === 'ArrowUp') nextIndex = (index - 1 + list.length) % list.length;
        else if (e.key === 'Home') nextIndex = 0;
        else if (e.key === 'End') nextIndex = list.length - 1;
        list[nextIndex]?.focus();
      });
    });
  });

  // Close when tapping/clicking anywhere outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-dropdown-wrap')) {
      closeAllCustomDropdowns();
    }
  });

  // Close when pressing Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllCustomDropdowns();
    }
  });
}

// Initialize custom pill dropdowns immediately
initCustomDropdowns();

hostSettingsBtn?.addEventListener('click', () => {
  if (currentRoom?.settings) {
    const djVal = currentRoom.settings.djMode || 'anyone';
    const queueVal = currentRoom.settings.queueMode || 'anyone';
    const themeVal = currentRoom.settings.theme || 'electric';
    const hasPin = Boolean(currentRoom.settings.hasPin);

    if (settingDjMode) settingDjMode.value = djVal;
    if (settingQueueMode) settingQueueMode.value = queueVal;
    if (settingTheme) settingTheme.value = themeVal;
    if (settingRoomPin) {
      settingRoomPin.value = '';
      settingRoomPin.disabled = false;
      settingRoomPin.placeholder = hasPin ? 'Enter a new PIN to replace it' : 'Optional: 4–8 digits';
    }
    if (settingRoomPinRemove) {
      settingRoomPinRemove.checked = false;
      settingRoomPinRemove.disabled = false;
    }
    roomPinRemoveRow?.classList.toggle('hidden', !hasPin);
    if (roomPinStatus) {
      roomPinStatus.textContent = hasPin
        ? 'This room currently requires a PIN. Leave the field blank to keep it.'
        : 'No PIN set — anyone with the room code can join.';
    }

    syncCustomDropdown('wrap-setting-dj-mode', djVal);
    syncCustomDropdown('wrap-setting-queue-mode', queueVal);
    syncCustomDropdown('wrap-setting-theme', themeVal);
  }
  closeAllCustomDropdowns();
  settingsModal?.classList.remove('hidden');
  closeSettingsModalBtn?.focus();
});

settingRoomPinRemove?.addEventListener('change', () => {
  const removing = Boolean(settingRoomPinRemove.checked);
  if (settingRoomPin) {
    settingRoomPin.disabled = removing;
    if (removing) settingRoomPin.value = '';
  }
});

closeSettingsModalBtn?.addEventListener('click', () => {
  closeAllCustomDropdowns();
  settingsModal?.classList.add('hidden');
  hostSettingsBtn?.focus();
});

saveSettingsBtn?.addEventListener('click', () => {
  closeAllCustomDropdowns();
  const payload = {
    djMode: settingDjMode?.value || 'anyone',
    queueMode: settingQueueMode?.value || 'anyone',
    theme: settingTheme?.value || 'electric'
  };

  const newPin = settingRoomPin ? settingRoomPin.value.trim() : '';
  if (settingRoomPinRemove?.checked) {
    payload.pin = null;
  } else if (newPin) {
    if (!/^\d{4,8}$/.test(newPin)) {
      showToast('Room PIN must be 4–8 digits.', 'error');
      return;
    }
    payload.pin = newPin;
  }

  socket.emit('update-room-settings', payload);
  settingsModal?.classList.add('hidden');
  hostSettingsBtn?.focus();
});

// --- 6. SYNCHRONIZATION, HYBRID AUDIO ENGINE & LOCK-SCREEN MEDIA SESSION ---
const DRIFT_HARD_SEEK_SEC = 0.4;   // Native <audio> drift threshold
// On cloud/mobile YouTube, use 1.25s tolerance to eliminate audio micro-stutters from coarse timer quantization
const DRIFT_YT_SEEK_SEC = (isCloudHosted || isMobileClient) ? 1.25 : 0.6;
const DRIFT_SETTLE_SEC = 0.25;     // tighter check right after a track starts
const SEEK_COOLDOWN_MS = isMobileClient ? 4000 : 2500; // never seek more often than this (prevents seek storms)
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
    // Direct audio engine unpause when triggered from OS lock-screen
    if (activeEngine === 'audio' && nativeAudio && nativeAudio.paused) {
      nativeAudio.play().catch(() => {});
    } else if (activeEngine === 'yt' && ytReady && ytPlayer) {
      try { ytPlayer.playVideo(); } catch (e) {}
    }
    socket.emit('play', { positionSec: calculateServerPosition() });
  });
  safeSet('pause', () => {
    if (!currentRoom?.currentTrack) return;
    localPauseIntentUntil = Date.now() + 2500;
    if (activeEngine === 'audio' && nativeAudio && !nativeAudio.paused) {
      nativeAudio.pause();
    } else if (activeEngine === 'yt' && ytReady && ytPlayer) {
      try { ytPlayer.pauseVideo(); } catch (e) {}
    }
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

  // Forward mobile audio telemetry to server terminal & /api/telemetry in real time
  if (isMobileClient && typeof socket !== 'undefined' && socket?.connected) {
    try {
      socket.emit('client-audio-telemetry', {
        event,
        detail,
        engine: activeEngine,
        hidden: document.hidden,
        state: nativeAudioSnapshot()
      });
    } catch (_) {}
  }
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
const NATIVE_STALL_MS = isMobileClient ? 8000 : 5500;

// High-availability CORS Piped & Invidious stream endpoints accessible from mobile consumer IPs
const CLIENT_STREAM_RESOLVERS = [
  'https://api.piped.privacydev.net',
  'https://piped-api.lunar.icu',
  'https://pipedapi.drgns.space',
  'https://pipedapi.colins.pt'
];
const clientStreamCache = new Map();

async function resolveClientSideStream(trackId) {
  if (!trackId) return null;
  const cached = clientStreamCache.get(trackId);
  if (cached && Date.now() - cached.ts < 1000 * 60 * 15) {
    return cached.url;
  }

  const attempts = CLIENT_STREAM_RESOLVERS.map(async (baseUrl) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(`${baseUrl}/streams/${encodeURIComponent(trackId)}`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) throw new Error(`${baseUrl} HTTP ${res.status}`);
      const data = await res.json();
      const streams = Array.isArray(data?.audioStreams) ? data.audioStreams : [];
      // Prefer M4A / AAC for universal iOS Safari and Android Chrome background play
      const m4a = streams
        .filter((s) => s.url && (s.mimeType?.startsWith('audio/mp4') || s.format === 'M4A'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      const anyAudio = streams
        .filter((s) => s.url && s.mimeType?.startsWith('audio/'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      const chosen = m4a || anyAudio;
      if (!chosen?.url) throw new Error('No audio streams found');
      return chosen.url;
    } finally {
      clearTimeout(timer);
    }
  });

  try {
    const directUrl = await Promise.any(attempts);
    if (directUrl) {
      if (clientStreamCache.size > 100) {
        clientStreamCache.delete(clientStreamCache.keys().next().value);
      }
      clientStreamCache.set(trackId, { url: directUrl, ts: Date.now() });
      return directUrl;
    }
  } catch (e) {
    audioLog('client-stream-resolver: failed all instances', e?.message || e);
  }
  return null;
}

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
  nativeStallTimer = setTimeout(async () => {
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

    // On mobile: before surrendering to iframe, attempt client-side direct stream bypass
    if (isMobileClient && nativeAudio.src && nativeAudio.src.includes('/api/audio/')) {
      audioLog('watchdog: attempting client-side direct stream bypass...');
      const trackId = currentRoom.currentTrack.id;
      const directUrl = await resolveClientSideStream(trackId);
      if (directUrl && token === loadRequestToken && currentRoom?.currentTrack?.id === trackId) {
        audioLog('watchdog: revived via client-side direct stream!', { directUrl: directUrl.substring(0, 45) });
        nativeAudio.src = directUrl;
        const livePos = Math.max(0, calculateServerPosition());
        if (livePos > 0.5) {
          try { nativeAudio.currentTime = livePos; } catch (e) {}
        }
        if (currentRoom.playback?.isPlaying) {
          nativeAudio.play().catch((e) => logPlayReject('watchdog-revived', e));
        }
        return;
      }
    }

    audioLog('watchdog: STALLED, no data received -> falling back to YouTube', nativeAudioSnapshot());
    nativeAudioFailed = true;
    const stalledTrackId = currentRoom.currentTrack.id;
    const failed = markEngineFailure(stalledTrackId, 'audio');
    if (failed.has('yt')) {
      // YouTube already failed for this song and the native retry stalled. Retrying
      // either engine would loop, so ask the room to move on instead.
      requestUnplayableTrackSkip(currentRoom, stalledTrackId);
      return;
    }
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
    if (activeEngine !== 'audio' || !currentRoom?.currentTrack) return;
    if (!currentRoom._trackEndNotified) {
      currentRoom._trackEndNotified = true;
      if (currentUser?.isHost) {
        socket.emit('skip-track', { endedTrackId: currentRoom.currentTrack.id });
      } else {
        socket.emit('sync-request');
      }
    }
  });

  // Diagnostics only: log the native audio lifecycle (no behaviour change)
  ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'waiting', 'stalled', 'pause', 'ended'].forEach((ev) => {
    nativeAudio.addEventListener(ev, () => {
      if (activeEngine === 'audio') {
        audioLog(`audio:${ev}`, nativeAudioSnapshot());
        if (ev === 'loadedmetadata') recordStopwatchStep('METADATA', `native <audio> duration=${nativeAudio.duration?.toFixed(1)}s`);
        if (ev === 'canplay') recordStopwatchStep('CANPLAY', `native <audio> readyState=${nativeAudio.readyState}`);
        if (ev === 'playing') recordStopwatchStep('AUDIBLE', `native <audio> playing, currentTime=${nativeAudio.currentTime?.toFixed(2)}s`);
      }
    });
  });

  // Automatic fallback to YouTube IFrame if direct stream ever errors
  nativeAudio.addEventListener('error', async () => {
    if (activeEngine !== 'audio' || !currentRoom?.currentTrack) return;
    if (nativeAudio.src === SILENT_WAV_DATA_URI) return;
    const mediaErr = nativeAudio.error;
    const labels = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
    // Ignore code 1 (ABORTED) caused by track switching or priming replacement
    if (mediaErr?.code === 1) return;

    const currentTrackId = currentRoom.currentTrack.id;
    const errToken = loadRequestToken;

    // On mobile: if server proxy /api/audio/ failed (e.g. Render datacenter IP blocked), attempt client direct stream
    if (isMobileClient && nativeAudio.src && nativeAudio.src.includes('/api/audio/')) {
      audioLog('audio: server proxy error, attempting client-side direct stream bypass...');
      const directUrl = await resolveClientSideStream(currentTrackId);
      if (
        directUrl &&
        errToken === loadRequestToken &&
        currentRoom?.currentTrack?.id === currentTrackId
      ) {
        audioLog('audio: revived via client-side direct stream!', { directUrl: directUrl.substring(0, 45) });
        nativeAudio.src = directUrl;
        const livePos = Math.max(0, calculateServerPosition());
        if (livePos > 0.5) {
          try { nativeAudio.currentTime = livePos; } catch (e) {}
        }
        if (currentRoom.playback?.isPlaying) {
          nativeAudio.play().catch((e) => logPlayReject('client-direct-stream', e));
        }
        disarmNativeStallWatchdog();
        return;
      }
    }

    if (errToken !== loadRequestToken || currentRoom?.currentTrack?.id !== currentTrackId) return;

    audioLog('audio:ERROR', {
      code: mediaErr?.code,
      label: labels[mediaErr?.code] || 'unknown',
      message: mediaErr?.message,
      ...nativeAudioSnapshot()
    });
    probeAudioEndpoint(currentTrackId);
    nativeAudioFailed = true;
    const failed = markEngineFailure(currentTrackId, 'audio');
    if (failed.has('yt')) {
      // The iframe already failed for this song, so retrying it would loop. Skip instead.
      requestUnplayableTrackSkip(currentRoom, currentTrackId);
      return;
    }
    fallbackToYouTubeTrack(currentRoom, 'native-audio-error');
  });

  // If mobile OS briefly pauses audio during app-switch or tab-switch transition while room is playing, resume
  // Note: iOS/Android often fire `pause` a few ms BEFORE `document.hidden` flips to true during a swipe gesture.
  nativeAudio.addEventListener('pause', () => {
    if (activeEngine !== 'audio' || !currentRoom?.currentTrack) return;
    if (nativeAudio.src === SILENT_WAV_DATA_URI) return;
    if (currentRoom.playback?.isPlaying && !nativeAudio.ended && Date.now() > localPauseIntentUntil) {
      [80, 350].forEach((delayMs) => {
        setTimeout(() => {
          if (
            activeEngine === 'audio' &&
            currentRoom?.currentTrack &&
            currentRoom?.playback?.isPlaying &&
            nativeAudio.paused &&
            !nativeAudio.ended &&
            nativeAudio.src !== SILENT_WAV_DATA_URI
          ) {
            nativeAudio.play().catch(() => {});
          }
        }, delayMs);
      });
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
    host: 'https://www.youtube-nocookie.com',
    playerVars: {
      autoplay: 1,
      controls: 0,
      modestbranding: 1,
      rel: 0,
      fs: 0,
      playsinline: 1,
      enablejsapi: 1,
      origin: window.location.protocol + '//' + window.location.host
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
        let erroredVideoId = '';
        try { erroredVideoId = ytPlayer?.getVideoData?.()?.video_id || ''; } catch (e) {}
        const activeTrackId = currentRoom?.currentTrack?.id;
        if (erroredVideoId && activeTrackId && erroredVideoId !== activeTrackId) {
          audioLog('yt:ERROR-stale', { code: event.data, erroredVideoId, activeTrackId });
          return;
        }
        audioLog('yt:ERROR', { code: event.data, meaning: meanings[event.data] || 'unknown', activeEngine });
        if (activeEngine !== 'yt' || !activeTrackId) return;

        const failed = markEngineFailure(activeTrackId, 'yt');
        if (!failed.has('audio') && nativeAudio) {
          // Embed-blocked or region-blocked video: try the server-proxied native stream
          // before giving up, since it does not depend on YouTube's embed permissions.
          showToast('YouTube playback failed. Trying the direct audio stream…', 'info');
          nativeAudioFailed = false;
          loadedTrackId = null;
          loadCurrentTrack(currentRoom, { forceNative: true, reload: true });
          return;
        }
        requestUnplayableTrackSkip(currentRoom, activeTrackId);
      },
      onStateChange: (event) => {
        if (activeEngine !== 'yt') return;
        audioLog('yt:state', event.data); // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
        if (event.data === YT.PlayerState.BUFFERING) {
          recordStopwatchStep('METADATA', 'YouTube IFrame state: BUFFERING (3)');
        }
        if (event.data === YT.PlayerState.PLAYING) {
          recordStopwatchStep('AUDIBLE', `YouTube IFrame state: PLAYING (1), currentTime=${ytPlayer.getCurrentTime?.().toFixed(2)}s`);
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
          if (currentRoom?.currentTrack && !currentRoom._trackEndNotified) {
            currentRoom._trackEndNotified = true;
            if (currentUser?.isHost) {
              socket.emit('skip-track', { endedTrackId: currentRoom.currentTrack.id });
            } else {
              socket.emit('sync-request');
            }
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

    // Track-End Boundary Protection: never kick audio.play() or driftSeek() past track finish
    const isAtOrPastEnd = effectiveTime >= duration - 0.15 || (activeEngine === 'audio' && nativeAudio?.ended);
    if (isAtOrPastEnd) {
      if (activeEngine === 'audio' && nativeAudio && !nativeAudio.paused) {
        try { nativeAudio.pause(); } catch (e) {}
      }
      if (nativeAudio) nativeAudio.playbackRate = 1;
      currentTimeDisplay.textContent = formatTime(duration);
      updateWaveformProgress(100);

      if (!currentRoom._trackEndNotified) {
        currentRoom._trackEndNotified = true;
        if (currentUser?.isHost) {
          socket.emit('skip-track', { endedTrackId: currentRoom.currentTrack.id });
        } else {
          socket.emit('sync-request');
        }
      }
      return;
    }

    if (activeEngine === 'audio' && nativeAudio && nativeAudio.src) {
      const local = nativeAudio.currentTime || 0;
      const isPlayingAudio = !nativeAudio.paused && !nativeAudio.ended && nativeAudio.readyState >= 2;
      const isBufferingAudio = !nativeAudio.paused && nativeAudio.readyState < 2;

      if (roomPlaying) {
        if (isPlayingAudio) {
          const drift = local - effectiveTime;
          const absDrift = Math.abs(drift);
          if (absDrift > DRIFT_HARD_SEEK_SEC) {
            nativeAudio.playbackRate = 1;
            driftSeek(effectiveTime);
          } else if (absDrift > 0.15) {
            // Gentle catch-up: an inaudible rate nudge avoids seek pops on small drift
            nativeAudio.playbackRate = drift > 0 ? 0.98 : 1.02;
          } else if (nativeAudio.playbackRate !== 1) {
            nativeAudio.playbackRate = 1;
          }
          notPlayingSince = 0;
          showAudioPrompt(false);
        } else if (!isBufferingAudio && Date.now() - lastPlayKick > 2200) {
          lastPlayKick = Date.now();
          nativeAudio.play().catch((e) => {
            if (!notPlayingSince) {
              notPlayingSince = Date.now();
              logPlayReject('sync-tick', e);
            }
          });
        }
      } else {
        if (!nativeAudio.paused) {
          try { nativeAudio.pause(); } catch (e) {}
        }
        if (nativeAudio.playbackRate !== 1) nativeAudio.playbackRate = 1;
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
            // Differentiated tolerance: avoids constant micro-seek stuttering on mobile YouTube
            if (Math.abs(local - effectiveTime) > DRIFT_YT_SEEK_SEC) driftSeek(effectiveTime);
          } else if (!isActive && Date.now() - lastPlayKick > 3000) {
            lastPlayKick = Date.now();
            ytPlayer.playVideo();
          }

        if (!isActive) {
          if (!notPlayingSince) notPlayingSince = Date.now();
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

    // Autoplay blocked / engine not advancing: surface the manual "Tap to Tune In" pill.
    if (roomPlaying && notPlayingSince && Date.now() - notPlayingSince > 1500) {
      showAudioPrompt(true);
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

    // Pre-warm the next queued track when within 15 seconds of current track ending
    if (duration > 0 && effectiveTime >= duration - 15) {
      const nextTrack = currentRoom?.queue?.[0];
      if (nextTrack?.id && window.handleWarmup) {
        window.handleWarmup(nextTrack.id);
      }
    }

    updateDebugOverlay();
  };

  // Run sync loop every 800ms on mobile devices to preserve CPU and battery, 400ms on desktop
  const syncTickRateMs = isMobileClient ? 800 : 400;
  syncInterval = setInterval(runSyncTick, syncTickRateMs);

  // Background & foreground transitions: native <audio> continues playing in background;
  // when returning to the app, resync clock and align immediately.
  if (!window._visibilityListenerAttached) {
    window._visibilityListenerAttached = true;
    const handleVisibilityOrReturn = () => {
      audioLog('visibilitychange', { hidden: document.hidden, engine: activeEngine });
      if (document.hidden) {
        if (syncInterval) clearInterval(syncInterval);
        // If mobile browser paused <audio> on tab/app hide, immediately kick it back on
        if (currentRoom?.currentTrack && currentRoom.playback?.isPlaying) {
          if (activeEngine === 'audio' && nativeAudio && nativeAudio.paused && !nativeAudio.ended) {
            nativeAudio.play().catch(() => {});
          }
          if ('mediaSession' in navigator) {
            try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {}
          }
        }
        // Keep a light 1.5s sync check for background <audio> drift
        syncInterval = setInterval(runSyncTick, 1500);
      } else {
        if (syncInterval) clearInterval(syncInterval);
        syncClock();
        if (currentRoom?.currentTrack && currentRoom.playback?.isPlaying) {
          syncWakeLock(true);
          const serverPos = calculateServerPosition();
          const duration = currentRoom.currentTrack.durationSeconds || 0;

          if (duration > 0 && serverPos >= duration - 0.15) {
            // Track reached its end while app was in background!
            if (activeEngine === 'audio' && nativeAudio && !nativeAudio.paused) {
              try { nativeAudio.pause(); } catch (e) {}
            }
            if (!currentRoom._trackEndNotified) {
              currentRoom._trackEndNotified = true;
              if (currentUser?.isHost) {
                socket.emit('skip-track', { endedTrackId: currentRoom.currentTrack.id });
              } else {
                socket.emit('sync-request');
              }
            }
            return;
          }

          if (activeEngine === 'audio' && nativeAudio) {
            const drift = Math.abs((nativeAudio.currentTime || 0) - serverPos);
            // Only seek if genuinely drifted outside tolerance (avoid audio hitch)
            if (drift > DRIFT_HARD_SEEK_SEC) {
              driftSeek(serverPos);
            }
            if (nativeAudio.paused && !nativeAudio.ended) {
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
              if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING && state !== YT.PlayerState.ENDED) {
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

function markEngineFailure(trackId, engine) {
  if (!trackId) return new Set();
  let engines = failedEnginesByTrack.get(trackId);
  if (!engines) {
    engines = new Set();
    failedEnginesByTrack.set(trackId, engines);
  }
  engines.add(engine);
  if (failedEnginesByTrack.size > 40) {
    failedEnginesByTrack.delete(failedEnginesByTrack.keys().next().value);
  }
  return engines;
}

// Both engines failed for this track: tell the user and advance instead of sitting in silence.
function requestUnplayableTrackSkip(room, trackId) {
  if (!room?.currentTrack || !trackId) return;
  if (room._skipRequestedForTrack === trackId) return;
  room._skipRequestedForTrack = trackId;
  if (playerStatusBadge) playerStatusBadge.textContent = 'SKIPPING…';
  showToast('This track cannot be played here. Skipping to the next one…', 'error');
  if (currentUser?.isHost) {
    socket.emit('skip-track', { endedTrackId: trackId });
  } else {
    socket.emit('vote-skip');
  }
}

function fallbackToYouTubeTrack(room, reason = 'unspecified') {
  if (!room?.currentTrack) return;
  audioLog('fallback-yt', { reason, id: room.currentTrack.id, ytReady });
  activeEngine = 'yt';
  disarmNativeStallWatchdog();
  if (nativeAudio) {
    try {
      nativeAudio.pause();
      nativeAudio.playbackRate = 1;
      nativeAudio.removeAttribute('src');
      nativeAudio.load();
    } catch (e) {}
  }
  if (reason !== 'cloud-direct-yt' && reason !== 'native-disabled-this-session') {
    if (playerStatusBadge) playerStatusBadge.textContent = 'RETRYING PLAYER…';
    showToast('Switched to the YouTube player for this track', 'info');
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
    recordStopwatchStep('ENGINE-LOAD', `yt: loadVideoById(${room.currentTrack.id}, start=${startSec.toFixed(1)}s)`);
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
function loadCurrentTrack(room, options = {}) {
  if (!room?.currentTrack) return;
  const { forceNative = false, reload = false } = options;
  const track = room.currentTrack;
  const trackId = track.id;
  if (loadedTrackId === trackId && !reload) return;
  loadedTrackId = trackId;
  if (room) {
    room._trackEndNotified = false;
    room._skipRequestedForTrack = null;
  }
  settlePending = true;
  lastSeekAt = Date.now(); // no drift seeks while the new track is loading
  const token = ++loadRequestToken;

  // A forced native retry (YouTube embed blocked) must not be short-circuited by an
  // earlier failure in this page session.
  if (forceNative) nativeAudioFailed = false;

  // Give every new track on mobile a fresh chance at native <audio> so one transient error never disables background play forever
  if (isMobileClient) {
    nativeAudioFailed = false;
  }

  updateMediaSessionMetadata(track);
  syncWakeLock(Boolean(room.playback?.isPlaying));

  // On desktop cloud hosting, YouTube direct iframe is used for zero-proxy overhead.
  // On mobile clients, attempt native <audio> first so music keeps playing in background and lock-screen!
  // A forced retry skips the cloud bypass so embed-blocked videos still get a second engine.
  const bypassNative = isCloudHosted && !isMobileClient && !forceNative;
  if (bypassNative || nativeAudioFailed || !nativeAudio) {
    fallbackToYouTubeTrack(room, bypassNative ? 'cloud-direct-yt' : 'native-disabled-this-session');
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
    const desiredSrc = `/api/audio/${encodeURIComponent(trackId)}`;
    // The search-row click preloads this exact URL inside the tap gesture. Re-assigning
    // it here would abort that request and start a second download, adding silence.
    const alreadyLoaded = Boolean(nativeAudio.src && nativeAudio.src.endsWith(desiredSrc));
    recordStopwatchStep('ENGINE-LOAD', `audio: ${desiredSrc} start=${startPos.toFixed(1)}s${alreadyLoaded ? ' (reuse preload)' : ''}`);
    if (!alreadyLoaded) {
      nativeAudio.src = desiredSrc;
    } else {
      audioLog('load-native-reuse', { id: trackId, readyState: nativeAudio.readyState });
    }
    nativeAudio.playbackRate = 1;
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

    // Seek to server position as soon as metadata is ready. The token check makes a
    // stale listener a no-op instead of seeking the newly loaded track.
    const onLoadedMeta = () => {
      if (token !== loadRequestToken) return;
      const target = Math.max(0, calculateServerPosition());
      // Also rewind when a reused preload is already at/near the end (replay of the same track).
      if (target > 0.5 || nativeAudio.ended || Math.abs((nativeAudio.currentTime || 0) - target) > 2) {
        try { nativeAudio.currentTime = target; } catch (e) {}
      }
      if (currentRoom?.playback?.isPlaying && nativeAudio.paused) {
        nativeAudio.play().catch((e) => {
          logPlayReject('loadedmetadata', e);
        });
      }
    };
    if (nativeAudio.readyState >= 1) {
      onLoadedMeta();
    } else {
      nativeAudio.addEventListener('loadedmetadata', onLoadedMeta, { once: true });
    }

    if (startPos > 0.5) {
      try { nativeAudio.currentTime = startPos; } catch (e) {}
    }

    if (currentRoom?.playback?.isPlaying) {
      nativeAudio.play().catch((e) => {
        logPlayReject('load', e);
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
  if (isMobileClient && !nativeAudioPrimed) {
    primeNativeAudioForMobile();
  }
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

  console.log(`[UI-ICON-SYNC] isPlaying=${playback.isPlaying} | playIconHidden=${playIcon?.classList.contains('hidden')} | pauseIconHidden=${pauseIcon?.classList.contains('hidden')} | engine=${activeEngine} | nativePaused=${nativeAudio?.paused}`);

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

// Audio Fade In / Out (Dual Engine: YouTube + HTML5 Native Audio)
let volumeFadeTimer = null;
function fadeAudio(targetVolume, durationMs = 350, onComplete) {
  const hasYt = ytReady && ytPlayer && typeof ytPlayer.getVolume === 'function';
  const hasNative = nativeAudio && !nativeAudio.paused;

  if (!hasYt && !hasNative) {
    if (onComplete) onComplete();
    return;
  }
  if (volumeFadeTimer) clearInterval(volumeFadeTimer);

  const startYtVolume = hasYt ? ytPlayer.getVolume() : targetVolume;
  const startNativeVol = hasNative ? nativeAudio.volume : (targetVolume / 100);
  const targetNativeVol = Math.max(0, Math.min(1, targetVolume / 100));

  const stepCount = 12;
  const interval = durationMs / stepCount;
  const deltaYt = (targetVolume - startYtVolume) / stepCount;
  const deltaNative = (targetNativeVol - startNativeVol) / stepCount;
  let currentStep = 0;

  volumeFadeTimer = setInterval(() => {
    currentStep++;
    if (hasYt) {
      try {
        const newYtVol = Math.round(startYtVolume + deltaYt * currentStep);
        ytPlayer.setVolume(Math.max(0, Math.min(100, newYtVol)));
      } catch (e) {}
    }
    if (hasNative) {
      try {
        nativeAudio.volume = Math.max(0, Math.min(1, startNativeVol + deltaNative * currentStep));
      } catch (e) {}
    }

    if (currentStep >= stepCount) {
      clearInterval(volumeFadeTimer);
      volumeFadeTimer = null;
      if (hasYt) {
        try { ytPlayer.setVolume(targetVolume); } catch (e) {}
      }
      if (hasNative) {
        try { nativeAudio.volume = targetNativeVol; } catch (e) {}
      }
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

  // Instant Optimistic Play/Pause (0ms perceived latency on mobile & desktop)
  if (isPlaying) {
    // 1. Immediately toggle UI icons
    playIcon?.classList.remove('hidden');
    pauseIcon?.classList.add('hidden');
    currentRoom.playback.isPlaying = false;
    // 2. Immediately pause audio locally without waiting for server network roundtrip
    localPauseIntentUntil = Date.now() + 2500;
    if (activeEngine === 'audio' && nativeAudio && !nativeAudio.paused) {
      try { nativeAudio.pause(); } catch (e) {}
    } else if (ytReady && ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
      try { ytPlayer.pauseVideo(); } catch (e) {}
    }
    socket.emit('pause', { positionSec: currentPos });
  } else {
    // 1. Immediately toggle UI icons
    playIcon?.classList.add('hidden');
    pauseIcon?.classList.remove('hidden');
    currentRoom.playback.isPlaying = true;
    // 2. Immediately play audio locally without waiting for server network roundtrip
    if (activeEngine === 'audio' && nativeAudio && nativeAudio.paused) {
      nativeAudio.play().catch(() => {});
    } else if (ytReady && ytPlayer && typeof ytPlayer.playVideo === 'function') {
      try { ytPlayer.playVideo(); } catch (e) {}
    }
    socket.emit('play', { positionSec: currentPos });
  }
});

skipBtn?.addEventListener('click', () => {
  if (currentUser?.isHost) {
    socket.emit('skip-track');
  } else {
    socket.emit('vote-skip');
    showToast('Voted to skip track ⏭️', 'info');
  }
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

// --- 8. REALTIME SEARCH & SPOTIFY-STYLE LOCAL-FIRST INDEX ---
const CLIENT_SEARCH_CACHE = new Map();
let searchAbortController = null;
let searchSeqId = 0;

// Local-First Prefix & Recents Search Engine
class LocalSearchEngine {
  constructor() {
    this.trackMap = new Map(); // id -> track object
    this.recentSearches = [];
    this.init();
  }

  init() {
    try {
      const stored = localStorage.getItem('jamlock_recent_searches');
      if (stored) {
        this.recentSearches = JSON.parse(stored).slice(0, 15);
      }
      const storedTracks = localStorage.getItem('jamlock_local_catalog');
      if (storedTracks) {
        const parsed = JSON.parse(storedTracks);
        if (Array.isArray(parsed)) {
          parsed.forEach(t => this.indexTrack(t, false));
        }
      }
    } catch (e) {
      console.warn('[LocalSearchEngine] init error:', e);
    }
  }

  save() {
    try {
      localStorage.setItem('jamlock_recent_searches', JSON.stringify(this.recentSearches));
      // Save top 80 most relevant tracks to keep localStorage small & fast
      const slice = Array.from(this.trackMap.values()).slice(0, 80);
      localStorage.setItem('jamlock_local_catalog', JSON.stringify(slice));
    } catch (e) {}
  }

  indexTrack(track, shouldSave = true) {
    if (!track || !track.id) return;
    this.trackMap.set(track.id, {
      id: track.id,
      title: track.title || 'Unknown Track',
      cleanTitle: track.cleanTitle || track.title || '',
      artist: track.artist || 'Unknown Artist',
      duration: track.duration || '0:00',
      thumbnail: track.thumbnail || '',
      url: track.url || ''
    });
    if (shouldSave) this.save();
  }

  indexTracks(tracks) {
    if (!Array.isArray(tracks)) return;
    tracks.forEach(t => this.indexTrack(t, false));
    this.save();
  }

  recordRecent(query) {
    const q = (query || '').trim();
    if (!q || q.length < 2) return;
    this.recentSearches = [q, ...this.recentSearches.filter(s => s.toLowerCase() !== q.toLowerCase())].slice(0, 10);
    this.save();
  }

  search(query, limit = 8) {
    const q = (query || '').toLowerCase().trim();
    if (!q) return [];
    const results = [];
    
    // Multi-tier ranking:
    // 1. Title/Artist starts with query
    // 2. Word boundary starts with query
    // 3. Substring match
    const tier1 = [];
    const tier2 = [];
    const tier3 = [];

    for (const track of this.trackMap.values()) {
      const title = (track.cleanTitle || track.title || '').toLowerCase();
      const artist = (track.artist || '').toLowerCase();

      if (title.startsWith(q) || artist.startsWith(q)) {
        tier1.push(track);
      } else if (new RegExp(`\\b${q}`, 'i').test(title) || new RegExp(`\\b${q}`, 'i').test(artist)) {
        tier2.push(track);
      } else if (title.includes(q) || artist.includes(q)) {
        tier3.push(track);
      }
      if (tier1.length >= limit) break;
    }

    const merged = [...tier1, ...tier2, ...tier3];
    return merged.slice(0, limit);
  }
}

const localSearch = new LocalSearchEngine();

// Expose indexing globally so played, queued, or room tracks get automatically indexed
window.indexTrackForSearch = (track) => localSearch.indexTrack(track);

inlineSearchInput?.addEventListener('input', (e) => {
  clearTimeout(searchDebounceTimer);
  const q = e.target.value.trim();
  const currentSeq = ++searchSeqId;

  if (q.length < 2) {
    searchResultsSection?.classList.add('hidden');
    searchEmptyPrompt?.classList.remove('hidden');
    return;
  }

  searchEmptyPrompt?.classList.add('hidden');

  // Instant Tier 1: Client in-memory exact search cache (0ms)
  const cached = CLIENT_SEARCH_CACHE.get(q.toLowerCase());
  if (cached && cached.length > 0) {
    renderSearchResults(cached);
    return;
  }

  // Instant Tier 2: Local-first prefix trie/index match (0ms instant preview)
  const localMatches = localSearch.search(q, 6);
  if (localMatches.length > 0) {
    renderSearchResults(localMatches, true); // true = instant preview
  } else {
    // Show non-blocking skeleton placeholder cards while network fetches
    renderSearchSkeletons();
  }

  if (searchAbortController) searchAbortController.abort();
  searchAbortController = new AbortController();

  // Tier 3: Debounced high-speed network fetch (180ms Spotify standard)
  searchDebounceTimer = setTimeout(async () => {
    searchSpinner?.classList.remove('hidden');
    const searchStart = performance.now();
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
        signal: searchAbortController.signal
      });
      if (currentSeq !== searchSeqId) return; // Stale query superseded by faster typing

      const results = await res.json();
      if (currentSeq !== searchSeqId) return;

      const roundtripMs = (performance.now() - searchStart).toFixed(0);
      const serverCache = res.headers.get('X-Cache') || 'UNKNOWN';
      const serverDuration = res.headers.get('X-Response-Time-Ms') || '?';
      console.log(`[CLIENT-SEARCH] "${q}" took ${roundtripMs}ms roundtrip (Server: ${serverDuration}ms, Cache: ${serverCache}, Count: ${results?.length || 0})`);

      CLIENT_SEARCH_CACHE.set(q.toLowerCase(), results);
      localSearch.indexTracks(results);
      localSearch.recordRecent(q);
      renderSearchResults(results, false);
    } catch (err) {
      if (err.name !== 'AbortError') console.error('Search error:', err);
    } finally {
      if (currentSeq === searchSeqId) {
        searchSpinner?.classList.add('hidden');
      }
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

let currentSearchResults = [];

function renderSearchResults(items, isInstantPreview = false) {
  if (!searchResultsList) return;
  trendingSection?.classList.add('hidden');
  searchResultsSection?.classList.remove('hidden');

  currentSearchResults = items || [];

  if (!items || items.length === 0) {
    searchResultsList.innerHTML = `
      <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px">
        No songs found. Try another track title or artist.
      </div>
    `;
    return;
  }

  const badgeHtml = isInstantPreview ? `
    <div style="display: flex; align-items: center; justify-content: space-between; padding: 4px 8px 8px; font-size: 11px; font-weight: 700; color: var(--lime); letter-spacing: 0.05em; text-transform: uppercase">
      <span>⚡ Instant Match</span>
      <span style="opacity: 0.7; font-weight: 500">Searching web...</span>
    </div>
  ` : '';

  searchResultsList.innerHTML = badgeHtml + items.map((song, idx) => {
    const displayTitle = getDisplayTitle(song);
    return `
      <div class="row" onmouseenter="handleWarmup('${song.id}')" onpointerdown="handleWarmup('${song.id}')" ontouchstart="handleWarmup('${song.id}')">
        <button type="button" class="art-btn" data-search-idx="${idx}" data-search-action="play-now" style="background-image: url('${song.thumbnail}')" title="Play Now">
          <div class="play-hint">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--lime)"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </button>
        <div style="flex: 1; min-width: 0; cursor: pointer" data-search-idx="${idx}" data-search-action="play-now">
          <div class="t" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</div>
          <div class="s">${escapeHtml(song.artist)}</div>
        </div>
        <span class="mono" style="margin-right: 4px">${song.duration}</span>
        <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0">
          <button type="button" class="search-action-btn" data-search-idx="${idx}" data-search-action="queue" title="Add to Queue">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            <span class="search-btn-label">Queue</span>
          </button>
          <button type="button" class="search-action-btn icon-only" title="Play Next" data-search-idx="${idx}" data-search-action="play-next">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Proactive Acceleration: automatically warm up the #1 ranked track immediately upon results render
  if (items[0]?.id && window.handleWarmup) {
    window.handleWarmup(items[0].id);
  }
}

// Clean event delegation for search result actions (handles apostrophes & special characters flawlessly)
searchResultsList?.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-search-action]');
  if (!trigger) return;
  const idx = parseInt(trigger.getAttribute('data-search-idx'), 10);
  const song = currentSearchResults[idx];
  if (!song) return;

  const action = trigger.getAttribute('data-search-action');
  if (action === 'play-now') {
    handlePlayNow(song);
  } else if (action === 'queue') {
    handleQueueSong(song, false);
  } else if (action === 'play-next') {
    handleQueueSong(song, true);
  }
});

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

window.handlePlayNow = (songOrEncoded) => {
  try {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    let song = songOrEncoded;
    if (typeof songOrEncoded === 'string') {
      try {
        song = JSON.parse(decodeURIComponent(songOrEncoded));
      } catch (err) {
        console.warn('[handlePlayNow] parse string failed:', err);
        return;
      }
    }
    if (!song) return;

    startClickStopwatch(song);

    // Optimistic UI update: switch hero button to pause icon immediately upon click
    playIcon?.classList.add('hidden');
    pauseIcon?.classList.remove('hidden');
    if (playerStatusBadge) playerStatusBadge.textContent = 'LOADING...';

    // Optimistic audio pipeline preload within user click gesture for instant playback.
    // Skip when host-only DJ mode will reject this request, otherwise the local player
    // would keep playing a track the room never accepted.
    const canPlayNow = !(currentRoom?.settings?.djMode === 'host-only' && !currentUser?.isHost);
    if (canPlayNow && nativeAudio && song?.id && (!isCloudHosted || isMobileClient) && !nativeAudioFailed) {
      const audioUrl = `/api/audio/${encodeURIComponent(song.id)}`;
      if (!nativeAudio.src.endsWith(audioUrl)) {
        const preloadStartedAt = performance.now();
        console.log(`[AUDIO-PRELOAD] Setting nativeAudio.src to ${audioUrl}`);
        nativeAudio.src = audioUrl;
        nativeAudio.currentTime = 0;
        nativeAudio.load();
        const playPromise = nativeAudio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise
            .then(() => console.log(`[AUDIO-PRELOAD] nativeAudio.play() promise resolved at +${(performance.now() - preloadStartedAt).toFixed(0)}ms`))
            .catch((err) => console.warn(`[AUDIO-PRELOAD] nativeAudio.play() rejected:`, err));
        }
      }
    }

    socket.emit('play-now', { track: song });
  } catch (e) {
    console.error(e);
  }
};

window.handleQueueSong = (songOrEncoded, playNext) => {
  try {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    let song = songOrEncoded;
    if (typeof songOrEncoded === 'string') {
      try {
        song = JSON.parse(decodeURIComponent(songOrEncoded));
      } catch (err) {
        console.warn('[handleQueueSong] parse string failed:', err);
        return;
      }
    }
    if (!song) return;

    socket.emit('add-to-queue', { track: song, playNext });
    showToast(`Added "${(song.title || '').slice(0, 28)}..." to queue`, 'success');
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

// --- EMOJI STORM HYPER-BURST (When 4+ reactions occur within 2.2s) ---
let stormTimestamps = [];
function checkEmojiStorm() {
  const now = Date.now();
  stormTimestamps.push(now);
  stormTimestamps = stormTimestamps.filter((t) => now - t < 2200);
  if (stormTimestamps.length >= 4) {
    triggerEmojiStorm();
    stormTimestamps = [];
  }
}

function triggerEmojiStorm() {
  const icons = ['🔥', '⚡', '❤️', '✨', '🎉', '🚀'];
  for (let i = 0; i < 20; i++) {
    setTimeout(() => {
      const el = document.createElement('span');
      el.className = 'fl text-2xl';
      el.textContent = icons[Math.floor(Math.random() * icons.length)];
      el.style.left = `${Math.random() * 86 + 7}%`;
      el.style.top = `${Math.random() * 50 + 20}%`;
      el.style.fontSize = `${Math.random() * 16 + 22}px`;
      el.style.animationDuration = `${1.2 + Math.random()}s`;
      reactionsContainer?.appendChild(el);
      setTimeout(() => el.remove(), 2200);
    }, i * 45);
  }
  const playerCard = document.getElementById('panel-player');
  if (playerCard) {
    playerCard.classList.add('party-pulse');
    setTimeout(() => playerCard.classList.remove('party-pulse'), 1200);
  }
}

// --- AUTO-FILL 3 SIMILAR TRACKS BUTTON ---
const queueSimilarBtn = document.getElementById('queue-similar-btn');
queueSimilarBtn?.addEventListener('click', () => {
  queueSimilarBtn.disabled = true;
  queueSimilarBtn.style.opacity = '0.5';
  socket.emit('queue-similar-tracks');
  setTimeout(() => {
    if (queueSimilarBtn) {
      queueSimilarBtn.disabled = false;
      queueSimilarBtn.style.opacity = '1';
    }
  }, 2500);
});

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
  recordStopwatchStep('ROOM-STATE', `room=${roomData?.id} track="${roomData?.currentTrack?.title || 'none'}"`);
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
  checkEmojiStorm();
  bumpVibeEnergy();

  if (typeof data.positionSec === 'number') {
    addWaveReactionMarker(data, currentRoom?.currentTrack?.durationSeconds, true);
  }

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

socket.on('skip-votes-updated', ({ votes, required }) => {
  if (skipVotePill) {
    if (votes > 0) {
      skipVotePill.textContent = `${votes}/${required}`;
      skipVotePill.classList.remove('hidden');
    } else {
      skipVotePill.classList.add('hidden');
    }
  }
  if (skipBtn) {
    const isHost = Boolean(currentUser?.isHost);
    if (isHost) {
      skipBtn.title = 'Skip Track (Host override)';
    } else {
      skipBtn.title = `Vote to skip (${votes || 0} of ${required || 1} votes needed)`;
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

socket.on('you-were-kicked', ({ message }) => {
  showToast(message || 'You were removed by the room host.', 'error');
  localStorage.removeItem('jamlock_current_room');
  leaveRoom();
});

socket.on('username-changed', ({ username }) => {
  if (currentUser) currentUser.username = username;
  localStorage.setItem('jamlock_username', username);
  if (usernameInput) usernameInput.value = username;
  showToast(`Your name is now "${username}"`, 'success');
});

socket.on('join-error', (err) => {
  if (err?.code === 'name_taken') {
    showToast(err.message, 'error');
    if (usernameInput && err.suggestion) {
      usernameInput.value = err.suggestion;
      localStorage.setItem('jamlock_username', err.suggestion);
      showToast(`Suggested: "${err.suggestion}" (click join to accept)`, 'info');
    }
  } else {
    showToast(err?.message || 'Failed to join room', 'error');
  }
});

socket.on('rename-error', (err) => {
  if (err?.code === 'name_taken') {
    showToast(err.message, 'error');
    if (err.suggestion) {
      showToast(`Name taken. Suggested: "${err.suggestion}"`, 'info');
    }
  } else {
    showToast(err?.message || 'Could not update username', 'error');
  }
});

socket.on('room-not-found', ({ roomId, message }) => {
  showToast(message || `Room "${roomId}" not found or expired.`, 'error');
  localStorage.removeItem('jamlock_current_room');
  leaveRoom();
});

// Member list interactive actions (Rename self & Host-Kick moderation)
if (usersStrip) {
  usersStrip.addEventListener('click', (e) => {
    const targetPill = e.target.closest('.member-avatar-pill');
    if (!targetPill || !currentRoom) return;

    const isMe = targetPill.dataset.isMe === 'true';
    const targetUsername = targetPill.dataset.username;
    const targetClientId = targetPill.dataset.clientId;
    const isTargetHost = targetPill.dataset.isHost === 'true';

    if (isMe) {
      const newName = prompt('Enter your new display name:', currentUser?.username || '');
      if (newName && newName.trim() && newName.trim() !== currentUser?.username) {
        socket.emit('change-username', { newUsername: newName.trim() });
      }
    } else if (currentUser?.isHost && !isTargetHost) {
      const confirmKick = confirm(`Remove "${targetUsername}" from this room?`);
      if (confirmKick) {
        socket.emit('kick-user', { targetClientId });
      }
    }
  });
}

// --- 12. UI STATE RENDERING ---
function renderRoomState(room) {
  if (!room) return;

  // Clear initial hydration skeleton state
  document.documentElement.classList.remove('in-room-loading');

  // Room switch: reset chat cache if entered a new room
  if (room.id && lastRenderedChatRoomId !== room.id) {
    lastRenderedChatRoomId = room.id;
    renderedChatIds.clear();
    if (chatMessages) chatMessages.innerHTML = '';
  }

  // Hydrate chat messages from server state (persists chat across page refreshes)
  if (Array.isArray(room.chat) && chatMessages) {
    room.chat.forEach((msg) => {
      appendChatMessage(msg);
    });
  }

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

  // User Avatars Strip with Interactive Actions (Self-Rename & Host-Kick)
  if (usersStrip) {
    usersStrip.innerHTML = room.users.map((u, i) => {
      const isMe = currentUser && (u.clientId === currentUser.clientId || u.username === currentUser.username);
      const isHostUser = u.isHost;
      return `
        <span class="av member-avatar-pill" data-client-id="${escapeHtml(u.clientId || '')}" data-username="${escapeHtml(u.username)}" data-is-me="${isMe}" data-is-host="${isHostUser}" style="background: ${u.avatarColor}; margin-left: ${i > 0 ? '-8px' : '0'}; border: 2px solid #0A0A0D; cursor: pointer; position: relative" title="${escapeHtml(u.username)} ${isHostUser ? '(Host)' : ''}${isMe ? ' (You - Click to Rename)' : (currentUser?.isHost ? ' (Click to Kick)' : '')}">
          ${u.username.charAt(0).toUpperCase()}
        </span>
      `;
    }).join('');
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

  // Apply Room Mood Theme
  const roomTheme = room.settings?.theme || 'electric';
  document.documentElement.dataset.theme = roomTheme;
  if (settingTheme) settingTheme.value = roomTheme;

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
      const isAuto = track.isAutoSuggested;
      return `
        <div class="row">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9A98A6" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="cursor: grab; flex: none">
            <circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/>
            <circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/>
            <circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>
          </svg>
          <img src="${track.thumbnail}" alt="" class="art">
          <div style="flex: 1; min-width: 0; cursor: pointer" data-queue-idx="${idx}" data-queue-action="play-now">
            <div class="t">
              ${escapeHtml(track.title)}
              ${isAuto ? '<span style="display: inline-block; vertical-align: middle; background: rgba(200, 255, 61, 0.15); color: var(--lime); font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px; margin-left: 6px">✨ Auto-Suggest</span>' : ''}
            </div>
            <div class="s">${escapeHtml(track.artist)} • ${track.duration}</div>
          </div>
          <span class="av" style="background: ${isAuto ? 'rgba(200, 255, 61, 0.2)' : 'var(--sky)'}; color: ${isAuto ? 'var(--lime)' : '#0A0A0D'}" title="${isAuto ? 'Auto-suggested (queued next)' : (track.addedBy ? `Queued by ${escapeHtml(track.addedBy)}` : 'Queued by member')}">
            ${isAuto ? '✨' : (track.addedBy ? escapeHtml(track.addedBy.charAt(0).toUpperCase()) : 'M')}
          </span>
          <button type="button" class="ghost" data-queue-idx="${idx}" data-queue-action="remove" style="background: none; border: 0; color: var(--text-muted); cursor: pointer; padding: 4px" title="Remove">✕</button>
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

    // Dynamic browser tab title
    const cleanT = room.currentTrack.cleanTitle || room.currentTrack.title;
    const playSymbol = room.playback?.isPlaying ? '▶' : '❚❚';
    document.title = `${playSymbol} ${cleanT} • ${room.currentTrack.artist} | JamLock`;

    // Added by chip
    if (addedByBadge) {
      addedByBadge.style.display = 'flex';
      addedByText.textContent = room.currentTrack.addedBy || 'host';
    }

    // Dynamic Ambient Backdrop from Album Cover Art
    if (ambientArtBg && room.currentTrack.thumbnail) {
      ambientArtBg.style.backgroundImage = `url("${room.currentTrack.thumbnail}")`;
      ambientArtBg.style.opacity = '0.70';
    }

    // Sync Democratic Skip Votes Pill & Tooltip
    const votes = room.skipVotes?.count || 0;
    const req = room.skipVotes?.required || 1;
    if (skipVotePill) {
      if (votes > 0) {
        skipVotePill.textContent = `${votes}/${req}`;
        skipVotePill.classList.remove('hidden');
      } else {
        skipVotePill.classList.add('hidden');
      }
    }
    if (skipBtn) {
      const isHost = Boolean(currentUser?.isHost);
      if (isHost) {
        skipBtn.title = 'Skip Track (Host override)';
      } else {
        skipBtn.title = `Vote to skip (${votes} of ${req} votes needed)`;
      }
    }

    // Render Timestamped Reaction Markers & reset reaction counts if new track loaded
    if (room.currentTrack.id !== currentMarkersTrackId) {
      currentMarkersTrackId = room.currentTrack.id;
      renderWaveReactionMarkers(room.trackReactions || []);
      // Reset reaction counts per track so counts don't bleed across tracks
      Object.keys(reactionCounts).forEach((emoji) => {
        reactionCounts[emoji] = 0;
        const btn = document.querySelector(`.reaction-btn[data-emoji="${emoji}"]`);
        const badge = btn?.querySelector('.rx-badge');
        if (badge) badge.remove();
      });
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
    document.title = 'JamLock — Music with Friends';
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

    // Dynamic browser tab title
    document.title = currentRoom?.id ? `JamLock — Room ${currentRoom.id}` : 'JamLock — Music with Friends';
    if (addedByBadge) addedByBadge.style.display = 'none';
    if (skipVotePill) skipVotePill.classList.add('hidden');
    if (skipBtn) skipBtn.title = 'Skip Track';
    if (wavyMarkersLayer) wavyMarkersLayer.innerHTML = '';
    currentMarkersTrackId = null;
    if (ambientGlow) ambientGlow.classList.remove('vibe-warm', 'vibe-hot');
    updateWaveformProgress(0);
  }
}

window.handleRemoveQueueItem = (idx) => {
  socket.emit('remove-from-queue', { index: idx });
};

// Clean event delegation for queue list actions (handles quotes & special characters flawlessly)
queueList?.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-queue-action]');
  if (!trigger) return;
  const idx = parseInt(trigger.getAttribute('data-queue-idx'), 10);
  const action = trigger.getAttribute('data-queue-action');
  if (action === 'play-now') {
    const track = currentRoom?.queue?.[idx];
    if (track) handlePlayNow(track);
  } else if (action === 'remove') {
    handleRemoveQueueItem(idx);
  }
});

function appendChatMessage(msg) {
  if (!msg || !chatMessages) return;
  const msgKey = msg.id || `${msg.user?.username || ''}_${msg.timestamp || ''}_${msg.text || ''}`;
  if (renderedChatIds.has(msgKey)) return;
  renderedChatIds.add(msgKey);

  const isMe = msg.user?.username === currentUser?.username;
  const div = document.createElement('div');
  div.dataset.msgId = msgKey;
  div.style.display = 'flex';
  div.style.gap = '10px';
  div.style.alignItems = 'flex-start';

  if (isMe) {
    div.style.alignSelf = 'flex-end';
    div.innerHTML = `
      <div style="background: var(--lime); color: #0A0A0D; border-radius: 16px 4px 16px 16px; padding: 8px 14px; font-size: 14px; font-weight: 500">
        ${escapeHtml(msg.text || '')}
      </div>
    `;
  } else {
    const uname = msg.user?.username || 'Guest';
    const initial = uname.charAt(0).toUpperCase();
    div.innerHTML = `
      <span class="av" style="background: ${msg.user?.avatarColor || 'var(--surface-raised)'}">${escapeHtml(initial)}</span>
      <div style="background: var(--surface-raised); border-radius: 4px 16px 16px 16px; padding: 8px 14px; font-size: 14px">
        <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 2px">${escapeHtml(uname)}</div>
        ${escapeHtml(msg.text || '')}
      </div>
    `;
  }

  chatMessages.appendChild(div);
  // Cap chat DOM to 50 messages to prevent unbounded DOM memory growth
  while (chatMessages.children.length > 50) {
    chatMessages.removeChild(chatMessages.firstChild);
  }
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

// Register Service Worker for PWA App Shell Caching & Fast Cold Starts
if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

// --- PWA INSTALL PROMPT ORCHESTRATION ---
let deferredInstallPrompt = null;
const pwaInstallBtn = document.getElementById('pwa-install-btn');
const roomPwaInstallBtn = document.getElementById('room-pwa-install-btn');
const iosPwaModal = document.getElementById('ios-pwa-modal');
const closeIosPwaBtn = document.getElementById('close-ios-pwa-btn');
const dismissIosPwaBtn = document.getElementById('dismiss-ios-pwa-btn');

const isIOS = /ipad|iphone|ipod/i.test(navigator.userAgent) && !window.MSStream;
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

// If user is already running the installed app, hide install buttons permanently
if (isStandalone) {
  if (pwaInstallBtn) pwaInstallBtn.style.display = 'none';
  if (roomPwaInstallBtn) roomPwaInstallBtn.style.display = 'none';
} else {
  // If in browser tab, make sure the install buttons stay visible
  if (pwaInstallBtn) pwaInstallBtn.style.display = 'inline-flex';
  if (roomPwaInstallBtn) roomPwaInstallBtn.style.display = 'inline-flex';
}

// Android / Desktop Chrome 1-tap install
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

// Cleanly handle successful OS app installation
window.addEventListener('appinstalled', () => {
  if (pwaInstallBtn) pwaInstallBtn.style.display = 'none';
  if (roomPwaInstallBtn) roomPwaInstallBtn.style.display = 'none';
  deferredInstallPrompt = null;
  showToast('JamLock installed successfully! 🎉', 'success');
});

async function handleInstallTrigger() {
  if (deferredInstallPrompt) {
    try {
      showToast('Opening install prompt...', 'info');
      await deferredInstallPrompt.prompt();
      const choicePromise = deferredInstallPrompt.userChoice;
      // 8-second timeout failsafe so button never hangs if user dismisses native dialog
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ outcome: 'dismissed' }), 8000));
      const { outcome } = await Promise.race([choicePromise, timeoutPromise]);
      if (outcome === 'accepted') {
        if (pwaInstallBtn) pwaInstallBtn.style.display = 'none';
        if (roomPwaInstallBtn) roomPwaInstallBtn.style.display = 'none';
      }
    } catch (err) {
      console.warn('[PWA] Prompt error:', err);
    }
  } else if (isIOS) {
    showIosInstallModal();
  } else {
    // Desktop Chrome / Edge fallback instruction
    showToast('To install: click the Install icon (⊕) in your browser address bar', 'info');
  }
}

pwaInstallBtn?.addEventListener('click', handleInstallTrigger);
roomPwaInstallBtn?.addEventListener('click', handleInstallTrigger);

function showIosInstallModal() {
  if (!iosPwaModal) return;
  iosPwaModal.classList.remove('hidden');
  iosPwaModal.style.display = 'flex';
}

function closeIosInstallModal() {
  if (!iosPwaModal) return;
  iosPwaModal.classList.add('hidden');
  iosPwaModal.style.display = 'none';
  try { localStorage.setItem('jamlock_ios_prompt_dismissed', '1'); } catch (e) {}
}

closeIosPwaBtn?.addEventListener('click', closeIosInstallModal);
dismissIosPwaBtn?.addEventListener('click', closeIosInstallModal);
