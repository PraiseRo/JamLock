// Fast Multi-Tier Search Engine with Direct YouTubei JSON & LRU In-Memory Cache
import ytSearch from 'yt-search';
import { detectGenreFamily, buildGenreDiscoveryQueries, normalizeArtistName, GENRE_FAMILIES } from './genreFamilies.js';

// Global In-Memory Cache: cleanQuery -> { data, timestamp }
const CACHE = new Map();
const CACHE_MAX_SIZE = 500;
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour cache
const INFLIGHT_SEARCHES = new Map();

// Regex patterns to clean bracketed video metadata
const VIDEO_NOISE_REGEX = /\s*(\(|\[)(official\s*(music\s*)?video|official\s*audio|official\s*lyric(\s*video)?|audio|lyrics?|visualizer|hd|4k|hq|music\s*video|prod\.?\s*by[^\)\]]*|extended|remastered|out\s*now)(\)|\])/gi;

// Strip features from titles (e.g. feat., ft., featuring, with)
const FEAT_REGEX = /\s*(feat\.?|ft\.?|featuring|with)\b[^\-\(\[\:\,]*/gi;

// Clean raw YouTube title for display and strip leading "Artist - " redundancy
function cleanTitle(rawTitle, artist = '') {
  if (!rawTitle) return 'Untitled Track';
  let t = rawTitle
    .replace(VIDEO_NOISE_REGEX, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Strip leading "Artist - " if present
  if (t.includes(' - ')) {
    const parts = t.split(' - ');
    const possibleArtist = parts[0].trim().toLowerCase();
    const cleanA = (artist || '').toLowerCase().trim();
    if (cleanA && (cleanA.includes(possibleArtist) || possibleArtist.includes(cleanA))) {
      t = parts.slice(1).join(' - ').trim();
    } else if (parts.length === 2 && possibleArtist.length > 0) {
      // General "Artist - Title" format: use clean title part
      t = parts[1].trim();
    }
  }

  return t || rawTitle;
}

// Canonical key to group duplicate uploads of the same song across different channels
function getSongKey(title, artist) {
  let raw = cleanTitle(title);

  // Check if title has "Artist - Song Name" structure
  let extractedArtist = '';
  let extractedTitle = raw;

  if (raw.includes(' - ')) {
    const parts = raw.split(' - ');
    extractedArtist = parts[0].trim();
    extractedTitle = parts.slice(1).join(' - ').trim();
  }

  // Remove secondary featured artists and parenthetical junk from title
  let cleanSongName = extractedTitle
    .replace(VIDEO_NOISE_REGEX, '')
    .replace(FEAT_REGEX, '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '') // remove any remaining brackets
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Primary artist: extract first main artist before comma, &, x, or ft/feat
  let rawLead = extractedArtist || artist || '';
  let primaryArtist = rawLead
    .replace(FEAT_REGEX, '')
    .split(/[,&x\/]/)[0] // Take first main artist before comma, &, or x
    .toLowerCase()
    .replace(/- topic/g, '')
    .replace(/vevo/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // If primaryArtist is still empty, fallback to channel artist
  if (!primaryArtist && artist) {
    primaryArtist = artist
      .toLowerCase()
      .replace(/- topic/g, '')
      .replace(/vevo/g, '')
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return `${primaryArtist}:::${cleanSongName}`;
}

// Compute audio suitability score (higher = better audio version)
function getAudioScore(rawTitle, artist) {
  const t = rawTitle.toLowerCase();
  const a = (artist || '').toLowerCase();
  let score = 0;

  // Heavy penalty for non-song junk, parodies, reviews, reactions
  if (/reaction|review|parody|dance\s*video|tiktok|shorts|behind\s*the\s*scenes/i.test(t)) {
    score -= 60;
  }
  // Penalize live / concert unless queried
  if (/live\s*(at|in|performance|session|version)/i.test(t)) {
    score -= 15;
  }

  // Boost official artist topic uploads and official audio
  if (a.includes('- topic') || a.includes('topic')) score += 30;
  if (t.includes('official audio') || t.includes('audio')) score += 20;
  if (t.includes('lyrics') || t.includes('lyric video')) score += 10;

  // Bonus if channel name matches lead artist
  const cleanT = t.replace(/[^\w\s]/g, '');
  const cleanA = a.replace(/[^\w\s]/g, '');
  if (cleanA && cleanT.includes(cleanA)) score += 15;

  return score;
}

// Calculate Spotify-style relevance score (Title/Artist Token Disambiguation + Popularity + Official Audio Quality)
function calculateSearchRelevance(track, query) {
  const q = query.trim().toLowerCase();
  const rawTitle = (track.title || '').toLowerCase();
  const cleanT = cleanTitle(track.title).toLowerCase();
  const artist = (track.artist || '').toLowerCase();
  const queryTokens = q.split(/\s+/).filter((t) => t.length > 0);

  let relevance = 0;

  // 1. Exact Full Match
  if (cleanT === q) {
    relevance += 120; // Perfect match on title
  } else if (cleanT.startsWith(q)) {
    relevance += 60;
  }

  // 2. Token Disambiguation ("Song Artist" or "Artist Song")
  // e.g. Query "beat ay" -> checks if "beat" in title and "ay" in artist
  if (queryTokens.length > 1) {
    let titleMatchedTokens = 0;
    let artistMatchedTokens = 0;

    for (const token of queryTokens) {
      const inTitle = cleanT.includes(token);
      const inArtist = artist.includes(token);

      if (inTitle) titleMatchedTokens++;
      if (inArtist) artistMatchedTokens++;
    }

    // Huge reward for multi-field cross matching
    if (titleMatchedTokens > 0 && artistMatchedTokens > 0) {
      relevance += 140; // Definite Artist + Title disambiguation
    } else if (titleMatchedTokens === queryTokens.length) {
      relevance += 80;  // All words match title
    } else if (artistMatchedTokens === queryTokens.length) {
      relevance += 70;  // All words match artist
    }
  } else if (queryTokens.length === 1) {
    const singleToken = queryTokens[0];
    if (artist === singleToken || artist.startsWith(singleToken)) {
      relevance += 40;
    }
    if (cleanT.includes(singleToken)) {
      relevance += 30;
    }
  }

  // 3. Audio Quality & Official Topic Boost (from getAudioScore)
  const audioScore = getAudioScore(track.title, track.artist);
  relevance += audioScore;

  return relevance;
}

// Deduplicate list of songs and sort by Spotify-style relevance ranking
function deduplicateAudioTracks(tracks, query = '', limit = 8) {
  const songMap = new Map();

  for (const track of tracks) {
    const audioScore = getAudioScore(track.title, track.artist);
    // Ignore heavy non-song junk
    if (audioScore <= -30) continue;

    const relevanceScore = calculateSearchRelevance(track, query);
    const key = getSongKey(track.title, track.artist);
    const existing = songMap.get(key);

    const candidate = {
      ...track,
      cleanTitle: cleanTitle(track.title, track.artist),
      relevanceScore
    };

    if (!existing || candidate.relevanceScore > existing.relevanceScore) {
      songMap.set(key, candidate);
    }
  }

  // Sort candidates by final Spotify-style relevance score (highest first)
  const sorted = Array.from(songMap.values()).sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Convert to clean list, stripping internal score
  return sorted
    .map(({ relevanceScore, ...cleanTrack }) => cleanTrack)
    .slice(0, limit);
}

// Direct YouTubei JSON Search (Much faster than DOM HTML scraping)
async function searchYouTubei(query, limit = 12) {
  const url = 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false';
  const body = {
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20240101.00.00',
        hl: 'en',
        gl: 'US'
      }
    },
    query: query,
    params: 'EgIQAQ%3D%3D' // Filter videos only
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;
    const json = await res.json();

    const sections = json.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    let items = [];

    for (const sec of sections) {
      const contents = sec.itemSectionRenderer?.contents || [];
      for (const item of contents) {
        if (item.videoRenderer) {
          const v = item.videoRenderer;
          const videoId = v.videoId;
          if (!videoId) continue;

          const title = v.title?.runs?.map((r) => r.text).join('') || 'Untitled Track';
          const artist = v.ownerText?.runs?.map((r) => r.text).join('') || 'Unknown Artist';
          const duration = v.lengthText?.simpleText || '0:00';
          const durationParts = duration.split(':').map(Number);
          let durationSeconds = 0;
          if (durationParts.length === 2) durationSeconds = durationParts[0] * 60 + durationParts[1];
          if (durationParts.length === 3) durationSeconds = durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2];

          const thumbnail = v.thumbnail?.thumbnails?.pop()?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

          items.push({
            id: videoId,
            title,
            artist,
            duration,
            durationSeconds,
            thumbnail,
            url: `https://www.youtube.com/watch?v=${videoId}`
          });

          if (items.length >= limit) break;
        }
      }
      if (items.length >= limit) break;
    }

    return items.length > 0 ? items : null;
  } catch (err) {
    clearTimeout(timeoutId);
    return null;
  }
}

// Fallback search with ytSearch
async function searchFallback(query, limit = 12) {
  try {
    const results = await ytSearch({ query });
    return (results.videos || []).slice(0, limit).map((v) => ({
      id: v.videoId,
      title: v.title,
      artist: v.author?.name || 'Unknown Artist',
      duration: v.timestamp || '0:00',
      durationSeconds: v.seconds || 0,
      thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      url: v.url
    }));
  } catch (err) {
    return [];
  }
}

// Staggered concurrent search race: resolves immediately as soon as either source returns
async function fetchFastResults(cleanQuery, limit = 16) {
  const startT = Date.now();
  return new Promise((resolve) => {
    let resolved = false;
    let pending = 2;

    const handleResults = (sourceName, items) => {
      if (resolved) return;
      if (Array.isArray(items) && items.length > 0) {
        resolved = true;
        console.log(`[SEARCH-SOURCE] "${cleanQuery}" won by ${sourceName} in ${Date.now() - startT}ms (${items.length} items)`);
        resolve(items);
      } else {
        pending--;
        if (pending <= 0 && !resolved) {
          resolved = true;
          console.warn(`[SEARCH-SOURCE] "${cleanQuery}" all sources failed/empty in ${Date.now() - startT}ms`);
          resolve([]);
        }
      }
    };

    // Branch 1: Direct YouTubei JSON (target: 300ms - 900ms)
    searchYouTubei(cleanQuery, limit).then((res) => handleResults('YouTubei', res)).catch(() => handleResults('YouTubei', null));

    // Branch 2: Staggered fallback (starts after 500ms if YouTubei hasn't returned yet)
    setTimeout(() => {
      if (resolved) return;
      searchFallback(cleanQuery, limit).then((res) => handleResults('Fallback', res)).catch(() => handleResults('Fallback', null));
    }, 500);
  });
}

export async function searchSongs(query, limit = 12) {
  const cleanQuery = query.trim().toLowerCase();
  if (!cleanQuery) return [];

  // 1. Direct Cache Hit (0ms)
  const cached = CACHE.get(cleanQuery);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  // 2. In-Flight Request Deduplication (share promise if already in-progress)
  if (INFLIGHT_SEARCHES.has(cleanQuery)) {
    return INFLIGHT_SEARCHES.get(cleanQuery);
  }

  // 3. Prefix / Substring Local Cache Lookup (Instant typing responsiveness)
  for (const [key, val] of CACHE.entries()) {
    if (key.includes(cleanQuery) || cleanQuery.includes(key)) {
      if (val.data && val.data.length >= 6) {
        // Filter locally in memory for instant responsiveness
        const matches = val.data.filter((song) =>
          song.title.toLowerCase().includes(cleanQuery) ||
          song.artist.toLowerCase().includes(cleanQuery)
        );
        if (matches.length >= 4) {
          return matches.slice(0, limit);
        }
      }
    }
  }

  const searchPromise = (async () => {
    try {
      // 4. Staggered concurrent race (guarantees fast return in <1.5s)
      const rawResults = await fetchFastResults(cleanQuery, 16);

      // Deduplicate and prioritize audio tracks over noisy video duplicates using Spotify-style ranking
      const results = deduplicateAudioTracks(rawResults || [], cleanQuery, limit);

      // Save to Cache
      if (results && results.length > 0) {
        if (CACHE.size >= CACHE_MAX_SIZE) {
          const oldestKey = CACHE.keys().next().value;
          CACHE.delete(oldestKey);
        }
        CACHE.set(cleanQuery, { data: results, timestamp: Date.now() });
      }

      return results || [];
    } finally {
      INFLIGHT_SEARCHES.delete(cleanQuery);
    }
  })();

  INFLIGHT_SEARCHES.set(cleanQuery, searchPromise);
  return searchPromise;
}

// Helper: extract simple core title without punctuation or features for strict similarity checks
function extractCoreTitle(title) {
  return cleanTitle(title)
    .replace(FEAT_REGEX, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Get Smart Recommendations based on genre family with guaranteed artist rotation
// Ensures the next track stays in the same musical genre while rotating artists (no repeat in 4-5 songs)
export async function getRecommendations(currentTrack, history = []) {
  if (!currentTrack) return null;

  // 1. Build banned sets from recent history (last 10 tracks)
  const bannedSongKeys = new Set();
  const bannedCoreTitles = new Set();
  const historyIds = new Set();

  const allPlayed = [...history.slice(0, 10), currentTrack];
  for (const t of allPlayed) {
    if (!t) continue;
    if (t.id) historyIds.add(t.id);
    const key = getSongKey(t.title, t.artist);
    if (key) bannedSongKeys.add(key);

    const core = extractCoreTitle(t.title);
    if (core && core.length > 2) bannedCoreTitles.add(core);
  }

  // 2. Track artists who appeared in the last 4-5 songs to strictly enforce variety
  const recentArtists = new Set();
  const lastFourPlayed = [currentTrack, ...history.slice(0, 4)];
  for (const t of lastFourPlayed) {
    if (t?.artist) {
      recentArtists.add(normalizeArtistName(t.artist));
    }
  }

  // 3. Detect the seed track's genre family (Afrobeats, Hip-Hop, Pop, R&B, etc.)
  const genreFamilyKey = await detectGenreFamily(currentTrack.artist, currentTrack.title);
  const family = GENRE_FAMILIES[genreFamilyKey] || GENRE_FAMILIES.afro;

  // 4. Discover candidates across the broader genre family instead of locking into one artist
  const queries = buildGenreDiscoveryQueries(currentTrack, genreFamilyKey);

  let candidatePool = [];
  for (const q of queries) {
    try {
      const results = await searchSongs(q, 15);
      if (results && results.length > 0) {
        candidatePool.push(...results);
      }
      if (candidatePool.length >= 35) break;
    } catch (_) {}
  }

  if (candidatePool.length === 0) {
    try {
      candidatePool = await searchSongs(`${family.name} songs audio`, 15);
    } catch (_) {}
  }

  // 5. Score and filter candidates based on genre alignment & artist cooldown
  const currentArtistNorm = normalizeArtistName(currentTrack.artist);
  const scoredCandidates = [];

  for (const candidate of candidatePool) {
    if (!candidate || !candidate.id) continue;
    if (historyIds.has(candidate.id)) continue;

    const candKey = getSongKey(candidate.title, candidate.artist);
    if (bannedSongKeys.has(candKey)) continue;

    const candCore = extractCoreTitle(candidate.title);
    let matchesBannedTitle = false;
    for (const banned of bannedCoreTitles) {
      if (candCore === banned || (candCore.length > 4 && banned.includes(candCore)) || (banned.length > 4 && candCore.includes(banned))) {
        matchesBannedTitle = true;
        break;
      }
    }
    if (matchesBannedTitle) continue;

    // Base score for any distinct track
    let score = 50;

    const candArtistNorm = normalizeArtistName(candidate.artist);

    // Rule: Heavily penalize artists who appeared in the last 4 to 5 tracks
    if (recentArtists.has(candArtistNorm)) {
      score -= 100;
    } else {
      score += 25; // Bonus for a fresh, distinct artist
    }

    // Bonus for matching keywords in the genre family
    const fullCandText = `${candidate.title} ${candidate.artist}`.toLowerCase();
    const matchesFamily = family.keywords.some((kw) => fullCandText.includes(kw));
    if (matchesFamily) {
      score += 20;
    }

    // Keep candidate if score > 0
    if (score > 0) {
      scoredCandidates.push({ candidate, score });
    }
  }

  // 6. Variety selection: Sort by score, take Top 5, and pick randomly to avoid deterministic queues
  if (scoredCandidates.length > 0) {
    scoredCandidates.sort((a, b) => b.score - a.score);
    const topCandidates = scoredCandidates.slice(0, 5);
    const chosen = topCandidates[Math.floor(Math.random() * topCandidates.length)].candidate;
    return chosen;
  }

  // 7. Graceful fallback: If no candidate passed strict artist cooldown, pick any candidate with distinct title and ID
  const currentCore = extractCoreTitle(currentTrack.title);
  const fallback = candidatePool.find((t) =>
    t.id !== currentTrack.id &&
    extractCoreTitle(t.title) !== currentCore &&
    !historyIds.has(t.id)
  );

  return fallback || null;
}

// Get Multiple Distinct Recommendations for "+3 Similar" feature
// Guarantees zero duplicate versions, lyric videos, or alternate uploads of the current track
export async function getMultipleRecommendations(currentTrack, count = 3, existingTracks = []) {
  if (!currentTrack) return [];

  const bannedSongKeys = new Set();
  const bannedCoreTitles = new Set();
  const bannedIds = new Set();

  const allPlayed = [...existingTracks, currentTrack];
  for (const t of allPlayed) {
    if (!t) continue;
    if (t.id) bannedIds.add(t.id);
    const key = getSongKey(t.title, t.artist);
    if (key) bannedSongKeys.add(key);

    const core = extractCoreTitle(t.title);
    if (core && core.length > 2) bannedCoreTitles.add(core);
  }

  const currentCore = extractCoreTitle(currentTrack.title);

  // Queries to discover genuinely diverse tracks:
  // 1. Same artist's other hits
  // 2. Similar artists / mix
  // 3. Related genre songs
  const queries = [
    `${currentTrack.artist} top songs`,
    `${currentTrack.artist} similar songs`,
    `${cleanTitle(currentTrack.title, currentTrack.artist)} similar music audio`
  ];

  const candidatePool = [];
  for (const q of queries) {
    try {
      const results = await searchSongs(q, 15);
      if (results && results.length > 0) {
        candidatePool.push(...results);
      }
      if (candidatePool.length >= 25) break;
    } catch (e) {
      console.warn('[search] Candidate query failed:', q, e.message);
    }
  }

  if (candidatePool.length === 0) {
    try {
      const fallbackResults = await searchSongs(`${currentTrack.artist} songs`, 15);
      if (fallbackResults) candidatePool.push(...fallbackResults);
    } catch (_) {}
  }

  const selectedTracks = [];

  for (const candidate of candidatePool) {
    if (!candidate || !candidate.id) continue;
    if (bannedIds.has(candidate.id)) continue;

    const candKey = getSongKey(candidate.title, candidate.artist);
    if (bannedSongKeys.has(candKey)) continue;

    const candCore = extractCoreTitle(candidate.title);
    if (!candCore || candCore.length < 2) continue;

    // Reject if candidate is the exact same song as the currently playing track
    let isDuplicateSong = false;
    if (candCore === currentCore ||
        (candCore.length > 3 && currentCore.includes(candCore)) ||
        (currentCore.length > 3 && candCore.includes(currentCore))) {
      isDuplicateSong = true;
    }

    if (!isDuplicateSong) {
      for (const banned of bannedCoreTitles) {
        if (candCore === banned ||
            (candCore.length > 4 && banned.includes(candCore)) ||
            (banned.length > 4 && candCore.includes(banned))) {
          isDuplicateSong = true;
          break;
        }
      }
    }

    if (isDuplicateSong) continue;

    // Passed all deduplication checks!
    selectedTracks.push(candidate);
    bannedIds.add(candidate.id);
    if (candKey) bannedSongKeys.add(candKey);
    bannedCoreTitles.add(candCore);

    if (selectedTracks.length >= count) {
      break;
    }
  }

  return selectedTracks;
}
