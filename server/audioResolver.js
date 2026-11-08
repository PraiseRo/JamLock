// Direct YouTube Audio Stream Resolver & Byte-Range Proxy for Mobile Background Playback
// Uses @distube/ytdl-core (Tier 1) + Piped API / Invidious API fallbacks (Tier 2 & 3) to extract
// native audio/mp4 (itag 140) streams so iOS Safari & Android Chrome keep <audio> playing
// when switching tabs, switching apps, or locking the screen—even on cloud datacenter IPs.

import { Ytdl, chooseFormat } from '@distube/ytdl-core';
import { Readable } from 'stream';

const ytdl = new Ytdl();

// Cache resolved format metadata per videoId (20-minute TTL)
const FORMAT_CACHE = new Map();
const FORMAT_TTL_MS = 1000 * 60 * 20;
const FORMAT_MAX = 400;
const INFLIGHT = new Map();

// Timeouts & fast failure recovery
const YTDL_TIMEOUT_MS = 4500;        // max time for Tier 1 ytdl-core
const FALLBACK_API_TIMEOUT_MS = 4500; // max time for Tier 2/3 Piped/Invidious fallback
const UPSTREAM_TIMEOUT_MS = 10000;   // max time to first byte from upstream media server
const FAIL_CACHE = new Map();
const FAIL_TTL_MS = 1000 * 15;       // 15s cooldown on complete failure (was 60s)

const PIPED_INSTANCES = [
  'https://api.piped.privacydev.net',
  'https://piped-api.lunar.icu',
  'https://pipedapi.drgns.space',
  'https://pipedapi.colins.pt',
  'https://api.piped.private.coffee'
];

const INVIDIOUS_INSTANCES = [
  'https://vid.puffyan.us',
  'https://invidious.projectsegfau.lt',
  'https://invidious.flokinet.to',
  'https://inv.nadeko.net'
];

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function markFailed(videoId) {
  if (FAIL_CACHE.size >= FORMAT_MAX) {
    FAIL_CACHE.delete(FAIL_CACHE.keys().next().value);
  }
  FAIL_CACHE.set(videoId, Date.now());
}

async function extractViaYtdl(videoId) {
  const info = await withTimeout(ytdl.getInfo(videoId), YTDL_TIMEOUT_MS, 'ytdl.getInfo');
  const formats = Array.isArray(info?.formats) ? info.formats : [];

  // Prefer itag 140 (audio/mp4 AAC) — universally supported on iOS Safari AND Android Chrome
  const m4a140 = formats.find((f) => f.itag === 140 && f.url);
  const anyMp4Audio = formats
    .filter((f) => f.url && f.mimeType?.startsWith('audio/mp4'))
    .sort((a, b) => (b.audioBitrate || b.bitrate || 0) - (a.audioBitrate || a.bitrate || 0))[0];
  const fallbackAudio = formats
    .filter((f) => f.url && f.mimeType?.startsWith('audio/'))
    .sort((a, b) => (b.audioBitrate || b.bitrate || 0) - (a.audioBitrate || a.bitrate || 0))[0];

  const chosen = m4a140 || anyMp4Audio || fallbackAudio || chooseFormat(formats, { quality: 'highestaudio', filter: 'audioonly' });
  if (!chosen?.url) {
    throw new Error(`no playable ytdl audio format (${formats.length} formats)`);
  }

  return {
    url: chosen.url,
    mimeType: (chosen.mimeType || 'audio/mp4').split(';')[0].trim(),
    contentLength: Number(chosen.contentLength) || 0,
    itag: chosen.itag || 140,
    provider: 'ytdl'
  };
}

async function extractViaPiped(videoId) {
  const attempts = PIPED_INSTANCES.map(async (base) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FALLBACK_API_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/streams/${encodeURIComponent(videoId)}`, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
          'accept': 'application/json'
        },
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`Piped ${base} HTTP ${res.status}`);
      const json = await res.json();
      const streams = Array.isArray(json?.audioStreams) ? json.audioStreams : [];
      const m4a = streams
        .filter((s) => s.url && (s.mimeType?.startsWith('audio/mp4') || s.format === 'M4A'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      const anyAudio = streams
        .filter((s) => s.url && s.mimeType?.startsWith('audio/'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      const chosen = m4a || anyAudio;
      if (!chosen?.url) throw new Error(`Piped ${base} no audioStreams`);
      return {
        url: chosen.url,
        mimeType: (chosen.mimeType || 'audio/mp4').split(';')[0].trim(),
        contentLength: Number(chosen.contentLength) || 0,
        itag: chosen.itag || 140,
        provider: `piped:${new URL(base).hostname}`
      };
    } finally {
      clearTimeout(timer);
    }
  });

  return Promise.any(attempts);
}

async function extractViaInvidious(videoId) {
  const attempts = INVIDIOUS_INSTANCES.map(async (base) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FALLBACK_API_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}`, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
          'accept': 'application/json'
        },
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`Invidious ${base} HTTP ${res.status}`);
      const json = await res.json();
      const formats = Array.isArray(json?.adaptiveFormats) ? json.adaptiveFormats : [];
      const m4a = formats
        .filter((f) => f.url && f.type?.startsWith('audio/mp4'))
        .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0];
      const anyAudio = formats
        .filter((f) => f.url && f.type?.startsWith('audio/'))
        .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0];
      const chosen = m4a || anyAudio;
      if (!chosen?.url) throw new Error(`Invidious ${base} no adaptiveFormats`);

      // Use Invidious instance's local proxy URL so datacenter IP blocks on googlevideo are bypassed
      const proxiedUrl = `${base}/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(chosen.itag || 140)}&local=true`;
      return {
        url: proxiedUrl,
        fallbackDirectUrl: chosen.url,
        mimeType: (chosen.type || 'audio/mp4').split(';')[0].trim(),
        contentLength: Number(chosen.clen) || 0,
        itag: Number(chosen.itag) || 140,
        provider: `invidious:${new URL(base).hostname}`
      };
    } finally {
      clearTimeout(timer);
    }
  });

  return Promise.any(attempts);
}

export async function getYoutubeAudioFormat(videoId, options = {}) {
  if (!videoId || !/^[\w-]{6,20}$/.test(videoId)) return null;
  const { skipYtdl = false, forceRefresh = false } = options;

  if (!forceRefresh && !skipYtdl) {
    const cached = FORMAT_CACHE.get(videoId);
    if (cached && Date.now() - cached.timestamp < FORMAT_TTL_MS) {
      return cached.data;
    }

    const failedAt = FAIL_CACHE.get(videoId);
    if (failedAt && Date.now() - failedAt < FAIL_TTL_MS) {
      return null;
    }
  }

  const inflightKey = `${videoId}:${skipYtdl ? 'fallback' : 'full'}`;
  if (INFLIGHT.has(inflightKey)) {
    return INFLIGHT.get(inflightKey);
  }

  const promise = (async () => {
    const startedAt = Date.now();
    let data = null;
    const errors = [];

    // Tier 1: @distube/ytdl-core (unless skipped after a 403 upstream rejection)
    if (!skipYtdl) {
      try {
        data = await extractViaYtdl(videoId);
      } catch (err) {
        errors.push(`ytdl: ${err?.message || err}`);
      }
    }

    // Tier 2 & 3: Race Piped and Invidious fallback extractors if Tier 1 failed or was skipped
    if (!data) {
      try {
        data = await Promise.any([
          extractViaPiped(videoId),
          extractViaInvidious(videoId)
        ]);
      } catch (err) {
        errors.push(`fallbacks: ${err?.message || err}`);
      }
    }

    if (data?.url) {
      if (FORMAT_CACHE.size >= FORMAT_MAX) {
        const oldest = FORMAT_CACHE.keys().next().value;
        FORMAT_CACHE.delete(oldest);
      }
      FORMAT_CACHE.set(videoId, { data, timestamp: Date.now() });
      FAIL_CACHE.delete(videoId);
      console.log(`[audio] extract ok id=${videoId} provider=${data.provider} itag=${data.itag} in ${Date.now() - startedAt}ms`);
      return data;
    }

    console.warn(`[audio] extract FAILED id=${videoId} after ${Date.now() - startedAt}ms (${errors.join(' | ')})`);
    markFailed(videoId);
    return null;
  })().finally(() => {
    INFLIGHT.delete(inflightKey);
  });

  INFLIGHT.set(inflightKey, promise);
  return promise;
}

// Proxy audio stream with full HTTP 206 Byte-Range support for iOS Safari & Android lock-screen seeking
export async function streamAudioToClient(req, res) {
  const videoId = String(req.params.videoId || '').trim();
  let format = await getYoutubeAudioFormat(videoId);

  if (!format || !format.url) {
    console.warn(`[audio] stream 404 id=${videoId}: no format (extraction failed)`);
    res.status(404).json({ error: 'Audio stream unavailable', reason: 'extract-failed' });
    return;
  }

  const upstreamHeaders = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'accept': '*/*'
  };

  if (req.headers.range) {
    upstreamHeaders.range = req.headers.range;
  }

  const abortController = new AbortController();
  req.on('close', () => {
    try { abortController.abort(); } catch (e) {}
  });

  let timedOut = false;
  const fetchUpstream = async (url) => {
    const timer = setTimeout(() => {
      timedOut = true;
      try { abortController.abort(); } catch (e) {}
    }, UPSTREAM_TIMEOUT_MS);
    try {
      return await fetch(url, { headers: upstreamHeaders, signal: abortController.signal, redirect: 'follow' });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let upstreamRes = await fetchUpstream(format.url);

    // If ytdl googlevideo URL is IP-blocked (403/410) or upstream failed, immediately switch to Tier 2/3 fallback proxy
    if (!upstreamRes.ok && upstreamRes.status !== 206) {
      console.warn(`[audio] upstream ${upstreamRes.status} from ${format.provider} id=${videoId}: switching to fallback stream`);
      FORMAT_CACHE.delete(videoId);
      const fallbackFormat = await getYoutubeAudioFormat(videoId, {
        skipYtdl: format.provider === 'ytdl',
        forceRefresh: true
      });
      if (fallbackFormat?.url) {
        format = fallbackFormat;
        upstreamRes = await fetchUpstream(format.url);
      }
    }

    if (!upstreamRes.ok && upstreamRes.status !== 206) {
      console.warn(`[audio] stream 502 id=${videoId}: upstream status ${upstreamRes.status}`);
      const reason = (upstreamRes.status === 403 || upstreamRes.status === 410) ? 'upstream-403' : 'upstream-error';
      res.status(502).json({ error: 'Audio upstream failed', reason });
      return;
    }

    res.status(upstreamRes.status);
    res.setHeader('Content-Type', format.mimeType || upstreamRes.headers.get('content-type') || 'audio/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const contentRange = upstreamRes.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    const contentLength = upstreamRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    if (!upstreamRes.body) {
      res.end();
      return;
    }

    const nodeStream = Readable.fromWeb(upstreamRes.body);
    nodeStream.on('error', () => {
      try { res.end(); } catch (e) {}
    });
    nodeStream.pipe(res);
  } catch (e) {
    if (timedOut && !res.headersSent) {
      console.warn(`[audio] upstream TIMEOUT id=${videoId}: no response within ${UPSTREAM_TIMEOUT_MS}ms`);
      FORMAT_CACHE.delete(videoId);
      res.status(504).json({ error: 'Audio upstream timed out', reason: 'timeout' });
      return;
    }
    if (e?.name !== 'AbortError') {
      console.warn(`[audio] stream error id=${videoId}: ${e?.message || e}`);
    }
    if (!res.headersSent) {
      res.status(500).json({ error: 'Audio stream error', reason: 'server-error' });
    } else {
      try { res.end(); } catch (err) {}
    }
  }
}

export async function resolveAudioStream({ videoId }) {
  const format = await getYoutubeAudioFormat(videoId);
  if (format?.url) {
    return {
      mode: 'audio',
      url: `/api/audio/${encodeURIComponent(videoId)}`,
      source: format.provider || 'ytdl-m4a-proxy'
    };
  }
  return { mode: 'iframe', url: null, source: 'yt-iframe' };
}
