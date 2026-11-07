// Multi-Source Direct Audio Stream Resolver with LRU Cache & Zero-Downtime Fallback
// Resolves direct CORS-enabled M4A/WebM streams for native HTML5 <audio> background playback,
// falling back cleanly to the YouTube IFrame if a track has no direct stream.

const STREAM_CACHE = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes
const CACHE_MAX = 400;

const NOISE_REGEX = /\s*(\(|\[)(official\s*(music\s*)?video|official\s*audio|official\s*lyric(\s*video)?|audio|lyrics?|visualizer|hd|4k|hq|music\s*video|prod\.?\s*by[^\)\]]*|extended|remastered|out\s*now)(\)|\])/gi;
const FEAT_REGEX = /\s*(feat\.?|ft\.?|featuring|with)\b[^\-\(\[\:\,]*/gi;

function normalizeText(str = '') {
  return String(str)
    .replace(NOISE_REGEX, '')
    .replace(FEAT_REGEX, '')
    .replace(/- topic/gi, '')
    .replace(/vevo/gi, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseArtistAndSong(rawTitle = '', rawArtist = '') {
  const cleaned = String(rawTitle).replace(NOISE_REGEX, '').trim();
  let artist = rawArtist || '';
  let song = cleaned;

  if (cleaned.includes(' - ')) {
    const parts = cleaned.split(' - ');
    artist = parts[0].trim();
    song = parts.slice(1).join(' - ').trim();
  }

  const primaryArtist = artist
    .replace(FEAT_REGEX, '')
    .split(/[,&x\/]/i)[0]
    .replace(/- topic/gi, '')
    .replace(/vevo/gi, '')
    .trim();

  const cleanSong = song
    .replace(FEAT_REGEX, '')
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .trim();

  return {
    primaryArtist: primaryArtist || rawArtist || '',
    cleanSong: cleanSong || cleaned
  };
}

// Tier 1: Direct high-bitrate M4A/MP3 CDN resolver (JioSaavn / Audius Discovery CDN, CORS-enabled, cloud-IP friendly)
const SAAVN_ENDPOINTS = [
  'https://saavn.dev/api/search/songs',
  'https://jiosaavn-api-privatecvc2.vercel.app/search/songs'
];
const AUDIUS_DISCOVERY = 'https://discoveryprovider.audius.co/v1';

async function resolveFromAudius({ title, artist, durationSeconds }) {
  const { primaryArtist, cleanSong } = parseArtistAndSong(title, artist);
  const searchQuery = `${primaryArtist} ${cleanSong}`.trim();
  if (!searchQuery) return null;

  const targetSongNorm = normalizeText(cleanSong);
  const targetArtistNorm = normalizeText(primaryArtist);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2800);
  try {
    const url = `${AUDIUS_DISCOVERY}/tracks/search?query=${encodeURIComponent(searchQuery)}&app_name=jamlock`;
    const res = await fetch(url, {
      headers: { 'accept': 'application/json' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    const json = await res.json();
    const list = Array.isArray(json?.data) ? json.data : [];
    for (const item of list.slice(0, 6)) {
      if (!item?.id || item.is_stream_gated) continue;
      const itemTitle = normalizeText(item.title || '');
      const itemUser = normalizeText(item.user?.name || item.user?.handle || '');
      const itemDur = Number(item.duration) || 0;

      const titleMatches = itemTitle === targetSongNorm || itemTitle.includes(targetSongNorm) || targetSongNorm.includes(itemTitle);
      if (!titleMatches) continue;

      const artistMatches = !targetArtistNorm || itemUser.includes(targetArtistNorm) || targetArtistNorm.includes(itemUser) || itemTitle.includes(targetArtistNorm);
      const durMatches = !durationSeconds || !itemDur || Math.abs(durationSeconds - itemDur) <= 22;

      if (artistMatches && durMatches) {
        return {
          mode: 'audio',
          url: `${AUDIUS_DISCOVERY}/tracks/${encodeURIComponent(item.id)}/stream?app_name=jamlock`,
          source: 'audius-cdn'
        };
      }
    }
  } catch (e) {
    clearTimeout(timer);
  }
  return null;
}

async function resolveFromMusicCDN({ title, artist, durationSeconds }) {
  const { primaryArtist, cleanSong } = parseArtistAndSong(title, artist);
  const searchQuery = `${primaryArtist} ${cleanSong}`.trim();
  if (!searchQuery) return null;

  const targetSongNorm = normalizeText(cleanSong);
  const targetArtistNorm = normalizeText(primaryArtist);

  for (const base of SAAVN_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3200);
    try {
      const url = `${base}?query=${encodeURIComponent(searchQuery)}&limit=8`;
      const res = await fetch(url, {
        headers: { 'accept': 'application/json', 'user-agent': 'Mozilla/5.0' },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) continue;

      const json = await res.json();
      const results = json?.data?.results || json?.results || [];
      if (!Array.isArray(results) || results.length === 0) continue;

      let bestCandidate = null;
      let bestScore = -Infinity;

      for (const item of results) {
        const itemTitle = item.name || item.title || '';
        const itemArtists = Array.isArray(item.artists?.primary)
          ? item.artists.primary.map((a) => a.name).join(' ')
          : (item.primaryArtists || item.artist || '');
        const itemDuration = Number(item.duration) || 0;

        const normItemTitle = normalizeText(itemTitle);
        const normItemArtist = normalizeText(itemArtists);

        let score = 0;

        // Title match check
        if (normItemTitle === targetSongNorm) {
          score += 50;
        } else if (normItemTitle.includes(targetSongNorm) || targetSongNorm.includes(normItemTitle)) {
          score += 30;
        } else {
          continue; // Must match the song title
        }

        // Artist match check
        if (targetArtistNorm && (normItemArtist.includes(targetArtistNorm) || targetArtistNorm.includes(normItemArtist))) {
          score += 35;
        }

        // Duration proximity check (within 18 seconds if known)
        if (durationSeconds > 0 && itemDuration > 0) {
          const diff = Math.abs(durationSeconds - itemDuration);
          if (diff <= 6) score += 25;
          else if (diff <= 18) score += 10;
          else if (diff > 35) score -= 40;
        }

        const downloads = item.downloadUrl || item.download_url || [];
        let streamUrl = null;
        if (Array.isArray(downloads) && downloads.length > 0) {
          // Prefer 320kbps or 160kbps M4A
          const high = downloads.find((d) => (d.quality === '320kbps' || d.quality === '160kbps') && (d.url || d.link))
            || downloads[downloads.length - 1];
          streamUrl = high?.url || high?.link || null;
        } else if (typeof downloads === 'string') {
          streamUrl = downloads;
        }

        if (streamUrl && score > bestScore) {
          bestScore = score;
          bestCandidate = streamUrl;
        }
      }

      if (bestCandidate && bestScore >= 40) {
        return { mode: 'audio', url: bestCandidate, source: 'cdn-m4a' };
      }
    } catch (e) {
      clearTimeout(timer);
    }
  }

  return null;
}

// Tier 2: Piped / Invidious public audio stream instances for YouTube-specific tracks
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.moomoo.me'
];

async function resolveFromPiped(videoId) {
  if (!videoId || !/^[a-zA-Z0-9_-]{6,15}$/.test(videoId)) return null;

  for (const instance of PIPED_INSTANCES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const res = await fetch(`${instance}/streams/${encodeURIComponent(videoId)}`, {
        headers: { 'accept': 'application/json', 'user-agent': 'Mozilla/5.0' },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) continue;

      const data = await res.json();
      const streams = Array.isArray(data?.audioStreams) ? data.audioStreams : [];
      if (!streams.length) continue;

      // Prefer MP4/M4A (works natively on iOS Safari AND Android Chrome)
      const m4a = streams
        .filter((s) => s.url && (s.mimeType?.includes('mp4') || s.format === 'M4A'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

      const chosen = m4a || streams.find((s) => s.url);
      if (chosen?.url) {
        return { mode: 'audio', url: chosen.url, source: 'piped-audio' };
      }
    } catch (e) {
      clearTimeout(timer);
    }
  }
  return null;
}

export async function resolveAudioStream({ videoId, title, artist, durationSeconds }) {
  const cacheKey = `${videoId || ''}:::${normalizeText(title)}:::${normalizeText(artist)}`;
  const cached = STREAM_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  // 1. Try direct Music CDNs first (fastest, cloud-IP immune, 320kbps M4A/MP3)
  let resolved = await resolveFromMusicCDN({ title, artist, durationSeconds });
  if (!resolved) {
    resolved = await resolveFromAudius({ title, artist, durationSeconds });
  }

  // 2. Fallback to Piped YouTube audio stream if not on music CDN
  if (!resolved && videoId) {
    resolved = await resolveFromPiped(videoId);
  }

  // 3. Final fallback: instruct client to use the YouTube IFrame player
  const finalResult = resolved || { mode: 'iframe', url: null, source: 'yt-iframe' };

  if (STREAM_CACHE.size >= CACHE_MAX) {
    const oldestKey = STREAM_CACHE.keys().next().value;
    STREAM_CACHE.delete(oldestKey);
  }
  // Cache audio hits for 30 min, iframe fallbacks for 3 min
  STREAM_CACHE.set(cacheKey, {
    data: finalResult,
    timestamp: finalResult.mode === 'audio' ? Date.now() : Date.now() - (CACHE_TTL_MS - 180000)
  });

  return finalResult;
}
